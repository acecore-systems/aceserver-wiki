import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const joseMock = vi.hoisted(() => ({ createRemoteJWKSet: vi.fn(() => vi.fn()), jwtVerify: vi.fn() }))
vi.mock('jose', () => joseMock)
import { getAccessIdentity } from '../functions/admin/api/_access-auth.ts'
import type { CmsRuntimeEnv } from '../functions/admin/api/_cms-policy.ts'

const id = '987654321098765432'
const guild = '123456789012345678'
const role = '222222222222222222'
const custom = {
  'https://acecore.net/claims/discord-id': id,
  'https://acecore.net/claims/subject': '11111111-1111-4111-8111-111111111111',
}
const BASE_ENV = {
  CMS_REPOSITORY_OWNER: 'acecore-systems', CMS_REPOSITORY_NAME: 'aceserver-wiki',
  CMS_REPOSITORY_BRANCH: 'main', CMS_CONTENT_ROOT: 'poc/astro-sveltia/src/content/wiki',
  CMS_MEDIA_ROOT: 'poc/astro-sveltia/public/uploads/wiki', CMS_PUBLICATION_MODE: 'direct',
  CMS_ACCESS_AUD: 'test-audience', CMS_ACCESS_TEAM_DOMAIN: 'https://team.cloudflareaccess.com',
  CMS_ACCESS_HOSTNAMES: 'wiki-admin.example.test', CMS_DISCORD_GUILD_ID: guild,
  CMS_DISCORD_AUTHORIZATION_MODE: 'guild', CMS_DISCORD_ALLOWED_ROLE_IDS: '',
  CMS_DISCORD_BOT_TOKEN: 'test-only-bot-token',
} satisfies CmsRuntimeEnv
const fetchMock = vi.fn()
const request = () => new Request('https://wiki-admin.example.test/admin/api/session', {
  headers: { 'cf-access-jwt-assertion': 'test-token' },
})
const identity = () => ({ custom, sub: 'access-subject', type: 'app' })

beforeEach(() => {
  joseMock.jwtVerify.mockResolvedValue({ payload: identity() })
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockImplementation(async () => Response.json({ user: { id }, roles: [role], pending: false }))
})
afterEach(() => { vi.unstubAllGlobals(); fetchMock.mockReset(); joseMock.jwtVerify.mockReset() })

