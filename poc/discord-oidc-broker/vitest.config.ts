import { generateKeyPairSync } from 'node:crypto'

import {
  cloudflareTest,
  readD1Migrations,
} from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
})
const publicJwk = publicKey.export({ format: 'jwk' })
const testBindings = {
  DISCORD_CLIENT_ID: '123456789012345678',
  DISCORD_CLIENT_SECRET: 'test-discord-client-secret',
  DISCORD_GUILD_ID: '123456789012345679',
  OIDC_ACCESS_CLIENT_ID: 'cloudflare-access-test-client',
  OIDC_ACCESS_CLIENT_SECRET: 'test-cloudflare-access-secret',
  OIDC_ACCESS_REDIRECT_URIS:
    'https://acecore.cloudflareaccess.com/cdn-cgi/access/callback',
  OIDC_ISSUER: 'https://oidc.example.test',
  OIDC_SIGNING_PRIVATE_KEY_PEM: privateKey.export({
    format: 'pem',
    type: 'pkcs8',
  }),
  OIDC_SIGNING_PUBLIC_JWK_JSON: JSON.stringify({
    ...publicJwk,
    alg: 'RS256',
    key_ops: ['verify'],
    kid: 'test-signing-key',
    use: 'sig',
  }),
}

Object.assign(process.env, testBindings)

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          ...testBindings,
          TEST_D1_MIGRATIONS: await readD1Migrations('./migrations'),
        },
        d1Databases: {
          OIDC_MIGRATION_TEST_DB: 'oidc-migration-test',
        },
      },
    }),
  ],
  test: {
    include: ['tests/**/*.test.ts'],
  },
})
