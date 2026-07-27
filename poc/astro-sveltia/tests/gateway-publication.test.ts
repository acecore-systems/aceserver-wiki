import { env } from 'cloudflare:workers'
import { applyD1Migrations } from 'cloudflare:test'
import {
  SignJWT,
  exportJWK,
  exportPKCS8,
  generateKeyPair,
  jwtVerify,
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

import {
  CMS_PROJECTED_TREE_LIMITS,
  onRequestPost,
} from '../functions/admin/api/graphql.ts'
import { onRequest as onGitHubProxyRequest } from '../functions/admin/api/github/[[path]].ts'
import { getGitHubToken } from '../functions/admin/api/_github-api.ts'
import {
  CMS_MUTATION_RATE_LIMITS,
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
let githubPublicKey: CryptoKey
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
  githubPublicKey = githubKeys.publicKey
  githubPrivateKeyPem = await exportPKCS8(githubKeys.privateKey)
  validAccessJwt = await signAccessJwt()
})

beforeEach(async () => {
  await env.CMS_DATABASE.exec(`
    DELETE FROM cms_audit_events;
    DELETE FROM cms_mutations;
    DELETE FROM cms_mutation_rate_limits;
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

  it('publishes an existing entry from the created ref response without an immediate ref re-read', async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = []
    let pendingRefReads = 0
    let publicationBranch = ''
    const commitSha = '6'.repeat(40)

    mockFetch(async (url, init) => {
      const method = init.method || 'GET'
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : null

      calls.push({ url, method, body })

      if (url.endsWith('/git/ref/heads/main')) {
        return jsonResponse({ object: { sha: MAIN_SHA } })
      }

      if (isProjectionTreeUrl(url)) {
        return projectionTreeResponse([
          {
            mode: '100644',
            path: 'poc/astro-sveltia/src/content/wiki/test.md',
            sha: '7'.repeat(40),
            size: 200,
            type: 'blob',
          },
        ])
      }

      if (method === 'GET' && url.includes('/git/ref/heads/cms/pending/')) {
        pendingRefReads += 1
        return jsonResponse({ message: 'Not Found' }, 404)
      }

      if (url.endsWith('/git/refs') && method === 'POST') {
        const value = body as { ref: string; sha: string }

        publicationBranch = value.ref.replace('refs/heads/', '')
        return jsonResponse({ ref: value.ref, object: { sha: value.sha } }, 201)
      }

      if (url.endsWith('/graphql')) {
        const variables = (body as GraphqlRequestBody).variables

        expect(variables.input.branch.branchName).toBe(publicationBranch)
        return commitResponse('6')
      }

      if (url.endsWith('/git/refs/heads/main') && method === 'PATCH') {
        return jsonResponse({ object: { sha: commitSha } })
      }

      if (method === 'DELETE' && url.includes('/git/refs/heads/cms/pending/')) {
        return new Response(null, { status: 204 })
      }

      throw new Error(`Unexpected request: ${url}`)
    })

    const response = await onRequestPost({
      request: graphqlRequest(commitVariables(MAIN_SHA)),
      env: testEnv('direct'),
    } as Parameters<typeof onRequestPost>[0])

    expect(response.status).toBe(200)
    expect(pendingRefReads).toBe(1)
    expect(calls.some(({ url }) => url.endsWith('/graphql'))).toBe(true)
  })

  it('recovers when a concurrent ref creation returns 422 but the ref is now at the base commit', async () => {
    let pendingRefReads = 0
    let publicationBranch = ''
    const commitSha = '8'.repeat(40)

    mockFetch(async (url, init) => {
      const method = init.method || 'GET'
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : null

      if (url.endsWith('/git/ref/heads/main')) {
        return jsonResponse({ object: { sha: MAIN_SHA } })
      }

      if (isProjectionTreeUrl(url)) return projectionTreeResponse()

      if (method === 'GET' && url.includes('/git/ref/heads/cms/pending/')) {
        pendingRefReads += 1

        return pendingRefReads === 1
          ? jsonResponse({ message: 'Not Found' }, 404)
          : jsonResponse({ object: { sha: MAIN_SHA } })
      }

      if (url.endsWith('/git/refs') && method === 'POST') {
        const value = body as { ref: string }

        publicationBranch = value.ref.replace('refs/heads/', '')
        return jsonResponse({ message: 'Reference already exists' }, 422)
      }

      if (url.endsWith('/graphql')) {
        const variables = (body as GraphqlRequestBody).variables

        expect(variables.input.branch.branchName).toBe(publicationBranch)
        return commitResponse('8')
      }

      if (url.endsWith('/git/refs/heads/main') && method === 'PATCH') {
        return jsonResponse({ object: { sha: commitSha } })
      }

      if (method === 'DELETE' && url.includes('/git/refs/heads/cms/pending/')) {
        return new Response(null, { status: 204 })
      }

      throw new Error(`Unexpected request: ${url}`)
    })

    const response = await onRequestPost({
      request: graphqlRequest(commitVariables(MAIN_SHA)),
      env: testEnv('direct'),
    } as Parameters<typeof onRequestPost>[0])

    expect(response.status).toBe(200)
    expect(pendingRefReads).toBe(2)
  })

  it('preserves a non-recoverable ref validation failure as an upstream error', async () => {
    const calls: string[] = []

    mockFetch(async (url, init) => {
      const method = init.method || 'GET'

      calls.push(url)

      if (url.endsWith('/git/ref/heads/main')) {
        return jsonResponse({ object: { sha: MAIN_SHA } })
      }

      if (isProjectionTreeUrl(url)) return projectionTreeResponse()

      if (method === 'GET' && url.includes('/git/ref/heads/cms/pending/')) {
        return jsonResponse({ message: 'Not Found' }, 404)
      }

      if (url.endsWith('/git/refs') && method === 'POST') {
        return jsonResponse({ message: 'Validation Failed' }, 422)
      }

      throw new Error(`Unexpected request: ${url}`)
    })

    const response = await onRequestPost({
      request: graphqlRequest(commitVariables(MAIN_SHA)),
      env: testEnv('direct'),
    } as Parameters<typeof onRequestPost>[0])
    const result = (await response.json()) as { message: string }

    expect(response.status).toBe(502)
    expect(result.message).toBe(
      'GitHubにCMS保存用branchを作成できませんでした。',
    )
    expect(calls.filter((url) => url.endsWith('/graphql'))).toHaveLength(0)
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

      if (isProjectionTreeUrl(url)) return projectionTreeResponse()

      if (method === 'GET' && url.includes('/git/ref/heads/cms/pending/')) {
        return branchSha
          ? jsonResponse({ object: { sha: branchSha } })
          : jsonResponse({ message: 'Not Found' }, 404)
      }

      if (url.endsWith('/git/refs') && method === 'POST') {
        const value = body as { ref: string }

        branchSha = MAIN_SHA
        return jsonResponse({ ref: value.ref, object: { sha: MAIN_SHA } }, 201)
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

      if (isProjectionTreeUrl(url)) return projectionTreeResponse()

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

      if (isProjectionTreeUrl(url)) return projectionTreeResponse()

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

  it('rejects a projected CMS tree above one thousand files before commit', async () => {
    const calls: string[] = []

    mockFetch(async (url) => {
      calls.push(url)

      if (url.endsWith('/git/ref/heads/main')) {
        return jsonResponse({ object: { sha: MAIN_SHA } })
      }

      if (isProjectionTreeUrl(url)) {
        return projectionTreeResponse(contentTree(1000))
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
    ).first<{ audit_status: string; mutation_state: string }>()

    expect(response.status).toBe(413)
    expect(state).toEqual({
      mutation_state: 'failed',
      audit_status: 'failed',
    })
    expect(calls.some((url) => url.endsWith('/git/refs'))).toBe(false)
    expect(calls.some((url) => url.endsWith('/graphql'))).toBe(false)
  })

  it('allows a deletion that brings an oversized CMS tree back to the cap', async () => {
    const tree = contentTree(CMS_PROJECTED_TREE_LIMITS.maxFiles + 1)
    const publication = mockSuccessfulDirectPublication('e', tree)
    const response = await onRequestPost({
      request: graphqlRequest(
        deletionVariables(MAIN_SHA, tree.at(-1)?.path || ''),
      ),
      env: testEnv('direct'),
    } as Parameters<typeof onRequestPost>[0])

    expect(response.status).toBe(200)
    expect(publication.calls.some(({ url }) => url.endsWith('/graphql'))).toBe(
      true,
    )
  })

  it('rejects projected CMS media above 512 MiB before commit', async () => {
    const calls: string[] = []

    mockFetch(async (url) => {
      calls.push(url)

      if (url.endsWith('/git/ref/heads/main')) {
        return jsonResponse({ object: { sha: MAIN_SHA } })
      }

      if (isProjectionTreeUrl(url)) {
        return projectionTreeResponse([
          {
            mode: '100644',
            path: 'poc/astro-sveltia/public/uploads/wiki/existing.png',
            sha: 'f'.repeat(40),
            size: CMS_PROJECTED_TREE_LIMITS.maxMediaBytes,
            type: 'blob',
          },
        ])
      }

      throw new Error(`Unexpected request: ${url}`)
    })

    const response = await onRequestPost({
      request: graphqlRequest(mediaCommitVariables(MAIN_SHA)),
      env: testEnv('direct'),
    } as Parameters<typeof onRequestPost>[0])

    expect(response.status).toBe(413)
    expect(calls.some((url) => url.endsWith('/git/refs'))).toBe(false)
    expect(calls.some((url) => url.endsWith('/graphql'))).toBe(false)
  })

  it('rejects projected Markdown above 64 MiB before commit', async () => {
    const calls = mockProjectionOnly([
      {
        mode: '100644',
        path: 'poc/astro-sveltia/src/content/wiki/existing.md',
        sha: '1'.repeat(40),
        size: CMS_PROJECTED_TREE_LIMITS.maxContentBytes,
        type: 'blob',
      },
    ])
    const response = await onRequestPost({
      request: graphqlRequest(commitVariables(MAIN_SHA)),
      env: testEnv('direct'),
    } as Parameters<typeof onRequestPost>[0])

    expect(response.status).toBe(413)
    expect(calls.some((url) => url.endsWith('/git/refs'))).toBe(false)
  })

  it('rejects the projected aggregate CMS blob size even below category caps', async () => {
    const calls = mockProjectionOnly([
      {
        mode: '100644',
        path: 'poc/astro-sveltia/public/uploads/wiki/existing.png',
        sha: '2'.repeat(40),
        size: 500 * 1024 * 1024,
        type: 'blob',
      },
      {
        mode: '100644',
        path: 'poc/astro-sveltia/src/content/wiki/existing.md',
        sha: '3'.repeat(40),
        size: 12 * 1024 * 1024,
        type: 'blob',
      },
    ])
    const response = await onRequestPost({
      request: graphqlRequest(commitVariables(MAIN_SHA)),
      env: testEnv('direct'),
    } as Parameters<typeof onRequestPost>[0])

    expect(response.status).toBe(413)
    expect(calls.some((url) => url.endsWith('/git/refs'))).toBe(false)
  })

  it('allows deleting oversized Markdown to recover below the byte cap', async () => {
    const path = 'poc/astro-sveltia/src/content/wiki/oversized.md'
    const publication = mockSuccessfulDirectPublication('4', [
      {
        mode: '100644',
        path,
        sha: '4'.repeat(40),
        size: CMS_PROJECTED_TREE_LIMITS.maxContentBytes + 1,
        type: 'blob',
      },
    ])
    const response = await onRequestPost({
      request: graphqlRequest(deletionVariables(MAIN_SHA, path)),
      env: testEnv('direct'),
    } as Parameters<typeof onRequestPost>[0])

    expect(response.status).toBe(200)
    expect(publication.calls.some(({ url }) => url.endsWith('/graphql'))).toBe(
      true,
    )
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
         (SELECT COUNT(*) FROM cms_audit_events) AS audits,
         (SELECT mutation_count
          FROM cms_mutation_rate_limits
          WHERE scope = 'user') AS user_rate,
         (SELECT mutation_count
          FROM cms_mutation_rate_limits
          WHERE scope = 'global') AS global_rate`,
    ).first<{
      mutations: number
      audits: number
      user_rate: number
      global_rate: number
    }>()

    expect(counts).toEqual({
      mutations: 1,
      audits: 1,
      user_rate: 1,
      global_rate: 1,
    })
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
        mutationBytes: 1,
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
        mutationBytes: 1,
        paths: ['poc/astro-sveltia/src/content/wiki/test.md'],
        request: new Request(
          'https://wiki-admin.example.test/admin/api/graphql',
        ),
      }),
    ).rejects.toMatchObject({
      status: 429,
    })
  })

  it.each([
    {
      name: 'global mutation count',
      scope: 'global',
      actorId: 'gateway',
      mutationCount: CMS_MUTATION_RATE_LIMITS.globalMutations,
      additionBytes: 0,
      maxMutationCount: CMS_MUTATION_RATE_LIMITS.globalMutations,
      maxAdditionBytes: CMS_MUTATION_RATE_LIMITS.globalAdditionBytes,
    },
    {
      name: 'user addition bytes',
      scope: 'user',
      actorId: DISCORD_ID,
      mutationCount: 0,
      additionBytes: CMS_MUTATION_RATE_LIMITS.userAdditionBytes,
      maxMutationCount: CMS_MUTATION_RATE_LIMITS.userMutations,
      maxAdditionBytes: CMS_MUTATION_RATE_LIMITS.userAdditionBytes,
    },
    {
      name: 'global addition bytes',
      scope: 'global',
      actorId: 'gateway',
      mutationCount: 0,
      additionBytes: CMS_MUTATION_RATE_LIMITS.globalAdditionBytes,
      maxMutationCount: CMS_MUTATION_RATE_LIMITS.globalMutations,
      maxAdditionBytes: CMS_MUTATION_RATE_LIMITS.globalAdditionBytes,
    },
  ])(
    'fails closed and rolls back partial counters at the $name limit',
    async ({
      actorId,
      additionBytes,
      maxAdditionBytes,
      maxMutationCount,
      mutationCount,
      name,
      scope,
    }) => {
      const now = Math.floor(Date.now() / 1000)
      const windowStart = now - (now % CMS_MUTATION_RATE_LIMITS.windowSeconds)

      await env.CMS_DATABASE.prepare(
        `INSERT INTO cms_mutation_rate_limits (
           scope,
           actor_id,
           window_start,
           mutation_count,
           addition_bytes,
           max_mutation_count,
           max_addition_bytes,
           last_reservation_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'seed')`,
      )
        .bind(
          scope,
          actorId,
          windowStart,
          mutationCount,
          additionBytes,
          maxMutationCount,
          maxAdditionBytes,
        )
        .run()

      await expect(
        beginCmsMutation({
          ...mutationStartArgs(`rate-limit-${name}`),
          mutationBytes: 1,
        }),
      ).rejects.toMatchObject({
        status: 429,
      })

      const state = await env.CMS_DATABASE.prepare(
        `SELECT
           (SELECT COUNT(*) FROM cms_mutations) AS mutations,
           (SELECT COUNT(*) FROM cms_audit_events) AS audits,
           (SELECT COUNT(*) FROM cms_mutation_rate_limits) AS rate_rows,
           (SELECT mutation_count
            FROM cms_mutation_rate_limits
            WHERE scope = ? AND actor_id = ?) AS mutation_count,
           (SELECT addition_bytes
            FROM cms_mutation_rate_limits
            WHERE scope = ? AND actor_id = ?) AS addition_bytes`,
      )
        .bind(scope, actorId, scope, actorId)
        .first<{
          addition_bytes: number
          audits: number
          mutation_count: number
          mutations: number
          rate_rows: number
        }>()

      expect(state).toEqual({
        mutations: 0,
        audits: 0,
        rate_rows: 1,
        mutation_count: mutationCount,
        addition_bytes: additionBytes,
      })
    },
  )
})

