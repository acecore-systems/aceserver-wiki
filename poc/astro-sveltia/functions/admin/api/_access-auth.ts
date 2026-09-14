import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose'

import { readDiscordMembership } from './_discord-membership.ts'

import type { CmsRuntimeEnv } from './_cms-policy.ts'

export type AccessIdentity =
  | {
      ok: true
      discordId: string
      discordRoleIds: string[]
      subject: string
    }
  | { ok: false; status: number; message: string; code?: string }

const SUBJECT_CLAIM = 'https://acecore.net/claims/subject'
const DISCORD_ID_CLAIM = 'https://acecore.net/claims/discord-id'
const IDENTITY_ACCOUNT_ID = 'db9b62f409f463da7acbcc374b8385d0'
const IDENTITY_PROVIDER_ID = 'a18ae74a-a342-40db-bfb2-7cc515d26637'
const MAX_IDENTITY_RESPONSE_BYTES = 64 * 1024
const IDENTITY_REQUEST_TIMEOUT_MS = 8 * 1000
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
const DISCORD_SNOWFLAKE_PATTERN = /^[1-9][0-9]{16,19}$/u

// This cache contains only public JWKS resolvers. It never stores request
// identities, JWTs, roles, or any other request-specific state.
const jwksByIssuer = new Map<string, ReturnType<typeof createRemoteJWKSet>>()

