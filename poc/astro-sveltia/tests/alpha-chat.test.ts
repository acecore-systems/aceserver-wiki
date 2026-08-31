import { describe, expect, it, vi } from 'vitest'

import alphaChatEndpointSource from '../functions/api/alpha-chat.ts?raw'
import { createAlphaChatHandler } from '../functions/api/alpha-chat.ts'
import alphaChatClientSource from '../public/alpha-chat.js?raw'
import alphaGuideSource from '../src/components/AlphaGuide.astro?raw'

const ORIGIN = 'https://asv-wiki.acecore.net'
const CURRENT_PERSONA_VERSION = '2026-08-14.1'

describe('Alpha-kun WIKI shared-service adapter', () => {
  it('forwards the bounded WIKI envelope and locale to the private service', async () => {
    const serviceRequests: Request[] = []
    const response = await invoke(
      chatRequest({
        locale: 'ja',
        messages: [
          {
            content: '前の記憶だよ。',
            loreRevisionId: 'revision-before',
            role: 'assistant',
          },
        ],
        question: 'そのあとどうなった？',
      }),
      createEnv({
        async serviceFetch(request) {
          serviceRequests.push(request)
          return Response.json({
            answer: '次の小さな記憶だよ。',
            loreRevisionId: 'revision-after',
            ok: true,
            personaVersion: CURRENT_PERSONA_VERSION,
            sources: [
              {
                title: '基本ルール',
                url: `${ORIGIN}/article/rules/`,
              },
            ],
          })
        },
      }),
    )

    expect(response.status).toBe(200)
    expect(serviceRequests).toHaveLength(1)
    expect(serviceRequests[0]?.url).toBe(
      'https://aceserver-alpha-chat.internal/v1/chat',
    )
    expect(serviceRequests[0]?.headers.get('Accept-Language')).toBe('ja')
    await expect(serviceRequests[0]?.json()).resolves.toEqual({
      payload: {
        locale: 'ja',
        messages: [
          {
            content: '前の記憶だよ。',
            loreRevisionId: 'revision-before',
            role: 'assistant',
          },
          { content: 'そのあとどうなった？', role: 'user' },
        ],
        question: 'そのあとどうなった？',
      },
      surface: 'wiki',
      version: 1,
    })
    await expect(response.json()).resolves.toEqual({
      answer: '次の小さな記憶だよ。',
      loreRevisionId: 'revision-after',
      ok: true,
      personaVersion: CURRENT_PERSONA_VERSION,
      sources: [{ title: '基本ルール', url: '/article/rules/' }],
    })
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(response.headers.get('Server-Timing')).toMatch(
      /^alpha-chat;dur=\d+\.\d$/u,
    )
  })

  it('forwards SSE without buffering the private service body', async () => {
    const source = [
      'event: delta\ndata: {"text":"やあ、"}\n\n',
      'event: complete\ndata: {"ok":true,"answer":"やあ、案内するよ。","sources":[]}\n\n',
    ].join('')
    let forwardedAccept: string | null = null
    const response = await invoke(
      chatRequest(
        { locale: 'ja', question: 'こんにちは' },
        { accept: 'text/event-stream' },
      ),
      createEnv({
        async serviceFetch(request) {
          forwardedAccept = request.headers.get('Accept')
          return new Response(source, {
            headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
          })
        },
      }),
    )

    expect(forwardedAccept).toBe('text/event-stream')
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe(
      'text/event-stream; charset=utf-8',
    )
    expect(response.headers.get('Cache-Control')).toContain('no-transform')
    await expect(response.text()).resolves.toBe(source)
  })

  it('preserves opaque conversation state without rebuilding a transcript', async () => {
    const conversationContext = {
      items: [
        {
          encrypted_content: 'opaque-state',
          id: 'cmp_1',
          type: 'compaction',
        },
      ],
      scope: {
        locale: 'ja',
        personaVersion: CURRENT_PERSONA_VERSION,
        surface: 'wiki',
      },
    }
    let forwarded: unknown
    const response = await invoke(
      chatRequest({
        conversationContext,
        loreRevisionId: 'revision-1',
        question: '続きは？',
      }),
      createEnv({
        async serviceFetch(request) {
          forwarded = await request.json()
          return Response.json({
            answer: '続きの案内だよ。',
            conversationContextReset: false,
            nextConversationContext: conversationContext,
            ok: true,
            personaVersion: CURRENT_PERSONA_VERSION,
            sources: [],
          })
        },
      }),
    )

    expect(response.status).toBe(200)
    expect(forwarded).toEqual({
      payload: {
        conversationContext,
        locale: 'ja',
        loreRevisionId: 'revision-1',
        question: '続きは？',
      },
      surface: 'wiki',
      version: 1,
    })
    await expect(response.json()).resolves.toMatchObject({
      answer: '続きの案内だよ。',
      conversationContextReset: false,
      nextConversationContext: conversationContext,
      personaVersion: CURRENT_PERSONA_VERSION,
    })
  })

  it('keeps the shared answer text byte-for-byte apart from outer trimming', async () => {
    const answer =
      '  `／home` と URL https://example.invalid/Ａ をそのまま伝えるよ。  '
    const response = await invoke(
      chatRequest({ question: '表示を確認して' }),
      createEnv({
        serviceFetch: async () =>
          Response.json({ answer, ok: true, sources: [] }),
      }),
    )

    await expect(response.json()).resolves.toMatchObject({
      answer: answer.trim(),
    })
  })

  it('fails closed and logs metadata only when the shared service fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const response = await invoke(
      chatRequest({ question: 'SECRET_QUESTION_TEXT' }),
      createEnv({
        serviceFetch: async () => {
          throw new Error('ServiceUnavailable')
        },
      }),
    )

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({
      answer:
        'いまはうまく答えを届けられなかったよ。少し時間をおいて、もう一度聞いてね。',
      ok: false,
    })
    const logs = errorSpy.mock.calls.flat().join('\n')
    expect(logs).toContain('shared_service')
    expect(logs).not.toContain('SECRET_QUESTION_TEXT')
    expect(logs).not.toContain('ServiceUnavailable')
  })

  it('rejects malformed and oversized shared responses', async () => {
    const malformed = await invoke(
      chatRequest({ question: '案内して' }),
      createEnv({
        serviceFetch: async () => Response.json({ answer: 42, ok: true }),
      }),
    )
    expect(malformed.status).toBe(503)

    const oversized = await invoke(
      chatRequest({ question: '案内して' }),
      createEnv({
        serviceFetch: async () =>
          new Response('{}', {
            headers: { 'Content-Length': String(96 * 1024 + 1) },
          }),
      }),
    )
    expect(oversized.status).toBe(503)
  })

  it('requires same-origin JSON and the configured shared bindings', async () => {
    const serviceFetch = vi.fn(async () =>
      Response.json({ answer: 'unexpected', ok: true }),
    )
    const env = createEnv({ serviceFetch })

    expect(
      (await invoke(chatRequest({ question: '案内して' }, { origin: '' }), env))
        .status,
    ).toBe(403)
    expect(
      (
        await invoke(
          chatRequest(
            { question: '案内して' },
            { origin: 'https://example.invalid', secFetchSite: 'cross-site' },
          ),
          env,
        )
      ).status,
    ).toBe(403)
    expect(
      (
        await invoke(
          new Request(`${ORIGIN}/api/alpha-chat`, {
            body: '案内して',
            headers: { 'Content-Type': 'text/plain', Origin: ORIGIN },
            method: 'POST',
          }),
          env,
        )
      ).status,
    ).toBe(415)
    expect(
      (
        await invoke(
          chatRequest({ question: '案内して' }),
          createEnv({ includeService: false }),
        )
      ).status,
    ).toBe(503)
    expect(
      (
        await invoke(
          chatRequest({ question: '案内して' }),
          createEnv({ includeDatabase: false }),
        )
      ).status,
    ).toBe(503)
    expect(serviceFetch).not.toHaveBeenCalled()
  })

  it('rejects malformed, oversized, and overlong request data before forwarding', async () => {
    const serviceFetch = vi.fn(async () =>
      Response.json({ answer: 'unexpected', ok: true }),
    )
    const env = createEnv({ serviceFetch })

    const malformed = await invoke(
      new Request(`${ORIGIN}/api/alpha-chat`, {
        body: '{',
        headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
        method: 'POST',
      }),
      env,
    )
    expect(malformed.status).toBe(400)

    const oversized = await invoke(
      chatRequest(
        { question: '案内して' },
        { contentLength: String(96 * 1024 + 1) },
      ),
      env,
    )
    expect(oversized.status).toBe(413)

    const longQuestion = await invoke(
      chatRequest({ question: 'あ'.repeat(501) }),
      env,
    )
    expect(longQuestion.status).toBe(400)

    const longConversation = await invoke(
      chatRequest({
        messages: [{ content: 'あ'.repeat(2_801), role: 'assistant' }],
        question: '続き',
      }),
      env,
    )
    expect(longConversation.status).toBe(400)
    expect(serviceFetch).not.toHaveBeenCalled()
  })

  it('keeps the existing client and global D1 rate limits', async () => {
    const clientBlockedService = vi.fn(async () =>
      Response.json({ answer: 'unexpected', ok: true }),
    )
    const clientBlocked = await invoke(
      chatRequest({ question: '案内して' }),
      createEnv({ clientAllowed: false, serviceFetch: clientBlockedService }),
    )
    expect(clientBlocked.status).toBe(429)
    expect(clientBlocked.headers.get('Retry-After')).toBe('60')
    expect(clientBlockedService).not.toHaveBeenCalled()

    const globalBlockedService = vi.fn(async () =>
      Response.json({ answer: 'unexpected', ok: true }),
    )
    const globalBlocked = await invoke(
      chatRequest({ question: '案内して' }),
      createEnv({ globalAllowed: false, serviceFetch: globalBlockedService }),
    )
    expect(globalBlocked.status).toBe(429)
    expect(globalBlockedService).not.toHaveBeenCalled()
  })
})

