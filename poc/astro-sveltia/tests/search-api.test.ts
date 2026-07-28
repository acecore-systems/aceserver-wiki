import { describe, expect, it, vi } from 'vitest'

import { onRequestPost } from '../functions/api/search.ts'

const QUERY_VECTOR = Array.from({ length: 1024 }, () => 0.01)

describe('semantic search API', () => {
  it('embeds same-origin Japanese searches and queries the ja namespace', async () => {
    let queryOptions: VectorizeQueryOptions | undefined
    const env = createEnv({
      matches: [
        articleMatch({
          id: 'one',
          score: 0.81,
          url: '/article/rule/',
        }),
        articleMatch({
          id: 'duplicate-url',
          score: 0.79,
          url: '/article/rule/',
        }),
        articleMatch({
          id: 'too-low',
          score: 0.49,
          url: '/article/guide/',
        }),
      ],
      onQuery(_values, options) {
        queryOptions = options
      },
    })

    const response = await invoke(
      searchRequest({ query: 'サーバーのルールを知りたい' }),
      env,
    )
    const body = (await response.json()) as {
      results: Array<{ rank: number; url: string }>
    }

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(response.headers.get('Server-Timing')).toMatch(/^search;dur=/u)
    expect(body.results).toEqual([
      {
        contentType: 'article',
        excerpt: 'Wikiの記事です',
        id: 'one',
        rank: 1,
        section: '案内',
        title: '記事',
        url: '/article/rule/',
      },
    ])
    expect(queryOptions).toEqual({
      namespace: 'ja',
      topK: 15,
      returnMetadata: 'all',
      returnValues: false,
    })
  })

  it('rejects requests without a matching Origin before Workers AI runs', async () => {
    const onAiRun = vi.fn()
    const request = new Request('https://asv-wiki.acecore.net/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '検索' }),
    })

    const response = await invoke(request, createEnv({ onAiRun }))

    expect(response.status).toBe(403)
    expect(onAiRun).not.toHaveBeenCalled()
    expect(response.headers.get('Cache-Control')).toBe('no-store')
  })

  it('accepts only JSON and fails closed when a binding or kill switch is absent', async () => {
    const textResponse = await invoke(
      new Request('https://asv-wiki.acecore.net/api/search', {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain',
          Origin: 'https://asv-wiki.acecore.net',
        },
        body: '検索',
      }),
      createEnv(),
    )
    const disabledResponse = await invoke(
      searchRequest({ query: '検索' }),
      createEnv({ enabled: false }),
    )
    const missingDatabaseResponse = await invoke(
      searchRequest({ query: '検索' }),
      createEnv({ includeDatabase: false }),
    )

    expect(textResponse.status).toBe(415)
    expect(disabledResponse.status).toBe(503)
    expect(missingDatabaseResponse.status).toBe(503)
  })

  it('normalizes queries, enforces 2-160 characters, and fixes locale to ja', async () => {
    let embeddedInput: unknown
    const env = createEnv({
      onAiRun(_model, input) {
        embeddedInput = input
      },
    })

    const normalizedResponse = await invoke(
      searchRequest({ query: '  ＡＳＶ   ルール  ', locale: 'ja' }),
      env,
    )
    const shortResponse = await invoke(
      searchRequest({ query: 'a' }),
      createEnv(),
    )
    const longResponse = await invoke(
      searchRequest({ query: 'あ'.repeat(161) }),
      createEnv(),
    )
    const localeResponse = await invoke(
      searchRequest({ query: '検索', locale: 'en' }),
      createEnv(),
    )

    expect(normalizedResponse.status).toBe(200)
    expect(embeddedInput).toEqual({
      text: ['ASV ルール'],
      truncate_inputs: true,
    })
    expect(shortResponse.status).toBe(400)
    expect(longResponse.status).toBe(400)
    expect(localeResponse.status).toBe(400)
  })

  it('rejects null, primitive, and malformed JSON bodies', async () => {
    const nullResponse = await invoke(searchRequest(null), createEnv())
    const primitiveResponse = await invoke(searchRequest('search'), createEnv())
    const malformedResponse = await invoke(
      new Request('https://asv-wiki.acecore.net/api/search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://asv-wiki.acecore.net',
        },
        body: '{',
      }),
      createEnv(),
    )

    expect(nullResponse.status).toBe(400)
    expect(primitiveResponse.status).toBe(400)
    expect(malformedResponse.status).toBe(400)
  })

  it('rejects declared and streamed bodies larger than 2 KiB', async () => {
    const declaredRequest = new Request(
      'https://asv-wiki.acecore.net/api/search',
      {
        method: 'POST',
        headers: {
          'Content-Length': '4096',
          'Content-Type': 'application/json',
          Origin: 'https://asv-wiki.acecore.net',
        },
        body: JSON.stringify({ query: '検索' }),
      },
    )
    const declaredResponse = await invoke(declaredRequest, createEnv())

    let pulls = 0
    const chunk = new Uint8Array(1024)
    const stream = new ReadableStream({
      pull(controller) {
        pulls += 1
        controller.enqueue(chunk)
        if (pulls >= 10) controller.close()
      },
    })
    const streamedRequest = new Request(
      'https://asv-wiki.acecore.net/api/search',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://asv-wiki.acecore.net',
        },
        body: stream,
        duplex: 'half',
      } as RequestInit,
    )
    const streamedResponse = await invoke(streamedRequest, createEnv())

    expect(declaredResponse.status).toBe(413)
    expect(declaredRequest.bodyUsed).toBe(false)
    expect(streamedResponse.status).toBe(413)
    expect(pulls).toBeLessThanOrEqual(4)
  })

  it('uses the CMS D1 database for client and global rate limits', async () => {
    const consumedKeys: string[] = []
    const allowedResponse = await invoke(
      searchRequest({ query: '検索' }, { connectingIp: '203.0.113.9' }),
      createEnv({
        onRateLimit(key) {
          consumedKeys.push(key)
        },
      }),
    )
    const rejectedKeys: string[] = []
    const rejectedResponse = await invoke(
      searchRequest({ query: '検索' }),
      createEnv({
        clientRateLimitSuccess: false,
        onRateLimit(key) {
          rejectedKeys.push(key)
        },
      }),
    )

    expect(allowedResponse.status).toBe(200)
    expect(consumedKeys[0]).toMatch(/^client:[0-9a-f]{64}$/u)
    expect(consumedKeys[1]).toBe('global')
    expect(rejectedResponse.status).toBe(429)
    expect(rejectedResponse.headers.get('Retry-After')).toBe('60')
    expect(rejectedKeys).toHaveLength(1)
  })

  it('returns at most five unique, same-origin /article/ metadata results', async () => {
    const matches = [
      articleMatch({ id: 'external', url: 'https://evil.example/article/' }),
      articleMatch({ id: 'wrong-path', url: '/search/' }),
      articleMatch({ id: 'traversal', url: '/article/../admin/' }),
      articleMatch({ id: 'wrong-locale', locale: 'en' }),
      ...Array.from({ length: 6 }, (_, index) =>
        articleMatch({
          id: `valid-${index}`,
          score: 0.9 - index * 0.01,
          url: `/article/valid-${index}/`,
        }),
      ),
    ]

    const response = await invoke(
      searchRequest({ query: '役立つ記事' }),
      createEnv({ matches }),
    )
    const body = (await response.json()) as {
      results: Array<{ url: string }>
    }

    expect(response.status).toBe(200)
    expect(body.results).toHaveLength(5)
    expect(body.results.map((result) => result.url)).toEqual([
      '/article/valid-0/',
      '/article/valid-1/',
      '/article/valid-2/',
      '/article/valid-3/',
      '/article/valid-4/',
    ])
  })

  it('accepts the calibrated 0.40 Wiki relevance threshold', async () => {
    const response = await invoke(
      searchRequest({ query: '初期スポーンの中心街はどこ？' }),
      createEnv({
        matches: [
          articleMatch({
            id: 'hub',
            score: 0.415,
            url: '/article/hub-intro/',
          }),
        ],
        minScore: '0.40',
      }),
    )
    const body = (await response.json()) as {
      results: Array<{ url: string }>
    }

    expect(response.status).toBe(200)
    expect(body.results).toHaveLength(1)
    expect(body.results[0]?.url).toBe('/article/hub-intro/')
  })

  it('returns 502 for invalid embeddings without logging the query body', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      const response = await invoke(
        searchRequest({ query: '秘密を含む検索テキスト' }),
        createEnv({ embedding: [0.1] }),
      )

      expect(response.status).toBe(502)
      expect(errorSpy).toHaveBeenCalledTimes(1)
      const log = String(errorSpy.mock.calls[0]?.[0])
      expect(log).not.toContain('秘密を含む検索テキスト')
      expect(log).toContain('invalid_embedding')
    } finally {
      errorSpy.mockRestore()
    }
  })
})

