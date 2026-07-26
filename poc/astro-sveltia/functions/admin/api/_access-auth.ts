import { createRemoteJWKSet, jwtVerify } from 'jose'

import type { CmsRuntimeEnv } from './_cms-policy.ts'

export type AccessIdentity =
  | {
      ok: true
      discordId: string
      discordRoleIds: string[]
      subject: string
    }
  | { ok: false; status: number; message: string }

const DISCORD_SNOWFLAKE_PATTERN = /^\d{17,20}$/u

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
    authorizationMode === 'guild',
  )

  if (
    !allowedHostnames ||
    !issuer ||
    !audience ||
    !DISCORD_SNOWFLAKE_PATTERN.test(allowedGuildId || '') ||
    !authorizationMode ||
    !allowedRoleIds
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

  if (!token) {
    return {
      ok: false,
      status: 401,
      message: 'Cloudflare Accessでログインしてください。',
    }
  }

  try {
    const { payload } = await jwtVerify(token, getRemoteJwkSet(issuer), {
      algorithms: ['RS256'],
      audience,
      clockTolerance: 60,
      issuer,
      requiredClaims: ['exp', 'iat', 'sub'],
    })
    const custom = isRecord(payload.custom) ? payload.custom : null
    const subject = typeof payload.sub === 'string' ? payload.sub.trim() : ''
    const discordId =
      custom && typeof custom.discord_id === 'string'
        ? custom.discord_id.trim()
        : ''
    const discordGuildId =
      custom && typeof custom.discord_guild_id === 'string'
        ? custom.discord_guild_id.trim()
        : ''
    const rawDiscordRoleIds = custom?.discord_roles
    const rawDiscordRoleCount = Array.isArray(rawDiscordRoleIds)
      ? rawDiscordRoleIds.length
      : null
    const discordRoleIds = Array.isArray(rawDiscordRoleIds)
      ? rawDiscordRoleIds.flatMap((role): string[] => {
          return typeof role === 'string' &&
            DISCORD_SNOWFLAKE_PATTERN.test(role.trim())
            ? [role.trim()]
            : []
        })
      : null

    if (
      !subject ||
      !DISCORD_SNOWFLAKE_PATTERN.test(discordId) ||
      discordGuildId !== allowedGuildId ||
      !discordRoleIds ||
      discordRoleIds.length !== rawDiscordRoleCount
    ) {
      return {
        ok: false,
        status: 403,
        message:
          'Cloudflare Access JWTのDiscord ID、guild、rolesを確認できません。',
      }
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
  } catch {
    return {
      ok: false,
      status: 401,
      message: 'Cloudflare Access JWTを検証できません。',
    }
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

  if (normalized === 'guild' || normalized === 'role') return normalized

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