export async function getAccessIdentity(
  request: Request,
  env: CmsRuntimeEnv,
): Promise<AccessIdentity> {
  const hostname = new URL(request.url).hostname.toLowerCase()
  const allowedHostnames = parseAllowedHostnames(env.CMS_ACCESS_HOSTNAMES)
  const issuer = normalizeAccessIssuer(env.CMS_ACCESS_TEAM_DOMAIN)
  const audience = env.CMS_ACCESS_AUD?.trim()
  const allowedGuildId = env.CMS_DISCORD_GUILD_ID?.trim()
  const authorizationMode = parseAuthorizationMode(
    env.CMS_DISCORD_AUTHORIZATION_MODE,
  )
  const allowedRoleIds = parseSnowflakeCsv(
    env.CMS_DISCORD_ALLOWED_ROLE_IDS,
    authorizationMode !== 'role',
  )

  if (
    !allowedHostnames ||
    !issuer ||
    !audience ||
    !authorizationMode ||
    !allowedRoleIds ||
    (authorizationMode !== 'account' &&
      !DISCORD_SNOWFLAKE_PATTERN.test(allowedGuildId || ''))
  ) {
    return {
      ok: false,
      status: 503,
      message: 'CMSのCloudflare AccessまたはDiscord認可設定が不足しています。',
    }
  }

  if (!allowedHostnames.some((pattern) => hostnameMatches(pattern, hostname))) {
    return {
      ok: false,
      status: 401,
      message:
        'Cloudflare Accessで保護されたCMSドメインからログインしてください。',
    }
  }

  const token = request.headers.get('cf-access-jwt-assertion') || ''

  if (!token || token.length > 32_768) {
    return {
      ok: false,
      status: 401,
      message: 'AcecoreIDでログインしてください。',
    }
  }

  let payload: JWTPayload

  try {
    const verified = await jwtVerify(token, getRemoteJwkSet(issuer), {
      algorithms: ['RS256'],
      audience,
      clockTolerance: 60,
      issuer,
      requiredClaims: ['exp', 'iat', 'sub'],
    })
    payload = verified.payload
  } catch {
    return {
      ok: false,
      status: 401,
      message: 'Cloudflare Access JWTを検証できません。',
    }
  }

  if (payload.type !== 'app') {
    return identityFailure('CMS_AUTH_TOKEN_TYPE_INVALID')
  }

  const subject = typeof payload.sub === 'string' ? payload.sub.trim() : ''

  if (!UUID_PATTERN.test(subject)) {
    return identityFailure('CMS_AUTH_ACCESS_SUBJECT_INVALID', 401)
  }

  if (payload.custom !== undefined && !isRecord(payload.custom)) {
    return identityFailure('CMS_AUTH_CUSTOM_CLAIMS_MISSING')
  }

  const custom = payload.custom || {}
  const directSubject = readOptionalClaim(
    custom,
    SUBJECT_CLAIM,
    UUID_PATTERN,
    'CMS_AUTH_SUBJECT_INVALID',
  )

  if (!directSubject.ok) return directSubject

  const directDiscordId = readOptionalClaim(
    custom,
    DISCORD_ID_CLAIM,
    DISCORD_SNOWFLAKE_PATTERN,
    'CMS_AUTH_DISCORD_ID_INVALID',
  )

  if (!directDiscordId.ok) return directDiscordId

  let discordId = directDiscordId.value

  if (!directSubject.value || !discordId) {
    const identity = await getFullIdentity(issuer, token)

    if (!identity.ok) return identity

    if (typeof identity.value.user_uuid !== 'string') {
      return identityFailure('CMS_AUTH_IDENTITY_USER_MISSING')
    }

    if (identity.value.user_uuid !== subject) {
      return identityFailure('CMS_AUTH_IDENTITY_USER_MISMATCH')
    }

    if (identity.value.account_id !== IDENTITY_ACCOUNT_ID) {
      return identityFailure('CMS_AUTH_IDENTITY_ACCOUNT_MISMATCH')
    }

    if (!isRecord(identity.value.idp)) {
      return identityFailure('CMS_AUTH_IDENTITY_PROVIDER_MISSING')
    }

    if (identity.value.idp.id !== IDENTITY_PROVIDER_ID) {
      return identityFailure('CMS_AUTH_IDENTITY_PROVIDER_MISMATCH')
    }

    if (identity.value.idp.type !== 'oidc') {
      return identityFailure('CMS_AUTH_IDENTITY_PROVIDER_TYPE_MISMATCH')
    }

    if (!isRecord(identity.value.oidc_fields)) {
      return identityFailure('CMS_AUTH_IDENTITY_FIELDS_MISSING')
    }

    const identitySubject = readRequiredIdentityClaim(
      identity.value.oidc_fields,
      SUBJECT_CLAIM,
      UUID_PATTERN,
      'CMS_AUTH_SUBJECT_INVALID',
    )

    if (!identitySubject.ok) return identitySubject

    const identityDiscordId = readRequiredIdentityClaim(
      identity.value.oidc_fields,
      DISCORD_ID_CLAIM,
      DISCORD_SNOWFLAKE_PATTERN,
      'CMS_AUTH_DISCORD_ID_INVALID',
    )

    if (!identityDiscordId.ok) return identityDiscordId

    if (
      (directSubject.value && directSubject.value !== identitySubject.value) ||
      (discordId && discordId !== identityDiscordId.value)
    ) {
      return identityFailure('CMS_AUTH_IDENTITY_SOURCE_CONFLICT')
    }

    discordId = identityDiscordId.value
  }

  let discordRoleIds: string[] = []
  if (authorizationMode !== 'account') {
    const membership = await readDiscordMembership(
      allowedGuildId!,
      discordId,
      env.CMS_DISCORD_MEMBERSHIP,
    )
    if (!membership.ok) return membership
    discordRoleIds = membership.roles
  }

  if (
    authorizationMode === 'role' &&
    !discordRoleIds.some((roleId) => allowedRoleIds.includes(roleId))
  ) {
    return {
      ok: false,
      status: 403,
      message: 'このDiscordユーザーにはCMS編集権限がありません。',
    }
  }

  return {
    ok: true,
    discordId,
    discordRoleIds: [...new Set(discordRoleIds)],
    subject,
  }
}

function readOptionalClaim(
  claims: Record<string, unknown>,
  name: string,
  pattern: RegExp,
  code: string,
) {
  const value = claims[name]

  if (value === undefined) return { ok: true as const, value: undefined }
  if (typeof value !== 'string' || !pattern.test(value)) {
    return identityFailure(code)
  }

  return { ok: true as const, value }
}

