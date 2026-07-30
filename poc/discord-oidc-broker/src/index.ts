import type { BrokerConfig } from './config.ts'
import { readConfig } from './config.ts'
import {
  pkceChallenge,
  randomToken,
  signIdToken,
  timingSafeTextEqual,
} from './crypto.ts'
import {
  createDiscordAuthorizationUrl,
  resolveDiscordIdentity,
} from './discord.ts'
import {
  hasDuplicateParameters,
  jsonResponse,
  oauthError,
  readFormBody,
  redirectOAuthError,
  redirectResponse,
} from './http.ts'
import {
  cleanupExpiredState,
  consumeAuthorizationCode,
  consumeAuthorizationRequest,
  createAuthorizationCode,
  createAuthorizationRequest,
  enforceRateLimit,
} from './store.ts'

const AUTHORIZE_RATE_LIMIT = 30
const CALLBACK_RATE_LIMIT = 30
const TOKEN_RATE_LIMIT = 3000
const OPAQUE_VALUE = /^[\x21-\x7e]+$/u
const PKCE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/u
const PKCE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/u
const CALLBACK_FAILURE_CODES = new Set([
  'authorization_code_write_failed',
  'body_too_large',
  'discord_guild_membership_invalid',
  'discord_guild_membership_required',
  'discord_identity_invalid',
  'discord_token_http_3xx',
  'discord_token_http_400',
  'discord_token_http_401',
  'discord_token_http_403',
  'discord_token_http_429',
  'discord_token_http_5xx',
  'discord_token_http_unexpected',
  'discord_token_metadata_invalid',
  'discord_token_request_failed',
  'discord_token_response_invalid',
  'discord_token_revocation_failed',
  'invalid_provider_response',
])
const SUPPORTED_OIDC_SCOPES = ['openid', 'email', 'profile']
const KNOWN_ROUTES = new Set([
  '/.well-known/openid-configuration',
  '/authorize',
  '/callback',
  '/jwks.json',
  '/token',
])

class ProtocolError extends Error {
  constructor(
    readonly error: string,
    readonly description: string,
    readonly status = 400,
    readonly logCode = error,
  ) {
    super(logCode)
  }
}

function unixTime(): number {
  return Math.floor(Date.now() / 1000)
}

function logRoute(request: Request): string {
  try {
    const pathname = new URL(request.url).pathname
    return KNOWN_ROUTES.has(pathname) ? pathname : 'other'
  } catch {
    return 'invalid'
  }
}

function logCallbackFailure(error: unknown): void {
  const logCode =
    error instanceof Error && CALLBACK_FAILURE_CODES.has(error.message)
      ? error.message
      : 'callback_processing_failed'
  console.error(
    JSON.stringify({
      error: logCode,
      event: 'oidc_callback_failed',
    }),
  )
}

function validateOpaque(
  value: string | null,
  name: string,
  minimum: number,
  maximum: number,
): string {
  if (
    value === null ||
    value.length < minimum ||
    value.length > maximum ||
    !OPAQUE_VALUE.test(value)
  ) {
    throw new ProtocolError('invalid_request', `${name} is invalid`)
  }
  return value
}

function validateScopes(raw: string | null): string {
  if (raw === null) {
    throw new ProtocolError('invalid_scope', 'scope is required')
  }
  const scopes = raw.split(' ')
  if (
    scopes.includes('') ||
    new Set(scopes).size !== scopes.length ||
    !scopes.includes('openid') ||
    !scopes.includes('email') ||
    scopes.some((scope) => !SUPPORTED_OIDC_SCOPES.includes(scope))
  ) {
    throw new ProtocolError('invalid_scope', 'scope is not supported')
  }
  return SUPPORTED_OIDC_SCOPES.filter((scope) => scopes.includes(scope)).join(
    ' ',
  )
}

async function validateAccessClient(
  parameters: URLSearchParams,
  config: BrokerConfig,
): Promise<{ redirectUri: string; state: string | null }> {
  const clientId = parameters.get('client_id')
  const redirectUri = parameters.get('redirect_uri')
  if (
    clientId === null ||
    !(await timingSafeTextEqual(clientId, config.accessClientId)) ||
    redirectUri === null ||
    !config.accessRedirectUris.has(redirectUri)
  ) {
    throw new ProtocolError(
      'invalid_request',
      'client_id or redirect_uri is invalid',
      400,
      'untrusted_authorization_request',
    )
  }
  return { redirectUri, state: parameters.get('state') }
}

