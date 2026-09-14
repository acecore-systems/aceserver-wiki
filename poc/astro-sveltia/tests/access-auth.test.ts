import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const joseMock = vi.hoisted(() => ({
  createRemoteJWKSet: vi.fn(() => vi.fn()),
  jwtVerify: vi.fn(),
}))
vi.mock('jose', () => joseMock)
import { getAccessIdentity } from '../functions/admin/api/_access-auth.ts'
import type { CmsRuntimeEnv } from '../functions/admin/api/_cms-policy.ts'
import membershipWorker from '../workers/discord-membership/index'

const id = '987654321098765432'
const guild = '737538781024092170'
const role = '222222222222222222'
const accessSubject = '22222222-2222-4222-8222-222222222222'
const acecoreSubject = '11111111-1111-4111-8111-111111111111'
const issuer = 'https://team.cloudflareaccess.com'
const custom = {
  'https://acecore.net/claims/discord-id': id,
  'https://acecore.net/claims/subject': acecoreSubject,
}
const BASE_ENV = {
  CMS_REPOSITORY_OWNER: 'acecore-systems',
  CMS_REPOSITORY_NAME: 'aceserver-wiki',
  CMS_REPOSITORY_BRANCH: 'main',
  CMS_CONTENT_ROOT: 'poc/astro-sveltia/src/content/wiki',
  CMS_MEDIA_ROOT: 'poc/astro-sveltia/public/uploads/wiki',
  CMS_PUBLICATION_MODE: 'direct',
  CMS_ACCESS_AUD: 'test-audience',
  CMS_ACCESS_TEAM_DOMAIN: issuer,
  CMS_ACCESS_HOSTNAMES: 'wiki-admin.example.test',
  CMS_DISCORD_GUILD_ID: guild,
  CMS_DISCORD_AUTHORIZATION_MODE: 'guild',
  CMS_DISCORD_ALLOWED_ROLE_IDS: '',
  CMS_DISCORD_MEMBERSHIP: {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) =>
      membershipWorker.fetch(new Request(input, init), {
        WIKI_GUILD_ID: guild,
        DISCORD_BOT_TOKEN: { get: async () => 'test-only-bot-token' },
      }),
  },
} satisfies CmsRuntimeEnv
const fetchMock = vi.fn()
const request = () =>
  new Request('https://wiki-admin.example.test/admin/api/session', {
    headers: { 'cf-access-jwt-assertion': 'test-token' },
  })
const identity = () => ({ custom, sub: accessSubject, type: 'app' })
const fullIdentity = (overrides: Record<string, unknown> = {}) => ({
  user_uuid: accessSubject,
  account_id: 'db9b62f409f463da7acbcc374b8385d0',
  idp: { id: 'a18ae74a-a342-40db-bfb2-7cc515d26637', type: 'oidc' },
  oidc_fields: custom,
  ...overrides,
})

