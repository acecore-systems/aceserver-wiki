const SEARCH_EMBEDDING_MODEL = '@cf/baai/bge-m3'
const SEARCH_EMBEDDING_DIMENSIONS = 1024
const SEARCH_LOCALE = 'ja'
const DEFAULT_MIN_SCORE = 0.4
const MAX_REQUEST_BYTES = 2048
const MIN_QUERY_LENGTH = 2
const MAX_QUERY_LENGTH = 160
const MAX_PATH_DECODE_PASSES = 4
const QUERY_TOP_K = 15
const RESULT_LIMIT = 5
const RATE_LIMIT_WINDOW_SECONDS = 60
const RATE_LIMIT_RETENTION_SECONDS = 600
const CLIENT_RATE_LIMIT = 20
const GLOBAL_RATE_LIMIT = 300
const MAX_URL_LENGTH = 500
const CANONICAL_PATH_ORIGIN = 'https://url-validation.invalid'
const CLIENT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

type SemanticSearchEnv = {
  AI?: Ai
  CMS_DATABASE?: D1Database
  SEARCH_EMBEDDING_DIMENSIONS?: string
  SEARCH_EMBEDDING_MODEL?: string
  SEARCH_ENABLED?: string
  SEARCH_INDEX?: Vectorize
  SEARCH_MIN_SCORE?: string
}

type SearchPayload = {
  locale?: unknown
  query?: unknown
}

type SearchMetadata = {
  contentType: string
  excerpt: string
  locale: typeof SEARCH_LOCALE
  section: string
  title: string
  url: string
}

type SearchResult = {
  contentType: string
  excerpt: string
  id: string
  rank: number
  section: string
  title: string
  url: string
}

export const createSearchHandler =
  (): PagesFunction<SemanticSearchEnv> =>
  async ({ request, env, waitUntil }) => {
    const startedAt = performance.now()
    const requestId = crypto.randomUUID()

    try {
      if (!isSameOriginRequest(request)) {
        return errorResponse('forbidden', 403, requestId, startedAt)
      }

      if (
        !request.headers
          .get('Content-Type')
          ?.toLowerCase()
          .startsWith('application/json')
      ) {
        return errorResponse(
          'unsupported_media_type',
          415,
          requestId,
          startedAt,
        )
      }

      if (
        env.SEARCH_ENABLED !== 'true' ||
        !env.AI ||
        !env.SEARCH_INDEX ||
        !env.CMS_DATABASE
      ) {
        return errorResponse('unavailable', 503, requestId, startedAt)
      }

      const requestText = await readBoundedRequestText(
        request,
        MAX_REQUEST_BYTES,
      )
      if (requestText === null) {
        return errorResponse('request_too_large', 413, requestId, startedAt)
      }

      let parsedPayload: unknown
      try {
        parsedPayload = JSON.parse(requestText)
      } catch {
        return errorResponse('invalid_json', 400, requestId, startedAt)
      }
      if (!isJsonObject(parsedPayload)) {
        return errorResponse('invalid_request', 400, requestId, startedAt)
      }

      const payload = parsedPayload as SearchPayload
      const query = normalizeQuery(payload.query)
      if (!query || !isJapaneseLocale(payload.locale)) {
        return errorResponse('invalid_request', 400, requestId, startedAt)
      }

      let clientAllowed = false
      let globalAllowed = false
      let clientKey = ''
      try {
        clientKey = await createClientRateLimitKey(request)
        clientAllowed = await consumeRateLimit(
          env.CMS_DATABASE,
          `client:${clientKey}`,
          CLIENT_RATE_LIMIT,
        )
        if (clientAllowed) {
          globalAllowed = await consumeRateLimit(
            env.CMS_DATABASE,
            'global',
            GLOBAL_RATE_LIMIT,
          )
        }
      } catch (error) {
        logSearchError(
          requestId,
          'rate_limit',
          getErrorCode(error, 'storage_error'),
        )
        return errorResponse('unavailable', 503, requestId, startedAt)
      }

      if (!clientAllowed || !globalAllowed) {
        return errorResponse('rate_limited', 429, requestId, startedAt, {
          'Retry-After': '60',
        })
      }

      if (requestId.endsWith('00')) {
        waitUntil(
          deleteExpiredRateLimits(env.CMS_DATABASE).catch((error) => {
            logSearchError(
              requestId,
              'rate_limit_cleanup',
              getErrorCode(error, 'storage_error'),
            )
          }),
        )
      }

      let embedding: number[]
      try {
        embedding = await createWorkersAiEmbedding(env, query)
      } catch (error) {
        logSearchError(
          requestId,
          'embedding',
          getErrorCode(error, 'provider_error'),
        )
        return errorResponse('provider_error', 502, requestId, startedAt)
      }

      let matches: VectorizeMatches
      try {
        matches = await env.SEARCH_INDEX.query(embedding, {
          namespace: SEARCH_LOCALE,
          topK: QUERY_TOP_K,
          returnMetadata: 'all',
          returnValues: false,
        })
      } catch (error) {
        logSearchError(
          requestId,
          'vectorize',
          getErrorCode(error, 'provider_error'),
        )
        return errorResponse('provider_error', 502, requestId, startedAt)
      }

      const results = normalizeMatches(
        matches,
        normalizeMinScore(env.SEARCH_MIN_SCORE),
      )

      return jsonResponse(
        {
          ok: true,
          requestId,
          results,
        },
        200,
        requestId,
        startedAt,
      )
    } catch (error) {
      logSearchError(requestId, 'request', getErrorCode(error, 'unknown_error'))
      return errorResponse('internal_error', 500, requestId, startedAt)
    }
  }