describe('GitHub App authentication', () => {
  it('signs an installation JWT with a downloaded PKCS#1 RSA private key', async () => {
    const clientId = 'Iv1.pkcs1-gateway-test'
    const installationId = '987655'
    const installationUrl = `https://api.github.com/app/installations/${installationId}/access_tokens`
    const pkcs1PrivateKey = pkcs8ToPkcs1Pem(githubPrivateKeyPem)
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(input)

        if (url !== installationUrl) {
          throw new Error(`Unexpected request: ${url}`)
        }

        const authorization = new Headers(init.headers).get('Authorization')
        const appJwt = authorization?.replace(/^Bearer /u, '')

        expect(appJwt).toBeTruthy()
        await expect(
          jwtVerify(appJwt || '', githubPublicKey, {
            algorithms: ['RS256'],
            issuer: clientId,
          }),
        ).resolves.toBeTruthy()

        return jsonResponse({
          token: 'pkcs1-installation-token',
          expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        })
      },
    )

    vi.stubGlobal('fetch', fetchMock)

    await expect(
      getGitHubToken(
        testEnv('direct', {
          CMS_GITHUB_APP_CLIENT_ID: clientId,
          CMS_GITHUB_APP_INSTALLATION_ID: installationId,
          CMS_GITHUB_APP_PRIVATE_KEY: pkcs1PrivateKey,
        }),
      ),
    ).resolves.toBe('pkcs1-installation-token')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('CMS read controls', () => {
  it('rejects an organization token even when its Discord claim is valid', async () => {
    const organizationJwt = await signAccessJwt('org')
    const fetchMock = mockFetch(async (url) => {
      throw new Error(`Unexpected request: ${url}`)
    })

    const response = await onRequestPost({
      request: graphqlQueryRequest(headHistoryQuery(), {}, organizationJwt),
      env: testEnv('direct'),
    } as Parameters<typeof onRequestPost>[0])

    expect(response.status).toBe(403)
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).includes('/access_tokens'),
      ),
    ).toBe(false)
  })

  it('rejects an application token that only has custom.sub', async () => {
    const fallbackJwt = await signAccessJwt('app', { sub: DISCORD_ID })
    const fetchMock = mockFetch(async (url) => {
      throw new Error(`Unexpected request: ${url}`)
    })

    const response = await onRequestPost({
      request: graphqlQueryRequest(headHistoryQuery(), {}, fallbackJwt),
      env: testEnv('direct'),
    } as Parameters<typeof onRequestPost>[0])

    expect(response.status).toBe(403)
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).includes('/access_tokens'),
      ),
    ).toBe(false)
  })

  it('rejects a banned user on GraphQL and REST reads before GitHub access', async () => {
    const now = Math.floor(Date.now() / 1000)
    const fetchMock = mockFetch(async (url) => {
      throw new Error(`Unexpected request: ${url}`)
    })

    await env.CMS_DATABASE.prepare(
      `INSERT INTO cms_bans (
         discord_id, reason, expires_at, created_at, created_by
       ) VALUES (?, ?, NULL, ?, ?)`,
    )
      .bind(DISCORD_ID, 'read test ban', now, 'test-suite')
      .run()

    const graphqlResponse = await onRequestPost({
      request: graphqlQueryRequest(headHistoryQuery()),
      env: testEnv('direct'),
    } as Parameters<typeof onRequestPost>[0])
    const restResponse = await onGitHubProxyRequest({
      request: githubProxyRequest(
        `repos/acecore-systems/aceserver-wiki/git/trees/main?recursive=1`,
      ),
      env: testEnv('direct'),
    } as Parameters<typeof onGitHubProxyRequest>[0])
    const rateCount = await env.CMS_DATABASE.prepare(
      `SELECT COUNT(*) AS count FROM cms_rate_limits`,
    ).first<{ count: number }>()

    expect(graphqlResponse.status).toBe(403)
    expect(restResponse.status).toBe(403)
    expect(rateCount?.count).toBe(0)
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).includes('/access_tokens'),
      ),
    ).toBe(false)
  })

  it('caps per-user reads without consuming more global capacity after 429', async () => {
    const now = Math.floor(Date.now() / 1000)
    const windowStart = now - (now % (10 * 60))

    mockFetch(async (url) => {
      throw new Error(`Unexpected request: ${url}`)
    })

    await env.CMS_DATABASE.prepare(
      `INSERT INTO cms_rate_limits (
         scope, actor_id, window_start, hit_count
       ) VALUES ('read-user', ?, ?, 120)`,
    )
      .bind(DISCORD_ID, windowStart)
      .run()

    const first = await onRequestPost({
      request: graphqlQueryRequest(headHistoryQuery()),
      env: testEnv('direct'),
    } as Parameters<typeof onRequestPost>[0])
    const second = await onRequestPost({
      request: graphqlQueryRequest(headHistoryQuery()),
      env: testEnv('direct'),
    } as Parameters<typeof onRequestPost>[0])
    const counts = await env.CMS_DATABASE.prepare(
      `SELECT
         (SELECT hit_count
          FROM cms_rate_limits
          WHERE scope = 'read-user' AND actor_id = ?) AS user_count,
         (SELECT hit_count
          FROM cms_rate_limits
          WHERE scope = 'read-global-burst'
            AND actor_id = 'gateway') AS global_count`,
    )
      .bind(DISCORD_ID)
      .first<{ global_count: number | null; user_count: number }>()

    expect(first.status).toBe(429)
    expect(second.status).toBe(429)
    expect(Number(first.headers.get('Retry-After'))).toBeGreaterThan(0)
    expect(Number(second.headers.get('Retry-After'))).toBeGreaterThan(0)
    expect(counts).toEqual({
      user_count: 120,
      global_count: null,
    })
  })

  it('caps global reads through the REST gateway and returns Retry-After', async () => {
    const now = Math.floor(Date.now() / 1000)
    const windowStart = now - (now % 10)

    mockFetch(async (url) => {
      throw new Error(`Unexpected request: ${url}`)
    })

    await env.CMS_DATABASE.prepare(
      `INSERT INTO cms_rate_limits (
         scope, actor_id, window_start, hit_count
       ) VALUES ('read-global-burst', 'gateway', ?, 60)`,
    )
      .bind(windowStart)
      .run()

    const response = await onGitHubProxyRequest({
      request: githubProxyRequest(
        `repos/acecore-systems/aceserver-wiki/git/trees/main?recursive=1`,
      ),
      env: testEnv('direct'),
    } as Parameters<typeof onGitHubProxyRequest>[0])
    const counts = await env.CMS_DATABASE.prepare(
      `SELECT scope, hit_count
       FROM cms_rate_limits
       WHERE scope IN ('read-user', 'read-global-burst')
       ORDER BY scope`,
    ).all<{ hit_count: number; scope: string }>()

    expect(response.status).toBe(429)
    expect(Number(response.headers.get('Retry-After'))).toBeGreaterThan(0)
    expect(Number(response.headers.get('Retry-After'))).toBeLessThanOrEqual(10)
    expect(counts.results).toEqual([
      { scope: 'read-global-burst', hit_count: 60 },
      { scope: 'read-user', hit_count: 1 },
    ])
  })

  it('caps sustained global reads across the ten-minute window', async () => {
    const now = Math.floor(Date.now() / 1000)
    const windowStart = now - (now % (10 * 60))

    mockFetch(async (url) => {
      throw new Error(`Unexpected request: ${url}`)
    })

    await env.CMS_DATABASE.prepare(
      `INSERT INTO cms_rate_limits (
         scope, actor_id, window_start, hit_count
       ) VALUES ('read-global-sustained', 'gateway', ?, 240)`,
    )
      .bind(windowStart)
      .run()

    const response = await onGitHubProxyRequest({
      request: githubProxyRequest('user'),
      env: testEnv('direct'),
    } as Parameters<typeof onGitHubProxyRequest>[0])
    const counts = await env.CMS_DATABASE.prepare(
      `SELECT scope, hit_count
       FROM cms_rate_limits
       WHERE scope IN (
         'read-user',
         'read-global-burst',
         'read-global-sustained'
       )
       ORDER BY scope`,
    ).all<{ hit_count: number; scope: string }>()

    expect(response.status).toBe(429)
    expect(Number(response.headers.get('Retry-After'))).toBeGreaterThan(0)
    expect(Number(response.headers.get('Retry-After'))).toBeLessThanOrEqual(
      10 * 60,
    )
    expect(counts.results).toEqual([
      { scope: 'read-global-burst', hit_count: 1 },
      { scope: 'read-global-sustained', hit_count: 240 },
      { scope: 'read-user', hit_count: 1 },
    ])
  })

  it('fails closed on GraphQL and REST when the D1 binding is missing', async () => {
    const runtimeEnv = {
      ...testEnv('direct'),
      CMS_DATABASE: undefined,
    }
    const fetchMock = mockFetch(async (url) => {
      throw new Error(`Unexpected request: ${url}`)
    })
    const graphqlResponse = await onRequestPost({
      request: graphqlQueryRequest(headHistoryQuery()),
      env: runtimeEnv,
    } as Parameters<typeof onRequestPost>[0])
    const restResponse = await onGitHubProxyRequest({
      request: githubProxyRequest('user'),
      env: runtimeEnv,
    } as Parameters<typeof onGitHubProxyRequest>[0])

    expect(graphqlResponse.status).toBe(503)
    expect(restResponse.status).toBe(503)
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).includes('/access_tokens'),
      ),
    ).toBe(false)
  })

  it('rejects cross-site REST reads and invalid paths before D1 or GitHub', async () => {
    mockFetch(async (url) => {
      throw new Error(`Unexpected request: ${url}`)
    })

    const crossSite = await onGitHubProxyRequest({
      request: githubProxyRequest('user', {
        fetchSite: 'cross-site',
      }),
      env: testEnv('direct'),
    } as Parameters<typeof onGitHubProxyRequest>[0])
    const invalidPath = await onGitHubProxyRequest({
      request: githubProxyRequest(
        'repos/acecore-systems/aceserver-wiki/private-metadata',
      ),
      env: testEnv('direct'),
    } as Parameters<typeof onGitHubProxyRequest>[0])
    const rateCount = await env.CMS_DATABASE.prepare(
      `SELECT COUNT(*) AS count FROM cms_rate_limits`,
    ).first<{ count: number }>()

    expect(crossSite.status).toBe(403)
    expect(invalidPath.status).toBe(403)
    expect(rateCount?.count).toBe(0)
  })

  it('reserves API attempts before reading invalid or oversized GraphQL bodies', async () => {
    mockFetch(async (url) => {
      throw new Error(`Unexpected request: ${url}`)
    })

    const invalid = await onRequestPost({
      request: graphqlRawRequest('{'),
      env: testEnv('direct'),
    } as Parameters<typeof onRequestPost>[0])
    const oversized = await onRequestPost({
      request: graphqlRawRequest('{}', {
        contentLength: 16 * 1024 * 1024 + 1,
      }),
      env: testEnv('direct'),
    } as Parameters<typeof onRequestPost>[0])
    const rates = await env.CMS_DATABASE.prepare(
      `SELECT scope, hit_count
       FROM cms_rate_limits
       WHERE scope IN (
         'read-user',
         'read-global-burst',
         'read-global-sustained'
       )
       ORDER BY scope`,
    ).all<{ hit_count: number; scope: string }>()

    expect(invalid.status).toBe(400)
    expect(oversized.status).toBe(413)
    expect(rates.results).toEqual([
      { scope: 'read-global-burst', hit_count: 2 },
      { scope: 'read-global-sustained', hit_count: 2 },
      { scope: 'read-user', hit_count: 2 },
    ])
  })

  it('returns a global attempt 429 without reading the GraphQL body', async () => {
    const now = Math.floor(Date.now() / 1000)
    const windowStart = now - (now % 10)
    let bodyRead = false

    await env.CMS_DATABASE.prepare(
      `INSERT INTO cms_rate_limits (
         scope, actor_id, window_start, hit_count
       ) VALUES ('read-global-burst', 'gateway', ?, 60)`,
    )
      .bind(windowStart)
      .run()

    const baseRequest = graphqlRawRequest('{}')
    const unreadRequest = new Proxy(baseRequest, {
      get(target, property) {
        if (property === 'body') {
          bodyRead = true
          throw new Error('GraphQL body was read after the attempt limit')
        }

        const value = Reflect.get(target, property, target) as unknown

        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const response = await onRequestPost({
      request: unreadRequest,
      env: testEnv('direct'),
    } as Parameters<typeof onRequestPost>[0])

    expect(response.status).toBe(429)
    expect(Number(response.headers.get('Retry-After'))).toBeLessThanOrEqual(10)
    expect(bodyRead).toBe(false)
  })

  it('rejects oversized unused read variables before GitHub', async () => {
    const fetchMock = mockFetch(async (url) => {
      throw new Error(`Unexpected request: ${url}`)
    })
    const response = await onRequestPost({
      request: graphqlQueryRequest(
        `
          query Oversized($junk: String) {
            repository(owner: "acecore-systems", name: "aceserver-wiki") {
              ref(qualifiedName: "main") {
                target {
                  ... on Commit {
                    history(first: 1) {
                      nodes { oid message }
                    }
                  }
                }
              }
            }
          }
        `,
        { junk: 'x'.repeat(65 * 1024) },
      ),
      env: testEnv('direct'),
    } as Parameters<typeof onRequestPost>[0])

    expect(response.status).toBe(413)
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).includes('api.github.com/graphql'),
      ),
    ).toBe(false)
  })
})