beforeEach(() => {
  joseMock.jwtVerify.mockResolvedValue({ payload: identity() })
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockImplementation(async (input) => {
    if (String(input) === `${issuer}/cdn-cgi/access/get-identity`) {
      return Response.json(fullIdentity())
    }

    return Response.json({ user: { id }, roles: [role], pending: false })
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
  fetchMock.mockReset()
  joseMock.jwtVerify.mockReset()
})

describe('AcecoreID Access and existing Discord authorization', () => {
  it('requires configured issuer, audience, hostnames and mode', async () => {
    for (const change of [
      { CMS_ACCESS_TEAM_DOMAIN: 'https://example.com' },
      { CMS_ACCESS_AUD: '' },
      { CMS_ACCESS_HOSTNAMES: '' },
      { CMS_DISCORD_AUTHORIZATION_MODE: '' },
      { CMS_DISCORD_ALLOWED_ROLE_IDS: 'not-a-snowflake' },
      { CMS_DISCORD_GUILD_ID: '' },
    ]) {
      expect(
        await getAccessIdentity(request(), { ...BASE_ENV, ...change }),
      ).toMatchObject({ ok: false, status: 503 })
    }
  })
  it('rejects missing JWT and foreign hostname before any provider call', async () => {
    for (const req of [
      new Request(request().url),
      new Request('https://other.test/admin/api/session', request()),
    ]) {
      expect(await getAccessIdentity(req, BASE_ENV)).toMatchObject({
        ok: false,
        status: 401,
      })
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('verifies app signature, issuer, audience and mandatory time claims', async () => {
    await getAccessIdentity(request(), BASE_ENV)
    expect(joseMock.jwtVerify).toHaveBeenCalledWith(
      'test-token',
      expect.any(Function),
      expect.objectContaining({
        algorithms: ['RS256'],
        issuer: BASE_ENV.CMS_ACCESS_TEAM_DOMAIN,
        audience: BASE_ENV.CMS_ACCESS_AUD,
        requiredClaims: ['exp', 'iat', 'sub'],
      }),
    )
    joseMock.jwtVerify.mockRejectedValue(new Error('invalid signature'))
    expect(await getAccessIdentity(request(), BASE_ENV)).toMatchObject({
      ok: false,
      status: 401,
    })
  })
  it.each([
    [],
    {
      ...custom,
      'https://acecore.net/claims/discord-id': ['987654321098765432'],
    },
    { ...custom, 'https://acecore.net/claims/subject': 'not-a-subject' },
  ])(
    'rejects old-provider or malformed signed identity attributes',
    async (claims) => {
      joseMock.jwtVerify.mockResolvedValue({
        payload: { ...identity(), custom: claims },
      })
      expect(await getAccessIdentity(request(), BASE_ENV)).toMatchObject({
        ok: false,
        status: 403,
      })
      expect(fetchMock).not.toHaveBeenCalled()
    },
  )
  it.each([
    undefined,
    {},
    { 'https://acecore.net/claims/subject': acecoreSubject },
    { 'https://acecore.net/claims/discord-id': id },
  ])(
    'fills only missing signed claims from the matching full identity',
    async (claims) => {
      joseMock.jwtVerify.mockResolvedValue({
        payload: { ...identity(), custom: claims },
      })
      expect(await getAccessIdentity(request(), BASE_ENV)).toEqual({
        ok: true,
        discordId: id,
        discordRoleIds: [role],
        subject: accessSubject,
      })
      expect(fetchMock).toHaveBeenNthCalledWith(
        1,
        new URL('/cdn-cgi/access/get-identity', `${issuer}/`),
        expect.objectContaining({
          method: 'GET',
          redirect: 'manual',
          cache: 'no-store',
          signal: expect.any(AbortSignal),
          headers: {
            Accept: 'application/json',
            Cookie: 'CF_Authorization=test-token',
          },
        }),
      )
    },
  )
  it.each([
    [fullIdentity({ user_uuid: undefined }), 'CMS_AUTH_IDENTITY_USER_MISSING'],
    [
      fullIdentity({ user_uuid: '33333333-3333-4333-8333-333333333333' }),
      'CMS_AUTH_IDENTITY_USER_MISMATCH',
    ],
    [
      fullIdentity({ account_id: 'other' }),
      'CMS_AUTH_IDENTITY_ACCOUNT_MISMATCH',
    ],
    [fullIdentity({ idp: undefined }), 'CMS_AUTH_IDENTITY_PROVIDER_MISSING'],
    [
      fullIdentity({ idp: { id: 'other', type: 'oidc' } }),
      'CMS_AUTH_IDENTITY_PROVIDER_MISMATCH',
    ],
    [
      fullIdentity({
        idp: { id: 'a18ae74a-a342-40db-bfb2-7cc515d26637', type: 'github' },
      }),
      'CMS_AUTH_IDENTITY_PROVIDER_TYPE_MISMATCH',
    ],
    [
      fullIdentity({ oidc_fields: undefined }),
      'CMS_AUTH_IDENTITY_FIELDS_MISSING',
    ],
  ])(
    'rejects a full identity outside the fixed boundary: %s',
    async (value, code) => {
      joseMock.jwtVerify.mockResolvedValue({
        payload: { ...identity(), custom: undefined },
      })
      fetchMock.mockResolvedValue(Response.json(value))
      expect(await getAccessIdentity(request(), BASE_ENV)).toMatchObject({
        ok: false,
        status: 403,
        code,
      })
    },
  )
  it.each([
    [
      { 'https://acecore.net/claims/discord-id': id },
      {
        ...custom,
        'https://acecore.net/claims/discord-id': '111111111111111111',
      },
    ],
    [
      { 'https://acecore.net/claims/subject': acecoreSubject },
      {
        ...custom,
        'https://acecore.net/claims/subject':
          '33333333-3333-4333-8333-333333333333',
      },
    ],
  ])(
    'rejects conflicts between each direct claim and full identity fallback',
    async (directClaims, identityClaims) => {
      joseMock.jwtVerify.mockResolvedValue({
        payload: { ...identity(), custom: directClaims },
      })
      fetchMock.mockResolvedValue(
        Response.json(
          fullIdentity({
            oidc_fields: identityClaims,
          }),
        ),
      )
      expect(await getAccessIdentity(request(), BASE_ENV)).toMatchObject({
        ok: false,
        status: 403,
        code: 'CMS_AUTH_IDENTITY_SOURCE_CONFLICT',
      })
    },
  )
  it.each([
    new Response(null, { status: 302 }),
    new Response('{'),
    new Response('x'.repeat(65_537)),
  ])(
    'rejects unavailable, malformed, or oversized full identity responses',
    async (response) => {
      joseMock.jwtVerify.mockResolvedValue({
        payload: { ...identity(), custom: undefined },
      })
      fetchMock.mockResolvedValue(response)
      expect(await getAccessIdentity(request(), BASE_ENV)).toMatchObject({
        ok: false,
        status: 502,
      })
    },
  )
  it('rejects a malformed Access sub before full identity lookup', async () => {
    joseMock.jwtVerify.mockResolvedValue({
      payload: { ...identity(), sub: 'not-a-uuid', custom: undefined },
    })
    expect(await getAccessIdentity(request(), BASE_ENV)).toMatchObject({
      ok: false,
      status: 401,
      code: 'CMS_AUTH_ACCESS_SUBJECT_INVALID',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('rejects org/service tokens', async () => {
    joseMock.jwtVerify.mockResolvedValue({
      payload: { ...identity(), type: 'org' },
    })
    expect(await getAccessIdentity(request(), BASE_ENV)).toMatchObject({
      ok: false,
      status: 403,
    })
  })
  it('account mode does not add a guild condition', async () => {
    expect(
      await getAccessIdentity(request(), {
        ...BASE_ENV,
        CMS_DISCORD_AUTHORIZATION_MODE: 'account',
        CMS_DISCORD_GUILD_ID: '',
        CMS_DISCORD_MEMBERSHIP: undefined,
      }),
    ).toEqual({
      ok: true,
      discordId: id,
      discordRoleIds: [],
      subject: accessSubject,
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('guild mode checks the exact linked account in the configured guild', async () => {
    expect(await getAccessIdentity(request(), BASE_ENV)).toEqual({
      ok: true,
      discordId: id,
      discordRoleIds: [role],
      subject: accessSubject,
    })
    expect(fetchMock).toHaveBeenCalledWith(
      `https://discord.com/api/v10/guilds/${guild}/members/${id}`,
      expect.objectContaining({
        headers: {
          Authorization: 'Bot test-only-bot-token',
          Accept: 'application/json',
        },
        redirect: 'manual',
      }),
    )
  })
  it('keeps role authorization and rechecks role removal', async () => {
    const env = {
      ...BASE_ENV,
      CMS_DISCORD_AUTHORIZATION_MODE: 'role',
      CMS_DISCORD_ALLOWED_ROLE_IDS: role,
    }
    expect(await getAccessIdentity(request(), env)).toMatchObject({ ok: true })
    fetchMock.mockResolvedValue(Response.json({ user: { id }, roles: [] }))
    expect(await getAccessIdentity(request(), env)).toMatchObject({
      ok: false,
      status: 403,
    })
  })
  it('does not trust stale guild/role claims instead of a live membership', async () => {
    joseMock.jwtVerify.mockResolvedValue({
      payload: {
        ...identity(),
        custom: { ...custom, discord_guild_id: guild, discord_roles: [role] },
      },
    })
    fetchMock.mockResolvedValue(new Response(null, { status: 404 }))
    expect(await getAccessIdentity(request(), BASE_ENV)).toMatchObject({
      ok: false,
      status: 403,
    })
  })
  it('denies membership screening pending users', async () => {
    fetchMock.mockResolvedValue(
      Response.json({ user: { id }, roles: [role], pending: true }),
    )
    expect(await getAccessIdentity(request(), BASE_ENV)).toMatchObject({
      ok: false,
      status: 403,
    })
  })
  it.each([401, 403, 429, 500])(
    'fails closed on provider error %s',
    async (status) => {
      fetchMock.mockResolvedValue(
        new Response('provider detail must not leak', { status }),
      )
      expect(await getAccessIdentity(request(), BASE_ENV)).toMatchObject({
        ok: false,
        status: 503,
      })
    },
  )
  it('fails closed on missing bot, timeout, wrong user, malformed roles or oversized response', async () => {
    expect(
      await getAccessIdentity(request(), {
        ...BASE_ENV,
        CMS_DISCORD_MEMBERSHIP: undefined,
      }),
    ).toMatchObject({ ok: false, status: 503 })
    fetchMock.mockRejectedValueOnce(new Error('timeout'))
    expect(await getAccessIdentity(request(), BASE_ENV)).toMatchObject({
      ok: false,
      status: 503,
    })
    for (const body of [
      JSON.stringify({ user: { id: 'other' }, roles: [] }),
      JSON.stringify({ user: { id }, roles: ['invalid'] }),
      'x'.repeat(65537),
    ]) {
      fetchMock.mockResolvedValue(new Response(body))
      expect(await getAccessIdentity(request(), BASE_ENV)).toMatchObject({
        ok: false,
        status: 503,
      })
    }
  })
})