async function getFullIdentity(issuer: string, token: string) {
  let response: Response

  try {
    response = await fetch(
      new URL('/cdn-cgi/access/get-identity', `${issuer}/`),
      {
        method: 'GET',
        redirect: 'manual',
        cache: 'no-store',
        signal: AbortSignal.timeout(IDENTITY_REQUEST_TIMEOUT_MS),
        headers: {
          Accept: 'application/json',
          Cookie: `CF_Authorization=${token}`,
        },
      },
    )
  } catch {
    return identityFailure('CMS_AUTH_IDENTITY_UNAVAILABLE', 502)
  }

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    return identityFailure('CMS_AUTH_IDENTITY_UNAVAILABLE', 502)
  }

  const value = await readBoundedJson(response)

  if (!isRecord(value)) {
    return identityFailure('CMS_AUTH_IDENTITY_INVALID', 502)
  }

  return { ok: true as const, value }
}

function readRequiredIdentityClaim(
  claims: Record<string, unknown>,
  name: string,
  pattern: RegExp,
  code: string,
) {
  const value = claims[name]

  if (typeof value !== 'string' || !pattern.test(value)) {
    return identityFailure(code)
  }

  return { ok: true as const, value }
}

function identityFailure(code: string, status = 403) {
  return {
    ok: false as const,
    status,
    message: 'AcecoreIDのDiscord連携を確認してください。',
    code,
  }
}

async function readBoundedJson(response: Response): Promise<unknown> {
  if (!response.body) return null

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0

  try {
    while (true) {
      const { done, value } = await reader.read()

      if (done) break

      totalBytes += value.byteLength
      if (totalBytes > MAX_IDENTITY_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined)
        return null
      }

      chunks.push(value)
    }

    const bytes = new Uint8Array(totalBytes)
    let offset = 0

    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }

    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes),
    )
  } catch {
    return null
  } finally {
    reader.releaseLock()
  }
}

function getRemoteJwkSet(issuer: string) {
  let jwks = jwksByIssuer.get(issuer)

  if (!jwks) {
    if (jwksByIssuer.size >= 4) jwksByIssuer.clear()

    jwks = createRemoteJWKSet(new URL('/cdn-cgi/access/certs', `${issuer}/`))
    jwksByIssuer.set(issuer, jwks)
  }

  return jwks
}

function normalizeAccessIssuer(value: string | undefined) {
  if (!value) return null

  try {
    const url = new URL(value)

    if (
      url.protocol !== 'https:' ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.pathname !== '/' && url.pathname !== '') ||
      !url.hostname.endsWith('.cloudflareaccess.com')
    ) {
      return null
    }

    return url.origin
  } catch {
    return null
  }
}

function parseAllowedHostnames(value: string | undefined) {
  const patterns = parseCsv(value)

  if (
    patterns.length === 0 ||
    patterns.some((pattern) => !isValidHostnamePattern(pattern))
  ) {
    return null
  }

  return patterns
}

function parseSnowflakeCsv(value: string | undefined, allowEmpty = false) {
  const values = parseCsv(value)

  if (allowEmpty && values.length === 0) return []

  if (
    values.length === 0 ||
    values.some((item) => !DISCORD_SNOWFLAKE_PATTERN.test(item))
  ) {
    return null
  }

  return [...new Set(values)]
}

function parseAuthorizationMode(value: string | undefined) {
  const normalized = value?.trim().toLowerCase()

  if (
    normalized === 'account' ||
    normalized === 'guild' ||
    normalized === 'role'
  ) {
    return normalized
  }

  return null
}

function parseCsv(value: string | undefined) {
  return (value || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
}

function isValidHostnamePattern(pattern: string) {
  if (pattern.includes('*') && !pattern.startsWith('*.')) return false

  const hostname = pattern.startsWith('*.') ? pattern.slice(2) : pattern

  if (!hostname || hostname.includes('*') || hostname.includes('/')) {
    return false
  }

  try {
    return new URL(`https://${hostname}`).hostname === hostname
  } catch {
    return false
  }
}

function hostnameMatches(pattern: string, hostname: string) {
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(1)

    return hostname.endsWith(suffix) && hostname !== pattern.slice(2)
  }

  return hostname === pattern
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
