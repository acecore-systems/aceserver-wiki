import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const API_BASE_URL = 'https://api.cloudflare.com/client/v4'
const OPENAI_API_BASE_URL = 'https://api.openai.com/v1'
const DEFAULT_CORPUS_FILE = resolve('dist/vector-corpus.json')
const EMBEDDING_MODEL = 'text-embedding-3-large'
const EMBEDDING_DIMENSIONS = 1536
const DISTANCE_METRIC = 'cosine'
const EMBEDDING_BATCH_SIZE = 32
const UPSERT_BATCH_SIZE = 200
const DELETE_BATCH_SIZE = 100
const LIST_BATCH_SIZE = 1000
const MUTATION_WAIT_TIMEOUT_MS = 180_000
const MUTATION_POLL_INTERVAL_MS = 5_000
const REQUEST_TIMEOUT_MS = 30_000
const MAX_REQUEST_RETRIES = 5
const RETRY_BASE_DELAY_MS = 500
const MAX_LIST_CURSOR_RESTARTS = 3
const MAX_DELETE_RATIO = 0.2
const MIN_SOURCE_COUNT = 15
const MIN_VECTOR_COUNT = 15
const MAX_VECTOR_COUNT = 500
const MAX_OPENAI_RESPONSE_BYTES = 4_000_000
const MAX_CLOUDFLARE_RESPONSE_BYTES = 4_000_000
const MANAGED_VECTOR_ID_PATTERN = /^v1-[0-9a-f]{48}$/u
const CORPUS_VERSION_PATTERN = /^[0-9a-f]{20}$/u
const PRODUCTION_INDEX_NAME =
  'aceserver-wiki-search-openai-1536-production'
const ALLOWED_INDEX_NAMES = new Set([
  PRODUCTION_INDEX_NAME,
])

class CloudflareApiError extends Error {
  constructor(message, status) {
    super(message)
    this.name = 'CloudflareApiError'
    this.status = status
  }
}

class OpenAiApiError extends Error {
  constructor(message, status) {
    super(message)
    this.name = 'OpenAiApiError'
    this.status = status
  }
}

export async function syncVectorize({
  accountId = process.env.CLOUDFLARE_ACCOUNT_ID,
  apiToken = process.env.CLOUDFLARE_API_TOKEN,
  openAiApiKey = process.env.OPENAI_API_KEY,
  indexName = process.env.VECTORIZE_INDEX_NAME,
  confirmProduction = process.env.VECTORIZE_CONFIRM_PRODUCTION,
  corpusFile = DEFAULT_CORPUS_FILE,
  dryRun = false,
  waitForMutations = true,
  allowLargeDelete = false,
  fetchImpl = globalThis.fetch,
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
  retryBaseDelayMs = RETRY_BASE_DELAY_MS,
  sleepImpl = sleep,
  randomImpl = Math.random,
  logger = console,
} = {}) {
  const corpus = JSON.parse(await readFile(corpusFile, 'utf8'))
  validateCorpus(corpus)
  validateIndexName(indexName, { required: !dryRun })

  if (dryRun) {
    const result = {
      dryRun: true,
      indexName: indexName || null,
      corpusVersion: corpus.version,
      sources: corpus.sourceCount,
      vectors: corpus.vectorCount,
    }
    logger.log(JSON.stringify({ event: 'vectorize_sync_dry_run', ...result }))
    return result
  }

  if (confirmProduction !== PRODUCTION_INDEX_NAME) {
    throw new Error(
      `Production sync requires --confirm-production ${PRODUCTION_INDEX_NAME}.`,
    )
  }

  if (!accountId || !apiToken || !openAiApiKey) {
    throw new Error(
      'CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, and OPENAI_API_KEY are required.',
    )
  }

  const client = createCloudflareClient({
    accountId,
    apiToken,
    fetchImpl,
    requestTimeoutMs,
    retryBaseDelayMs,
    sleepImpl,
    randomImpl,
  })
  const embeddingClient = {
    apiKey: openAiApiKey,
    fetchImpl,
    requestTimeoutMs,
    retryBaseDelayMs,
    sleepImpl,
    randomImpl,
  }
  const index = await ensureIndex(client, indexName)
  validateIndexConfiguration(index, indexName)

  const currentIds = await listVectorIds(client, indexName, {
    logger,
    sleepImpl,
    retryBaseDelayMs,
  })
  validateExistingVectorIds(currentIds, indexName)

  const expectedIds = new Set(corpus.chunks.map(({ id }) => id))
  const chunksToUpsert = corpus.chunks.filter(({ id }) => !currentIds.has(id))
  const idsToDelete = [...currentIds].filter((id) => !expectedIds.has(id))
  validateDeletePlan({
    currentCount: currentIds.size,
    deleteCount: idsToDelete.length,
    allowLargeDelete,
  })

  logger.log(
    JSON.stringify({
      event: 'vectorize_sync_plan',
      indexName,
      corpusVersion: corpus.version,
      current: currentIds.size,
      expected: expectedIds.size,
      upsert: chunksToUpsert.length,
      delete: idsToDelete.length,
    }),
  )

  const mutationIds = []
  for (const chunkBatch of batches(chunksToUpsert, EMBEDDING_BATCH_SIZE)) {
    const embeddings = await createEmbeddings(embeddingClient, chunkBatch)
    const vectors = chunkBatch.map((chunk, indexInBatch) => ({
      id: chunk.id,
      values: embeddings[indexInBatch],
      namespace: chunk.namespace,
      metadata: chunk.metadata,
    }))

    for (const vectorBatch of batches(vectors, UPSERT_BATCH_SIZE)) {
      mutationIds.push(await upsertVectors(client, indexName, vectorBatch))
    }
  }

  for (const idBatch of batches(idsToDelete, DELETE_BATCH_SIZE)) {
    mutationIds.push(await deleteVectors(client, indexName, idBatch))
  }

  const lastMutationId = mutationIds.at(-1)
  if (waitForMutations && lastMutationId) {
    await waitForMutation(client, indexName, lastMutationId, {
      sleepImpl,
    })
  }

  const result = {
    dryRun: false,
    indexName,
    corpusVersion: corpus.version,
    existing: currentIds.size,
    upserted: chunksToUpsert.length,
    deleted: idsToDelete.length,
    mutationId: lastMutationId || null,
  }
  logger.log(JSON.stringify({ event: 'vectorize_sync_complete', ...result }))
  return result
}