describe('AcecoreID Access and existing Discord authorization', () => {
  it('requires configured issuer, audience, hostnames and mode', async () => {
    for (const change of [{ CMS_ACCESS_TEAM_DOMAIN: 'https://example.com' }, { CMS_ACCESS_AUD: '' },
      { CMS_ACCESS_HOSTNAMES: '' }, { CMS_DISCORD_AUTHORIZATION_MODE: '' },
      { CMS_DISCORD_ALLOWED_ROLE_IDS: 'not-a-snowflake' }, { CMS_DISCORD_GUILD_ID: '' }]) {
      expect(await getAccessIdentity(request(), { ...BASE_ENV, ...change })).toMatchObject({ ok: false, status: 503 })
    }
  })
  it('rejects missing JWT and foreign hostname before any provider call', async () => {
    for (const req of [new Request(request().url), new Request('https://other.test/admin/api/session', request())]) {
      expect(await getAccessIdentity(req, BASE_ENV)).toMatchObject({ ok: false, status: 401 })
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('verifies app signature, issuer, audience and mandatory time claims', async () => {
    await getAccessIdentity(request(), BASE_ENV)
    expect(joseMock.jwtVerify).toHaveBeenCalledWith('test-token', expect.any(Function), expect.objectContaining({
      algorithms: ['RS256'], issuer: BASE_ENV.CMS_ACCESS_TEAM_DOMAIN, audience: BASE_ENV.CMS_ACCESS_AUD, requiredClaims: ['exp', 'iat', 'sub'],
    }))
    joseMock.jwtVerify.mockRejectedValue(new Error('invalid signature'))
    expect(await getAccessIdentity(request(), BASE_ENV)).toMatchObject({ ok: false, status: 401 })
  })
  it.each([
    {}, { discord_id: id }, { ...custom, 'https://acecore.net/claims/discord-id': ['987654321098765432'] },
    { ...custom, 'https://acecore.net/claims/subject': 'not-a-subject' },
  ])('rejects old-provider or malformed identity attributes', async (claims) => {
    joseMock.jwtVerify.mockResolvedValue({ payload: { ...identity(), custom: claims } })
    expect(await getAccessIdentity(request(), BASE_ENV)).toMatchObject({ ok: false, status: 403 })
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('rejects org/service tokens', async () => {
    joseMock.jwtVerify.mockResolvedValue({ payload: { ...identity(), type: 'org' } })
    expect(await getAccessIdentity(request(), BASE_ENV)).toMatchObject({ ok: false, status: 403 })
  })
  it('account mode does not add a guild condition', async () => {
    expect(await getAccessIdentity(request(), { ...BASE_ENV, CMS_DISCORD_AUTHORIZATION_MODE: 'account',
      CMS_DISCORD_GUILD_ID: '', CMS_DISCORD_BOT_TOKEN: '' })).toEqual({ ok: true, discordId: id, discordRoleIds: [], subject: 'access-subject' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('guild mode checks the exact linked account in the configured guild', async () => {
    expect(await getAccessIdentity(request(), BASE_ENV)).toEqual({ ok: true, discordId: id, discordRoleIds: [role], subject: 'access-subject' })
    expect(fetchMock).toHaveBeenCalledWith(`https://discord.com/api/v10/guilds/${guild}/members/${id}`,
      expect.objectContaining({ headers: { Authorization: 'Bot test-only-bot-token', Accept: 'application/json' }, redirect: 'error' }))
  })
  it('keeps role authorization and rechecks role removal', async () => {
    const env = { ...BASE_ENV, CMS_DISCORD_AUTHORIZATION_MODE: 'role', CMS_DISCORD_ALLOWED_ROLE_IDS: role }
    expect(await getAccessIdentity(request(), env)).toMatchObject({ ok: true })
    fetchMock.mockResolvedValue(Response.json({ user: { id }, roles: [] }))
    expect(await getAccessIdentity(request(), env)).toMatchObject({ ok: false, status: 403 })
  })
  it('does not trust stale guild/role claims instead of a live membership', async () => {
    joseMock.jwtVerify.mockResolvedValue({ payload: { ...identity(), custom: { ...custom, discord_guild_id: guild, discord_roles: [role] } } })
    fetchMock.mockResolvedValue(new Response(null, { status: 404 }))
    expect(await getAccessIdentity(request(), BASE_ENV)).toMatchObject({ ok: false, status: 403 })
  })
  it('denies membership screening pending users', async () => {
    fetchMock.mockResolvedValue(Response.json({ user: { id }, roles: [role], pending: true }))
    expect(await getAccessIdentity(request(), BASE_ENV)).toMatchObject({ ok: false, status: 403 })
  })
  it.each([401, 403, 429, 500])('fails closed on provider error %s', async (status) => {
    fetchMock.mockResolvedValue(new Response('provider detail must not leak', { status }))
    expect(await getAccessIdentity(request(), BASE_ENV)).toMatchObject({ ok: false, status: 503 })
  })
  it('fails closed on missing bot, timeout, wrong user, malformed roles or oversized response', async () => {
    expect(await getAccessIdentity(request(), { ...BASE_ENV, CMS_DISCORD_BOT_TOKEN: '' })).toMatchObject({ ok: false, status: 503 })
    fetchMock.mockRejectedValueOnce(new Error('timeout'))
    expect(await getAccessIdentity(request(), BASE_ENV)).toMatchObject({ ok: false, status: 503 })
    for (const body of [JSON.stringify({ user: { id: 'other' }, roles: [] }),
      JSON.stringify({ user: { id }, roles: ['invalid'] }), 'x'.repeat(65537)]) {
      fetchMock.mockResolvedValue(new Response(body))
      expect(await getAccessIdentity(request(), BASE_ENV)).toMatchObject({ ok: false, status: 503 })
    }
  })
})
