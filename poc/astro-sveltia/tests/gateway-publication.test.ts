import { env } from 'cloudflare:workers'
import { applyD1Migrations } from 'cloudflare:test'
import {
  SignJWT,
  exportJWK,
  exportPKCS8,
  generateKeyPair,
  type JWK,
} from 'jose'
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'

import { onRequestPost } from '../functions/admin/api/graphql.ts'
import {
  beginCmsMutation,
  completeCmsMutation,
} from '../functions/admin/api/_cms-state.ts'
import type { CmsRuntimeEnv } from '../functions/admin/api/_cms-policy.ts'

const MAIN_SHA = 'a'.repeat(40)
const ACCESS_ISSUER = 'https://test-suite.cloudflareaccess.com'
const ACCESS_AUDIENCE = 'test-cms-audience'
const ACCESS_KEY_ID = 'test-access-key'
const DISCORD_ID = '345678901234567890'
const DISCORD_ROLE_ID = '234567890123456789'
const GITHUB_CLIENT_ID = 'Iv1.gateway-test'
const GITHUB_INSTALLATION_ID = '987654'
const INSTALLATION_TOKEN_URL = `https://api.github.com/app/installations/${GITHUB_INSTALLATION_ID}/access_tokens`

let accessPrivateKey: CryptoKey
let accessJwk: JWK
let githubPrivateKeyPem: string
let validAccessJwt: string

beforeAll(async () => {
  const testMigrations = (
    env as Env & {
      TEST_D1_MIGRATIONS: Array<{ name: string; queries: string[] }>
    }
  ).TEST_D1_MIGRATIONS

  await applyD1Migrations(env.CMS_DATABASE, testMigrations)

  const accessKeys = await generateKeyPair('RS256', { extractable: true })
  const githubKeys = await generateKeyPair('RS256', { extractable: true })

  accessPrivateKey = accessKeys.privateKey
  accessJwk = await exportJWK(accessKeys.publicKey)
  accessJwk.alg = 'RS256'
  accessJwk.kid = ACCESS_KEY_ID
  accessJwk.use = 'sig'
  githubPrivateKeyPem = await exportPKCS8(githubKeys.privateKey)
  validAccessJwt = await signAccessJwt()
})

