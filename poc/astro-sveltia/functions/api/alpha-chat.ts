const MAX_SHARED_REQUEST_BYTES = 96 * 1024
const MAX_SHARED_RESPONSE_BYTES = 96 * 1024
const MAX_QUESTION_CHARACTERS = 500
const MAX_MESSAGES = 8
const MAX_CONVERSATION_CHARACTERS = 2_800
const MAX_RESPONSE_SOURCES = 2

const RATE_LIMIT_WINDOW_SECONDS = 60
const RATE_LIMIT_RETENTION_SECONDS = 600
const CLIENT_RATE_LIMIT = 5
const GLOBAL_RATE_LIMIT = 60
const CLIENT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

const INVALID_REQUEST_ANSWER =
  'リクエスト形式が正しくないみたい。もう一度送ってね。'
const REQUEST_TOO_LARGE_ANSWER =
  '送信内容が大きすぎるみたい。質問を短くして送ってね。'
const QUESTION_TOO_LONG_ANSWER = '質問が長いみたい。少し短く分けて聞いてね。'
const CONVERSATION_TOO_LONG_ANSWER =
  '会話が長くなってきたよ。聞きたいことを短くまとめてもう一度送ってね。'
const UNAVAILABLE_ANSWER =
  'いまはまだうまく答えられないんだ。少し時間をおいて、もう一度聞いてね。'
const SERVICE_FAILURE_ANSWER =
  'いまはうまく答えを届けられなかったよ。少し時間をおいて、もう一度聞いてね。'

type AlphaChatEnv = Omit<
  Env,
  'ALPHA_CHAT_ENABLED' | 'ALPHA_CHAT_SERVICE'
> & {
  ALPHA_CHAT_ENABLED?: string
  ALPHA_CHAT_SERVICE?: Fetcher
}

type ChatMessage = {
  content: string
  loreRevisionId?: string
  role: 'assistant' | 'user'
}

type AlphaSource = {
  title: string
  url: string
}

type AlphaResponse = {
  answer: string
  conversationContextReset?: boolean
  loreRevisionId?: string
  nextConversationContext?: Record<string, unknown>
  ok: boolean
  personaVersion?: string
  sources: AlphaSource[]
}

type SharedPayloadValidation =
  | { ok: true; value: Record<string, unknown> }
  | { answer: string; ok: false }

