import { defineConfig } from 'astro/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  output: 'static',
  site: process.env.ASTRO_SITE_URL ?? 'https://asv-wiki.acecore.net',
  trailingSlash: 'always',
  markdown: {
    syntaxHighlight: 'shiki',
  },
  vite: {
    esbuild: {
      tsconfigRaw: '{}',
    },
    resolve: {
      tsconfigPaths: false,
    },
    build: {
      rolldownOptions: {
        tsconfig: false,
      },
    },
  },
})