function articleMatch({
  id = 'article',
  locale = 'ja',
  score = 0.8,
  url = '/article/guide/',
}: {
  id?: string
  locale?: string
  score?: number
  url?: string
} = {}): VectorizeMatch {
  return {
    id,
    score,
    metadata: {
      contentType: 'article',
      excerpt: 'Wikiの記事です',
      locale,
      section: '案内',
      title: '記事',
      url,
    },
  }
}

function searchRequest(
  body: unknown,
  { connectingIp }: { connectingIp?: string } = {},
): Request {
  const headers = new Headers({
    'Content-Type': 'application/json',
    Origin: 'https://asv-wiki.acecore.net',
    'X-Acecore-Search-Client': '018f7e5a-7b4d-7c6a-8e9f-0123456789ab',
  })
  if (connectingIp) headers.set('CF-Connecting-IP', connectingIp)

  return new Request('https://asv-wiki.acecore.net/api/search', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
}

function createEnv({
  clientRateLimitSuccess = true,
  embedding = QUERY_VECTOR,
  enabled = true,
  globalRateLimitSuccess = true,
  includeDatabase = true,
  matches = [],
  minScore = '0.50',
  onAiRun = () => undefined,
  onQuery = () => undefined,
  onRateLimit = () => undefined,
}: {
  clientRateLimitSuccess?: boolean
  embedding?: number[]
  enabled?: boolean
  globalRateLimitSuccess?: boolean
  includeDatabase?: boolean
  matches?: VectorizeMatch[]
  minScore?: string
  onAiRun?: (model: string, input: unknown) => void
  onQuery?: (values: number[], options?: VectorizeQueryOptions) => void
  onRateLimit?: (key: string) => void
} = {}) {
  return {
    AI: {
      async run(model: string, input: unknown) {
        onAiRun(model, input)
        expect(model).toBe('@cf/baai/bge-m3')
        return { data: [embedding] }
      },
    },
    CMS_DATABASE: includeDatabase
      ? createRateLimitDatabase({
          clientRateLimitSuccess,
          globalRateLimitSuccess,
          onRateLimit,
        })
      : undefined,
    SEARCH_ENABLED: enabled ? 'true' : 'false',
    SEARCH_INDEX: {
      async query(values: number[], options?: VectorizeQueryOptions) {
        expect(values).toHaveLength(1024)
        onQuery(values, options)
        return { count: matches.length, matches }
      },
    },
    SEARCH_MIN_SCORE: minScore,
  }
}

function createRateLimitDatabase({
  clientRateLimitSuccess,
  globalRateLimitSuccess,
  onRateLimit,
}: {
  clientRateLimitSuccess: boolean
  globalRateLimitSuccess: boolean
  onRateLimit: (key: string) => void
}): D1Database {
  return {
    prepare(query: string) {
      if (query.startsWith('DELETE')) {
        return {
          bind() {
            return {
              async run() {
                return { success: true }
              },
            }
          },
        }
      }

      expect(query).toContain('INSERT INTO semantic_search_rate_limits')
      return {
        bind(key: string) {
          return {
            async first() {
              onRateLimit(key)
              const success =
                key === 'global'
                  ? globalRateLimitSuccess
                  : clientRateLimitSuccess
              return success ? { request_count: 1 } : null
            },
          }
        },
      }
    },
  } as unknown as D1Database
}

async function invoke(request: Request, env: ReturnType<typeof createEnv>) {
  return onRequestPost({
    request,
    env,
    waitUntil() {},
  } as unknown as Parameters<typeof onRequestPost>[0])
}
