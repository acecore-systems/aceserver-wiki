import { applyD1Migrations, env, SELF } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { pkceChallenge } from '../src/crypto.ts'
import { cleanupExpiredState, enforceRateLimit } from '../src/store.ts'

const ISSUER = 'https://oidc.example.test'
const ACCESS_CALLBACK =
  'https://acecore.cloudflareaccess.com/cdn-cgi/access/callback'
const ACCESS_CLIENT_ID = 'cloudflare-access-test-client'
const ACCESS_CLIENT_SECRET = 'test-cloudflare-access-secret'
const DISCORD_ID = '987654321098765432'
const VERIFIER = 'v'.repeat(64)

beforeEach(async () => {
  await applyD1Migrations(env.OIDC_STATE_DB, env.TEST_D1_MIGRATIONS)
  await env.OIDC_STATE_DB.batch([
    env.OIDC_STATE_DB.prepare('DELETE FROM oidc_authorization_requests'),
    env.OIDC_STATE_DB.prepare('DELETE FROM oidc_authorization_codes'),
    env.OIDC_STATE_DB.prepare('DELETE FROM oidc_rate_limits'),
  ])
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function validAuthorizeParameters(): URLSearchParams {
  return new URLSearchParams({
    client_id: ACCESS_CLIENT_ID,
    code_challenge: '',
    code_challenge_method: 'S256',
    nonce: 'nonce-12345678901234567890',
    redirect_uri: ACCESS_CALLBACK,
    response_type: 'code',
    scope: 'openid email',
    state: 'access-state-12345678901234567890',
  })
}

async function beginAuthorization(
  overrides: Record<string, string> = {},
): Promise<{ discordState: string; response: Response }> {
  const parameters = validAuthorizeParameters()
  parameters.set('code_challenge', await pkceChallenge(VERIFIER))
  for (const [name, value] of Object.entries(overrides)) {
    parameters.set(name, value)
  }
  const response = await SELF.fetch(
    `${ISSUER}/authorize?${parameters.toString()}`,
    { redirect: 'manual' },
  )
  const locationValue = response.headers.get('Location')
  const location = locationValue === null ? null : new URL(locationValue)
  return {
    discordState: location?.searchParams.get('state') ?? '',
    response,
  }
}

function installDiscordFetchMock(options?: {
  emailVerified?: boolean
  revokeStatus?: number
  tokenScope?: string
}): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url =
      input instanceof Request
        ? input.url
        : input instanceof URL
          ? input.toString()
          : input
    if (url === 'https://discord.com/api/v10/oauth2/token') {
      return Response.json({
        access_token: 'discord-access-token-for-tests',
        expires_in: 3600,
        scope: options?.tokenScope ?? 'identify email',
        token_type: 'Bearer',
      })
    }
    if (url === 'https://discord.com/api/v10/users/@me') {
      return Response.json({
        avatar: 'avatar_hash',
        email: 'editor@example.test',
        global_name: 'Editor',
        id: DISCORD_ID,
        username: 'editor',
        verified: options?.emailVerified ?? true,
      })
    }
    if (url === 'https://discord.com/api/v10/oauth2/token/revoke') {
      return new Response(null, { status: options?.revokeStatus ?? 200 })
    }
    throw new Error('unexpected provider URL')
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

async function completeAuthorization(): Promise<string> {
  const { discordState } = await beginAuthorization()
  installDiscordFetchMock()
  const response = await SELF.fetch(
    `${ISSUER}/callback?code=discord-code&state=${discordState}`,
    { redirect: 'manual' },
  )
  expect(response.status).toBe(303)
  const location = new URL(response.headers.get('Location') ?? '')
  expect(location.origin + location.pathname).toBe(ACCESS_CALLBACK)
  expect(location.searchParams.get('state')).toBe(
    'access-state-12345678901234567890',
  )
  return location.searchParams.get('code') ?? ''
}

function tokenRequest(
  code: string,
  verifier = VERIFIER,
  authorization = `Basic ${btoa(
    `${ACCESS_CLIENT_ID}:${ACCESS_CLIENT_SECRET}`,
  )}`,
): Request {
  return new Request(`${ISSUER}/token`, {
    body: new URLSearchParams({
      code,
      code_verifier: verifier,
      grant_type: 'authorization_code',
      redirect_uri: ACCESS_CALLBACK,
    }),
    headers: {
      Authorization: authorization,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    method: 'POST',
  })
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const payload = token.split('.')[1] ?? ''
  const padded = payload.replaceAll('-', '+').replaceAll('_', '/')
  const json = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='))
  const parsed: unknown = JSON.parse(json)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('invalid token payload')
  }
  return parsed as Record<string, unknown>
}

function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/')
  const binary = atob(
    normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='),
  )
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

function isJsonWebKey(value: unknown): value is JsonWebKey {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    'kty' in value &&
    typeof value.kty === 'string'
  )
}

async function verifyJwtSignature(token: string): Promise<boolean> {
  const [header, payload, signature] = token.split('.')
  if (!header || !payload || !signature) {
    return false
  }
  const parsed: unknown = JSON.parse(env.OIDC_SIGNING_PUBLIC_JWK_JSON)
  if (!isJsonWebKey(parsed)) {
    return false
  }
  const publicKey = await crypto.subtle.importKey(
    'jwk',
    parsed,
    { hash: 'SHA-256', name: 'RSASSA-PKCS1-v1_5' },
    false,
    ['verify'],
  )
  return crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    publicKey,
    decodeBase64Url(signature),
    new TextEncoder().encode(`${header}.${payload}`),
  )
}