export const onRequestPost = createSearchHandler()

async function createWorkersAiEmbedding(
  env: SemanticSearchEnv,
  query: string,
): Promise<number[]> {
  const model = env.SEARCH_EMBEDDING_MODEL || SEARCH_EMBEDDING_MODEL
  const dimensions = Number(
    env.SEARCH_EMBEDDING_DIMENSIONS || SEARCH_EMBEDDING_DIMENSIONS,
  )
  if (
    model !== SEARCH_EMBEDDING_MODEL ||
    dimensions !== SEARCH_EMBEDDING_DIMENSIONS ||
    !env.AI
  ) {
    throw namedError('WorkersAiEmbeddingConfigurationError')
  }

  const payload: unknown = await env.AI.run(SEARCH_EMBEDDING_MODEL, {
    text: [query],
    truncate_inputs: false,
  })
  if (!isJsonObject(payload) || !Array.isArray(payload.data)) {
    throw namedError('WorkersAiEmbeddingCountError')
  }
  if (payload.data.length !== 1 || !Array.isArray(payload.data[0])) {
    throw namedError('WorkersAiEmbeddingCountError')
  }
  const embedding = payload.data[0]
  if (
    embedding.length !== SEARCH_EMBEDDING_DIMENSIONS ||
    embedding.some(
      (value) => typeof value !== 'number' || !Number.isFinite(value),
    )
  ) {
    throw namedError('WorkersAiEmbeddingDimensionsError')
  }
  if (
    (payload.pooling !== undefined && payload.pooling !== 'cls') ||
    (payload.shape !== undefined &&
      (!Array.isArray(payload.shape) ||
        payload.shape.length !== 2 ||
        payload.shape[0] !== 1 ||
        payload.shape[1] !== SEARCH_EMBEDDING_DIMENSIONS))
  ) {
    throw namedError('WorkersAiEmbeddingContractError')
  }
  return embedding as number[]
}

function namedError(name: string): Error {
  const error = new Error(name)
  error.name = name
  return error
}

function normalizeQuery(value: unknown): string | null {
  if (typeof value !== 'string') return null

  const query = value.normalize('NFKC').replace(/\s+/gu, ' ').trim()
  const length = [...query].length
  return length >= MIN_QUERY_LENGTH && length <= MAX_QUERY_LENGTH ? query : null
}

function isJapaneseLocale(value: unknown): boolean {
  return value === undefined || value === SEARCH_LOCALE
}

