import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

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
      wrangler: {
        configPath: './wrangler.jsonc',
      },
      miniflare: {
        bindings: testSecrets,
      },
    }),
  ],
  test: {
    include: ['tests/**/*.test.ts'],
  },
})