export function validateCorpus(corpus) {
  if (
    corpus?.schemaVersion !== 1 ||
    !CORPUS_VERSION_PATTERN.test(corpus?.version || '') ||
    corpus?.embedding?.model !== EMBEDDING_MODEL ||
    corpus?.embedding?.dimensions !== EMBEDDING_DIMENSIONS ||
    corpus?.embedding?.metric !== DISTANCE_METRIC
  ) {
    throw new Error(
      `Corpus must use schema 1, ${EMBEDDING_MODEL}, ${EMBEDDING_DIMENSIONS} dimensions, and ${DISTANCE_METRIC}.`,
    )
  }

  if (
    !Number.isInteger(corpus.sourceCount) ||
    corpus.sourceCount < MIN_SOURCE_COUNT
  ) {
    throw new Error(
      `Corpus must contain at least ${MIN_SOURCE_COUNT} source documents.`,
    )
  }
  if (
    !Array.isArray(corpus.chunks) ||
    !Number.isInteger(corpus.vectorCount) ||
    corpus.chunks.length !== corpus.vectorCount ||
    corpus.vectorCount < MIN_VECTOR_COUNT ||
    corpus.vectorCount > MAX_VECTOR_COUNT
  ) {
    throw new Error(
      `Corpus vector count must be between ${MIN_VECTOR_COUNT} and ${MAX_VECTOR_COUNT}.`,
    )
  }
  if (corpus?.localeCounts?.ja !== corpus.vectorCount) {
    throw new Error('Corpus localeCounts.ja must match vectorCount.')
  }

  const ids = new Set()
  const urls = new Set()
  for (const chunk of corpus.chunks) {
    const metadata = chunk?.metadata
    if (
      typeof chunk?.id !== 'string' ||
      !MANAGED_VECTOR_ID_PATTERN.test(chunk.id) ||
      chunk.namespace !== 'ja' ||
      typeof chunk.text !== 'string' ||
      chunk.text.length < 1 ||
      chunk.text.length > 1200 ||
      !isBoundedString(metadata?.url, 500) ||
      !metadata.url.startsWith('/article/') ||
      !metadata.url.endsWith('/') ||
      !isBoundedString(metadata?.title, 240) ||
      !isBoundedString(metadata?.section, 240) ||
      !isBoundedString(metadata?.excerpt, 500) ||
      !isBoundedString(metadata?.category, 100) ||
      metadata?.locale !== 'ja'
    ) {
      throw new Error('Corpus contains an invalid chunk.')
    }
    if (ids.has(chunk.id)) {
      throw new Error(`Duplicate vector id: ${chunk.id}`)
    }
    ids.add(chunk.id)
    urls.add(metadata.url)
  }

  if (urls.size !== corpus.sourceCount) {
    throw new Error('Corpus sourceCount must match the unique article URLs.')
  }
}