export const createAlphaChatHandler = (): PagesFunction<AlphaChatEnv> =>
  async (context) => {
    const startedAt = performance.now()
    const requestId = crypto.randomUUID()
    const { env, request } = context

    try {
      if (!isSameOriginRequest(request)) {
        return alphaResponse(
          { ok: false, answer: INVALID_REQUEST_ANSWER, sources: [] },
          403,
          requestId,
          startedAt,
        )
      }
      if (!isJsonRequest(request)) {
        return alphaResponse(
          { ok: false, answer: INVALID_REQUEST_ANSWER, sources: [] },
          415,
          requestId,
          startedAt,
        )
      }
      if (
        env.ALPHA_CHAT_ENABLED !== 'true' ||
        !env.CMS_DATABASE ||
        !env.ALPHA_CHAT_SERVICE
      ) {
        return alphaResponse(
          { ok: false, answer: UNAVAILABLE_ANSWER, sources: [] },
          503,
          requestId,
          startedAt,
        )
      }

      let shouldCleanupRateLimits = false
      try {
        const clientKey = await createClientRateLimitKey(request)
        const clientLimit = await consumeRateLimit(
          env.CMS_DATABASE,
          `alpha-client:${clientKey}`,
          CLIENT_RATE_LIMIT,
        )
        if (!clientLimit.allowed) {
          return rateLimitResponse(requestId, startedAt)
        }

        const globalLimit = await consumeRateLimit(
          env.CMS_DATABASE,
          'alpha-global',
          GLOBAL_RATE_LIMIT,
        )
        if (!globalLimit.allowed) {
          return rateLimitResponse(requestId, startedAt)
        }
        shouldCleanupRateLimits = globalLimit.count === 1
      } catch (error) {
        logAlphaError(
          requestId,
          'rate_limit',
          getErrorCode(error, 'storage_error'),
        )
        return alphaResponse(
          { ok: false, answer: UNAVAILABLE_ANSWER, sources: [] },
          503,
          requestId,
          startedAt,
        )
      }

      if (shouldCleanupRateLimits) {
        context.waitUntil(
          deleteExpiredRateLimits(env.CMS_DATABASE).catch((error) => {
            logAlphaError(
              requestId,
              'rate_limit_cleanup',
              getErrorCode(error, 'storage_error'),
            )
          }),
        )
      }

      const requestText = await readBoundedText(
        request,
        MAX_SHARED_REQUEST_BYTES,
      )
      if (requestText === null) {
        return alphaResponse(
          { ok: false, answer: REQUEST_TOO_LARGE_ANSWER, sources: [] },
          413,
          requestId,
          startedAt,
        )
      }

      let parsedPayload: unknown
      try {
        parsedPayload = JSON.parse(requestText)
      } catch {
        return alphaResponse(
          { ok: false, answer: INVALID_REQUEST_ANSWER, sources: [] },
          400,
          requestId,
          startedAt,
        )
      }
      const payloadResult = normalizeSharedPayload(parsedPayload)
      if (!payloadResult.ok) {
        return alphaResponse(
          { ok: false, answer: payloadResult.answer, sources: [] },
          400,
          requestId,
          startedAt,
        )
      }

      const locale = String(payloadResult.value.locale || 'ja')
      const serviceResponse = await env.ALPHA_CHAT_SERVICE.fetch(
        new Request('https://aceserver-alpha-chat.internal/v1/chat', {
          body: JSON.stringify({
            payload: payloadResult.value,
            surface: 'wiki',
            version: 1,
          }),
          headers: {
            Accept: 'application/json',
            'Accept-Language': locale,
            'Content-Type': 'application/json',
          },
          method: 'POST',
        }),
      )
      const responseText = await readBoundedText(
        serviceResponse,
        MAX_SHARED_RESPONSE_BYTES,
      )
      if (responseText === null) {
        throw namedError('AlphaChatServiceResponseSize')
      }
      const sharedBody = normalizeSharedAlphaResponse(
        JSON.parse(responseText),
      )
      if (!sharedBody) throw namedError('AlphaChatServiceResponsePayload')

      return alphaResponse(
        sharedBody,
        normalizeServiceStatus(serviceResponse.status),
        requestId,
        startedAt,
      )
    } catch (error) {
      logAlphaError(
        requestId,
        'shared_service',
        getErrorCode(error, 'service_error'),
      )
      return alphaResponse(
        { ok: false, answer: SERVICE_FAILURE_ANSWER, sources: [] },
        503,
        requestId,
        startedAt,
      )
    }
  }

export const onRequestPost = createAlphaChatHandler()

function normalizeSharedAlphaResponse(value: unknown): AlphaResponse | null {
  if (!isJsonObject(value) || typeof value.ok !== 'boolean') return null
  const answer = readPublicAnswer(value.answer)
  if (!answer) return null

  const loreRevisionId = readOptionalString(value.loreRevisionId, 128)
  if (loreRevisionId === null) return null
  const personaVersion = readOptionalString(value.personaVersion, 64)
  if (personaVersion === null) return null
  const nextConversationContext = readSharedConversationContext(
    value.nextConversationContext,
  )
  const conversationContextReset =
    value.conversationContextReset === true ||
    (value.nextConversationContext !== undefined && !nextConversationContext)
  const hasConversationContextReset =
    typeof value.conversationContextReset === 'boolean' ||
    (value.nextConversationContext !== undefined && !nextConversationContext)
  const sources = Array.isArray(value.sources)
    ? value.sources
        .map((source) => {
          if (!isJsonObject(source)) return null
          const title = readString(source.title, 240)
          const url = normalizeArticleUrl(source.url, ORIGIN_PLACEHOLDER)
          return title && url ? { title, url } : null
        })
        .filter((source): source is AlphaSource => source !== null)
        .slice(0, MAX_RESPONSE_SOURCES)
    : []

  return {
    answer,
    ok: value.ok,
    sources,
    ...(hasConversationContextReset ? { conversationContextReset } : {}),
    ...(loreRevisionId ? { loreRevisionId } : {}),
    ...(nextConversationContext ? { nextConversationContext } : {}),
    ...(personaVersion ? { personaVersion } : {}),
  }
}