describe('OIDC metadata', () => {
  it('publishes only the implemented code flow and S256 methods', async () => {
    const response = await SELF.fetch(
      `${ISSUER}/.well-known/openid-configuration`,
    )
    const body = await response.json<Record<string, unknown>>()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({
      code_challenge_methods_supported: ['S256'],
      grant_types_supported: ['authorization_code'],
      issuer: ISSUER,
      response_modes_supported: ['query'],
      response_types_supported: ['code'],
      token_endpoint_auth_methods_supported: [
        'client_secret_basic',
        'client_secret_post',
      ],
    })
    expect(body).not.toHaveProperty('userinfo_endpoint')
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull()
  })

  it('publishes a public-only RS256 JWKS', async () => {
    const response = await SELF.fetch(`${ISSUER}/jwks.json`)
    const body = await response.json<{ keys: Array<Record<string, unknown>> }>()
    const [key] = body.keys

    expect(key).toMatchObject({
      alg: 'RS256',
      kid: 'test-signing-key',
      kty: 'RSA',
      use: 'sig',
    })
    for (const privateField of ['d', 'p', 'q', 'dp', 'dq', 'qi']) {
      expect(key).not.toHaveProperty(privateField)
    }
  })
})

describe('authorization endpoint', () => {
  it('accepts GET and separates the upstream Discord state', async () => {
    const { discordState, response } = await beginAuthorization()
    const location = new URL(response.headers.get('Location') ?? '')

    expect(response.status).toBe(303)
    expect(location.origin + location.pathname).toBe(
      'https://discord.com/oauth2/authorize',
    )
    expect(location.searchParams.get('redirect_uri')).toBe(`${ISSUER}/callback`)
    expect(location.searchParams.get('scope')).toBe('identify email')
    expect(discordState).toMatch(/^[A-Za-z0-9_-]{43}$/u)
    expect(discordState).not.toBe('access-state-12345678901234567890')
  })

  it('accepts a form-encoded POST authorization request', async () => {
    const parameters = validAuthorizeParameters()
    parameters.set('code_challenge', await pkceChallenge(VERIFIER))
    const response = await SELF.fetch(`${ISSUER}/authorize`, {
      body: parameters,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      method: 'POST',
      redirect: 'manual',
    })
    expect(response.status).toBe(303)
    expect(response.headers.get('Location')).toMatch(
      /^https:\/\/discord\.com\/oauth2\/authorize\?/u,
    )
  })

  it('rejects an alternate origin even when the path is valid', async () => {
    const response = await SELF.fetch(
      'https://alternate.example.test/.well-known/openid-configuration',
    )
    expect(response.status).toBe(421)
  })

  it('never redirects an invalid redirect_uri', async () => {
    const { response } = await beginAuthorization({
      redirect_uri: 'https://attacker.example/callback',
    })
    expect(response.status).toBe(400)
    expect(response.headers.get('Location')).toBeNull()
  })

  it('redirects trusted prompt=none requests with login_required', async () => {
    const { response } = await beginAuthorization({ prompt: 'none' })
    const location = new URL(response.headers.get('Location') ?? '')
    expect(location.origin + location.pathname).toBe(ACCESS_CALLBACK)
    expect(location.searchParams.get('error')).toBe('login_required')
    expect(location.searchParams.get('state')).toBe(
      'access-state-12345678901234567890',
    )
  })

  it('rejects unsupported interactive prompt semantics', async () => {
    const { response } = await beginAuthorization({ prompt: 'login' })
    const location = new URL(response.headers.get('Location') ?? '')
    expect(location.origin + location.pathname).toBe(ACCESS_CALLBACK)
    expect(location.searchParams.get('error')).toBe('invalid_request')
  })

  it('keeps unsupported response_mode errors local', async () => {
    const { response } = await beginAuthorization({ response_mode: 'fragment' })
    expect(response.status).toBe(400)
    expect(response.headers.get('Location')).toBeNull()
  })

  it('rejects duplicate parameters at the trusted callback', async () => {
    const parameters = validAuthorizeParameters()
    parameters.set('code_challenge', await pkceChallenge(VERIFIER))
    const response = await SELF.fetch(
      `${ISSUER}/authorize?${parameters.toString()}&scope=openid`,
      { redirect: 'manual' },
    )
    expect(response.status).toBe(400)
    expect(response.headers.get('Location')).toBeNull()
  })
})

