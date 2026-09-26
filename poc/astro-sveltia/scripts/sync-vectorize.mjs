import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const API_BASE_URL = 'https://api.cloudflare.com/client/v4'
const DEFAULT_CORPUS_FILE = resolve('dist/vector-corpus.json')
const EMBEDDING_MODEL = '@cf/baai/bge-m3'
const EMBEDDING_DIMENSIONS = 1024
const DISTANCE_METRIC = 'cosine'
const EMBEDDING_BATCH_SIZE = 16
const UPSERT_BATCH_SIZE = 200
const DELETE_BATCH_SIZE = 100
const LIST_BATCH_SIZE = 1000
const MUTATION_WAIT_TIMEOUT_MS = 180_000
const MUTATION_POLL_INTERVAL_MS = 5_000
const RECONCILIATION_MAX_ATTEMPTS = 12
const RECONCILIATION_POLL_INTERVAL_MS = 5_000
const QUERY_CANARY_MAX_ATTEMPTS = 12
const QUERY_CANARY_POLL_INTERVAL_MS = 5_000
const REQUEST_TIMEOUT_MS = 30_000
const MAX_REQUEST_RETRIES = 5
const RETRY_BASE_DELAY_MS = 500
const MAX_LIST_CURSOR_RESTARTS = 3
const MAX_DELETE_RATIO = 0.2
// Temporary allowance for the reviewed Discord rules rewrite. Remove after reconciliation.
const REVIEWED_RULES_MIGRATION = Object.freeze({
  corpusVersion: '4f094fb285870c13f6f8',
  currentCount: 26,
  expectedCount: 32,
  deleteCount: 15,
})
const MIN_SOURCE_COUNT = 15
const MIN_VECTOR_COUNT = 15
const MAX_VECTOR_COUNT = 500
const MAX_CLOUDFLARE_RESPONSE_BYTES = 4_000_000
const MANAGED_VECTOR_ID_PATTERN = /^v1-[0-9a-f]{48}$/u
const CORPUS_VERSION_PATTERN = /^[0-9a-f]{20}$/u
const PRODUCTION_INDEX_NAME = 'aceserver-wiki-search-bge-m3-1024-production-v1'
const ALLOWED_INDEX_NAMES = new Set([PRODUCTION_INDEX_NAME])

class CloudflareApiError extends Error {
  constructor(message, status) {
    super(message)
    this.name = 'CloudflareApiError'
    this.status = status
  }
}