function normalizeSharedPayload(value: unknown): SharedPayloadValidation {
  if (!isJsonObject(value)) {
    return { ok: false, answer: INVALID_REQUEST_ANSWER }
  }

  const question = normalizeInputText(value.question)
  if (!question) return { ok: false, answer: INVALID_REQUEST_ANSWER }
  if (characterLength(question) > MAX_QUESTION_CHARACTERS) {
    return { ok: false, answer: QUESTION_TOO_LONG_ANSWER }
  }

  const locale =
    value.locale === undefined ? 'ja' : readStrictString(value.locale, 16)
  if (!locale) return { ok: false, answer: INVALID_REQUEST_ANSWER }

  const loreRevisionId = readOptionalString(value.loreRevisionId, 128)
  if (loreRevisionId === null) {
    return { ok: false, answer: INVALID_REQUEST_ANSWER }
  }

  const messagesResult = normalizeMessages(value.messages, question)
  if (!messagesResult.ok) return messagesResult

  return {
    ok: true,
    value: {
      locale,
      question,
      ...(messagesResult.messages
        ? { messages: messagesResult.messages }
        : {}),
      ...(Object.hasOwn(value, 'conversationContext')
        ? { conversationContext: value.conversationContext }
        : {}),
      ...(loreRevisionId ? { loreRevisionId } : {}),
    },
  }
}

function normalizeMessages(
  value: unknown,
  question: string,
):
  | { ok: true; messages?: ChatMessage[] }
  | { answer: string; ok: false } {
  if (value === undefined) return { ok: true }
  if (!Array.isArray(value)) {
    return { ok: false, answer: INVALID_REQUEST_ANSWER }
  }
  if (value.length > MAX_MESSAGES) {
    return { ok: false, answer: CONVERSATION_TOO_LONG_ANSWER }
  }

  const messages: ChatMessage[] = []
  for (const rawMessage of value) {
    if (
      !isJsonObject(rawMessage) ||
      (rawMessage.role !== 'user' && rawMessage.role !== 'assistant')
    ) {
      return { ok: false, answer: INVALID_REQUEST_ANSWER }
    }
    const content = normalizeInputText(rawMessage.content, false)
    if (!content) return { ok: false, answer: INVALID_REQUEST_ANSWER }
    const loreRevisionId = readOptionalString(rawMessage.loreRevisionId, 128)
    if (loreRevisionId === null) {
      return { ok: false, answer: INVALID_REQUEST_ANSWER }
    }
    messages.push({
      content,
      role: rawMessage.role,
      ...(loreRevisionId ? { loreRevisionId } : {}),
    })
  }

  const last = messages.at(-1)
  if (!last || last.role !== 'user' || last.content !== question) {
    messages.push({ content: question, role: 'user' })
  }
  const conversation = messages.slice(-MAX_MESSAGES)
  const conversationCharacters = conversation.reduce(
    (total, message) => total + characterLength(message.content),
    0,
  )
  if (conversationCharacters > MAX_CONVERSATION_CHARACTERS) {
    return { ok: false, answer: CONVERSATION_TOO_LONG_ANSWER }
  }
  return { ok: true, messages: conversation }
}

function readSharedConversationContext(
  value: unknown,
): Record<string, unknown> | null {
  if (!isJsonObject(value)) return null
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength <=
      64 * 1024
      ? value
      : null
  } catch {
    return null
  }
}

const ORIGIN_PLACEHOLDER = 'https://asv-wiki.acecore.net/'

function normalizeServiceStatus(value: number): number {
  return Number.isInteger(value) && value >= 200 && value <= 599 ? value : 502
}

function normalizeArticleUrl(
  value: unknown,
  requestUrl: string,
): string | null {
  const rawUrl = readString(value, 500)
  if (!rawUrl || rawUrl.startsWith('//') || rawUrl.includes('\\')) return null
  try {
    const requestOrigin = new URL(requestUrl).origin
    const resolved = new URL(rawUrl, requestUrl)
    if (
      resolved.origin !== requestOrigin ||
      !resolved.pathname.startsWith('/article/') ||
      resolved.search ||
      resolved.hash
    ) {
      return null
    }
    return resolved.pathname
  } catch {
    return null
  }
}

function readPublicAnswer(value: unknown): string {
  if (typeof value !== 'string') return ''
  const answer = value.trim()
  return answer && characterLength(answer) <= 16_000 ? answer : ''
}

