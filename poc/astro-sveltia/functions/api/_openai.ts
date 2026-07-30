export const OPENAI_API_BASE_URL = 'https://api.openai.com/v1'
export const OPENAI_RESPONSE_MODEL = 'gpt-5.6-luna'
export const OPENAI_REASONING_EFFORT = 'low'
export const OPENAI_EMBEDDING_MODEL = 'text-embedding-3-large'
export const OPENAI_EMBEDDING_DIMENSIONS = 1536

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const MAX_RESPONSE_BYTES = 1_000_000

type OpenAiRequestOptions = {
  apiKey: string
  body: Record<string, unknown>
  endpoint: '/embeddings' | '/responses'
  fetchImpl: typeof fetch
  requestTimeoutMs: number
}

type OpenAiEmbeddingOptions = {
  apiKey: string
  dimensions?: number
  fetchImpl?: typeof fetch
  input: string | string[]
  model?: string
  requestTimeoutMs?: number
  user?: string
}

type OpenAiStructuredResponseOptions = {
  apiKey: string
  description: string
  fetchImpl?: typeof fetch
  input: string
  instructions: string
  maxOutputTokens: number
  model?: string
  reasoningEffort?: string
  requestTimeoutMs?: number
  safetyIdentifier?: string
  schema: Record<string, unknown>
  schemaName: string
}

export async function createOpenAiEmbeddings({
  apiKey,
  dimensions = OPENAI_EMBEDDING_DIMENSIONS,
  fetchImpl = fetch,
  input,
  model = OPENAI_EMBEDDING_MODEL,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  user,
}: OpenAiEmbeddingOptions): Promise<number[][]> {
  if (
    model !== OPENAI_EMBEDDING_MODEL ||
    dimensions !== OPENAI_EMBEDDING_DIMENSIONS
  ) {
    throw namedError('OpenAIEmbeddingConfigurationError')
  }

  const inputs = Array.isArray(input) ? input : [input]
  if (
    inputs.length === 0 ||
    inputs.some((value) => typeof value !== 'string' || !value.trim())
  ) {
    throw namedError('OpenAIEmbeddingInputError')
  }

  const body: Record<string, unknown> = {
    model,
    input,
    dimensions,
    encoding_format: 'float',
  }
  if (user) body.user = user

  const payload = await requestOpenAiJson({
    apiKey,
    endpoint: '/embeddings',
    body,
    fetchImpl,
    requestTimeoutMs,
  })

  if (!isJsonObject(payload) || payload.model !== model) {
    throw namedError('OpenAIEmbeddingModelError')
  }
  return extractOpenAiEmbeddingData(payload, inputs.length, dimensions)
}

export async function createOpenAiStructuredResponse({
  apiKey,
  description,
  fetchImpl = fetch,
  input,
  instructions,
  maxOutputTokens,
  model = OPENAI_RESPONSE_MODEL,
  reasoningEffort = OPENAI_REASONING_EFFORT,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  safetyIdentifier,
  schema,
  schemaName,
}: OpenAiStructuredResponseOptions): Promise<string> {
  if (
    model !== OPENAI_RESPONSE_MODEL ||
    reasoningEffort !== OPENAI_REASONING_EFFORT
  ) {
    throw namedError('OpenAIResponseConfigurationError')
  }

  const body: Record<string, unknown> = {
    model,
    instructions,
    input,
    reasoning: {
      effort: reasoningEffort,
    },
    max_output_tokens: maxOutputTokens,
    store: false,
    text: {
      format: {
        type: 'json_schema',
        name: schemaName,
        description,
        strict: true,
        schema,
      },
    },
  }
  if (safetyIdentifier) body.safety_identifier = safetyIdentifier

  const payload = await requestOpenAiJson({
    apiKey,
    endpoint: '/responses',
    body,
    fetchImpl,
    requestTimeoutMs,
  })

  return extractOpenAiResponseText(payload)
}

