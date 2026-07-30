import { afterEach, describe, expect, it, vi } from 'vitest'

const joseMock = vi.hoisted(() => ({
  createRemoteJWKSet: vi.fn(() => vi.fn()),
  jwtVerify: vi.fn(),
}))

vi.mock('jose', () => joseMock)

import { getAccessIdentity } from '../functions/admin/api/_access-auth.ts'
import type { CmsRuntimeEnv } from '../functions/admin/api/_cms-policy.ts'

const BASE_ENV = {
  CMS_REPOSITORY_OWNER: 'acecore-systems',
  CMS_REPOSITORY_NAME: 'aceserver-wiki',
  CMS_REPOSITORY_BRANCH: 'main',
  CMS_CONTENT_ROOT: 'poc/astro-sveltia/src/content/wiki',
  CMS_MEDIA_ROOT: 'poc/astro-sveltia/public/uploads/wiki',
  CMS_PUBLICATION_MODE: 'direct',
  CMS_ACCESS_AUD: 'test-audience',
  CMS_ACCESS_TEAM_DOMAIN: 'https://team.cloudflareaccess.com',
  CMS_ACCESS_HOSTNAMES: 'wiki-admin.example.test',
  CMS_DISCORD_GUILD_ID: '',
  CMS_DISCORD_AUTHORIZATION_MODE: 'account',
  CMS_DISCORD_ALLOWED_ROLE_IDS: '',
  CMS_GITHUB_APP_CLIENT_ID: 'Iv1.test',
  CMS_GITHUB_APP_INSTALLATION_ID: '12345',
  CMS_GITHUB_APP_PRIVATE_KEY: 'test-only',
} as const satisfies CmsRuntimeEnv

afterEach(() => {
  joseMock.jwtVerify.mockReset()
})

describe('Cloudflare Access boundary', () => {
  it('fails closed when deployment configuration is invalid', async () => {
    const result = await getAccessIdentity(
      new Request('https://wiki-admin.example.test/admin/api/session'),
      {
        ...BASE_ENV,
        CMS_ACCESS_TEAM_DOMAIN: 'https://example.com',
      },
    )

    expect(result).toMatchObject({ ok: false, status: 503 })
  })

  it('rejects requests from a hostname outside the allowlist', async () => {
    const result = await getAccessIdentity(
      new Request('https://untrusted.example.test/admin/api/session'),
      BASE_ENV,
    )

    expect(result).toMatchObject({ ok: false, status: 401 })
  })

  it('requires the Access JWT even on an allowed hostname', async () => {
    const result = await getAccessIdentity(
      new Request('https://wiki-admin.example.test/admin/api/session'),
      BASE_ENV,
    )

    expect(result).toMatchObject({ ok: false, status: 401 })
  })

  it('rejects malformed Discord role configuration', async () => {
    const result = await getAccessIdentity(
      new Request('https://wiki-admin.example.test/admin/api/session'),
      {
        ...BASE_ENV,
        CMS_DISCORD_ALLOWED_ROLE_IDS: 'not-a-snowflake',
      },
    )

    expect(result).toMatchObject({ ok: false, status: 503 })
  })

  it('allows an empty role list in guild authorization mode', async () => {
    const result = await getAccessIdentity(
      new Request('https://wiki-admin.example.test/admin/api/session'),
      {
        ...BASE_ENV,
        CMS_DISCORD_GUILD_ID: '123456789012345678',
        CMS_DISCORD_AUTHORIZATION_MODE: 'guild',
        CMS_DISCORD_ALLOWED_ROLE_IDS: '',
      },
    )

    expect(result).toMatchObject({ ok: false, status: 401 })
  })

  it('accepts the configured guild without requiring a role claim', async () => {
    joseMock.jwtVerify.mockResolvedValue({
      payload: {
        custom: {
          discord_guild_id: '123456789012345678',
          discord_id: '987654321098765432',
        },
        sub: 'cloudflare-subject',
        type: 'app',
      },
    })

    const result = await getAccessIdentity(
      new Request('https://wiki-admin.example.test/admin/api/session', {
        headers: { 'cf-access-jwt-assertion': 'test-token' },
      }),
      {
        ...BASE_ENV,
        CMS_DISCORD_GUILD_ID: '123456789012345678',
        CMS_DISCORD_AUTHORIZATION_MODE: 'guild',
        CMS_DISCORD_ALLOWED_ROLE_IDS: '',
      },
    )

    expect(result).toEqual({
      ok: true,
      discordId: '987654321098765432',
      discordRoleIds: [],
      subject: 'cloudflare-subject',
    })
  })

  it('still requires an allowed role claim in role mode', async () => {
    joseMock.jwtVerify.mockResolvedValue({
      payload: {
        custom: {
          discord_guild_id: '123456789012345678',
          discord_id: '987654321098765432',
        },
        sub: 'cloudflare-subject',
        type: 'app',
      },
    })

    const result = await getAccessIdentity(
      new Request('https://wiki-admin.example.test/admin/api/session', {
        headers: { 'cf-access-jwt-assertion': 'test-token' },
      }),
      {
        ...BASE_ENV,
        CMS_DISCORD_GUILD_ID: '123456789012345678',
        CMS_DISCORD_AUTHORIZATION_MODE: 'role',
        CMS_DISCORD_ALLOWED_ROLE_IDS: '222222222222222222',
      },
    )

    expect(result).toMatchObject({ ok: false, status: 403 })
  })

  it.each([undefined, '111111111111111111'])(
    'rejects a missing or different guild claim',
    async (discordGuildId) => {
      joseMock.jwtVerify.mockResolvedValue({
        payload: {
          custom: {
            ...(discordGuildId
              ? { discord_guild_id: discordGuildId }
              : {}),
            discord_id: '987654321098765432',
          },
          sub: 'cloudflare-subject',
          type: 'app',
        },
      })

      const result = await getAccessIdentity(
        new Request('https://wiki-admin.example.test/admin/api/session', {
          headers: { 'cf-access-jwt-assertion': 'test-token' },
        }),
        {
          ...BASE_ENV,
          CMS_DISCORD_GUILD_ID: '123456789012345678',
          CMS_DISCORD_AUTHORIZATION_MODE: 'guild',
          CMS_DISCORD_ALLOWED_ROLE_IDS: '',
        },
      )

      expect(result).toMatchObject({ ok: false, status: 403 })
    },
  )
})