function normalizeInputText(value: unknown, collapseWhitespace = true): string {
  if (typeof value !== 'string') return ''
  const normalized = value.trim()
  return collapseWhitespace
    ? normalized.replace(/\s+/gu, ' ')
    : normalized
        .replace(/\r\n?/gu, '\n')
        .replace(/[ \t]+/gu, ' ')
        .replace(/\n{3,}/gu, '\n\n')
}

function readStrictString(value: unknown, maximumLength: number): string {
  if (typeof value !== 'string') return ''
  const normalized = value.trim()
  return normalized && normalized.length <= maximumLength ? normalized : ''
}

function readOptionalString(
  value: unknown,
  maximumLength: number,
): string | undefined | null {
  if (value === undefined) return undefined
  const normalized = readStrictString(value, maximumLength)
  return normalized || null
}

function readString(value: unknown, maximumLength: number): string {
  return typeof value === 'string'
    ? value
        .normalize('NFKC')
        .replace(/\s+/gu, ' ')
        .trim()
        .slice(0, maximumLength)
    : ''
}

function characterLength(value: string): number {
  return [...value].length
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isJsonRequest(request: Request): boolean {
  return (
    request.headers
      .get('Content-Type')
      ?.split(';', 1)[0]
      ?.trim()
      .toLowerCase() === 'application/json'
  )
}

function isSameOriginRequest(request: Request): boolean {
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site') return false
  const origin = request.headers.get('Origin')
  if (!origin) return false
  try {
    return new URL(origin).origin === new URL(request.url).origin
  } catch {
    return false
  }
}

async function readBoundedText(
  source: Request | Response,
  maximumBytes: number,
): Promise<string | null> {
  const contentLength = source.headers.get('Content-Length')
  if (contentLength !== null) {
    const length = Number(contentLength)
    if (!Number.isSafeInteger(length) || length < 0 || length > maximumBytes) {
      return null
    }
  }
  if (!source.body) return ''

  const reader = source.body.getReader()
  const chunks: Uint8Array[] = []
  let byteLength = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      byteLength += value.byteLength
      if (byteLength > maximumBytes) {
        await reader.cancel('body too large').catch(() => undefined)
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

async function createClientRateLimitKey(request: Request): Promise<string> {
  const connectingIp = readString(request.headers.get('CF-Connecting-IP'), 64)
  const rawClientId = readString(
    request.headers.get('X-Acecore-Chat-Client'),
    64,
  )
  const clientId = CLIENT_ID_PATTERN.test(rawClientId)
    ? rawClientId
    : 'anonymous'
  const source = connectingIp ? `ip:${connectingIp}` : `session:${clientId}`
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(source),
  )
  return Array.from(new Uint8Array(digest), (entry) =>
    entry.toString(16).padStart(2, '0'),
  ).join('')
}

async function consumeRateLimit(
  database: D1Database,
  limiterKey: string,
  limit: number,
): Promise<{ allowed: boolean; count: number }> {
  const now = Math.floor(Date.now() / 1_000)
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

  const count =
    result && Number.isInteger(result.request_count) ? result.request_count : 0
  return {
    allowed: count > 0 && count <= limit,
    count,
  }
}

async function deleteExpiredRateLimits(database: D1Database): Promise<void> {
  await database
    .prepare('DELETE FROM semantic_search_rate_limits WHERE expires_at < ?')
    .bind(Math.floor(Date.now() / 1_000))
    .run()
}

function rateLimitResponse(requestId: string, startedAt: number): Response {
  return alphaResponse(
    { ok: false, answer: UNAVAILABLE_ANSWER, sources: [] },
    429,
    requestId,
    startedAt,
    { 'Retry-After': String(RATE_LIMIT_WINDOW_SECONDS) },
  )
}

function alphaResponse(
  body: AlphaResponse,
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
      'Server-Timing': `alpha-chat;dur=${duration}`,
      'X-Alpha-Chat-Request-Id': requestId,
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders,
    },
  })
}

function namedError(name: string): Error {
  const error = new Error(name)
  error.name = name
  return error
}

function getErrorCode(error: unknown, fallback: string): string {
  return error instanceof Error && error.name ? error.name : fallback
}

function logAlphaError(
  requestId: string,
  stage: string,
  errorCode: string,
): void {
  console.error(
    JSON.stringify({
      event: 'alpha_chat_error',
      requestId,
      stage,
      errorCode,
    }),
  )
}
