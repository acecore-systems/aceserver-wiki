import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from '../workers/discord-membership/index'
import {
  MEMBERSHIP_URL,
  readJson,
} from '../workers/discord-membership/protocol'
import { readDiscordMembership } from '../functions/admin/api/_discord-membership'
import workerConfig from '../workers/discord-membership/wrangler.jsonc?raw'
import pagesConfig from '../wrangler.jsonc?raw'

const guildId = '737538781024092170'
const discordId = '987654321098765432'
const role = '222222222222222222'
const secret = 'test-only-not-a-real-token'
const makeRequest = (value: unknown = { guildId, discordId }) =>
  new Request(MEMBERSHIP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  })
const makeEnv = () =>
  ({
    WIKI_GUILD_ID: guildId,
    DISCORD_BOT_TOKEN: { get: vi.fn(async () => secret) },
  }) as const
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('private Discord membership service', () => {
  it('keeps the Worker private, Store-only, and unavailable to preview Pages', () => {
    const config = JSON.parse(workerConfig.replace(/,\s*([}\]])/gu, '$1'))
    const pages = JSON.parse(pagesConfig.replace(/,\s*([}\]])/gu, '$1'))
    expect(config.workers_dev).toBe(false)
    expect(config.preview_urls).toBe(false)
    expect(config.routes).toEqual([])
    expect(config.observability.logs.invocation_logs).toBe(false)
    expect(config.secrets_store_secrets).toEqual([
      expect.objectContaining({
        binding: 'DISCORD_BOT_TOKEN',
        secret_name: 'aceserver-wiki-production-discord-bot-token',
      }),
    ])
    expect(Object.keys(config.vars)).toEqual(['WIKI_GUILD_ID'])
    expect(pages.services).toContainEqual(
      expect.objectContaining({
        binding: 'CMS_DISCORD_MEMBERSHIP',
        service: config.name,
      }),
    )
    expect(
      pages.env.preview.services.some(
        (service: { binding: string }) =>
          service.binding === 'CMS_DISCORD_MEMBERSHIP',
      ),
    ).toBe(false)
    expect(pagesConfig).not.toContain('BOT_TOKEN')
  })
  it('passes the complete Pages-to-Worker call with request options', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ user: { id: discordId }, roles: [role] }),
      ),
    )
    let error: unknown
    let status: number | undefined
    const result = await readDiscordMembership(guildId, discordId, {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        try {
          const response = await worker.fetch(
            new Request(input, init),
            makeEnv(),
          )
          status = response.status
          return response
        } catch (caught) {
          error = caught
          throw caught
        }
      },
    })
    expect(error).toBeUndefined()
    expect(status).toBe(200)
    expect(result).toEqual({ ok: true, roles: [role] })
  })
  it('reads only Secrets Store and returns only membership identifiers and roles', async () => {
    const fetch = vi.fn(async () =>
      Response.json({
        user: { id: discordId, email: 'private@example.test' },
        roles: [role],
        pending: false,
      }),
    )
    vi.stubGlobal('fetch', fetch)
    const env = makeEnv()
    const response = await worker.fetch(makeRequest(), env)
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(await response.json()).toEqual({
      ok: true,
      guildId,
      discordId,
      roles: [role],
    })
    expect(env.DISCORD_BOT_TOKEN.get).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledWith(
      `https://discord.com/api/v10/guilds/${guildId}/members/${discordId}`,
      expect.objectContaining({
        headers: { Authorization: `Bot ${secret}`, Accept: 'application/json' },
        redirect: 'manual',
      }),
    )
    await worker.fetch(makeRequest(), env)
    expect(env.DISCORD_BOT_TOKEN.get).toHaveBeenCalledTimes(2)
  })
  it('rejects arbitrary routes, methods, guilds, malformed IDs, and oversized bodies before reading secrets', async () => {
    const env = makeEnv()
    for (const request of [
      new Request(MEMBERSHIP_URL),
      new Request('https://other.test/v1/member', makeRequest()),
      makeRequest({ guildId: '111111111111111111', discordId }),
      makeRequest({ guildId, discordId: '../@me' }),
      makeRequest({ guildId, discordId, padding: 'x'.repeat(1024) }),
      makeRequest([]),
      new Request(MEMBERSHIP_URL, { method: 'POST', body: '{}' }),
    ]) {
      expect((await worker.fetch(request, env)).status).toBeGreaterThanOrEqual(
        400,
      )
    }
    expect(env.DISCORD_BOT_TOKEN.get).not.toHaveBeenCalled()
  })
  it('fails closed and does not expose secret-store error details', async () => {
    const env = makeEnv()
    env.DISCORD_BOT_TOKEN.get.mockRejectedValue(new Error(secret))
    const response = await worker.fetch(makeRequest(), env)
    expect(response.status).toBe(503)
    expect(await response.text()).toBe('{"ok":false}')
  })
  it('forwards neither cookies nor Access JWT nor a token from Pages', async () => {
    const fetch = vi.fn(async () =>
      Response.json({ ok: true, guildId, discordId, roles: [role] }),
    )
    expect(await readDiscordMembership(guildId, discordId, { fetch })).toEqual({
      ok: true,
      roles: [role],
    })
    expect(fetch).toHaveBeenCalledWith(
      MEMBERSHIP_URL,
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guildId, discordId }),
      }),
    )
  })
  it('rejects mismatched or malformed service responses, redirects and errors', async () => {
    for (const response of [
      Response.json({ ok: true, guildId: 'other', discordId, roles: [] }),
      Response.json({ ok: true, guildId, discordId: 'other', roles: [] }),
      Response.json({ ok: true, guildId, discordId, roles: ['invalid'] }),
      Response.json({ ok: false, guildId, discordId, roles: [] }),
      new Response('{'),
      new Response('x'.repeat(16385)),
      new Response(null, { status: 302 }),
      new Response(null, { status: 500 }),
    ]) {
      expect(
        await readDiscordMembership(guildId, discordId, {
          fetch: vi.fn(async () => response),
        }),
      ).toMatchObject({ ok: false, status: 503 })
    }
    expect(
      await readDiscordMembership(guildId, discordId, {
        fetch: vi.fn(async () => new Response(null, { status: 403 })),
      }),
    ).toMatchObject({ ok: false, status: 403 })
  })
  it('cancels stalled body reads and fails closed', async () => {
    vi.useFakeTimers()
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({ cancel })
    const result = readJson(body, 1024).catch(() => 'timed-out')
    await vi.advanceTimersByTimeAsync(8001)
    expect(await result).toBe('timed-out')
    expect(cancel).toHaveBeenCalled()
  })
})