export function extractEmbeddingData(payload, expectedCount) {
  const data = payload?.data
  if (!Array.isArray(data) || data.length !== expectedCount) {
    throw new Error(
      `OpenAI returned ${Array.isArray(data) ? data.length : 0} embeddings; expected ${expectedCount}.`,
    )
  }

  const ordered = Array(expectedCount)
  for (const entry of data) {
    if (
      !Number.isInteger(entry?.index) ||
      entry.index < 0 ||
      entry.index >= expectedCount ||
      ordered[entry.index]
    ) {
      throw new Error('OpenAI embedding response contains an invalid index.')
    }

    const values = entry?.embedding
    if (
      !Array.isArray(values) ||
      values.length !== EMBEDDING_DIMENSIONS ||
      values.some((value) => !Number.isFinite(value))
    ) {
      throw new Error(
        `OpenAI embedding must contain ${EMBEDDING_DIMENSIONS} finite values.`,
      )
    }
    ordered[entry.index] = values
  }
  if (ordered.some((values) => !values)) {
    throw new Error('OpenAI embedding response is missing an index.')
  }
  return ordered
}

export function validateDeletePlan({
  currentCount,
  deleteCount,
  allowLargeDelete,
}) {
  if (
    deleteCount === 0 ||
    currentCount === 0 ||
    deleteCount / currentCount <= MAX_DELETE_RATIO ||
    allowLargeDelete
  ) {
    return
  }

  const percentage = ((deleteCount / currentCount) * 100).toFixed(1)
  throw new Error(
    `Refusing to delete ${deleteCount}/${currentCount} vectors (${percentage}%); pass --allow-large-delete to override.`,
  )
}

function isBoundedString(value, maximumLength) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximumLength
  )
}

function validateIndexName(indexName, { required }) {
  if (!indexName && !required) return
  if (!ALLOWED_INDEX_NAMES.has(indexName)) {
    throw new Error(
      `VECTORIZE_INDEX_NAME must be one of: ${[...ALLOWED_INDEX_NAMES].join(', ')}.`,
    )
  }
}

function validateExistingVectorIds(ids, indexName) {
  const unmanagedIds = [...ids].filter(
    (id) => !MANAGED_VECTOR_ID_PATTERN.test(id),
  )
  if (unmanagedIds.length === 0) return

  throw new Error(
    `Vectorize index ${indexName} contains unmanaged vector IDs; refusing to mutate it.`,
  )
}

function createCloudflareClient({
  accountId,
  apiToken,
  fetchImpl,
  requestTimeoutMs,
  retryBaseDelayMs,
  sleepImpl,
  randomImpl,
}) {
  const accountBase = `${API_BASE_URL}/accounts/${encodeURIComponent(accountId)}`

  return {
    async request(path, init = {}) {
      const headers = new Headers(init.headers)
      headers.set('Authorization', `Bearer ${apiToken}`)
      headers.set('Accept', 'application/json')

      for (let attempt = 0; attempt <= MAX_REQUEST_RETRIES; attempt += 1) {
        const timeoutController = new AbortController()
        const timeout = setTimeout(
          () => timeoutController.abort(new Error('Request timed out.')),
          requestTimeoutMs,
        )

        try {
          const response = await fetchImpl(`${accountBase}${path}`, {
            ...init,
            headers,
            signal: timeoutController.signal,
          })

          if (
            isRetryableStatus(response.status) &&
            attempt < MAX_REQUEST_RETRIES
          ) {
            await response.body?.cancel().catch(() => {})
            await sleepImpl(
              getRetryDelay({
                attempt,
                retryAfter: response.headers.get('Retry-After'),
                retryBaseDelayMs,
                randomImpl,
              }),
            )
            continue
          }

          const payload = await readJsonResponse(response)
          if (!response.ok || payload?.success === false) {
            const message =
              payload?.errors
                ?.map((error) => error?.message)
                .filter(Boolean)
                .join('; ') ||
              `Cloudflare API request failed with ${response.status}.`
            throw new CloudflareApiError(message, response.status)
          }
          return payload
        } catch (error) {
          if (
            attempt >= MAX_REQUEST_RETRIES ||
            !isRetryableNetworkError(error, timeoutController.signal.aborted)
          ) {
            throw error
          }
          await sleepImpl(
            getRetryDelay({
              attempt,
              retryBaseDelayMs,
              randomImpl,
            }),
          )
        } finally {
          clearTimeout(timeout)
        }
      }

      throw new Error('Cloudflare API request exhausted all retries.')
    },
  }
}