describe('Discord callback and token endpoint', () => {
  it('mints a signed one-time ID token with the Discord snowflake', async () => {
    const code = await completeAuthorization()
    vi.unstubAllGlobals()

    const response = await SELF.fetch(tokenRequest(code))
    const body = await response.json<{ id_token: string }>()
    const claims = decodeJwtPayload(body.id_token)

    expect(response.status).toBe(200)
    expect(claims).toMatchObject({
      aud: ACCESS_CLIENT_ID,
      discord_id: DISCORD_ID,
      email: 'editor@example.test',
      email_verified: true,
      iss: ISSUER,
      nonce: 'nonce-12345678901234567890',
      sub: DISCORD_ID,
    })
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull()
    await expect(verifyJwtSignature(body.id_token)).resolves.toBe(true)

    const replay = await SELF.fetch(tokenRequest(code))
    expect(replay.status).toBe(400)
    await expect(replay.json()).resolves.toMatchObject({
      error: 'invalid_grant',
    })
  })

  it('allows exactly one concurrent exchange of a broker code', async () => {
    const code = await completeAuthorization()
    vi.unstubAllGlobals()

    const responses = await Promise.all([
      SELF.fetch(tokenRequest(code)),
      SELF.fetch(tokenRequest(code)),
    ])
    expect(responses.map(({ status }) => status).sort()).toEqual([200, 400])
  })

  it('does not consume a code when the PKCE verifier is wrong', async () => {
    const code = await completeAuthorization()
    vi.unstubAllGlobals()

    const wrong = await SELF.fetch(tokenRequest(code, 'x'.repeat(64)))
    expect(wrong.status).toBe(400)

    const valid = await SELF.fetch(tokenRequest(code))
    expect(valid.status).toBe(200)
  })

  it('supports client_secret_post without accepting mixed auth methods', async () => {
    const code = await completeAuthorization()
    vi.unstubAllGlobals()
    const body = new URLSearchParams({
      client_id: ACCESS_CLIENT_ID,
      client_secret: ACCESS_CLIENT_SECRET,
      code,
      code_verifier: VERIFIER,
      grant_type: 'authorization_code',
      redirect_uri: ACCESS_CALLBACK,
    })
    const valid = await SELF.fetch(`${ISSUER}/token`, {
      body,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      method: 'POST',
    })
    expect(valid.status).toBe(200)

    const secondCode = await completeAuthorization()
    vi.unstubAllGlobals()
    const mixedBody = new URLSearchParams({
      client_secret: ACCESS_CLIENT_SECRET,
      code: secondCode,
      code_verifier: VERIFIER,
      grant_type: 'authorization_code',
      redirect_uri: ACCESS_CALLBACK,
    })
    const mixed = await SELF.fetch(`${ISSUER}/token`, {
      body: mixedBody,
      headers: {
        Authorization: `Basic ${btoa(
          `${ACCESS_CLIENT_ID}:${ACCESS_CLIENT_SECRET}`,
        )}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      method: 'POST',
    })
    expect(mixed.status).toBe(401)
  })

  it('returns a Basic challenge for invalid client authentication', async () => {
    const response = await SELF.fetch(
      tokenRequest(
        'c'.repeat(43),
        VERIFIER,
        `Basic ${btoa(`${ACCESS_CLIENT_ID}:wrong-secret-value`)}`,
      ),
    )
    expect(response.status).toBe(401)
    expect(response.headers.get('WWW-Authenticate')).toBe(
      'Basic realm="oidc-token"',
    )
  })

  it('rejects an unverified Discord email and still revokes the token', async () => {
    const { discordState } = await beginAuthorization()
    const fetchMock = installDiscordFetchMock({ emailVerified: false })
    const response = await SELF.fetch(
      `${ISSUER}/callback?code=discord-code&state=${discordState}`,
      { redirect: 'manual' },
    )
    const location = new URL(response.headers.get('Location') ?? '')

    expect(location.searchParams.get('error')).toBe('server_error')
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).includes('/oauth2/token/revoke'),
      ),
    ).toBe(true)
  })

  it('revokes an issued Discord token when token metadata is invalid', async () => {
    const { discordState } = await beginAuthorization()
    const fetchMock = installDiscordFetchMock({ tokenScope: 'identify' })
    const response = await SELF.fetch(
      `${ISSUER}/callback?code=discord-code&state=${discordState}`,
      { redirect: 'manual' },
    )
    const location = new URL(response.headers.get('Location') ?? '')

    expect(location.searchParams.get('error')).toBe('server_error')
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).includes('/oauth2/token/revoke'),
      ),
    ).toBe(true)
  })

  it('fails closed when Discord token revocation fails', async () => {
    const { discordState } = await beginAuthorization()
    installDiscordFetchMock({ revokeStatus: 503 })
    const response = await SELF.fetch(
      `${ISSUER}/callback?code=discord-code&state=${discordState}`,
      { redirect: 'manual' },
    )
    const location = new URL(response.headers.get('Location') ?? '')
    expect(location.searchParams.get('error')).toBe('server_error')
  })

  it('requires form encoding and does not expose CORS', async () => {
    const response = await SELF.fetch(`${ISSUER}/token`, {
      body: '{}',
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    })
    expect(response.status).toBe(400)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull()

    const preflight = await SELF.fetch(`${ISSUER}/token`, {
      method: 'OPTIONS',
    })
    expect(preflight.status).toBe(405)
    expect(preflight.headers.get('Access-Control-Allow-Origin')).toBeNull()
  })
})

describe('state retention', () => {
  it('physically removes expired state and identity rows', async () => {
    await env.OIDC_STATE_DB.prepare(
      `INSERT INTO oidc_authorization_codes
         (code_hash, access_redirect_uri, nonce, scope, pkce_challenge,
          discord_id, email, authenticated_at, created_at, expires_at)
       VALUES (?1, ?2, NULL, 'openid email', ?3, ?4, ?5, 1, 1, 2)`,
    )
      .bind(
        'a'.repeat(64),
        ACCESS_CALLBACK,
        await pkceChallenge(VERIFIER),
        DISCORD_ID,
        'expired@example.test',
      )
      .run()

    await cleanupExpiredState(env, 3)

    await expect(
      env.OIDC_STATE_DB.prepare(
        'SELECT email FROM oidc_authorization_codes WHERE code_hash = ?1',
      )
        .bind('a'.repeat(64))
        .first(),
    ).resolves.toBeNull()
  })
})

describe('rate limiting', () => {
  it('uses a keyed IP bucket and leaves expired-row cleanup to the cron path', async () => {
    const now = 1_200
    const address = '203.0.113.8'
    const expiredBucket = 'f'.repeat(64)
    const expiredCode = 'b'.repeat(64)

    await env.OIDC_STATE_DB.batch([
      env.OIDC_STATE_DB.prepare(
        `INSERT INTO oidc_rate_limits
           (bucket_hash, window_start, request_count, expires_at)
         VALUES (?1, 0, 1, 1)`,
      ).bind(expiredBucket),
      env.OIDC_STATE_DB.prepare(
        `INSERT INTO oidc_authorization_codes
           (code_hash, access_redirect_uri, nonce, scope, pkce_challenge,
            discord_id, email, authenticated_at, created_at, expires_at)
         VALUES (?1, ?2, NULL, 'openid email', ?3, ?4, ?5, 1, 1, 2)`,
      ).bind(
        expiredCode,
        ACCESS_CALLBACK,
        await pkceChallenge(VERIFIER),
        DISCORD_ID,
        'expired@example.test',
      ),
    ])

    const allowed = await enforceRateLimit(
      new Request(`${ISSUER}/authorize`, {
        headers: { 'CF-Connecting-IP': address },
      }),
      env,
      'authorize',
      30,
      now,
    )

    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(ACCESS_CLIENT_SECRET),
      { hash: 'SHA-256', name: 'HMAC' },
      false,
      ['sign'],
    )
    const signature = new Uint8Array(
      await crypto.subtle.sign(
        'HMAC',
        key,
        new TextEncoder().encode(`authorize\u0000${address}`),
      ),
    )
    const expectedBucket = Array.from(signature, (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('')
    const current = await env.OIDC_STATE_DB.prepare(
      `SELECT bucket_hash, request_count
       FROM oidc_rate_limits
       WHERE window_start = ?1`,
    )
      .bind(now)
      .first<{ bucket_hash: string; request_count: number }>()

    expect(allowed).toBe(true)
    expect(current).toEqual({
      bucket_hash: expectedBucket,
      request_count: 1,
    })
    await expect(
      env.OIDC_STATE_DB.prepare(
        'SELECT bucket_hash FROM oidc_rate_limits WHERE bucket_hash = ?1',
      )
        .bind(expiredBucket)
        .first(),
    ).resolves.toEqual({ bucket_hash: expiredBucket })
    await expect(
      env.OIDC_STATE_DB.prepare(
        'SELECT email FROM oidc_authorization_codes WHERE code_hash = ?1',
      )
        .bind(expiredCode)
        .first(),
    ).resolves.toEqual({ email: 'expired@example.test' })
  })
})