describe('Alpha-kun WIKI fixed copy', () => {
  it('uses calm casual Japanese in component data and script fallbacks', async () => {
    const expected = [
      'やあ、ぼくはアルファくんだよ。公開中のAceserver WIKIから案内するね。',
      'いまWIKIを調べているよ…',
      'いまはうまく答えを届けられなかったよ。少し時間をおいて、もう一度聞いてね。',
    ]
    for (const message of expected) {
      expect(alphaGuideSource).toContain(message)
      expect(alphaChatClientSource).toContain(message)
    }
    expect(alphaChatClientSource).toContain(
      '会話の継続情報を更新したよ。表示中のメッセージはそのままだよ。',
    )
    expect(`${alphaGuideSource}\n${alphaChatClientSource}`).not.toMatch(
      /(?:です|ます|ください)(?:[。！？!?…]|$)/u,
    )
    expect(alphaChatClientSource).toMatch(/Accept:\s*'text\/event-stream'/u)
    expect(alphaChatClientSource).toMatch(/response\.body\.getReader\(\)/u)
    expect(alphaChatClientSource).toMatch(/event === 'delta'/u)
    expect(alphaChatClientSource).toMatch(
      /event === 'complete' \|\| event === 'error'/u,
    )
    expect(alphaChatClientSource).toMatch(/bubble\.textContent = text/u)
  })

  it('keeps the public endpoint free of local model and search generation', async () => {
    expect(alphaChatEndpointSource).toContain('ALPHA_CHAT_SERVICE')
    expect(alphaChatEndpointSource).toContain('CMS_DATABASE')
    expect(alphaChatEndpointSource).not.toContain('ALPHA_CHAT_SHARED_ENABLED')
    expect(alphaChatEndpointSource).not.toContain("from './_openai'")
    expect(alphaChatEndpointSource).not.toContain('OPENAI_API_KEY')
    expect(alphaChatEndpointSource).not.toContain('SEARCH_INDEX')
    expect(alphaChatEndpointSource).not.toContain('createOpenAi')
  })
})