function isRetryableStatus(status) {
  return status === 429 || status >= 500
}

function isRetryableNetworkError(error, timedOut) {
  return (
    timedOut ||
    error instanceof TypeError ||
    error?.name === 'AbortError' ||
    error?.name === 'TimeoutError'
  )
}

function isRetryableOpenAiError(error, timedOut) {
  return (
    isRetryableNetworkError(error, timedOut) ||
    (error instanceof OpenAiApiError &&
      (error.status === 429 || error.status >= 500))
  )
}

function getRetryDelay({ attempt, retryAfter, retryBaseDelayMs, randomImpl }) {
  const exponentialDelay = retryBaseDelayMs * 2 ** attempt
  const jitter = randomImpl() * retryBaseDelayMs
  const retryAfterDelay = parseRetryAfter(retryAfter)
  return Math.max(exponentialDelay + jitter, retryAfterDelay)
}

function parseRetryAfter(value) {
  if (!value) return 0
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000

  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : 0
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) =>
    setTimeout(resolvePromise, milliseconds),
  )
}

async function ensureIndex(client, indexName) {
  const encodedName = encodeURIComponent(indexName)
  try {
    const payload = await client.request(`/vectorize/v2/indexes/${encodedName}`)
    return payload.result
  } catch (error) {
    if (!(error instanceof CloudflareApiError) || error.status !== 404) {
      throw error
    }
  }

  const payload = await client.request('/vectorize/v2/indexes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: indexName,
      description:
        'Ace Server Wiki semantic search (OpenAI text-embedding-3-large, 1536 dimensions)',
      config: {
        dimensions: EMBEDDING_DIMENSIONS,
        metric: DISTANCE_METRIC,
      },
    }),
  })
  return payload.result
}

function validateIndexConfiguration(index, indexName) {
  if (
    index?.config?.dimensions !== EMBEDDING_DIMENSIONS ||
    index?.config?.metric !== DISTANCE_METRIC
  ) {
    throw new Error(
      `Vectorize index ${indexName} must use ${EMBEDDING_DIMENSIONS} dimensions and ${DISTANCE_METRIC}.`,
    )
  }
}

async function listVectorIds(
  client,
  indexName,
  { logger, sleepImpl, retryBaseDelayMs },
) {
  for (let restart = 0; restart <= MAX_LIST_CURSOR_RESTARTS; restart += 1) {
    try {
      return await listVectorIdsOnce(client, indexName)
    } catch (error) {
      if (
        restart >= MAX_LIST_CURSOR_RESTARTS ||
        !(error instanceof CloudflareApiError) ||
        error.status !== 400 ||
        !/cursor/iu.test(error.message)
      ) {
        throw error
      }

      logger.log(
        JSON.stringify({
          event: 'vectorize_list_cursor_restart',
          indexName,
          restart: restart + 1,
        }),
      )
      await sleepImpl(retryBaseDelayMs * 2 ** restart)
    }
  }
  throw new Error('Vectorize list pagination exhausted all cursor restarts.')
}

