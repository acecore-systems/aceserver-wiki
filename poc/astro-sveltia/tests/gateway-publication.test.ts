import {
  SignJWT,
  exportJWK,
  exportPKCS8,
  generateKeyPair,
  type JWK,
} from 'jose'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { onRequestPost } from '../functions/admin/api/graphql.ts'
import type { CmsRuntimeEnv } from '../functions/admin/api/_cms-policy.ts'

const MAIN_SHA = 'a'.repeat(40)
const ACCESS_ISSUER = 'https://test-suite.cloudflareaccess.com'
const ACCESS_AUDIENCE = 'test-cms-audience'
const ACCESS_KEY_ID = 'test-access-key'
const DISCORD_ID = '345678901234567890'
const DISCORD_GUILD_ID = '123456789012345678'
const DISCORD_ROLE_ID = '234567890123456789'
const GITHUB_CLIENT_ID = 'Iv1.gateway-test'
const GITHUB_INSTALLATION_ID = '987654'
const INSTALLATION_TOKEN_URL = `https://api.github.com/app/installations/${GITHUB_INSTALLATION_ID}/access_tokens`

let accessPrivateKey: CryptoKey
let accessJwk: JWK
let githubPrivateKeyPem: string
let validAccessJwt: string

beforeAll(async () => {
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
    const calls: Array<{ url: string; method: string; body: unknown }> = []

    mockFetch(async (url, init) => {
      const method = init.method || 'GET'
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : null

      calls.push({ url, method, body })

      if (url.endsWith('/git/ref/heads/main')) {
        return jsonResponse({ object: { sha: MAIN_SHA } })
      }

      if (url.endsWith('/graphql')) {
        const variables = (body as GraphqlRequestBody).variables

        expect(variables.input.branch.branchName).toBe('main')
        expect(variables.input.expectedHeadOid).toBe(MAIN_SHA)

        return commitResponse('c')
      }

      throw new Error(`Unexpected request: ${url}`)
    })

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
    expect(calls.some(({ url }) => url.endsWith('/git/refs'))).toBe(false)
    expect(calls.some(({ url }) => url.endsWith('/pulls'))).toBe(false)
  })

  it('removes the short-lived review branch when PR creation fails', async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = []
    let reviewBranch = ''

    mockFetch(async (url, init) => {
      const method = init.method || 'GET'
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : null

      calls.push({ url, method, body })

      if (url.endsWith('/git/ref/heads/main')) {
        return jsonResponse({ object: { sha: MAIN_SHA } })
      }

      if (url.endsWith('/git/refs') && method === 'POST') {
        reviewBranch = (body as { ref: string }).ref.replace('refs/heads/', '')
        expect(reviewBranch).toMatch(/^cms\/asv\//u)

        return jsonResponse(
          { ref: `refs/heads/${reviewBranch}`, object: { sha: MAIN_SHA } },
          201,
        )
      }

      if (url.endsWith('/graphql')) {
        const variables = (body as GraphqlRequestBody).variables

        expect(variables.input.branch.branchName).toBe(reviewBranch)
        return commitResponse('d')
      }

      if (url.endsWith('/pulls')) {
        return jsonResponse({ message: 'test PR failure' }, 500)
      }

      if (method === 'DELETE' && url.includes('/git/refs/heads/cms/asv/')) {
        return new Response(null, { status: 204 })
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
          method === 'DELETE' && url.includes('/git/refs/heads/cms/asv/'),
      ),
    ).toBe(true)
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

function testEnv(publicationMode: 'direct' | 'review') {
  return {
    CMS_REPOSITORY_OWNER: 'acecore-systems',
    CMS_REPOSITORY_NAME: 'aceserver-wiki',
    CMS_REPOSITORY_BRANCH: 'main',
    CMS_CONTENT_ROOT: 'poc/astro-sveltia/src/content/wiki',
    CMS_MEDIA_ROOT: 'poc/astro-sveltia/public/uploads/wiki',
    CMS_PUBLICATION_MODE: publicationMode,
    CMS_ACCESS_AUD: ACCESS_AUDIENCE,
    CMS_ACCESS_TEAM_DOMAIN: ACCESS_ISSUER,
    CMS_ACCESS_HOSTNAMES: 'wiki-admin.example.test',
    CMS_DISCORD_GUILD_ID: DISCORD_GUILD_ID,
    CMS_DISCORD_AUTHORIZATION_MODE: 'guild',
    CMS_DISCORD_ALLOWED_ROLE_IDS: DISCORD_ROLE_ID,
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
category: PoC
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
      discord_id: DISCORD_ID,
      discord_guild_id: DISCORD_GUILD_ID,
      discord_roles: [DISCORD_ROLE_ID],
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