beforeEach(async () => {
  await env.CMS_DATABASE.exec(`
    DELETE FROM cms_audit_events;
    DELETE FROM cms_mutations;
    DELETE FROM cms_rate_limits;
    DELETE FROM cms_bans;
  `)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('CMS publication modes', () => {
  it('rejects cross-origin and non-JSON mutation requests before authentication', async () => {
    const crossOriginResponse = await onRequestPost({
      request: graphqlRequest(commitVariables(MAIN_SHA), {
        origin: 'https://attacker.example',
      }),
      env: testEnv('direct'),
    } as Parameters<typeof onRequestPost>[0])
    const textResponse = await onRequestPost({
      request: graphqlRequest(commitVariables(MAIN_SHA), {
        contentType: 'text/plain',
      }),
      env: testEnv('direct'),
    } as Parameters<typeof onRequestPost>[0])

    expect(crossOriginResponse.status).toBe(403)
    expect(textResponse.status).toBe(415)
  })

  it('returns 409 when main no longer matches expectedHeadOid', async () => {
    const calls: string[] = []

    mockFetch(async (url) => {
      calls.push(url)

      if (url.endsWith('/git/ref/heads/main')) {
        return jsonResponse({ object: { sha: MAIN_SHA } })
      }

      throw new Error(`Unexpected request: ${url}`)
    })

    const response = await onRequestPost({
      request: graphqlRequest({
        ...commitVariables('b'.repeat(40)),
      }),
      env: testEnv('review'),
    } as Parameters<typeof onRequestPost>[0])

    expect(response.status).toBe(409)
    expect(calls.some((url) => url.endsWith('/git/refs'))).toBe(false)
    expect(calls.some((url) => url.endsWith('/graphql'))).toBe(false)
  })

  it('commits directly to main only when direct mode is explicit', async () => {
    const publication = mockSuccessfulDirectPublication('c')

    const response = await onRequestPost({
      request: graphqlRequest(commitVariables(MAIN_SHA)),
      env: testEnv('direct'),
    } as Parameters<typeof onRequestPost>[0])
    const result = (await response.json()) as CmsResponse

    expect(response.status).toBe(200)
    expect(result.extensions.cms).toMatchObject({
      branch: 'main',
      mode: 'direct',
    })
    expect(publication.branch()).toMatch(/^cms\/pending\/[a-f0-9]{64}$/u)
    expect(publication.calls.some(({ url }) => url.endsWith('/pulls'))).toBe(
      false,
    )

    const commitCall = publication.calls.find(({ url }) =>
      url.endsWith('/graphql'),
    )
    const commitMessage = (
      commitCall?.body as {
        variables: { input: { message: { body: string } } }
      }
    ).variables.input.message.body

    expect(commitMessage).toContain('CMS-Idempotency-Key:')
    expect(commitMessage).toContain('Request ID:')
    expect(commitMessage).not.toContain(DISCORD_ID)

    const audit = await env.CMS_DATABASE.prepare(
      `SELECT actor_discord_id, status, branch, commit_oid, http_status
       FROM cms_audit_events
       LIMIT 1`,
    ).first<{
      actor_discord_id: string
      status: string
      branch: string
      commit_oid: string
      http_status: number
    }>()

    expect(response.headers.get('X-CMS-Audit-Status')).toBe('recorded')
    expect(audit).toMatchObject({
      actor_discord_id: DISCORD_ID,
      status: 'succeeded',
      branch: 'main',
      commit_oid: 'c'.repeat(40),
      http_status: 200,
    })
  })

  it('replays an identical successful mutation without writing twice', async () => {
    const publication = mockSuccessfulDirectPublication('e')

    const requestBody = commitVariables(MAIN_SHA)
    const first = await onRequestPost({
      request: graphqlRequest(requestBody),
      env: testEnv('direct'),
    } as Parameters<typeof onRequestPost>[0])
    const second = await onRequestPost({
      request: graphqlRequest(requestBody),
      env: testEnv('direct'),
    } as Parameters<typeof onRequestPost>[0])

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(second.headers.get('X-CMS-Idempotent-Replay')).toBe('true')
    expect(
      publication.calls.filter(({ url }) => url.endsWith('/graphql')),
    ).toHaveLength(1)
    expect(
      publication.calls.filter(({ url }) =>
        url.endsWith('/git/ref/heads/main'),
      ),
    ).toHaveLength(2)
  })

  it('records a definitive main divergence as failed and removes the staging branch', async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = []
    const divergedSha = 'b'.repeat(40)
    let mainReads = 0
    let branchSha: string | null = null

    mockFetch(async (url, init) => {
      const method = init.method || 'GET'
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : null

      calls.push({ url, method, body })

      if (url.endsWith('/git/ref/heads/main')) {
        mainReads += 1
        return jsonResponse({
          object: { sha: mainReads === 1 ? MAIN_SHA : divergedSha },
        })
      }

      if (method === 'GET' && url.includes('/git/ref/heads/cms/pending/')) {
        return branchSha
          ? jsonResponse({ object: { sha: branchSha } })
          : jsonResponse({ message: 'Not Found' }, 404)
      }

      if (url.endsWith('/git/refs') && method === 'POST') {
        branchSha = MAIN_SHA
        return jsonResponse({ object: { sha: MAIN_SHA } }, 201)
      }

      if (url.endsWith('/graphql')) {
        branchSha = '5'.repeat(40)
        return commitResponse('5')
      }

      if (url.includes('/compare/') && method === 'GET') {
        return jsonResponse({ status: 'diverged' })
      }

      if (method === 'DELETE' && url.includes('/git/refs/heads/cms/pending/')) {
        branchSha = null
        return new Response(null, { status: 204 })
      }

      throw new Error(`Unexpected request: ${url}`)
    })

    const response = await onRequestPost({
      request: graphqlRequest(commitVariables(MAIN_SHA)),
      env: testEnv('direct'),
    } as Parameters<typeof onRequestPost>[0])
    const state = await env.CMS_DATABASE.prepare(
      `SELECT
         (SELECT state FROM cms_mutations LIMIT 1) AS mutation_state,
         (SELECT status FROM cms_audit_events LIMIT 1) AS audit_status`,
    ).first<{ mutation_state: string; audit_status: string }>()

    expect(response.status).toBe(409)
    expect(state).toEqual({
      mutation_state: 'failed',
      audit_status: 'failed',
    })
    expect(
      calls.some(
        ({ method, url }) =>
          method === 'DELETE' && url.includes('/git/refs/heads/cms/pending/'),
      ),
    ).toBe(true)
  })

  it('publishes review mode through a deterministic branch and pull request', async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = []
    let reviewBranch = ''
    let reviewBranchSha: string | null = null

    mockFetch(async (url, init) => {
      const method = init.method || 'GET'
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : null

      calls.push({ url, method, body })

      if (url.endsWith('/git/ref/heads/main')) {
        return jsonResponse({ object: { sha: MAIN_SHA } })
      }

      if (method === 'GET' && url.includes('/git/ref/heads/cms/pending/')) {
        return reviewBranchSha
          ? jsonResponse({ object: { sha: reviewBranchSha } })
          : jsonResponse({ message: 'Not Found' }, 404)
      }

      if (url.endsWith('/git/refs') && method === 'POST') {
        const value = body as { ref: string; sha: string }

        reviewBranch = value.ref.replace('refs/heads/', '')
        reviewBranchSha = value.sha
        return jsonResponse({ ref: value.ref, object: { sha: value.sha } }, 201)
      }

      if (url.endsWith('/graphql')) {
        reviewBranchSha = '7'.repeat(40)
        return commitResponse('7')
      }

      if (url.includes('/pulls?') && method === 'GET') {
        return jsonResponse([])
      }

      if (url.endsWith('/pulls') && method === 'POST') {
        return jsonResponse(
          {
            number: 42,
            html_url:
              'https://github.com/acecore-systems/aceserver-wiki/pull/42',
          },
          201,
        )
      }

      throw new Error(`Unexpected request: ${url}`)
    })

    const response = await onRequestPost({
      request: graphqlRequest(commitVariables(MAIN_SHA)),
      env: testEnv('review'),
    } as Parameters<typeof onRequestPost>[0])
    const result = (await response.json()) as CmsResponse

    expect(response.status).toBe(200)
    expect(reviewBranch).toMatch(/^cms\/pending\/[a-f0-9]{64}$/u)
    expect(result.extensions.cms).toMatchObject({
      branch: reviewBranch,
      mode: 'review',
      pull_request: {
        number: 42,
      },
    })
    expect(
      calls.some(
        ({ method, url }) =>
          method === 'DELETE' && url.includes('/git/refs/heads/cms/pending/'),
      ),
    ).toBe(false)
  })

  it('retains a deterministic review branch for reconciliation when PR creation fails', async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = []
    let reviewBranch = ''
    let reviewBranchSha: string | null = null

    mockFetch(async (url, init) => {
      const method = init.method || 'GET'
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : null

      calls.push({ url, method, body })

      if (url.endsWith('/git/ref/heads/main')) {
        return jsonResponse({ object: { sha: MAIN_SHA } })
      }

      if (method === 'GET' && url.includes('/git/ref/heads/cms/pending/')) {
        return reviewBranchSha
          ? jsonResponse({ object: { sha: reviewBranchSha } })
          : jsonResponse({ message: 'Not Found' }, 404)
      }

      if (url.endsWith('/git/refs') && method === 'POST') {
        reviewBranch = (body as { ref: string }).ref.replace('refs/heads/', '')
        expect(reviewBranch).toMatch(/^cms\/pending\/[a-f0-9]{64}$/u)
        reviewBranchSha = MAIN_SHA

        return jsonResponse(
          { ref: `refs/heads/${reviewBranch}`, object: { sha: MAIN_SHA } },
          201,
        )
      }

      if (url.endsWith('/graphql')) {
        const variables = (body as GraphqlRequestBody).variables

        expect(variables.input.branch.branchName).toBe(reviewBranch)
        reviewBranchSha = 'd'.repeat(40)
        return commitResponse('d')
      }

      if (url.includes('/pulls?') && method === 'GET') {
        return jsonResponse([])
      }

      if (url.endsWith('/pulls')) {
        const pullRequest = body as { body: string }

        expect(pullRequest.body).toContain('CMS-Idempotency-Key:')
        expect(pullRequest.body).toContain('Request ID:')
        expect(pullRequest.body).not.toContain(DISCORD_ID)
        return jsonResponse({ message: 'test PR failure' }, 500)
      }

      throw new Error(`Unexpected request: ${url}`)
    })

    const response = await onRequestPost({
      request: graphqlRequest(commitVariables(MAIN_SHA)),
      env: testEnv('review'),
    } as Parameters<typeof onRequestPost>[0])

    expect(response.status).toBe(500)
    expect(reviewBranch).not.toBe('')
    expect(
      calls.some(
        ({ method, url }) =>
          method === 'DELETE' && url.includes('/git/refs/heads/cms/pending/'),
      ),
    ).toBe(false)

    const mutation = await env.CMS_DATABASE.prepare(
      `SELECT state FROM cms_mutations LIMIT 1`,
    ).first<{ state: string }>()

    expect(mutation?.state).toBe('unknown')
  })
})