async function listVectorIdsOnce(client, indexName) {
  const ids = new Set()
  const seenCursors = new Set()
  let cursor = ''
  let expectedTotalCount = null
  let listedCount = 0

  do {
    const query = new URLSearchParams({ count: String(LIST_BATCH_SIZE) })
    if (cursor) query.set('cursor', cursor)
    const payload = await client.request(
      `/vectorize/v2/indexes/${encodeURIComponent(indexName)}/list?${query}`,
    )
    const result = validateVectorListPage(payload?.result, indexName)

    if (expectedTotalCount === null) {
      expectedTotalCount = result.totalCount
    } else if (result.totalCount !== expectedTotalCount) {
      throw invalidVectorListResponse(
        indexName,
        'totalCount changed between pages.',
      )
    }

    listedCount += result.count
    if (listedCount > expectedTotalCount) {
      throw invalidVectorListResponse(
        indexName,
        'listed vector count exceeded totalCount.',
      )
    }

    for (const vector of result.vectors) {
      if (typeof vector?.id !== 'string' || !vector.id.trim()) {
        throw new Error(
          `Vectorize index ${indexName} returned an invalid vector ID.`,
        )
      }
      ids.add(vector.id)
    }

    cursor = result.nextCursor
    if (cursor) {
      if (seenCursors.has(cursor)) {
        throw invalidVectorListResponse(
          indexName,
          'pagination cursor was repeated.',
        )
      }
      seenCursors.add(cursor)
    }
  } while (cursor)

  if (
    expectedTotalCount === null ||
    listedCount !== expectedTotalCount ||
    ids.size !== expectedTotalCount
  ) {
    throw invalidVectorListResponse(
      indexName,
      `listed ${listedCount} vectors (${ids.size} unique), expected ${expectedTotalCount}.`,
    )
  }

  return ids
}

function validateVectorListPage(result, indexName) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw invalidVectorListResponse(indexName, 'result must be an object.')
  }

  const { count, totalCount, isTruncated, vectors } = result
  if (
    !Number.isInteger(count) ||
    count < 0 ||
    !Number.isInteger(totalCount) ||
    totalCount < 0 ||
    typeof isTruncated !== 'boolean' ||
    !Array.isArray(vectors)
  ) {
    throw invalidVectorListResponse(
      indexName,
      'count, totalCount, isTruncated, or vectors was invalid.',
    )
  }
  if (count !== vectors.length || totalCount < count) {
    throw invalidVectorListResponse(
      indexName,
      'count did not match vectors or exceeded totalCount.',
    )
  }

  let nextCursor = ''
  if (isTruncated) {
    if (typeof result.nextCursor !== 'string' || !result.nextCursor.trim()) {
      throw invalidVectorListResponse(
        indexName,
        'truncated response did not include nextCursor.',
      )
    }
    nextCursor = result.nextCursor
  }

  return { count, totalCount, vectors, nextCursor }
}

function invalidVectorListResponse(indexName, reason) {
  return new Error(
    `Vectorize index ${indexName} returned an invalid list response: ${reason}`,
  )
}

async function createEmbeddings(client, chunks) {
  for (let attempt = 0; attempt <= MAX_REQUEST_RETRIES; attempt += 1) {
    const controller = new AbortController()
    const timeout = setTimeout(
      () => controller.abort(new Error('Request timed out.')),
      client.requestTimeoutMs,
    )

    try {
      const response = await client.fetchImpl(
        `${OPENAI_API_BASE_URL}/embeddings`,
        {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${client.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: EMBEDDING_MODEL,
            input: chunks.map(({ text }) => text),
            dimensions: EMBEDDING_DIMENSIONS,
            encoding_format: 'float',
          }),
          signal: controller.signal,
        },
      )

      if (isRetryableStatus(response.status) && attempt < MAX_REQUEST_RETRIES) {
        await response.body?.cancel().catch(() => {})
        await client.sleepImpl(
          getRetryDelay({
            attempt,
            retryAfter: response.headers.get('Retry-After'),
            retryBaseDelayMs: client.retryBaseDelayMs,
            randomImpl: client.randomImpl,
          }),
        )
        continue
      }

      if (!response.ok) {
        await response.body?.cancel().catch(() => {})
        throw new OpenAiApiError(
          `OpenAI API request failed with ${response.status}.`,
          response.status,
        )
      }

      const payload = await readOpenAiJsonResponse(response)
      if (payload?.model !== EMBEDDING_MODEL) {
        throw new Error(`OpenAI response model must be ${EMBEDDING_MODEL}.`)
      }
      return extractEmbeddingData(payload, chunks.length)
    } catch (error) {
      if (
        attempt >= MAX_REQUEST_RETRIES ||
        !isRetryableOpenAiError(error, controller.signal.aborted)
      ) {
        throw error
      }
      await client.sleepImpl(
        getRetryDelay({
          attempt,
          retryBaseDelayMs: client.retryBaseDelayMs,
          randomImpl: client.randomImpl,
        }),
      )
    } finally {
      clearTimeout(timeout)
    }
  }

  throw new Error('OpenAI embeddings request exhausted all retries.')
}