function normalizeClientId(value: string | null): string {
  const clientId = String(value || '').trim()
  return CLIENT_ID_PATTERN.test(clientId) ? clientId : 'anonymous'
}

async function readBoundedRequestText(
  request: Request,
  maxBytes: number,
): Promise<string | null> {
  const declaredLength = request.headers.get('Content-Length')
  if (declaredLength !== null) {
    const length = Number(declaredLength)
    if (!Number.isSafeInteger(length) || length < 0 || length > maxBytes) {
      return null
    }
  }

  if (!request.body) return ''

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let byteLength = 0

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      byteLength += value.byteLength
      if (byteLength > maxBytes) {
        await reader.cancel('request body too large').catch(() => undefined)
        return null
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const body = new Uint8Array(byteLength)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(body)
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

async function createClientRateLimitKey(request: Request): Promise<string> {
  const connectingIp = String(
    request.headers.get('CF-Connecting-IP') || '',
  ).trim()
  const source =
    connectingIp && connectingIp.length <= 64
      ? `ip:${connectingIp}`
      : `session:${normalizeClientId(
          request.headers.get('X-Acecore-Search-Client'),
        )}`
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(source),
  )
  return Array.from(new Uint8Array(digest), (value) =>
    value.toString(16).padStart(2, '0'),
  ).join('')
}

async function consumeRateLimit(
  database: D1Database,
  limiterKey: string,
  limit: number,
): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000)
  const windowStart =
    Math.floor(now / RATE_LIMIT_WINDOW_SECONDS) * RATE_LIMIT_WINDOW_SECONDS
  const result = await database
    .prepare(
      `INSERT INTO semantic_search_rate_limits
        (limiter_key, window_start, request_count, expires_at)
       VALUES (?, ?, 1, ?)
       ON CONFLICT (limiter_key, window_start) DO UPDATE SET
         request_count = semantic_search_rate_limits.request_count + 1,
         expires_at = excluded.expires_at
       WHERE semantic_search_rate_limits.request_count < ?
       RETURNING request_count`,
    )
    .bind(limiterKey, windowStart, now + RATE_LIMIT_RETENTION_SECONDS, limit)
    .first<{ request_count: number }>()

  return Boolean(
    result &&
    Number.isInteger(result.request_count) &&
    result.request_count <= limit,
  )
}

async function deleteExpiredRateLimits(database: D1Database): Promise<void> {
  const now = Math.floor(Date.now() / 1000)
  await database
    .prepare('DELETE FROM semantic_search_rate_limits WHERE expires_at < ?')
    .bind(now)
    .run()
}

function normalizeMinScore(value: string | undefined): number {
  const score = Number(value)
  return Number.isFinite(score) && score >= 0 && score <= 1
    ? score
    : DEFAULT_MIN_SCORE
}

function normalizeMatches(
  queryResult: VectorizeMatches,
  minScore: number,
): SearchResult[] {
  const results: SearchResult[] = []
  const seenUrls = new Set<string>()

  for (const match of queryResult.matches || []) {
    if (!Number.isFinite(match.score) || match.score < minScore) continue

    const id = readString(match.id, 128)
    const metadata = normalizeMetadata(match.metadata)
    if (!id || !metadata || seenUrls.has(metadata.url)) continue

    seenUrls.add(metadata.url)
    results.push({
      id,
      url: metadata.url,
      title: metadata.title,
      section: metadata.section,
      excerpt: metadata.excerpt,
      contentType: metadata.contentType,
      rank: results.length + 1,
    })
    if (results.length >= RESULT_LIMIT) break
  }

  return results
}

function normalizeMetadata(value: unknown): SearchMetadata | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null

  const metadata = value as Record<string, unknown>
  const pathname = getSafePublicPathname(metadata.url)
  const title = readString(metadata.title, 240)
  const section = readString(metadata.section, 240) || title
  const excerpt = readString(metadata.excerpt, 500)
  const contentType = readString(metadata.contentType, 40) || 'article'
  const locale = readString(metadata.locale, 16)
  if (
    !pathname ||
    !title ||
    locale !== SEARCH_LOCALE ||
    !pathname.startsWith('/article/')
  ) {
    return null
  }

  return {
    url: pathname,
    title,
    section,
    excerpt,
    contentType,
    locale: SEARCH_LOCALE,
  }
}

