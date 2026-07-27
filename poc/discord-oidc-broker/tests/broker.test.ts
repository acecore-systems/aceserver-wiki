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
  vi.restoreAllMocks()
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
  failureAt?: 'identity' | 'revoke' | 'token'
  revokeStatus?: number
  tokenStatus?: number
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
      if (options?.failureAt === 'token') {
        throw new Error('sensitive-provider-failure')
      }
      if (options?.tokenStatus !== undefined) {
        return Response.json(
          { error: 'sensitive-provider-response' },
          { status: options.tokenStatus },
        )
      }
      return Response.json({
        access_token: 'discord-access-token-for-tests',
        expires_in: 3600,
        scope: options?.tokenScope ?? 'identify email',
        token_type: 'Bearer',
      })
    }
    if (url === 'https://discord.com/api/v10/users/@me') {
      if (options?.failureAt === 'identity') {
        throw new Error('sensitive-provider-failure')
      }
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
      if (options?.failureAt === 'revoke') {
        throw new Error('sensitive-provider-failure')
      }
      return new Response(null, { status: options?.revokeStatus ?? 200 })
    }
    throw new Error('unexpected provider URL')
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

async function completeAuthorization(
  overrides: Record<string, string> = {},
): Promise<string> {
  const { discordState } = await beginAuthorization(overrides)
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
      scopes_supported: ['openid', 'email', 'profile'],
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

  it('accepts Cloudflare profile scope without widening Discord permissions', async () => {
    const { response } = await beginAuthorization({
      scope: 'openid email profile',
    })
    const location = new URL(response.headers.get('Location') ?? '')

    expect(response.status).toBe(303)
    expect(location.origin + location.pathname).toBe(
      'https://discord.com/oauth2/authorize',
    )
    expect(location.searchParams.get('scope')).toBe('identify email')
  })

  it('rejects unknown scopes and requests missing email', async () => {
    for (const scope of ['openid email groups', 'openid profile']) {
      const { response } = await beginAuthorization({ scope })
      const location = new URL(response.headers.get('Location') ?? '')

      expect(response.status).toBe(303)
      expect(location.origin + location.pathname).toBe(ACCESS_CALLBACK)
      expect(location.searchParams.get('error')).toBe('invalid_scope')
    }

    const stateRows = await env.OIDC_STATE_DB.prepare(
      'SELECT COUNT(*) AS count FROM oidc_authorization_requests',
    ).first<{ count: number }>()
    expect(stateRows?.count).toBe(0)
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

  it('echoes profile scope without minting additional profile claims', async () => {
    const code = await completeAuthorization({
      scope: 'openid email profile',
    })
    vi.unstubAllGlobals()

    const response = await SELF.fetch(tokenRequest(code))
    const body = await response.json<{ id_token: string; scope: string }>()
    const claims = decodeJwtPayload(body.id_token)

    expect(response.status).toBe(200)
    expect(body.scope).toBe('openid email profile')
    for (const profileClaim of [
      'name',
      'preferred_username',
      'picture',
      'profile',
    ]) {
      expect(claims).not.toHaveProperty(profileClaim)
    }
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

  it('logs a stable rejection code without logging token request values', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const body = new URLSearchParams({
      code: 'sensitive-authorization-code'.padEnd(43, 'x'),
      code_verifier: VERIFIER,
      grant_type: 'authorization_code',
    })

    try {
      const response = await SELF.fetch(`${ISSUER}/token`, {
        body,
        headers: {
          Authorization: `Basic ${btoa(
            `${ACCESS_CLIENT_ID}:${ACCESS_CLIENT_SECRET}`,
          )}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        method: 'POST',
      })

      expect(response.status).toBe(400)
      expect(warn).toHaveBeenCalledExactlyOnceWith(
        JSON.stringify({
          error: 'token_redirect_uri_missing',
          event: 'oidc_token_request_rejected',
        }),
      )
      expect(warn.mock.calls.flat().join(' ')).not.toContain(
        'sensitive-authorization-code',
      )
    } finally {
      warn.mockRestore()
    }
  })

  it('classifies malformed authorization codes without logging them', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const cases = [
      {
        code: '',
        expected: 'token_code_empty',
      },
      {
        code: 'short-sensitive-code',
        expected: 'token_code_too_short',
      },
      {
        code: 'long-sensitive-code'.padEnd(257, 'x'),
        expected: 'token_code_too_long',
      },
      {
        code: `${'character-sensitive-code'.padEnd(42, 'x')}\n`,
        expected: 'token_code_characters_invalid',
      },
    ]

    try {
      for (const testCase of cases) {
        const response = await SELF.fetch(tokenRequest(testCase.code, VERIFIER))
        expect(response.status).toBe(400)
      }

      expect(
        warn.mock.calls.map(([message]) => JSON.parse(message).error),
      ).toEqual(cases.map(({ expected }) => expected))
      expect(warn.mock.calls.flat().join(' ')).not.toContain('sensitive-code')
    } finally {
      warn.mockRestore()
    }
  })

  it('rejects an unverified Discord email and still revokes the token', async () => {
    const errorLog = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined)
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
    expect(errorLog).toHaveBeenCalledWith(
      JSON.stringify({
        error: 'discord_identity_invalid',
        event: 'oidc_callback_failed',
      }),
    )
  })

  it('revokes an issued Discord token when token metadata is invalid', async () => {
    const errorLog = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined)
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
    expect(errorLog).toHaveBeenCalledWith(
      JSON.stringify({
        error: 'discord_token_metadata_invalid',
        event: 'oidc_callback_failed',
      }),
    )
  })

  it('fails closed when Discord token revocation fails', async () => {
    const errorLog = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined)
    const { discordState } = await beginAuthorization()
    installDiscordFetchMock({ revokeStatus: 503 })
    const response = await SELF.fetch(
      `${ISSUER}/callback?code=discord-code&state=${discordState}`,
      { redirect: 'manual' },
    )
    const location = new URL(response.headers.get('Location') ?? '')
    expect(location.searchParams.get('error')).toBe('server_error')
    expect(errorLog).toHaveBeenCalledWith(
      JSON.stringify({
        error: 'discord_token_revocation_failed',
        event: 'oidc_callback_failed',
      }),
    )
  })

  it.each([
    ['token', 'discord_token_request_failed'],
    ['identity', 'discord_identity_invalid'],
    ['revoke', 'discord_token_revocation_failed'],
  ] as const)(
    'normalizes a %s provider failure before logging it',
    async (failureAt, expected) => {
      const errorLog = vi
        .spyOn(console, 'error')
        .mockImplementation(() => undefined)
      const { discordState } = await beginAuthorization()
      installDiscordFetchMock({ failureAt })
      const response = await SELF.fetch(
        `${ISSUER}/callback?code=discord-code&state=${discordState}`,
        { redirect: 'manual' },
      )
      const location = new URL(response.headers.get('Location') ?? '')

      expect(location.searchParams.get('error')).toBe('server_error')
      expect(errorLog).toHaveBeenCalledWith(
        JSON.stringify({
          error: expected,
          event: 'oidc_callback_failed',
        }),
      )
      expect(errorLog.mock.calls.flat().join(' ')).not.toContain(
        'sensitive-provider-failure',
      )
    },
  )

  it.each([
    [400, 'discord_token_http_400'],
    [401, 'discord_token_http_401'],
    [403, 'discord_token_http_403'],
    [429, 'discord_token_http_429'],
    [503, 'discord_token_http_5xx'],
    [418, 'discord_token_http_unexpected'],
  ] as const)(
    'classifies a Discord token HTTP %s without logging its body',
    async (tokenStatus, expected) => {
      const errorLog = vi
        .spyOn(console, 'error')
        .mockImplementation(() => undefined)
      const { discordState } = await beginAuthorization()
      installDiscordFetchMock({ tokenStatus })
      const response = await SELF.fetch(
        `${ISSUER}/callback?code=discord-code&state=${discordState}`,
        { redirect: 'manual' },
      )
      const location = new URL(response.headers.get('Location') ?? '')

      expect(location.searchParams.get('error')).toBe('server_error')
      expect(errorLog).toHaveBeenCalledWith(
        JSON.stringify({
          error: expected,
          event: 'oidc_callback_failed',
        }),
      )
      expect(errorLog.mock.calls.flat().join(' ')).not.toContain(
        'sensitive-provider-response',
      )
    },
  )

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