function throwRedirectableValidationError(parameters: URLSearchParams): {
  challenge: string
  nonce: string | null
  scope: string
  state: string
} {
  if (parameters.get('response_type') !== 'code') {
    throw new ProtocolError(
      'unsupported_response_type',
      'response_type must be code',
    )
  }
  if (parameters.has('max_age')) {
    throw new ProtocolError('invalid_request', 'max_age is not supported')
  }

  const state = validateOpaque(parameters.get('state'), 'state', 16, 2048)
  const nonceValue = parameters.get('nonce')
  const nonce =
    nonceValue === null ? null : validateOpaque(nonceValue, 'nonce', 16, 512)
  const challenge = parameters.get('code_challenge')
  if (
    challenge === null ||
    !PKCE_CHALLENGE.test(challenge) ||
    parameters.get('code_challenge_method') !== 'S256'
  ) {
    throw new ProtocolError(
      'invalid_request',
      'S256 PKCE is required',
      400,
      'pkce_required',
    )
  }

  return {
    challenge,
    nonce,
    scope: validateScopes(parameters.get('scope')),
    state,
  }
}

function validatePrompt(
  parameters: URLSearchParams,
): 'consent' | 'interactive' | 'none' {
  const prompt = parameters.get('prompt')
  if (prompt === null) {
    return 'interactive'
  }

  const values = prompt.split(' ')
  if (
    values.includes('') ||
    new Set(values).size !== values.length ||
    values.some(
      (value) =>
        !['none', 'login', 'consent', 'select_account'].includes(value),
    ) ||
    (values.includes('none') && values.length !== 1)
  ) {
    throw new ProtocolError('invalid_request', 'prompt is invalid')
  }
  if (values[0] === 'none') {
    return 'none'
  }
  if (values.length === 1 && values[0] === 'consent') {
    return 'consent'
  }
  throw new ProtocolError('invalid_request', 'prompt is not supported')
}

async function readAuthorizeParameters(
  request: Request,
): Promise<URLSearchParams> {
  if (request.method === 'GET') {
    if (request.url.length > 8192) {
      throw new ProtocolError('invalid_request', 'request URI is too long', 414)
    }
    return new URL(request.url).searchParams
  }
  if (request.method === 'POST') {
    try {
      return await readFormBody(request)
    } catch {
      throw new ProtocolError(
        'invalid_request',
        'authorization request must be form encoded',
      )
    }
  }
  throw new ProtocolError(
    'invalid_request',
    'authorization endpoint supports GET and POST',
    405,
  )
}

async function handleAuthorize(
  request: Request,
  env: Env,
  config: BrokerConfig,
): Promise<Response> {
  const now = unixTime()
  if (
    !(await enforceRateLimit(
      request,
      env,
      'authorize',
      AUTHORIZE_RATE_LIMIT,
      now,
    ))
  ) {
    return oauthError(429, 'temporarily_unavailable', 'rate limit exceeded')
  }

  const parameters = await readAuthorizeParameters(request)
  if (hasDuplicateParameters(parameters)) {
    throw new ProtocolError(
      'invalid_request',
      'duplicate parameters are not allowed',
      400,
      'duplicate_authorization_parameter',
    )
  }

  const trusted = await validateAccessClient(parameters, config)
  if (
    parameters.has('response_mode') &&
    parameters.get('response_mode') !== 'query'
  ) {
    throw new ProtocolError('invalid_request', 'response_mode must be query')
  }
  try {
    const validated = throwRedirectableValidationError(parameters)
    const promptMode = validatePrompt(parameters)
    if (promptMode === 'none') {
      return redirectOAuthError(
        trusted.redirectUri,
        validated.state,
        'login_required',
      )
    }

    const discordState = randomToken()
    await createAuthorizationRequest(
      env,
      discordState,
      {
        access_redirect_uri: trusted.redirectUri,
        access_state: validated.state,
        nonce: validated.nonce,
        pkce_challenge: validated.challenge,
        scope: validated.scope,
      },
      now,
    )
    return redirectResponse(
      createDiscordAuthorizationUrl(
        config,
        discordState,
        promptMode === 'consent',
      ),
    )
  } catch (error) {
    if (
      error instanceof ProtocolError &&
      trusted.state !== null &&
      OPAQUE_VALUE.test(trusted.state) &&
      trusted.state.length >= 16 &&
      trusted.state.length <= 2048
    ) {
      return redirectOAuthError(trusted.redirectUri, trusted.state, error.error)
    }
    throw error
  }
}