async function upsertVectors(client, indexName, vectors) {
  const ndjson = vectors.map((vector) => JSON.stringify(vector)).join('\n')
  const form = new FormData()
  form.set(
    'vectors',
    new Blob([`${ndjson}\n`], { type: 'application/x-ndjson' }),
    'vectors.ndjson',
  )
  const payload = await client.request(
    `/vectorize/v2/indexes/${encodeURIComponent(indexName)}/upsert`,
    {
      method: 'POST',
      body: form,
    },
  )
  return getMutationId(payload)
}

async function deleteVectors(client, indexName, ids) {
  const payload = await client.request(
    `/vectorize/v2/indexes/${encodeURIComponent(indexName)}/delete_by_ids`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    },
  )
  return getMutationId(payload)
}

function getMutationId(payload) {
  const value = payload?.result?.mutationId ?? payload?.mutationId
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(
      'Cloudflare Vectorize mutation response did not include a valid mutationId.',
    )
  }
  return value
}

async function waitForMutation(client, indexName, mutationId, { sleepImpl }) {
  const deadline = Date.now() + MUTATION_WAIT_TIMEOUT_MS
  while (Date.now() < deadline) {
    const payload = await client.request(
      `/vectorize/v2/indexes/${encodeURIComponent(indexName)}/info`,
    )
    if (payload?.result?.processedUpToMutation === mutationId) return
    await sleepImpl(MUTATION_POLL_INTERVAL_MS)
  }
  throw new Error(`Vectorize mutation ${mutationId} was not queryable in time.`)
}

async function readJsonResponse(response) {
  return readBoundedJsonResponse(
    response,
    MAX_CLOUDFLARE_RESPONSE_BYTES,
    'Cloudflare API',
  )
}

async function readOpenAiJsonResponse(response) {
  return readBoundedJsonResponse(
    response,
    MAX_OPENAI_RESPONSE_BYTES,
    'OpenAI API',
  )
}

async function readBoundedJsonResponse(response, maxBytes, providerName) {
  const contentLength = response.headers.get('Content-Length')
  if (contentLength !== null) {
    const normalizedLength = contentLength.trim()
    const length = Number(normalizedLength)
    if (
      !/^\d+$/u.test(normalizedLength) ||
      !Number.isSafeInteger(length) ||
      length > maxBytes
    ) {
      await response.body?.cancel().catch(() => {})
      throw new Error(`${providerName} returned an invalid response size.`)
    }
  }

  const reader = response.body?.getReader()
  if (!reader) return null

  const decoder = new TextDecoder()
  let byteLength = 0
  let text = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      byteLength += value.byteLength
      if (byteLength > maxBytes) {
        await reader.cancel().catch(() => {})
        throw new Error(`${providerName} returned an invalid response size.`)
      }
      text += decoder.decode(value, { stream: true })
    }
    text += decoder.decode()
  } finally {
    reader.releaseLock()
  }
  if (!text) return null

  try {
    return JSON.parse(text)
  } catch {
    throw new Error(
      `${providerName} returned non-JSON with HTTP ${response.status}.`,
    )
  }
}

function batches(items, size) {
  const result = []
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size))
  }
  return result
}

function parseArguments(argv) {
  const options = {
    dryRun: false,
    waitForMutations: true,
    allowLargeDelete: false,
    indexName: process.env.VECTORIZE_INDEX_NAME,
    confirmProduction: process.env.VECTORIZE_CONFIRM_PRODUCTION,
    corpusFile: DEFAULT_CORPUS_FILE,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--dry-run') options.dryRun = true
    else if (argument === '--no-wait') options.waitForMutations = false
    else if (argument === '--allow-large-delete') {
      options.allowLargeDelete = true
    } else if (argument === '--index') {
      options.indexName = argv[++index]
    } else if (argument === '--confirm-production') {
      options.confirmProduction = argv[++index]
    } else if (argument === '--corpus') {
      options.corpusFile = resolve(argv[++index])
    } else {
      throw new Error(`Unknown argument: ${argument}`)
    }
  }
  return options
}

function isDirectExecution() {
  if (!process.argv[1]) return false
  return (
    resolve(process.argv[1]).toLowerCase() ===
    fileURLToPath(import.meta.url).toLowerCase()
  )
}

if (isDirectExecution()) {
  await syncVectorize(parseArguments(process.argv.slice(2)))
}