describe('CMS mutation controls', () => {
  it('rejects a currently banned Discord user before GitHub access', async () => {
    const now = Math.floor(Date.now() / 1000)

    await env.CMS_DATABASE.prepare(
      `INSERT INTO cms_bans (
         discord_id, reason, expires_at, created_at, created_by
       ) VALUES (?, ?, NULL, ?, ?)`,
    )
      .bind(DISCORD_ID, 'test ban', now, 'test-suite')
      .run()

    const response = await onRequestPost({
      request: graphqlRequest(commitVariables(MAIN_SHA)),
      env: testEnv('direct'),
    } as Parameters<typeof onRequestPost>[0])

    expect(response.status).toBe(403)
  })

  it('allows a Discord user again after a temporary ban expires', async () => {
    const now = Math.floor(Date.now() / 1000)

    await env.CMS_DATABASE.prepare(
      `INSERT INTO cms_bans (
         discord_id, reason, expires_at, created_at, created_by
       ) VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(DISCORD_ID, 'expired test ban', now - 1, now - 60, 'test-suite')
      .run()
    mockSuccessfulDirectPublication('f')

    const response = await onRequestPost({
      request: graphqlRequest(commitVariables(MAIN_SHA)),
      env: testEnv('direct'),
    } as Parameters<typeof onRequestPost>[0])

    expect(response.status).toBe(200)
  })

  it('reserves one atomic attempt for concurrent identical mutations', async () => {
    const args = mutationStartArgs('parallel-mutation')
    const results = await Promise.allSettled([
      beginCmsMutation(args),
      beginCmsMutation(args),
    ])
    const fulfilled = results.filter(
      (
        result,
      ): result is PromiseFulfilledResult<
        Awaited<ReturnType<typeof beginCmsMutation>>
      > => result.status === 'fulfilled',
    )
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    )

    expect(fulfilled).toHaveLength(1)
    expect(fulfilled[0].value.kind).toBe('reserved')
    expect(rejected).toHaveLength(1)
    expect(rejected[0].reason).toMatchObject({ status: 409 })

    const counts = await env.CMS_DATABASE.prepare(
      `SELECT
         (SELECT COUNT(*) FROM cms_mutations) AS mutations,
         (SELECT COUNT(*) FROM cms_audit_events) AS audits`,
    ).first<{ mutations: number; audits: number }>()

    expect(counts).toEqual({ mutations: 1, audits: 1 })
  })

  it('moves an expired processing lease to unknown for reconciliation', async () => {
    const args = mutationStartArgs('stale-processing')
    const first = await beginCmsMutation(args)

    expect(first.kind).toBe('reserved')

    await env.CMS_DATABASE.prepare(
      `UPDATE cms_mutations SET lease_expires_at = ?`,
    )
      .bind(Math.floor(Date.now() / 1000) - 1)
      .run()

    const second = await beginCmsMutation(args)
    const state = await env.CMS_DATABASE.prepare(
      `SELECT
         (SELECT state FROM cms_mutations LIMIT 1) AS mutation_state,
         (SELECT status FROM cms_audit_events LIMIT 1) AS audit_status`,
    ).first<{ mutation_state: string; audit_status: string }>()

    expect(second.kind).toBe('reconcile')
    expect(state).toEqual({
      mutation_state: 'unknown',
      audit_status: 'unknown',
    })
  })

  it('does not report success when completion changes zero rows', async () => {
    const started = await beginCmsMutation(
      mutationStartArgs('missing-completion-row'),
    )

    expect(started.kind).toBe('reserved')
    if (started.kind !== 'reserved') throw new Error('Expected reservation')

    await env.CMS_DATABASE.prepare(`DELETE FROM cms_audit_events WHERE id = ?`)
      .bind(started.reservation.auditId)
      .run()

    await expect(
      completeCmsMutation({
        branch: 'main',
        commitOid: '1'.repeat(40),
        env: testEnv('direct'),
        reservation: started.reservation,
        response: { data: {} },
        status: 200,
      }),
    ).rejects.toMatchObject({ status: 503 })
  })

  it('fails closed when D1 completion itself fails', async () => {
    const failingDatabase = {
      batch: vi.fn().mockRejectedValue(new Error('simulated D1 outage')),
    } as unknown as D1Database

    await expect(
      completeCmsMutation({
        branch: 'main',
        commitOid: '2'.repeat(40),
        env: {
          ...testEnv('direct'),
          CMS_DATABASE: failingDatabase,
        },
        reservation: {
          auditId: crypto.randomUUID(),
          idempotencyKey: '3'.repeat(64),
          requestId: 'completion-failure-test',
          publicationBranch: `cms/pending/${'3'.repeat(64)}`,
          commitMarker: `CMS-Idempotency-Key: ${'3'.repeat(64)}`,
          expectedHeadOid: MAIN_SHA,
        },
        response: { data: {} },
        status: 200,
      }),
    ).rejects.toMatchObject({ status: 503 })
  })

  it('reconciles a GitHub commit after the first response is lost', async () => {
    const publication = mockCommitResponseLossThenRecovery('9')
    const variables = commitVariables(MAIN_SHA)
    const first = await onRequestPost({
      request: graphqlRequest(variables),
      env: testEnv('direct'),
    } as Parameters<typeof onRequestPost>[0])
    const second = await onRequestPost({
      request: graphqlRequest(variables),
      env: testEnv('direct'),
    } as Parameters<typeof onRequestPost>[0])

    expect(first.status).toBe(502)
    expect(second.status).toBe(200)
    expect(second.headers.get('X-CMS-Reconciled')).toBe('true')
    expect(
      publication.calls.filter(({ url }) => url.endsWith('/graphql')),
    ).toHaveLength(1)

    const state = await env.CMS_DATABASE.prepare(
      `SELECT state, commit_oid FROM cms_mutations LIMIT 1`,
    ).first<{ state: string; commit_oid: string }>()

    expect(state).toEqual({
      state: 'succeeded',
      commit_oid: '9'.repeat(40),
    })
  })

  it('rejects a marker-bearing recovery commit whose parent is not the reserved main', async () => {
    mockCommitResponseLossThenRecovery('6', 'b'.repeat(40))
    const variables = commitVariables(MAIN_SHA)
    const first = await onRequestPost({
      request: graphqlRequest(variables),
      env: testEnv('direct'),
    } as Parameters<typeof onRequestPost>[0])
    const second = await onRequestPost({
      request: graphqlRequest(variables),
      env: testEnv('direct'),
    } as Parameters<typeof onRequestPost>[0])
    const state = await env.CMS_DATABASE.prepare(
      `SELECT state FROM cms_mutations LIMIT 1`,
    ).first<{ state: string }>()

    expect(first.status).toBe(502)
    expect(second.status).toBe(409)
    expect(state?.state).toBe('unknown')
  })

  it('deletes bounded batches of expired rate, replay, and unknown rows while retaining audits', async () => {
    await env.CMS_DATABASE.prepare(
      `
      WITH RECURSIVE sequence(value) AS (
        SELECT 1
        UNION ALL
        SELECT value + 1 FROM sequence WHERE value < 105
      )
      INSERT INTO cms_rate_limits (scope, actor_id, window_start, hit_count)
      SELECT 'old', 'actor-' || value, 0, 1 FROM sequence
    `,
    ).run()
    await env.CMS_DATABASE.prepare(
      `
      WITH RECURSIVE sequence(value) AS (
        SELECT 1
        UNION ALL
        SELECT value + 1 FROM sequence WHERE value < 105
      )
      INSERT INTO cms_mutations (
        idempotency_key,
        actor_discord_id,
        request_id,
        audit_id,
        state,
        response_json,
        http_status,
        lease_expires_at,
        publication_branch,
        commit_marker,
        expected_head_oid,
        commit_oid,
        created_at,
        updated_at
      )
      SELECT
        printf('%064x', value),
        '${DISCORD_ID}',
        'old-request-' || value,
        'old-audit-' || value,
        'succeeded',
        '{}',
        200,
        NULL,
        'cms/pending/' || printf('%064x', value),
        'CMS-Idempotency-Key: ' || printf('%064x', value),
        '${MAIN_SHA}',
        '${'8'.repeat(40)}',
        0,
        0
      FROM sequence
    `,
    ).run()
    await env.CMS_DATABASE.prepare(
      `
      WITH RECURSIVE sequence(value) AS (
        SELECT 1
        UNION ALL
        SELECT value + 1 FROM sequence WHERE value < 105
      )
      INSERT INTO cms_mutations (
        idempotency_key,
        actor_discord_id,
        request_id,
        audit_id,
        state,
        response_json,
        http_status,
        lease_expires_at,
        publication_branch,
        commit_marker,
        expected_head_oid,
        commit_oid,
        created_at,
        updated_at
      )
      SELECT
        printf('%064x', value + 1000),
        '${DISCORD_ID}',
        'unknown-request-' || value,
        'unknown-audit-' || value,
        'unknown',
        NULL,
        NULL,
        NULL,
        'cms/pending/' || printf('%064x', value + 1000),
        'CMS-Idempotency-Key: ' || printf('%064x', value + 1000),
        '${MAIN_SHA}',
        NULL,
        0,
        0
      FROM sequence
    `,
    ).run()
    await env.CMS_DATABASE.prepare(
      `
      WITH RECURSIVE sequence(value) AS (
        SELECT 1
        UNION ALL
        SELECT value + 1 FROM sequence WHERE value < 105
      )
      INSERT INTO cms_audit_events (
        id,
        occurred_at,
        actor_discord_id,
        discord_role_ids_json,
        request_id,
        action,
        status,
        paths_json,
        detail
      )
      SELECT
        'unknown-audit-' || value,
        0,
        '${DISCORD_ID}',
        '[]',
        'unknown-request-' || value,
        'mutation',
        'unknown',
        '[]',
        'retention test'
      FROM sequence
    `,
    ).run()

    const started = await beginCmsMutation(
      mutationStartArgs('retention-trigger'),
    )
    const remaining = await env.CMS_DATABASE.prepare(
      `SELECT
         (SELECT COUNT(*) FROM cms_rate_limits WHERE scope = 'old') AS rates,
         (SELECT COUNT(*) FROM cms_mutations WHERE state = 'succeeded' AND updated_at = 0) AS replays,
         (SELECT COUNT(*) FROM cms_mutations WHERE state = 'unknown' AND updated_at = 0) AS unknown_mutations,
         (SELECT COUNT(*) FROM cms_audit_events WHERE status = 'unknown') AS unknown_audits`,
    ).first<{
      rates: number
      replays: number
      unknown_mutations: number
      unknown_audits: number
    }>()

    expect(started.kind).toBe('reserved')
    expect(remaining).toEqual({
      rates: 5,
      replays: 5,
      unknown_mutations: 5,
      unknown_audits: 105,
    })
  })

  it('limits each Discord user to twelve new mutations per ten minutes', async () => {
    const runtimeEnv = testEnv('direct')

    for (let index = 0; index < 12; index += 1) {
      const result = await beginCmsMutation({
        bodyText: `mutation-${index}`,
        discordId: DISCORD_ID,
        discordRoleIds: [DISCORD_ROLE_ID],
        env: runtimeEnv,
        expectedHeadOid: MAIN_SHA,
        paths: ['poc/astro-sveltia/src/content/wiki/test.md'],
        request: new Request(
          'https://wiki-admin.example.test/admin/api/graphql',
        ),
      })

      expect(result.kind).toBe('reserved')
    }

    await expect(
      beginCmsMutation({
        bodyText: 'mutation-over-limit',
        discordId: DISCORD_ID,
        discordRoleIds: [DISCORD_ROLE_ID],
        env: runtimeEnv,
        expectedHeadOid: MAIN_SHA,
        paths: ['poc/astro-sveltia/src/content/wiki/test.md'],
        request: new Request(
          'https://wiki-admin.example.test/admin/api/graphql',
        ),
      }),
    ).rejects.toMatchObject({
      status: 429,
    })
  })
})

describe('stock Sveltia read queries', () => {
  it('allows file history up to 100 entries only for an allowed CMS path', async () => {
    mockFetch(async (url) => {
      if (url.endsWith('/graphql')) {
        return jsonResponse({
          data: {
            repository: {
              ref: {
                target: {
                  history: {
                    nodes: [],
                  },
                },
              },
            },
          },
        })
      }

      throw new Error(`Unexpected request: ${url}`)
    })

    const response = await onRequestPost({
      request: graphqlQueryRequest(`
        query {
          repository(owner: "acecore-systems", name: "aceserver-wiki") {
            ref(qualifiedName: "main") {
              target {
                ... on Commit {
                  history(
                    first: 100
                    path: "poc/astro-sveltia/src/content/wiki/test.md"
                  ) {
                    nodes {
                      oid
                      author {
                        name
                        email
                        avatarUrl
                        user { login }
                      }
                      committedDate
                    }
                  }
                }
              }
            }
          }
        }
      `),
      env: testEnv('direct'),
    } as Parameters<typeof onRequestPost>[0])

    expect(response.status).toBe(200)
  })

  it('limits pathless HEAD history to the stock Sveltia first-one query', async () => {
    const response = await onRequestPost({
      request: graphqlQueryRequest(`
        query {
          repository(owner: "acecore-systems", name: "aceserver-wiki") {
            ref(qualifiedName: "main") {
              target {
                ... on Commit {
                  history(first: 2) {
                    nodes { oid message }
                  }
                }
              }
            }
          }
        }
      `),
      env: testEnv('direct'),
    } as Parameters<typeof onRequestPost>[0])

    expect(response.status).toBe(403)
  })
})

function mockFetch(
  handler: (url: string, init: RequestInit) => Promise<Response>,
) {
  vi.stubGlobal(
    'fetch',
    async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input)

      if (url === `${ACCESS_ISSUER}/cdn-cgi/access/certs`) {
        return jsonResponse({ keys: [accessJwk] })
      }

      if (url === INSTALLATION_TOKEN_URL) {
        return jsonResponse({
          token: 'test-installation-token',
          expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        })
      }

      return await handler(url, init)
    },
  )
}

function mockSuccessfulDirectPublication(marker: string) {
  const calls: Array<{ url: string; method: string; body: unknown }> = []
  let mainSha = MAIN_SHA
  let publicationBranch = ''
  let publicationBranchSha: string | null = null
  const commitSha = marker.repeat(40)

  mockFetch(async (url, init) => {
    const method = init.method || 'GET'
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : null

    calls.push({ url, method, body })

    if (url.endsWith('/git/ref/heads/main')) {
      return jsonResponse({ object: { sha: mainSha } })
    }

    if (method === 'GET' && url.includes('/git/ref/heads/cms/pending/')) {
      return publicationBranchSha
        ? jsonResponse({ object: { sha: publicationBranchSha } })
        : jsonResponse({ message: 'Not Found' }, 404)
    }

    if (url.endsWith('/git/refs') && method === 'POST') {
      const value = body as { ref: string; sha: string }

      publicationBranch = value.ref.replace('refs/heads/', '')
      publicationBranchSha = value.sha
      return jsonResponse(
        {
          ref: value.ref,
          object: { sha: value.sha },
        },
        201,
      )
    }

    if (url.endsWith('/graphql')) {
      const variables = (body as GraphqlRequestBody).variables

      expect(variables.input.branch.branchName).toBe(publicationBranch)
      expect(variables.input.expectedHeadOid).toBe(MAIN_SHA)
      publicationBranchSha = commitSha
      return commitResponse(marker)
    }

    if (url.endsWith('/git/refs/heads/main') && method === 'PATCH') {
      const value = body as { sha: string; force: boolean }

      expect(value).toEqual({ sha: commitSha, force: false })
      mainSha = value.sha
      return jsonResponse({ object: { sha: mainSha } })
    }

    if (method === 'DELETE' && url.includes('/git/refs/heads/cms/pending/')) {
      publicationBranchSha = null
      return new Response(null, { status: 204 })
    }

    throw new Error(`Unexpected request: ${url}`)
  })

  return {
    calls,
    branch: () => publicationBranch,
  }
}

function mockCommitResponseLossThenRecovery(
  marker: string,
  parentSha = MAIN_SHA,
) {
  const calls: Array<{ url: string; method: string; body: unknown }> = []
  let mainSha = MAIN_SHA
  let publicationBranchSha: string | null = null
  let commitMessage = ''
  const commitSha = marker.repeat(40)

  mockFetch(async (url, init) => {
    const method = init.method || 'GET'
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : null

    calls.push({ url, method, body })

    if (url.endsWith('/git/ref/heads/main')) {
      return jsonResponse({ object: { sha: mainSha } })
    }

    if (method === 'GET' && url.includes('/git/ref/heads/cms/pending/')) {
      return publicationBranchSha
        ? jsonResponse({ object: { sha: publicationBranchSha } })
        : jsonResponse({ message: 'Not Found' }, 404)
    }

    if (url.endsWith('/git/refs') && method === 'POST') {
      const value = body as { ref: string; sha: string }

      publicationBranchSha = value.sha
      return jsonResponse({ ref: value.ref, object: { sha: value.sha } }, 201)
    }

    if (url.endsWith('/graphql')) {
      const variables = (
        body as {
          variables: {
            input: {
              message: { body: string }
            }
          }
        }
      ).variables

      commitMessage = variables.input.message.body
      publicationBranchSha = commitSha
      throw new Error('simulated response loss after GitHub commit')
    }

    if (url.includes(`/git/commits/${commitSha}`) && method === 'GET') {
      return jsonResponse({
        sha: commitSha,
        message: commitMessage,
        committer: { date: '2026-07-27T00:00:00Z' },
        parents: [{ sha: parentSha }],
      })
    }

    if (url.endsWith('/git/refs/heads/main') && method === 'PATCH') {
      const value = body as { sha: string; force: boolean }

      expect(value).toEqual({ sha: commitSha, force: false })
      mainSha = value.sha
      return jsonResponse({ object: { sha: mainSha } })
    }

    if (method === 'DELETE' && url.includes('/git/refs/heads/cms/pending/')) {
      publicationBranchSha = null
      return new Response(null, { status: 204 })
    }

    throw new Error(`Unexpected request: ${url}`)
  })

  return { calls }
}

function mutationStartArgs(bodyText: string) {
  return {
    bodyText,
    discordId: DISCORD_ID,
    discordRoleIds: [DISCORD_ROLE_ID],
    env: testEnv('direct'),
    expectedHeadOid: MAIN_SHA,
    paths: ['poc/astro-sveltia/src/content/wiki/test.md'],
    request: new Request('https://wiki-admin.example.test/admin/api/graphql'),
  }
}

function testEnv(publicationMode: 'direct' | 'review') {
  return {
    CMS_DATABASE: env.CMS_DATABASE,
    CMS_REPOSITORY_OWNER: 'acecore-systems',
    CMS_REPOSITORY_NAME: 'aceserver-wiki',
    CMS_REPOSITORY_BRANCH: 'main',
    CMS_CONTENT_ROOT: 'poc/astro-sveltia/src/content/wiki',
    CMS_MEDIA_ROOT: 'poc/astro-sveltia/public/uploads/wiki',
    CMS_PUBLICATION_MODE: publicationMode,
    CMS_ACCESS_AUD: ACCESS_AUDIENCE,
    CMS_ACCESS_TEAM_DOMAIN: ACCESS_ISSUER,
    CMS_ACCESS_HOSTNAMES: 'wiki-admin.example.test',
    CMS_DISCORD_GUILD_ID: '',
    CMS_DISCORD_AUTHORIZATION_MODE: 'account',
    CMS_DISCORD_ALLOWED_ROLE_IDS: '',
    CMS_GITHUB_APP_CLIENT_ID: GITHUB_CLIENT_ID,
    CMS_GITHUB_APP_INSTALLATION_ID: GITHUB_INSTALLATION_ID,
    CMS_GITHUB_APP_PRIVATE_KEY: githubPrivateKeyPem,
  } as CmsRuntimeEnv
}

function graphqlRequest(
  variables: Record<string, unknown>,
  overrides: { contentType?: string; origin?: string } = {},
) {
  return new Request('https://wiki-admin.example.test/admin/api/graphql', {
    method: 'POST',
    headers: {
      'Cf-Access-Jwt-Assertion': validAccessJwt,
      'Content-Type': overrides.contentType || 'application/json',
      Origin: overrides.origin || 'https://wiki-admin.example.test',
      'Sec-Fetch-Site': 'same-origin',
    },
    body: JSON.stringify({
      query: `
          mutation($input: CreateCommitOnBranchInput!) {
            createCommitOnBranch(input: $input) {
              commit { oid committedDate }
            }
          }
        `,
      variables,
    }),
  })
}

function graphqlQueryRequest(query: string) {
  return new Request('https://wiki-admin.example.test/admin/api/graphql', {
    method: 'POST',
    headers: {
      'Cf-Access-Jwt-Assertion': validAccessJwt,
      'Content-Type': 'application/json',
      Origin: 'https://wiki-admin.example.test',
      'Sec-Fetch-Site': 'same-origin',
    },
    body: JSON.stringify({ query, variables: {} }),
  })
}

function commitVariables(expectedHeadOid: string) {
  const markdown = `---
title: Test
description: Gateway publication test.
category: その他
order: 10
draft: false
---

## Test
`

  return {
    input: {
      branch: {
        repositoryNameWithOwner: 'acecore-systems/aceserver-wiki',
        branchName: 'main',
      },
      expectedHeadOid,
      fileChanges: {
        additions: [
          {
            path: 'poc/astro-sveltia/src/content/wiki/test.md',
            contents: encodeUtf8(markdown),
          },
        ],
        deletions: [],
      },
      message: { headline: 'Test gateway publication' },
    },
  }
}

function signAccessJwt() {
  return new SignJWT({
    custom: {
      sub: DISCORD_ID,
    },
  })
    .setProtectedHeader({ alg: 'RS256', kid: ACCESS_KEY_ID })
    .setIssuer(ACCESS_ISSUER)
    .setAudience(ACCESS_AUDIENCE)
    .setSubject('access-test-subject')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(accessPrivateKey)
}

function commitResponse(marker: string) {
  return jsonResponse({
    data: {
      createCommitOnBranch: {
        commit: {
          oid: marker.repeat(40),
          committedDate: '2026-07-26T00:00:00Z',
        },
      },
    },
  })
}

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function encodeUtf8(value: string) {
  const bytes = new TextEncoder().encode(value)
  let binary = ''

  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }

  return btoa(binary)
}

type GraphqlRequestBody = {
  variables: {
    input: {
      branch: { branchName: string }
      expectedHeadOid: string
    }
  }
}

type CmsResponse = {
  extensions: {
    cms: {
      branch: string
      mode: string
    }
  }
}