describe('stock Sveltia read queries', () => {
  it('allows stock aliased file-content queries and redacts commit authors', async () => {
    const blobSha = 'd'.repeat(40)

    mockFetch(async (url) => {
      if (url.includes('/git/trees/main?recursive=1')) {
        return projectionTreeResponse([
          {
            mode: '100644',
            path: 'poc/astro-sveltia/src/content/wiki/test.md',
            sha: blobSha,
            size: 100,
            type: 'blob',
          },
        ])
      }

      if (url.endsWith('/graphql')) {
        return jsonResponse({
          data: {
            repository: {
              content_0: {
                text: '# Public Wiki content',
              },
              commit_0: {
                target: {
                  history: {
                    nodes: [
                      {
                        author: {
                          name: 'Private repository author',
                          email: 'private-author@example.test',
                          user: {
                            id: 987654321,
                            login: 'private-login',
                          },
                        },
                        committedDate: '2026-07-27T00:00:00Z',
                      },
                    ],
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
      request: graphqlQueryRequest(
        `
        query($owner: String!, $repo: String!, $branch: String!) {
          repository(owner: $owner, name: $repo) {
            content_0: object(oid: "${blobSha}") {
              ... on Blob { text }
            }
            commit_0: ref(qualifiedName: $branch) {
              target {
                ... on Commit {
                  history(
                    first: 1
                    path: "poc/astro-sveltia/src/content/wiki/test.md"
                  ) {
                    nodes {
                      author {
                        name
                        email
                        user {
                          id: databaseId
                          login
                        }
                      }
                      committedDate
                    }
                  }
                }
              }
            }
          }
        }
      `,
        {
          owner: 'acecore-systems',
          repo: 'aceserver-wiki',
          branch: 'main',
        },
      ),
      env: testEnv('direct'),
    } as Parameters<typeof onRequestPost>[0])
    const body = (await response.json()) as {
      data: {
        repository: {
          content_0: { text: string }
          commit_0: {
            target: {
              history: {
                nodes: Array<{
                  author: {
                    name: string
                    email: string
                    user: unknown
                  }
                  committedDate: string
                }>
              }
            }
          }
        }
      }
    }
    const serialized = JSON.stringify(body)

    expect(response.status).toBe(200)
    expect(body.data.repository.content_0.text).toBe('# Public Wiki content')
    expect(body.data.repository.commit_0.target.history.nodes[0]).toEqual({
      author: {
        name: 'Anonymous',
        email: '',
        user: null,
      },
      committedDate: '2026-07-27T00:00:00Z',
    })
    expect(serialized).not.toContain('Private repository author')
    expect(serialized).not.toContain('private-author@example.test')
    expect(serialized).not.toContain('private-login')
    expect(serialized).not.toContain('987654321')
  })

  it('allows distinct CMS paths that share the same Git blob SHA', async () => {
    const blobSha = 'e'.repeat(40)
    const paths = [
      'poc/astro-sveltia/src/content/wiki/duplicate-a.md',
      'poc/astro-sveltia/src/content/wiki/duplicate-b.md',
    ]

    mockFetch(async (url) => {
      if (url.includes('/git/trees/main?recursive=1')) {
        return projectionTreeResponse(
          paths.map((path) => ({
            mode: '100644',
            path,
            sha: blobSha,
            size: 20,
            type: 'blob',
          })),
        )
      }

      if (url.endsWith('/graphql')) {
        return jsonResponse({ data: { repository: {} } })
      }

      throw new Error(`Unexpected request: ${url}`)
    })

    const fields = paths
      .map(
        (path, index) => `
          content_${index}: object(oid: "${blobSha}") {
            ... on Blob { text }
          }
          commit_${index}: ref(qualifiedName: "main") {
            target {
              ... on Commit {
                history(first: 1, path: "${path}") {
                  nodes {
                    author {
                      name
                      email
                      user {
                        id: databaseId
                        login
                      }
                    }
                    committedDate
                  }
                }
              }
            }
          }
        `,
      )
      .join('')
    const response = await onRequestPost({
      request: graphqlQueryRequest(`
        query {
          repository(owner: "acecore-systems", name: "aceserver-wiki") {
            ${fields}
          }
        }
      `),
      env: testEnv('direct'),
    } as Parameters<typeof onRequestPost>[0])

    expect(response.status).toBe(200)
  })

  it('binds each content alias to the matching CMS path and blob SHA', async () => {
    const firstSha = 'e'.repeat(40)
    const secondSha = 'f'.repeat(40)
    const firstPath = 'poc/astro-sveltia/src/content/wiki/first.md'
    const secondPath = 'poc/astro-sveltia/src/content/wiki/second.md'
    const calls: string[] = []

    mockFetch(async (url) => {
      calls.push(url)

      if (url.includes('/git/trees/main?recursive=1')) {
        return projectionTreeResponse([
          {
            mode: '100644',
            path: firstPath,
            sha: firstSha,
            size: 20,
            type: 'blob',
          },
          {
            mode: '100644',
            path: secondPath,
            sha: secondSha,
            size: 20,
            type: 'blob',
          },
        ])
      }

      throw new Error(`Unexpected request: ${url}`)
    })

    const response = await onRequestPost({
      request: graphqlQueryRequest(`
        query {
          repository(owner: "acecore-systems", name: "aceserver-wiki") {
            content_0: object(oid: "${secondSha}") {
              ... on Blob { text }
            }
            commit_0: ref(qualifiedName: "main") {
              target {
                ... on Commit {
                  history(first: 1, path: "${firstPath}") {
                    nodes {
                      author {
                        name
                        email
                        user {
                          id: databaseId
                          login
                        }
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

    expect(response.status).toBe(403)
    expect(calls.some((url) => url.endsWith('/graphql'))).toBe(false)
  })

  it('allows file history up to 100 entries only for an allowed CMS path', async () => {
    mockFetch(async (url) => {
      if (url.endsWith('/graphql')) {
        return jsonResponse({
          data: {
            repository: {
              history_0: {
                target: {
                  history: {
                    nodes: [
                      {
                        oid: 'b'.repeat(40),
                        committedDate: '2026-07-27T00:00:00Z',
                        author: {
                          name: 'Private repository author',
                          email: 'private-author@example.test',
                          avatarUrl:
                            'https://avatars.example.test/private-user',
                          user: {
                            databaseId: 987654321,
                            login: 'private-login',
                          },
                          privateMetadata: 'must-not-pass',
                        },
                        privateMetadata: 'must-not-pass',
                      },
                    ],
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
            history_0: ref(qualifiedName: "main") {
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
    const body = (await response.json()) as {
      data: {
        repository: {
          history_0: {
            target: {
              history: {
                nodes: unknown[]
              }
            }
          }
        }
      }
    }
    const serialized = JSON.stringify(body)

    expect(response.status).toBe(200)
    expect(body.data.repository.history_0.target.history.nodes).toEqual([
      {
        oid: 'b'.repeat(40),
        committedDate: '2026-07-27T00:00:00Z',
        author: {
          name: 'Anonymous',
          email: '',
          avatarUrl: '',
          user: null,
        },
      },
    ])
    expect(serialized).not.toContain('Private repository author')
    expect(serialized).not.toContain('private-author@example.test')
    expect(serialized).not.toContain('private-login')
    expect(serialized).not.toContain('987654321')
    expect(serialized).not.toContain('must-not-pass')
  })

  it('redacts the pathless HEAD message while preserving its oid', async () => {
    mockFetch(async (url) => {
      if (url.endsWith('/graphql')) {
        return jsonResponse({
          data: {
            repository: {
              ref: {
                target: {
                  history: {
                    nodes: [
                      {
                        oid: 'c'.repeat(40),
                        message:
                          'Private release plan and internal incident details',
                      },
                    ],
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
      request: graphqlQueryRequest(headHistoryQuery()),
      env: testEnv('direct'),
    } as Parameters<typeof onRequestPost>[0])
    const body = (await response.json()) as {
      data: {
        repository: {
          ref: {
            target: {
              history: {
                nodes: Array<{ message: string; oid: string }>
              }
            }
          }
        }
      }
    }
    const node = body.data.repository.ref.target.history.nodes[0]

    expect(response.status).toBe(200)
    expect(node).toEqual({
      oid: 'c'.repeat(40),
      message: '',
    })
    expect(JSON.stringify(body)).not.toContain('Private release plan')
  })

  it('rejects a non-Sveltia ref alias that could bypass response sanitization', async () => {
    mockFetch(async (url) => {
      throw new Error(`Unexpected request: ${url}`)
    })

    const response = await onRequestPost({
      request: graphqlQueryRequest(`
        query {
          repository(owner: "acecore-systems", name: "aceserver-wiki") {
            secret: ref(qualifiedName: "main") {
              target {
                ... on Commit {
                  history(first: 1) {
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

  it('rejects duplicate node fields that omit a required stock field', async () => {
    mockFetch(async (url) => {
      throw new Error(`Unexpected request: ${url}`)
    })

    const response = await onRequestPost({
      request: graphqlQueryRequest(`
        query {
          repository(owner: "acecore-systems", name: "aceserver-wiki") {
            history_0: ref(qualifiedName: "main") {
              target {
                ... on Commit {
                  history(
                    first: 100
                    path: "poc/astro-sveltia/src/content/wiki/test.md"
                  ) {
                    nodes {
                      oid
                      oid
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

    expect(response.status).toBe(403)
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
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input)

      if (url === `${ACCESS_ISSUER}/cdn-cgi/access/certs`) {
        return jsonResponse({ keys: [accessJwk] })
      }

      if (url.startsWith('https://api.github.com/')) {
        expect(init.cache).toBe('no-store')
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

  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function mockSuccessfulDirectPublication(
  marker: string,
  projectionTree: Parameters<typeof projectionTreeResponse>[0] = [],
) {
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

    if (isProjectionTreeUrl(url)) {
      return projectionTreeResponse(projectionTree)
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

function mockProjectionOnly(
  tree: Parameters<typeof projectionTreeResponse>[0],
) {
  const calls: string[] = []

  mockFetch(async (url) => {
    calls.push(url)

    if (url.endsWith('/git/ref/heads/main')) {
      return jsonResponse({ object: { sha: MAIN_SHA } })
    }

    if (isProjectionTreeUrl(url)) {
      return projectionTreeResponse(tree)
    }

    throw new Error(`Unexpected request: ${url}`)
  })

  return calls
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

    if (isProjectionTreeUrl(url)) return projectionTreeResponse()

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
    mutationBytes: 1,
    paths: ['poc/astro-sveltia/src/content/wiki/test.md'],
    request: new Request('https://wiki-admin.example.test/admin/api/graphql'),
  }
}

function testEnv(
  publicationMode: 'direct' | 'review',
  overrides: Partial<CmsRuntimeEnv> = {},
) {
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
    ...overrides,
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

function graphqlRawRequest(
  body: string,
  { contentLength }: { contentLength?: number } = {},
) {
  const headers = new Headers({
    'Cf-Access-Jwt-Assertion': validAccessJwt,
    'Content-Type': 'application/json',
    Origin: 'https://wiki-admin.example.test',
    'Sec-Fetch-Site': 'same-origin',
  })

  if (contentLength !== undefined) {
    headers.set('Content-Length', String(contentLength))
  }

  return new Request('https://wiki-admin.example.test/admin/api/graphql', {
    method: 'POST',
    headers,
    body,
  })
}

function graphqlQueryRequest(
  query: string,
  variables: Record<string, unknown> = {},
  accessJwt = validAccessJwt,
) {
  return new Request('https://wiki-admin.example.test/admin/api/graphql', {
    method: 'POST',
    headers: {
      'Cf-Access-Jwt-Assertion': accessJwt,
      'Content-Type': 'application/json',
      Origin: 'https://wiki-admin.example.test',
      'Sec-Fetch-Site': 'same-origin',
    },
    body: JSON.stringify({ query, variables }),
  })
}

function githubProxyRequest(
  path: string,
  { fetchSite = 'same-origin' }: { fetchSite?: string } = {},
) {
  const headers = new Headers({
    'Cf-Access-Jwt-Assertion': validAccessJwt,
  })

  if (fetchSite) headers.set('Sec-Fetch-Site', fetchSite)

  return new Request(
    `https://wiki-admin.example.test/admin/api/github/api/v3/${path}`,
    {
      headers,
    },
  )
}

function headHistoryQuery() {
  return `
    query {
      repository(owner: "acecore-systems", name: "aceserver-wiki") {
        ref(qualifiedName: "main") {
          target {
            ... on Commit {
              history(first: 1) {
                nodes { oid message }
              }
            }
          }
        }
      }
    }
  `
}

function deletionVariables(expectedHeadOid: string, path: string) {
  return {
    input: {
      branch: {
        repositoryNameWithOwner: 'acecore-systems/aceserver-wiki',
        branchName: 'main',
      },
      expectedHeadOid,
      fileChanges: {
        additions: [],
        deletions: [{ path }],
      },
      message: { headline: 'Delete over-cap content' },
    },
  }
}

function mediaCommitVariables(expectedHeadOid: string) {
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
            path: 'poc/astro-sveltia/public/uploads/wiki/new.png',
            contents: encodeBytes(createPng(1, 1)),
          },
        ],
        deletions: [],
      },
      message: { headline: 'Add projected over-cap media' },
    },
  }
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

function pkcs8ToPkcs1Pem(pkcs8Pem: string) {
  const body = pkcs8Pem
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\s+/gu, '')
  const bytes = Uint8Array.from(atob(body), (value) => value.charCodeAt(0))
  const outer = readTestDerElement(bytes, 0, 0x30)
  const version = readTestDerElement(bytes, outer.contentOffset, 0x02)
  const algorithm = readTestDerElement(bytes, version.endOffset, 0x30)
  const privateKey = readTestDerElement(bytes, algorithm.endOffset, 0x04)

  if (
    outer.endOffset !== bytes.byteLength ||
    privateKey.endOffset !== outer.endOffset
  ) {
    throw new Error('Test PKCS#8 private key has an unexpected structure')
  }

  const pkcs1 = bytes.slice(privateKey.contentOffset, privateKey.endOffset)
  const encoded = btoa(String.fromCharCode(...pkcs1))
    .match(/.{1,64}/gu)
    ?.join('\n')

  if (!encoded) throw new Error('Could not encode test PKCS#1 key')

  return `-----BEGIN RSA PRIVATE KEY-----\n${encoded}\n-----END RSA PRIVATE KEY-----`
}

function readTestDerElement(
  bytes: Uint8Array,
  offset: number,
  expectedTag: number,
) {
  if (bytes[offset] !== expectedTag) {
    throw new Error('Test private key has an unexpected DER tag')
  }

  const firstLength = bytes[offset + 1]

  if (firstLength === undefined) {
    throw new Error('Test private key has no DER length')
  }

  let contentLength = 0
  let contentOffset = offset + 2

  if (firstLength < 0x80) {
    contentLength = firstLength
  } else {
    const octetCount = firstLength & 0x7f

    if (octetCount === 0 || octetCount > 4) {
      throw new Error('Test private key has an invalid DER length')
    }

    contentOffset += octetCount

    for (let index = offset + 2; index < contentOffset; index += 1) {
      contentLength = contentLength * 256 + (bytes[index] ?? 0)
    }
  }

  const endOffset = contentOffset + contentLength

  if (endOffset > bytes.byteLength) {
    throw new Error('Test private key DER length exceeds its input')
  }

  return {
    contentOffset,
    endOffset,
  }
}

function signAccessJwt(
  type = 'app',
  custom: Record<string, string> = { discord_id: DISCORD_ID },
) {
  return new SignJWT({
    type,
    custom,
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

function contentTree(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    mode: '100644',
    path: `poc/astro-sveltia/src/content/wiki/entry-${index}.md`,
    sha: index.toString(16).padStart(40, '0'),
    size: 1,
    type: 'blob' as const,
  }))
}

function isProjectionTreeUrl(url: string) {
  return url.includes(`/git/trees/${MAIN_SHA}?recursive=1`)
}

function projectionTreeResponse(
  tree: Array<{
    mode: string
    path: string
    sha: string
    size?: number
    type: 'blob' | 'tree'
  }> = [],
) {
  return jsonResponse({
    sha: MAIN_SHA,
    tree,
    truncated: false,
  })
}

function encodeUtf8(value: string) {
  return encodeBytes(new TextEncoder().encode(value))
}

function encodeBytes(bytes: Uint8Array) {
  let binary = ''

  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }

  return btoa(binary)
}

function createPng(width: number, height: number) {
  return new Uint8Array([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    0x00,
    0x00,
    0x00,
    0x0d,
    0x49,
    0x48,
    0x44,
    0x52,
    (width >>> 24) & 0xff,
    (width >>> 16) & 0xff,
    (width >>> 8) & 0xff,
    width & 0xff,
    (height >>> 24) & 0xff,
    (height >>> 16) & 0xff,
    (height >>> 8) & 0xff,
    height & 0xff,
    0x08,
    0x02,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x49,
    0x45,
    0x4e,
    0x44,
    0x00,
    0x00,
    0x00,
    0x00,
  ])
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