function getSafePublicPathname(value: unknown): string | null {
  const rawPathname = getRawUrl(value)
  if (
    !rawPathname ||
    !rawPathname.startsWith('/') ||
    rawPathname.startsWith('//')
  ) {
    return null
  }

  let pathname = rawPathname
  for (let pass = 0; pass < MAX_PATH_DECODE_PASSES; pass += 1) {
    pathname = pathname.normalize('NFKC')
    if (hasUnsafePathSyntax(pathname)) return null
    if (!pathname.includes('%')) break
    if (/%(?:2f|5c)/iu.test(pathname)) return null

    try {
      pathname = decodeURIComponent(pathname)
    } catch {
      return null
    }
  }

  pathname = pathname.normalize('NFKC')
  if (hasUnsafePathSyntax(pathname) || pathname.includes('%')) return null

  try {
    const url = new URL(pathname, CANONICAL_PATH_ORIGIN)
    return url.origin === CANONICAL_PATH_ORIGIN && !url.search && !url.hash
      ? url.pathname
      : null
  } catch {
    return null
  }
}

function getRawUrl(value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    !value ||
    [...value].length > MAX_URL_LENGTH
  ) {
    return null
  }

  const rawUrl = value.normalize('NFKC')
  if (
    !rawUrl ||
    [...rawUrl].length > MAX_URL_LENGTH ||
    /[\s\u0000-\u001F\u007F]/u.test(rawUrl) ||
    rawUrl.includes('\\') ||
    rawUrl.includes('?') ||
    rawUrl.includes('#') ||
    /[<>"']/u.test(rawUrl)
  ) {
    return null
  }

  return rawUrl
}

function hasUnsafePathSyntax(pathname: string): boolean {
  if (
    !pathname.startsWith('/') ||
    pathname.includes('//') ||
    pathname.includes('\\') ||
    pathname.includes('?') ||
    pathname.includes('#') ||
    /[\s\u0000-\u001F\u007F]/u.test(pathname) ||
    pathname.split('/').some((segment) => segment === '.' || segment === '..')
  ) {
    return true
  }

  const firstSegment = pathname.split('/')[1]?.toLowerCase()
  return firstSegment === 'admin' || firstSegment === 'api'
}

function getErrorCode(error: unknown, fallback: string): string {
  return error instanceof Error && error.name ? error.name : fallback
}

function readString(value: unknown, maxLength: number): string {
  return typeof value === 'string'
    ? value.normalize('NFKC').trim().slice(0, maxLength)
    : ''
}

function isSameOriginRequest(request: Request): boolean {
  const origin = request.headers.get('Origin')
  if (!origin) return false

  try {
    return new URL(origin).origin === new URL(request.url).origin
  } catch {
    return false
  }
}

function errorResponse(
  code: string,
  status: number,
  requestId: string,
  startedAt: number,
  extraHeaders: Record<string, string> = {},
): Response {
  return jsonResponse(
    { ok: false, error: { code }, requestId },
    status,
    requestId,
    startedAt,
    extraHeaders,
  )
}

function jsonResponse(
  body: unknown,
  status: number,
  requestId: string,
  startedAt: number,
  extraHeaders: Record<string, string> = {},
): Response {
  const duration = Math.max(0, performance.now() - startedAt).toFixed(1)
  return Response.json(body, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Server-Timing': `search;dur=${duration}`,
      'X-Content-Type-Options': 'nosniff',
      'X-Search-Request-Id': requestId,
      ...extraHeaders,
    },
  })
}

function logSearchError(
  requestId: string,
  stage: string,
  errorCode: string,
): void {
  console.error(
    JSON.stringify({
      event: 'semantic_search_error',
      requestId,
      locale: SEARCH_LOCALE,
      stage,
      errorCode,
    }),
  )
}
