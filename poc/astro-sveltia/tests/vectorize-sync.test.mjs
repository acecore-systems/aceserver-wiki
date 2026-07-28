import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import {
  extractEmbeddingData,
  syncVectorize,
  validateCorpus,
  validateDeletePlan,
} from '../scripts/sync-vectorize.mjs'

const PREVIEW_INDEX = 'aceserver-wiki-search-preview'
const embedding = Array.from({ length: 1024 }, () => 0.01)
const temporaryRoots = []

after(async () => {
  await Promise.all(
    temporaryRoots.map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  )
})

test('BGE-M3 embeddingの件数と1024次元を検証する', () => {
  assert.deepEqual(extractEmbeddingData({ result: { data: [embedding] } }, 1), [
    embedding,
  ])
  assert.throws(
    () => extractEmbeddingData({ result: { data: [[0.1]] } }, 1),
    /1024/u,
  )
})

test('15記事のcorpusを検証し、dry-runはcredentialを要求しない', async () => {
  const corpus = createCorpus()
  validateCorpus(corpus)
  const corpusFile = await writeCorpus(corpus)

  const result = await syncVectorize({
    corpusFile,
    dryRun: true,
    indexName: PREVIEW_INDEX,
    fetchImpl() {
      throw new Error('network must not be called')
    },
    logger: silentLogger,
  })

  assert.equal(result.dryRun, true)
  assert.equal(result.sources, 15)
  assert.equal(result.vectors, 15)
})

test('同期先indexをWiki preview/productionだけに制限する', async () => {
  const corpusFile = await writeCorpus(createCorpus())

  await assert.rejects(
    syncVectorize({
      corpusFile,
      dryRun: true,
      indexName: 'untrusted-index',
      logger: silentLogger,
    }),
    /must be one of/u,
  )
})

test('20%を超える削除を明示overrideなしでは拒否する', () => {
  assert.throws(
    () =>
      validateDeletePlan({
        currentCount: 20,
        deleteCount: 5,
        allowLargeDelete: false,
      }),
    /--allow-large-delete/u,
  )
  assert.doesNotThrow(() =>
    validateDeletePlan({
      currentCount: 20,
      deleteCount: 5,
      allowLargeDelete: true,
    }),
  )
})

test('既存indexとの差分だけをembedding・upsert・deleteする', async () => {
  const corpus = createCorpus()
  const corpusFile = await writeCorpus(corpus)
  const newChunk = corpus.chunks.at(-1)
  const staleId = managedId(99)
  const existingIds = [
    ...corpus.chunks.slice(0, -1).map(({ id }) => id),
    staleId,
  ]
  const calls = []

  const fetchImpl = async (input, init = {}) => {
    const url = String(input)
    calls.push({ url, method: init.method || 'GET' })

    if (url.endsWith(`/vectorize/v2/indexes/${PREVIEW_INDEX}`)) {
      return cloudflareResponse({
        name: PREVIEW_INDEX,
        config: { dimensions: 1024, metric: 'cosine' },
      })
    }
    if (url.includes('/list?')) {
      return cloudflareResponse({
        vectors: existingIds.map((id) => ({ id })),
        count: existingIds.length,
        totalCount: existingIds.length,
        isTruncated: false,
      })
    }
    if (url.includes('/ai/run/@cf/baai/bge-m3')) {
      assert.deepEqual(JSON.parse(init.body).text, [newChunk.text])
      return cloudflareResponse({ data: [embedding] })
    }
    if (url.endsWith('/upsert')) {
      const ndjson = await init.body.get('vectors').text()
      const vector = JSON.parse(ndjson.trim())
      assert.equal(vector.id, newChunk.id)
      assert.equal(vector.values.length, 1024)
      return cloudflareResponse({ mutationId: 'mutation-upsert' })
    }
    if (url.endsWith('/delete_by_ids')) {
      assert.deepEqual(JSON.parse(init.body), { ids: [staleId] })
      return cloudflareResponse({ mutationId: 'mutation-delete' })
    }
    if (url.endsWith('/info')) {
      return cloudflareResponse({
        processedUpToMutation: 'mutation-delete',
      })
    }

    throw new Error(`Unexpected request: ${url}`)
  }

  const result = await syncVectorize({
    accountId: 'account',
    apiToken: 'token',
    indexName: PREVIEW_INDEX,
    corpusFile,
    fetchImpl,
    logger: silentLogger,
  })

  assert.equal(result.upserted, 1)
  assert.equal(result.deleted, 1)
  assert.equal(result.mutationId, 'mutation-delete')
  assert.equal(calls.filter(({ url }) => url.includes('/ai/run/')).length, 1)
})

test('管理外IDが現存するindexをmutation前に拒否する', async () => {
  const corpusFile = await writeCorpus(createCorpus())
  let mutated = false

  const fetchImpl = async (input) => {
    const url = String(input)
    if (url.endsWith(`/vectorize/v2/indexes/${PREVIEW_INDEX}`)) {
      return cloudflareResponse({
        config: { dimensions: 1024, metric: 'cosine' },
      })
    }
    if (url.includes('/list?')) {
      return cloudflareResponse({
        vectors: [{ id: 'legacy-vector' }],
        count: 1,
        totalCount: 1,
        isTruncated: false,
      })
    }
    mutated = true
    throw new Error(`Unexpected request: ${url}`)
  }

  await assert.rejects(
    syncVectorize({
      accountId: 'account',
      apiToken: 'token',
      indexName: PREVIEW_INDEX,
      corpusFile,
      fetchImpl,
      logger: silentLogger,
    }),
    /unmanaged vector IDs/u,
  )
  assert.equal(mutated, false)
})