function chatRequest(
  body: unknown,
  {
    accept,
    clientId = '018f7e5a-7b4d-7c6a-8e9f-0123456789ab',
    connectingIp,
    contentLength,
    origin = ORIGIN,
    secFetchSite,
  }: {
    accept?: string
    clientId?: string
    connectingIp?: string
    contentLength?: string
    origin?: string
    secFetchSite?: string
  } = {},
): Request {
  const headers = new Headers({
    ...(accept ? { Accept: accept } : {}),
    'Content-Type': 'application/json',
    'X-Acecore-Chat-Client': clientId,
  })
  if (origin) headers.set('Origin', origin)
  if (connectingIp) headers.set('CF-Connecting-IP', connectingIp)
  if (contentLength) headers.set('Content-Length', contentLength)
  if (secFetchSite) headers.set('Sec-Fetch-Site', secFetchSite)

  return new Request(`${ORIGIN}/api/alpha-chat`, {
    body: JSON.stringify(body),
    headers,
    method: 'POST',
  })
}

function createEnv({
  clientAllowed = true,
  globalAllowed = true,
  includeDatabase = true,
  includeService = true,
  serviceFetch = async () =>
    Response.json({ answer: '案内するよ。', ok: true, sources: [] }),
}: {
  clientAllowed?: boolean
  globalAllowed?: boolean
  includeDatabase?: boolean
  includeService?: boolean
  serviceFetch?: (request: Request) => Promise<Response>
} = {}) {
  return {
    ALPHA_CHAT_ENABLED: 'true',
    ALPHA_CHAT_SERVICE: includeService
      ? ({ fetch: serviceFetch } as unknown as Fetcher)
      : undefined,
    CMS_DATABASE: includeDatabase
      ? createRateLimitDatabase({ clientAllowed, globalAllowed })
      : undefined,
  }
}

function createRateLimitDatabase({
  clientAllowed,
  globalAllowed,
}: {
  clientAllowed: boolean
  globalAllowed: boolean
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
              const allowed =
                key === 'alpha-global' ? globalAllowed : clientAllowed
              return allowed ? { request_count: 1 } : null
            },
          }
        },
      }
    },
  } as unknown as D1Database
}

async function invoke(request: Request, env: ReturnType<typeof createEnv>) {
  return createAlphaChatHandler()({
    request,
    env,
    waitUntil(promise: Promise<unknown>) {
      void promise
    },
  } as unknown as Parameters<ReturnType<typeof createAlphaChatHandler>>[0])
}