function validateCallbackParameters(url: URL): {
  code: string | null
  discordError: string | null
  state: string
} {
  if (hasDuplicateParameters(url.searchParams)) {
    throw new ProtocolError(
      'invalid_request',
      'duplicate callback parameters are not allowed',
    )
  }
  const state = validateOpaque(url.searchParams.get('state'), 'state', 43, 43)
  if (!PKCE_CHALLENGE.test(state)) {
    throw new ProtocolError('invalid_request', 'state is invalid')
  }

  const code = url.searchParams.get('code')
  const discordError = url.searchParams.get('error')
  if ((code === null) === (discordError === null)) {
    throw new ProtocolError('invalid_request', 'callback is invalid')
  }
  if (
    code !== null &&
    (code.length < 1 || code.length > 2048 || !OPAQUE_VALUE.test(code))
  ) {
    throw new ProtocolError('invalid_request', 'authorization code is invalid')
  }
  return { code, discordError, state }
}

async function handleCallback(
  request: Request,
  env: Env,
  config: BrokerConfig,
): Promise<Response> {
  if (request.method !== 'GET') {
    return oauthError(405, 'invalid_request', 'callback requires GET')
  }
  if (request.url.length > 8192) {
    return oauthError(414, 'invalid_request', 'request URI is too long')
  }

  const now = unixTime()
  if (
    !(await enforceRateLimit(
      request,
      env,
      'callback',
      CALLBACK_RATE_LIMIT,
      now,
    ))
  ) {
    return oauthError(429, 'temporarily_unavailable', 'rate limit exceeded')
  }

  const callback = validateCallbackParameters(new URL(request.url))
  const authorization = await consumeAuthorizationRequest(
    env,
    callback.state,
    now,
  )
  if (authorization === null) {
    return oauthError(400, 'invalid_request', 'state is invalid or expired')
  }

  if (callback.discordError !== null) {
    return redirectOAuthError(
      authorization.access_redirect_uri,
      authorization.access_state,
      callback.discordError === 'access_denied'
        ? 'access_denied'
        : 'server_error',
    )
  }

  try {
    const identity = await resolveDiscordIdentity(config, callback.code ?? '')
    const membershipVerifiedAt = unixTime()
    const brokerCode = randomToken()
    await createAuthorizationCode(
      env,
      brokerCode,
      {
        access_redirect_uri: authorization.access_redirect_uri,
        authenticated_at: membershipVerifiedAt,
        discord_guild_id: identity.guildId,
        discord_id: identity.id,
        email: identity.email,
        nonce: authorization.nonce,
        pkce_challenge: authorization.pkce_challenge,
        scope: authorization.scope,
      },
      membershipVerifiedAt,
    )

    const target = new URL(authorization.access_redirect_uri)
    target.searchParams.set('code', brokerCode)
    target.searchParams.set('state', authorization.access_state)
    return redirectResponse(target.toString())
  } catch (error) {
    logCallbackFailure(error)
    return redirectOAuthError(
      authorization.access_redirect_uri,
      authorization.access_state,
      error instanceof Error &&
        error.message === 'discord_guild_membership_required'
        ? 'access_denied'
        : 'server_error',
    )
  }
}

function decodeBasicCredentials(
  authorization: string,
): { clientId: string; clientSecret: string } | null {
  const match = authorization.match(/^Basic ([A-Za-z0-9+/=]+)$/iu)
  if (!match) {
    return null
  }
  try {
    const decoded = atob(match[1])
    const separator = decoded.indexOf(':')
    if (separator < 1) {
      return null
    }
    return {
      clientId: decodeURIComponent(
        decoded.slice(0, separator).replaceAll('+', ' '),
      ),
      clientSecret: decodeURIComponent(
        decoded.slice(separator + 1).replaceAll('+', ' '),
      ),
    }
  } catch {
    return null
  }
}

