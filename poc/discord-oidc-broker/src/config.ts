import { parsePublicSigningJwk, type PublicSigningJwk } from './crypto.ts'

export type BrokerConfig = {
  accessClientId: string
  accessClientSecret: string
  accessRedirectUris: ReadonlySet<string>
  discordClientId: string
  discordClientSecret: string
  discordRedirectUri: string
  issuer: string
  signingPrivateKeyPem: string
  signingPublicJwk: PublicSigningJwk
  signingPublicJwks: readonly PublicSigningJwk[]
}

function parseIssuer(raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('invalid_issuer')
  }

  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error('invalid_issuer')
  }

  return url.origin
}

function parseAccessRedirectUris(raw: string): ReadonlySet<string> {
  const values = raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)

  if (values.length < 1 || values.length > 4) {
    throw new Error('invalid_access_redirect_uri')
  }

  const redirects = new Set<string>()
  for (const value of values) {
    let url: URL
    try {
      url = new URL(value)
    } catch {
      throw new Error('invalid_access_redirect_uri')
    }

    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      !url.hostname.endsWith('.cloudflareaccess.com') ||
      url.pathname !== '/cdn-cgi/access/callback' ||
      url.search ||
      url.hash ||
      url.toString() !== value
    ) {
      throw new Error('invalid_access_redirect_uri')
    }
    redirects.add(value)
  }

  if (redirects.size !== values.length) {
    throw new Error('invalid_access_redirect_uri')
  }

  return redirects
}

function requireBoundedSecret(value: string, name: string): string {
  if (value.length < 16 || value.length > 16_384) {
    throw new Error(`invalid_${name}`)
  }
  return value
}

function parsePreviousPublicSigningJwks(
  raw: string,
  current: PublicSigningJwk,
): readonly PublicSigningJwk[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('invalid_previous_signing_jwks')
  }
  if (!Array.isArray(parsed) || parsed.length > 2) {
    throw new Error('invalid_previous_signing_jwks')
  }

  const keys = parsed.map((value) =>
    parsePublicSigningJwk(JSON.stringify(value)),
  )
  const keyIds = new Set([current.kid])
  for (const key of keys) {
    if (keyIds.has(key.kid)) {
      throw new Error('duplicate_signing_key_id')
    }
    keyIds.add(key.kid)
  }
  return [current, ...keys]
}

export function readConfig(env: Env): BrokerConfig {
  const issuer = parseIssuer(env.OIDC_ISSUER)
  const signingPublicJwk = parsePublicSigningJwk(
    env.OIDC_SIGNING_PUBLIC_JWK_JSON,
  )

  if (
    !/^[A-Za-z0-9._~-]{8,256}$/u.test(env.OIDC_ACCESS_CLIENT_ID) ||
    !/^\d{17,20}$/u.test(env.DISCORD_CLIENT_ID)
  ) {
    throw new Error('invalid_client_configuration')
  }

  return {
    accessClientId: env.OIDC_ACCESS_CLIENT_ID,
    accessClientSecret: requireBoundedSecret(
      env.OIDC_ACCESS_CLIENT_SECRET,
      'access_client_secret',
    ),
    accessRedirectUris: parseAccessRedirectUris(env.OIDC_ACCESS_REDIRECT_URIS),
    discordClientId: env.DISCORD_CLIENT_ID,
    discordClientSecret: requireBoundedSecret(
      env.DISCORD_CLIENT_SECRET,
      'discord_client_secret',
    ),
    discordRedirectUri: `${issuer}/callback`,
    issuer,
    signingPrivateKeyPem: requireBoundedSecret(
      env.OIDC_SIGNING_PRIVATE_KEY_PEM,
      'signing_private_key',
    ),
    signingPublicJwk,
    signingPublicJwks: parsePreviousPublicSigningJwks(
      env.OIDC_SIGNING_PREVIOUS_PUBLIC_JWKS_JSON,
      signingPublicJwk,
    ),
  }
}