export async function syncVectorize({
  accountId = process.env.CLOUDFLARE_ACCOUNT_ID,
  apiToken = process.env.CLOUDFLARE_API_TOKEN,
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

  if (!accountId || !apiToken) {
    throw new Error(
      'CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required.',
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
  const reviewedRulesMigration = isReviewedRulesMigration({
    corpusVersion: corpus.version,
    currentCount: currentIds.size,
    expectedCount: expectedIds.size,
    deleteCount: idsToDelete.length,
  })
  validateDeletePlan({
    currentCount: currentIds.size,
    deleteCount: idsToDelete.length,
    allowLargeDelete: allowLargeDelete || reviewedRulesMigration,
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
  let queryCanary = null
  for (const chunkBatch of batches(chunksToUpsert, EMBEDDING_BATCH_SIZE)) {
    const embeddings = await createEmbeddings(client, chunkBatch)
    queryCanary ??= {
      id: chunkBatch[0].id,
      namespace: chunkBatch[0].namespace,
      values: embeddings[0],
    }
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
  let verified = false
  let queryVerified = false
  if (waitForMutations) {
    if (lastMutationId) {
      await waitForMutation(client, indexName, lastMutationId, {
        sleepImpl,
      })
    }
    await waitForReconciliation(client, indexName, expectedIds, {
      sleepImpl,
      maxAttempts: lastMutationId ? RECONCILIATION_MAX_ATTEMPTS : 1,
    })
    verified = true

    if (!queryCanary) {
      const canaryChunk = corpus.chunks[0]
      const [values] = await createEmbeddings(client, [canaryChunk])
      queryCanary = {
        id: canaryChunk.id,
        namespace: canaryChunk.namespace,
        values,
      }
    }
    await waitForQueryCanary(client, indexName, queryCanary, { sleepImpl })
    queryVerified = true
  }

  const result = {
    dryRun: false,
    indexName,
    corpusVersion: corpus.version,
    existing: currentIds.size,
    upserted: chunksToUpsert.length,
    deleted: idsToDelete.length,
    mutationId: lastMutationId || null,
    verified,
    queryVerified,
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
      `Workers AI returned ${Array.isArray(data) ? data.length : 0} embeddings; expected ${expectedCount}.`,
    )
  }

  if (payload.pooling !== undefined && payload.pooling !== 'cls') {
    throw new Error('Workers AI BGE-M3 must use cls pooling.')
  }
  if (
    payload.shape !== undefined &&
    (!Array.isArray(payload.shape) ||
      payload.shape.length !== 2 ||
      payload.shape[0] !== expectedCount ||
      payload.shape[1] !== EMBEDDING_DIMENSIONS)
  ) {
    throw new Error('Workers AI BGE-M3 returned an invalid embedding shape.')
  }

  return data.map((values) => {
    if (
      !Array.isArray(values) ||
      values.length !== EMBEDDING_DIMENSIONS ||
      values.some(
        (value) => typeof value !== 'number' || !Number.isFinite(value),
      )
    ) {
      throw new Error(
        `Workers AI embedding must contain ${EMBEDDING_DIMENSIONS} finite values.`,
      )
    }
    return values
  })
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

export function isReviewedRulesMigration(plan) {
  return Object.entries(REVIEWED_RULES_MIGRATION).every(
    ([key, expected]) => plan[key] === expected,
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
        'Ace Server Wiki semantic search (Cloudflare Workers AI BGE-M3, 1024 dimensions)',
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
  const payload = await client.request(`/ai/run/${EMBEDDING_MODEL}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: chunks.map(({ text }) => text),
      truncate_inputs: false,
    }),
  })
  return extractEmbeddingData(payload?.result, chunks.length)
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

async function waitForReconciliation(
  client,
  indexName,
  expectedIds,
  { sleepImpl, maxAttempts },
) {
  let lastError = null
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const actualIds = await listVectorIds(client, indexName, {
      logger: { log() {} },
      sleepImpl,
      retryBaseDelayMs: RETRY_BASE_DELAY_MS,
    })
    try {
      validateReconciliation(actualIds, expectedIds, indexName)
      return
    } catch (error) {
      lastError = error
      if (attempt === maxAttempts) break
      await sleepImpl(RECONCILIATION_POLL_INTERVAL_MS)
    }
  }
  throw lastError
}

export function validateReconciliation(actualIds, expectedIds, indexName) {
  const missingIds = [...expectedIds].filter((id) => !actualIds.has(id))
  const unexpectedIds = [...actualIds].filter((id) => !expectedIds.has(id))
  if (missingIds.length === 0 && unexpectedIds.length === 0) return
  throw new Error(
    `Vectorize index ${indexName} did not converge: ${missingIds.length} missing and ${unexpectedIds.length} unexpected vector id(s).`,
  )
}

async function waitForQueryCanary(client, indexName, canary, { sleepImpl }) {
  for (let attempt = 1; attempt <= QUERY_CANARY_MAX_ATTEMPTS; attempt += 1) {
    const payload = await client.request(
      `/vectorize/v2/indexes/${encodeURIComponent(indexName)}/query`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vector: canary.values,
          namespace: canary.namespace,
          topK: 10,
          returnMetadata: 'none',
          returnValues: false,
        }),
      },
    )
    if (
      Array.isArray(payload?.result?.matches) &&
      payload.result.matches.some((match) => match?.id === canary.id)
    ) {
      return
    }
    if (attempt === QUERY_CANARY_MAX_ATTEMPTS) break
    await sleepImpl(QUERY_CANARY_POLL_INTERVAL_MS)
  }
  throw new Error(
    `Vectorize index ${indexName} did not return query canary ${canary.id}.`,
  )
}

async function readJsonResponse(response) {
  return readBoundedJsonResponse(
    response,
    MAX_CLOUDFLARE_RESPONSE_BYTES,
    'Cloudflare API',
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