async function authenticateTokenClient(
  request: Request,
  parameters: URLSearchParams,
  config: BrokerConfig,
): Promise<boolean> {
  const authorization = request.headers.get('Authorization')
  const bodySecret = parameters.get('client_secret')
  const bodyClientId = parameters.get('client_id')

  if (authorization !== null && bodySecret !== null) {
    return false
  }

  if (authorization !== null) {
    const credentials = decodeBasicCredentials(authorization)
    if (credentials === null) {
      return false
    }
    if (
      bodyClientId !== null &&
      !(await timingSafeTextEqual(bodyClientId, credentials.clientId))
    ) {
      return false
    }
    return (
      (await timingSafeTextEqual(
        credentials.clientId,
        config.accessClientId,
      )) &&
      (await timingSafeTextEqual(
        credentials.clientSecret,
        config.accessClientSecret,
      ))
    )
  }

  if (bodyClientId === null || bodySecret === null) {
    return false
  }
  return (
    (await timingSafeTextEqual(bodyClientId, config.accessClientId)) &&
    (await timingSafeTextEqual(bodySecret, config.accessClientSecret))
  )
}

function rejectTokenRequest(
  status: number,
  error: string,
  description: string,
  logCode: string,
): Response {
  console.warn(
    JSON.stringify({
      error: logCode,
      event: 'oidc_token_request_rejected',
    }),
  )
  return oauthError(status, error, description)
}

async function handleToken(
  request: Request,
  env: Env,
  config: BrokerConfig,
): Promise<Response> {
  if (request.method !== 'POST') {
    return oauthError(405, 'invalid_request', 'token endpoint requires POST')
  }

  const now = unixTime()
  if (!(await enforceRateLimit(request, env, 'token', TOKEN_RATE_LIMIT, now))) {
    return oauthError(429, 'temporarily_unavailable', 'rate limit exceeded')
  }

  let parameters: URLSearchParams
  try {
    parameters = await readFormBody(request)
  } catch {
    return rejectTokenRequest(
      400,
      'invalid_request',
      'token request must be form encoded',
      'token_form_invalid',
    )
  }
  if (hasDuplicateParameters(parameters)) {
    return rejectTokenRequest(
      400,
      'invalid_request',
      'duplicate parameters',
      'token_parameters_duplicated',
    )
  }
  if (!(await authenticateTokenClient(request, parameters, config))) {
    const response = rejectTokenRequest(
      401,
      'invalid_client',
      'client authentication failed',
      'token_client_authentication_failed',
    )
    response.headers.set('WWW-Authenticate', 'Basic realm="oidc-token"')
    return response
  }
  if (parameters.get('grant_type') !== 'authorization_code') {
    return rejectTokenRequest(
      400,
      'unsupported_grant_type',
      'grant_type must be authorization_code',
      'token_grant_type_unsupported',
    )
  }

  const code = parameters.get('code')
  const redirectUri = parameters.get('redirect_uri')
  const verifier = parameters.get('code_verifier')
  if (code === null) {
    return rejectTokenRequest(
      400,
      'invalid_request',
      'grant parameters are invalid',
      'token_code_missing',
    )
  }
  if (code.length === 0) {
    return rejectTokenRequest(
      400,
      'invalid_request',
      'grant parameters are invalid',
      'token_code_empty',
    )
  }
  if (code.length < 32) {
    return rejectTokenRequest(
      400,
      'invalid_request',
      'grant parameters are invalid',
      'token_code_too_short',
    )
  }
  if (code.length > 256) {
    return rejectTokenRequest(
      400,
      'invalid_request',
      'grant parameters are invalid',
      'token_code_too_long',
    )
  }
  if (!OPAQUE_VALUE.test(code)) {
    return rejectTokenRequest(
      400,
      'invalid_request',
      'grant parameters are invalid',
      'token_code_characters_invalid',
    )
  }
  if (redirectUri === null) {
    return rejectTokenRequest(
      400,
      'invalid_request',
      'grant parameters are invalid',
      'token_redirect_uri_missing',
    )
  }
  if (verifier === null) {
    return rejectTokenRequest(
      400,
      'invalid_request',
      'grant parameters are invalid',
      'token_code_verifier_missing',
    )
  }
  if (!PKCE_VERIFIER.test(verifier)) {
    return rejectTokenRequest(
      400,
      'invalid_request',
      'grant parameters are invalid',
      'token_code_verifier_malformed',
    )
  }
  if (!config.accessRedirectUris.has(redirectUri)) {
    return rejectTokenRequest(
      400,
      'invalid_grant',
      'authorization grant is invalid',
      'token_redirect_uri_untrusted',
    )
  }

  const authorization = await consumeAuthorizationCode(
    env,
    code,
    redirectUri,
    await pkceChallenge(verifier),
    now,
  )
  if (authorization === null) {
    return rejectTokenRequest(
      400,
      'invalid_grant',
      'authorization grant is invalid or expired',
      'token_authorization_grant_invalid',
    )
  }
  if (authorization.discord_guild_id !== config.discordGuildId) {
    return rejectTokenRequest(
      400,
      'invalid_grant',
      'authorization grant is invalid',
      'token_discord_guild_invalid',
    )
  }

  const expiresIn = 5 * 60
  const claims: Record<string, string | number | boolean> = {
    aud: config.accessClientId,
    auth_time: authorization.authenticated_at,
    discord_guild_id: authorization.discord_guild_id,
    discord_id: authorization.discord_id,
    discord_membership_verified_at: String(
      authorization.authenticated_at,
    ),
    email: authorization.email,
    email_verified: true,
    exp: now + expiresIn,
    iat: now,
    iss: config.issuer,
    jti: crypto.randomUUID(),
    sub: authorization.discord_id,
  }
  if (authorization.nonce !== null) {
    claims.nonce = authorization.nonce
  }
  const idToken = await signIdToken(
    config.signingPrivateKeyPem,
    config.signingPublicJwk,
    claims,
  )
  return jsonResponse(
    {
      access_token: randomToken(),
      expires_in: expiresIn,
      id_token: idToken,
      scope: authorization.scope,
      token_type: 'Bearer',
    },
    { headers: { Pragma: 'no-cache' } },
  )
}

