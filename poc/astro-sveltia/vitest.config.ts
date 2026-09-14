import {
  cloudflareTest,
  readD1Migrations,
} from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

const cmsStateMigrations = await readD1Migrations('./migrations')
const testSecrets = {
  CMS_ACCESS_AUD: 'test-audience',
  CMS_ACCESS_TEAM_DOMAIN: 'https://team.cloudflareaccess.com',
  CMS_ACCESS_HOSTNAMES: 'wiki-admin.example.test',
  CMS_DISCORD_GUILD_ID: '123456789012345678',
  CMS_DISCORD_ALLOWED_ROLE_IDS: '234567890123456789',
  CMS_GITHUB_APP_CLIENT_ID: 'Iv1.test',
  CMS_GITHUB_APP_INSTALLATION_ID: '12345',
  CMS_GITHUB_APP_PRIVATE_KEY: 'test-only-not-a-private-key',
} as const

Object.assign(process.env, testSecrets)

export default defineConfig({
  plugins: [
    cloudflareTest({
      remoteBindings: false,
      wrangler: {
        configPath: './wrangler.jsonc',
      },
      miniflare: {
        bindings: {
          ...testSecrets,
          TEST_D1_MIGRATIONS: cmsStateMigrations,
        },
        serviceBindings: {
          CMS_DISCORD_MEMBERSHIP: async () =>
            Response.json({ ok: false }, { status: 503 }),
          CMS_AI: async () =>
            Response.json(
              {
                message: 'CMS AI is not available in this test.',
              },
              { status: 503 },
            ),
          ALPHA_CHAT_SERVICE: async () =>
            Response.json(
              {
                ok: false,
                error: 'Shared Alpha chat is not available in this test.',
              },
              { status: 503 },
            ),
        },
      },
    }),
  ],
  test: {
    include: ['tests/**/*.test.ts'],
  },
})
