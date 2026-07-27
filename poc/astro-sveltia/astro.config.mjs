import { defineConfig } from 'astro/config'
import { unified } from '@astrojs/markdown-remark'
import { fileURLToPath } from 'node:url'

import { rehypeUgcExternalLinks } from './src/lib/external-link-policy.ts'

const site = process.env.ASTRO_SITE_URL ?? 'https://asv-wiki.acecore.net'

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  output: 'static',
  site,
  trailingSlash: 'always',
  markdown: {
    syntaxHighlight: 'shiki',
    processor: unified({
      rehypePlugins: [[rehypeUgcExternalLinks, { site }]],
    }),
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
