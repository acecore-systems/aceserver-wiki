import type { BrokerConfig } from './config.ts'
import { readProviderJson } from './http.ts'

const DISCORD_AUTHORIZE_URL = 'https://discord.com/oauth2/authorize'
const DISCORD_TOKEN_URL = 'https://discord.com/api/oauth2/token'
const DISCORD_REVOKE_URL = 'https://discord.com/api/oauth2/token/revoke'
const DISCORD_USER_URL = 'https://discord.com/api/v10/users/@me'
const USER_AGENT = 'aceserver-wiki-discord-oidc-broker/1.0'

type DiscordToken = {
  accessToken: string
  metadataValid: boolean
}

export type DiscordIdentity = {
  email: string
  id: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function discordBasicAuthorization(config: BrokerConfig): string {
  return `Basic ${btoa(
    `${config.discordClientId}:${config.discordClientSecret}`,
  )}`
}

async function withDiscordFailure<T>(
  logCode: string,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation()
  } catch {
    throw new Error(logCode)
  }
}

function discordTokenHttpFailure(status: number): Error {
  if (status >= 300 && status <= 399) {
    return new Error('discord_token_http_3xx')
  }
  if (status === 400) {
    return new Error('discord_token_http_400')
  }
  if (status === 401) {
    return new Error('discord_token_http_401')
  }
  if (status === 403) {
    return new Error('discord_token_http_403')
  }
  if (status === 429) {
    return new Error('discord_token_http_429')
  }
  if (status >= 500 && status <= 599) {
    return new Error('discord_token_http_5xx')
  }
  return new Error('discord_token_http_unexpected')
}

export function createDiscordAuthorizationUrl(
  config: BrokerConfig,
  state: string,
  forceConsent = false,
): string {
  const target = new URL(DISCORD_AUTHORIZE_URL)
  target.searchParams.set('response_type', 'code')
  target.searchParams.set('client_id', config.discordClientId)
  target.searchParams.set('redirect_uri', config.discordRedirectUri)
  target.searchParams.set('scope', 'identify email')
  target.searchParams.set('state', state)
  if (forceConsent) {
    target.searchParams.set('prompt', 'consent')
  }
  return target.toString()
}

async function exchangeDiscordCode(
  config: BrokerConfig,
  code: string,
): Promise<DiscordToken> {
  const body = new URLSearchParams({
    code,
    grant_type: 'authorization_code',
    redirect_uri: config.discordRedirectUri,
  })
  let response: Response
  try {
    response = await fetch(DISCORD_TOKEN_URL, {
      body,
      headers: {
        Accept: 'application/json',
        Authorization: discordBasicAuthorization(config),
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': USER_AGENT,
      },
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(8000),
    })
  } catch {
    throw new Error('discord_token_request_failed')
  }
  if (!response.ok) {
    try {
      await response.body?.cancel()
    } catch {
      // Preserve the provider HTTP classification if body disposal fails.
    }
    throw discordTokenHttpFailure(response.status)
  }

  let payload: unknown
  try {
    payload = await readProviderJson(response)
  } catch {
    try {
      await response.body?.cancel()
    } catch {
      // The response is already consumed or closed; keep the fixed error.
    }
    throw new Error('discord_token_response_invalid')
  }
  if (
    !isRecord(payload) ||
    typeof payload.access_token !== 'string' ||
    payload.access_token.length < 20 ||
    payload.access_token.length > 4096
  ) {
    throw new Error('discord_token_response_invalid')
  }

  const scopes =
    typeof payload.scope === 'string'
      ? new Set(payload.scope.split(/\s+/u))
      : new Set<string>()
  return {
    accessToken: payload.access_token,
    metadataValid:
      typeof payload.token_type === 'string' &&
      payload.token_type.toLowerCase() === 'bearer' &&
      typeof payload.expires_in === 'number' &&
      Number.isInteger(payload.expires_in) &&
      payload.expires_in >= 1 &&
      payload.expires_in <= 604_800 &&
      scopes.has('identify') &&
      scopes.has('email'),
  }
}

async function fetchDiscordIdentity(
  accessToken: string,
): Promise<DiscordIdentity> {
  return withDiscordFailure('discord_identity_invalid', async () => {
    const response = await fetch(DISCORD_USER_URL, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': USER_AGENT,
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(8000),
    })
    const payload = await readProviderJson(response)

    if (
      !response.ok ||
      !isRecord(payload) ||
      typeof payload.id !== 'string' ||
      !/^\d{17,20}$/u.test(payload.id) ||
      typeof payload.email !== 'string' ||
      payload.email.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(payload.email) ||
      payload.verified !== true
    ) {
      throw new Error('discord_identity_invalid')
    }

    return {
      email: payload.email,
      id: payload.id,
    }
  })
}

async function revokeDiscordToken(
  config: BrokerConfig,
  accessToken: string,
): Promise<void> {
  await withDiscordFailure('discord_token_revocation_failed', async () => {
    const response = await fetch(DISCORD_REVOKE_URL, {
      body: new URLSearchParams({
        token: accessToken,
        token_type_hint: 'access_token',
      }),
      headers: {
        Authorization: discordBasicAuthorization(config),
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': USER_AGENT,
      },
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(8000),
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error('discord_token_revocation_failed')
    }
    await response.body?.cancel()
  })
}

export async function resolveDiscordIdentity(
  config: BrokerConfig,
  code: string,
): Promise<DiscordIdentity> {
  const token = await exchangeDiscordCode(config, code)
  let identity: DiscordIdentity | null = null
  let identityError: unknown

  try {
    if (!token.metadataValid) {
      throw new Error('discord_token_metadata_invalid')
    }
    identity = await fetchDiscordIdentity(token.accessToken)
  } catch (error) {
    identityError = error
  }

  await revokeDiscordToken(config, token.accessToken)
  if (identityError !== undefined) {
    throw identityError
  }
  if (identity === null) {
    throw new Error('discord_identity_invalid')
  }
  return identity
}