function discovery(config: BrokerConfig): Response {
  return jsonResponse(
    {
      authorization_endpoint: `${config.issuer}/authorize`,
      claims_supported: [
        'aud',
        'auth_time',
        'discord_guild_id',
        'discord_id',
        'discord_membership_verified_at',
        'email',
        'email_verified',
        'exp',
        'iat',
        'iss',
        'nonce',
        'sub',
      ],
      code_challenge_methods_supported: ['S256'],
      grant_types_supported: ['authorization_code'],
      id_token_signing_alg_values_supported: ['RS256'],
      issuer: config.issuer,
      jwks_uri: `${config.issuer}/jwks.json`,
      response_modes_supported: ['query'],
      response_types_supported: ['code'],
      scopes_supported: SUPPORTED_OIDC_SCOPES,
      subject_types_supported: ['public'],
      token_endpoint: `${config.issuer}/token`,
      token_endpoint_auth_methods_supported: [
        'client_secret_basic',
        'client_secret_post',
      ],
    },
    {},
    'public, max-age=300',
  )
}

function jwks(config: BrokerConfig): Response {
  return jsonResponse(
    { keys: config.signingPublicJwks },
    {},
    'public, max-age=300',
  )
}

async function routeRequest(
  request: Request,
  env: Env,
  config: BrokerConfig,
): Promise<Response> {
  const url = new URL(request.url)
  if (url.origin !== config.issuer) {
    return oauthError(421, 'invalid_request', 'request origin is not served')
  }
  if (
    url.pathname === '/.well-known/openid-configuration' &&
    request.method === 'GET'
  ) {
    return discovery(config)
  }
  if (url.pathname === '/jwks.json' && request.method === 'GET') {
    return jwks(config)
  }
  if (url.pathname === '/authorize') {
    return handleAuthorize(request, env, config)
  }
  if (url.pathname === '/callback') {
    return handleCallback(request, env, config)
  }
  if (url.pathname === '/token') {
    return handleToken(request, env, config)
  }
  return oauthError(404, 'not_found', 'endpoint not found')
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const route = logRoute(request)
    try {
      const config = readConfig(env)
      return await routeRequest(request, env, config)
    } catch (error) {
      const protocolError =
        error instanceof ProtocolError
          ? error
          : new ProtocolError(
              'server_error',
              'service configuration or state is unavailable',
              503,
              'unhandled_failure',
            )
      console.error(
        JSON.stringify({
          error: protocolError.logCode,
          event: 'oidc_request_failed',
          route,
        }),
      )
      return oauthError(
        protocolError.status,
        protocolError.error,
        protocolError.description,
      )
    }
  },
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(
      cleanupExpiredState(env, unixTime()).catch(() => {
        console.error(
          JSON.stringify({
            error: 'state_cleanup_failed',
            event: 'oidc_scheduled_cleanup_failed',
          }),
        )
      }),
    )
  },
} satisfies ExportedHandler<Env>