test('Vectorize一覧をcursorで最後まで列挙して件数を照合する', async () => {
  const corpus = createCorpus()
  const corpusFile = await writeCorpus(corpus)
  let listCalls = 0

  const fetchImpl = async (input) => {
    const url = String(input)
    if (url.endsWith(`/vectorize/v2/indexes/${PREVIEW_INDEX}`)) {
      return cloudflareResponse({
        config: { dimensions: 1024, metric: 'cosine' },
      })
    }
    if (url.includes('/list?')) {
      listCalls += 1
      const cursor = new URL(url).searchParams.get('cursor')
      if (listCalls === 1) {
        assert.equal(cursor, null)
        return cloudflareResponse({
          vectors: corpus.chunks.slice(0, 8).map(({ id }) => ({ id })),
          count: 8,
          totalCount: corpus.vectorCount,
          isTruncated: true,
          nextCursor: 'page-2',
        })
      }

      assert.equal(cursor, 'page-2')
      return cloudflareResponse({
        vectors: corpus.chunks.slice(8).map(({ id }) => ({ id })),
        count: corpus.vectorCount - 8,
        totalCount: corpus.vectorCount,
        isTruncated: false,
      })
    }
    throw new Error(`Unexpected request: ${url}`)
  }

  const result = await syncVectorize({
    accountId: 'account',
    apiToken: 'token',
    indexName: PREVIEW_INDEX,
    corpusFile,
    fetchImpl,
    logger: silentLogger,
  })

  assert.equal(listCalls, 2)
  assert.equal(result.existing, corpus.vectorCount)
  assert.equal(result.upserted, 0)
  assert.equal(result.deleted, 0)
})

test('Vectorize一覧の欠損や不整合をmutation前に拒否する', async () => {
  const corpusFile = await writeCorpus(createCorpus())
  const invalidResults = [
    null,
    {
      vectors: [],
      count: 0,
      totalCount: 0,
    },
    {
      vectors: [{ id: managedId(0) }],
      count: 2,
      totalCount: 2,
      isTruncated: false,
    },
    {
      vectors: [{ id: managedId(0) }],
      count: 1,
      totalCount: 2,
      isTruncated: true,
    },
    {
      vectors: [{ id: managedId(0) }],
      count: 1,
      totalCount: 2,
      isTruncated: false,
    },
  ]

  for (const invalidResult of invalidResults) {
    let mutated = false
    const fetchImpl = async (input) => {
      const url = String(input)
      if (url.endsWith(`/vectorize/v2/indexes/${PREVIEW_INDEX}`)) {
        return cloudflareResponse({
          config: { dimensions: 1024, metric: 'cosine' },
        })
      }
      if (url.includes('/list?')) {
        return cloudflareResponse(invalidResult)
      }
      mutated = true
      throw new Error(`Unexpected request: ${url}`)
    }

    await assert.rejects(
      syncVectorize({
        accountId: 'account',
        apiToken: 'token',
        indexName: PREVIEW_INDEX,
        corpusFile,
        fetchImpl,
        logger: silentLogger,
      }),
      /invalid list response/u,
    )
    assert.equal(mutated, false)
  }
})

function createCorpus() {
  const chunks = Array.from({ length: 15 }, (_, index) => ({
    id: managedId(index),
    namespace: 'ja',
    text: `記事${index}の検索本文`,
    metadata: {
      url: `/article/article-${index}/`,
      title: `記事${index}`,
      section: `見出し${index}`,
      excerpt: `記事${index}の概要`,
      category: 'テスト',
      locale: 'ja',
    },
  }))

  return {
    schemaVersion: 1,
    version: 'a'.repeat(20),
    embedding: {
      model: '@cf/baai/bge-m3',
      dimensions: 1024,
      metric: 'cosine',
    },
    chunking: {
      targetCharacters: 850,
      maximumCharacters: 1200,
      overlapCharacters: 120,
    },
    sourceCount: 15,
    vectorCount: chunks.length,
    localeCounts: { ja: chunks.length },
    chunks,
  }
}

function managedId(index) {
  return `v1-${index.toString(16).padStart(48, '0')}`
}

async function writeCorpus(corpus) {
  const root = await mkdtemp(join(tmpdir(), 'aceserver-vectorize-'))
  temporaryRoots.push(root)
  const corpusFile = join(root, 'corpus.json')
  await writeFile(corpusFile, JSON.stringify(corpus), 'utf8')
  return corpusFile
}

function cloudflareResponse(result, status = 200) {
  return Response.json(
    {
      success: status >= 200 && status < 300,
      result,
      errors: [],
      messages: [],
    },
    { status },
  )
}

const silentLogger = { log() {} }
