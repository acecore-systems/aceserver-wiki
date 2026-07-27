import { hmacSha256Hex, sha256Hex } from './crypto.ts'

const RATE_WINDOW_SECONDS = 10 * 60

export type AuthorizationRequest = {
  access_redirect_uri: string
  access_state: string
  nonce: string | null
  pkce_challenge: string
  scope: string
}

export type AuthorizationCode = {
  access_redirect_uri: string
  authenticated_at: number
  discord_id: string
  email: string
  nonce: string | null
  pkce_challenge: string
  scope: string
}

export async function cleanupExpiredState(
  env: Env,
  now: number,
): Promise<void> {
  const results = await env.OIDC_STATE_DB.batch([
    env.OIDC_STATE_DB.prepare(
      'DELETE FROM oidc_rate_limits WHERE expires_at < ?1',
    ).bind(now),
    env.OIDC_STATE_DB.prepare(
      'DELETE FROM oidc_authorization_requests WHERE expires_at < ?1',
    ).bind(now),
    env.OIDC_STATE_DB.prepare(
      'DELETE FROM oidc_authorization_codes WHERE expires_at < ?1',
    ).bind(now),
  ])
  if (results.some((result) => !result.success)) {
    throw new Error('state_cleanup_failed')
  }
}

export async function enforceRateLimit(
  request: Request,
  env: Env,
  route: string,
  maximumRequests: number,
  now: number,
): Promise<boolean> {
  const address = request.headers.get('CF-Connecting-IP') ?? 'missing'
  const bucketHash = await hmacSha256Hex(
    env.OIDC_ACCESS_CLIENT_SECRET,
    `${route}\u0000${address}`,
  )
  const windowStart =
    Math.floor(now / RATE_WINDOW_SECONDS) * RATE_WINDOW_SECONDS
  const expiresAt = windowStart + RATE_WINDOW_SECONDS * 2

  const result = await env.OIDC_STATE_DB.prepare(
    `INSERT INTO oidc_rate_limits
         (bucket_hash, window_start, request_count, expires_at)
       VALUES (?1, ?2, 1, ?3)
       ON CONFLICT (bucket_hash, window_start)
       DO UPDATE SET request_count = request_count + 1
       RETURNING request_count`,
  )
    .bind(bucketHash, windowStart, expiresAt)
    .first<{ request_count: number }>()

  const count = result?.request_count
  if (typeof count !== 'number') {
    throw new Error('rate_limit_state_failure')
  }
  return count <= maximumRequests
}

export async function createAuthorizationRequest(
  env: Env,
  state: string,
  request: AuthorizationRequest,
  now: number,
): Promise<void> {
  const result = await env.OIDC_STATE_DB.prepare(
    `INSERT INTO oidc_authorization_requests
       (state_hash, access_state, access_redirect_uri, nonce, scope,
        pkce_challenge, created_at, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
  )
    .bind(
      await sha256Hex(state),
      request.access_state,
      request.access_redirect_uri,
      request.nonce,
      request.scope,
      request.pkce_challenge,
      now,
      now + 5 * 60,
    )
    .run()

  if (!result.success || result.meta.changes !== 1) {
    throw new Error('authorization_state_write_failed')
  }
}

export async function consumeAuthorizationRequest(
  env: Env,
  state: string,
  now: number,
): Promise<AuthorizationRequest | null> {
  return env.OIDC_STATE_DB.prepare(
    `DELETE FROM oidc_authorization_requests
     WHERE state_hash = ?1 AND expires_at >= ?2
     RETURNING access_state, access_redirect_uri, nonce, scope, pkce_challenge`,
  )
    .bind(await sha256Hex(state), now)
    .first<AuthorizationRequest>()
}

export async function createAuthorizationCode(
  env: Env,
  code: string,
  value: AuthorizationCode,
  now: number,
): Promise<void> {
  try {
    const result = await env.OIDC_STATE_DB.prepare(
      `INSERT INTO oidc_authorization_codes
         (code_hash, access_redirect_uri, nonce, scope, pkce_challenge,
          discord_id, email, authenticated_at, created_at, expires_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
    )
      .bind(
        await sha256Hex(code),
        value.access_redirect_uri,
        value.nonce,
        value.scope,
        value.pkce_challenge,
        value.discord_id,
        value.email,
        value.authenticated_at,
        now,
        now + 60,
      )
      .run()

    if (!result.success || result.meta.changes !== 1) {
      throw new Error('authorization_code_write_failed')
    }
  } catch {
    throw new Error('authorization_code_write_failed')
  }
}

export async function consumeAuthorizationCode(
  env: Env,
  code: string,
  redirectUri: string,
  challenge: string,
  now: number,
): Promise<AuthorizationCode | null> {
  return env.OIDC_STATE_DB.prepare(
    `DELETE FROM oidc_authorization_codes
     WHERE code_hash = ?1
       AND access_redirect_uri = ?2
       AND pkce_challenge = ?3
       AND expires_at >= ?4
     RETURNING access_redirect_uri, nonce, scope, pkce_challenge,
       discord_id, email, authenticated_at`,
  )
    .bind(await sha256Hex(code), redirectUri, challenge, now)
    .first<AuthorizationCode>()
}