export function extractOpenAiEmbeddingData(
  payload: unknown,
  expectedCount: number,
  dimensions = OPENAI_EMBEDDING_DIMENSIONS,
): number[][] {
  if (!isJsonObject(payload) || !Array.isArray(payload.data)) {
    throw namedError('OpenAIEmbeddingCountError')
  }
  if (payload.data.length !== expectedCount) {
    throw namedError('OpenAIEmbeddingCountError')
  }

  const ordered: Array<number[] | undefined> = Array(expectedCount)
  for (const value of payload.data) {
    if (
      !isJsonObject(value) ||
      !Number.isInteger(value.index) ||
      Number(value.index) < 0 ||
      Number(value.index) >= expectedCount ||
      ordered[Number(value.index)]
    ) {
      throw namedError('OpenAIEmbeddingIndexError')
    }

    if (
      !Array.isArray(value.embedding) ||
      value.embedding.length !== dimensions ||
      value.embedding.some(
        (entry) => typeof entry !== 'number' || !Number.isFinite(entry),
      )
    ) {
      throw namedError('OpenAIEmbeddingDimensionsError')
    }
    ordered[Number(value.index)] = value.embedding as number[]
  }

  if (ordered.some((embedding) => embedding === undefined)) {
    throw namedError('OpenAIEmbeddingIndexError')
  }
  return ordered as number[][]
}

export function extractOpenAiResponseText(payload: unknown): string {
  if (
    !isJsonObject(payload) ||
    payload.status !== 'completed' ||
    payload.error ||
    !Array.isArray(payload.output)
  ) {
    throw namedError('OpenAIResponsePayloadError')
  }

  const texts: string[] = []
  for (const output of payload.output) {
    if (!isJsonObject(output) || output.type !== 'message') continue
    if (!Array.isArray(output.content)) {
      throw namedError('OpenAIResponsePayloadError')
    }

    for (const content of output.content) {
      if (!isJsonObject(content)) {
        throw namedError('OpenAIResponsePayloadError')
      }
      if (content.type === 'refusal') {
        throw namedError('OpenAIResponseRefusalError')
      }
      if (content.type === 'output_text' && typeof content.text === 'string') {
        texts.push(content.text)
      }
    }
  }

  if (texts.length !== 1 || !texts[0].trim()) {
    throw namedError('OpenAIResponsePayloadError')
  }
  return texts[0]
}

async function requestOpenAiJson({
  apiKey,
  body,
  endpoint,
  fetchImpl,
  requestTimeoutMs,
}: OpenAiRequestOptions): Promise<unknown> {
  if (!apiKey.trim()) throw namedError('OpenAIConfigurationError')

  const controller = new AbortController()
  const timeout = setTimeout(
    () => controller.abort(namedError('OpenAIRequestTimeoutError')),
    requestTimeoutMs,
  )

  try {
    const response = await fetchImpl(`${OPENAI_API_BASE_URL}${endpoint}`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey.trim()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })

    const declaredLength = response.headers.get('Content-Length')
    if (declaredLength !== null) {
      const length = Number(declaredLength)
      if (
        !Number.isSafeInteger(length) ||
        length < 0 ||
        length > MAX_RESPONSE_BYTES
      ) {
        await response.body?.cancel().catch(() => undefined)
        throw namedError('OpenAIResponseSizeError')
      }
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      throw namedError('OpenAIHttpError', response.status)
    }

    const text = await readBoundedResponseText(response, MAX_RESPONSE_BYTES)
    if (text === null || !text) throw namedError('OpenAIResponseSizeError')
    try {
      return JSON.parse(text)
    } catch {
      throw namedError('OpenAIResponseJsonError')
    }
  } finally {
    clearTimeout(timeout)
  }
}

async function readBoundedResponseText(
  response: Response,
  maximumBytes: number,
): Promise<string | null> {
  if (!response.body) return ''

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let byteLength = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      byteLength += value.byteLength
      if (byteLength > maximumBytes) {
        await reader.cancel('response body too large').catch(() => undefined)
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

function namedError(
  name: string,
  status?: number,
): Error & { status?: number } {
  const error = new Error(name) as Error & { status?: number }
  error.name = name
  if (Number.isInteger(status)) error.status = status
  return error
}
