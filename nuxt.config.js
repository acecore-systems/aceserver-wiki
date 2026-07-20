import { promises as fs } from 'fs'
import { resolve } from 'path'
import { createClient } from 'newt-client-js'
import {
  ROOT_DESCRIPTION,
  SITE_TITLE,
  articlePath,
  canonicalUrl,
} from './utils/seo'


const config = {
  spaceUid: 'aceserver',
  appUid: 'wiki',
  token: 'lLlHPd32YH3KJQI7OPXKFFOsqlxmz38AARJCpa0rq5U',
  apiType: 'cdn',
  articleModelUid: 'article',
  categoryModelUid: 'category',
  linkModelUid: 'link',
}

let articleSummariesPromise

const fetchArticleSummaries = () => {
  if (!articleSummariesPromise) {
    const client = createClient({
      spaceUid: config.spaceUid,
      token: config.token,
      apiType: config.apiType,
    })

    articleSummariesPromise = client
      .getContents({
        appUid: config.appUid,
        modelUid: config.articleModelUid,
        query: {
          depth: 2,
          order: ['sortOrder'],
          select: ['title', 'slug'],
          limit: 1000,
        },
      })
      .then(({ items }) => items)
  }

  return articleSummariesPromise
}

const createSitemap = (articles) => {
  const locations = articles.map((article) =>
    canonicalUrl(articlePath(article.slug))
  )

  const urls = [...new Set(locations)]
    .map((location) => `  <url><loc>${location}</loc></url>`)
    .join('\n')

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`
}

export default {
  publicRuntimeConfig: {
    ...config,
  },

  // Target: https://go.nuxtjs.dev/config-target
  target: 'static',

  generate: {
    fallback: '404.html',
    async routes() {
      const articles = await fetchArticleSummaries()
      return articles.map((article) => articlePath(article.slug))
    },
  },

  hooks: {
    async 'generate:done'() {
      const articles = await fetchArticleSummaries()
      await fs.writeFile(
        resolve(__dirname, 'dist', 'sitemap.xml'),
        createSitemap(articles),
        'utf8'
      )
    },
  },

  // Global page headers: https://go.nuxtjs.dev/config-head
  head: {
    title: SITE_TITLE,
    htmlAttrs: {
      lang: 'ja',
    },
    meta: [
      { charset: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      {
        hid: 'description',
        name: 'description',
        content: ROOT_DESCRIPTION,
      },
      { name: 'format-detection', content: 'telephone=no' },
    ],
    link: [{ rel: 'icon', type: 'image/x-icon', href: '/favicon.ico' }],
  },

  // Global CSS: https://go.nuxtjs.dev/config-css
  css: [
    '~/assets/css/style.css'
  ],

  // Plugins to run before rendering page: https://go.nuxtjs.dev/config-plugins
  plugins: [],

  // Auto import components: https://go.nuxtjs.dev/config-components
  components: true,

  // Modules for dev and build (recommended): https://go.nuxtjs.dev/config-modules
  buildModules: [
    // https://go.nuxtjs.dev/eslint
    '@nuxtjs/eslint-module',
  ],

  // Modules: https://go.nuxtjs.dev/config-modules
  modules: [
    // https://go.nuxtjs.dev/axios
    '@nuxtjs/axios',
    ["@nuxtjs/google-adsense",
    {
      id: "ca-pub-3935803464310919",
      pageLevelAds: true, // 自動広告を表示させる場合
    }],
  ],

  // Build Configuration: https://go.nuxtjs.dev/config-build
  build: {
    extend(config) {
      config.module.rules.push({
        test: /\.mjs$/,
        include: /node_modules/,
        type: 'javascript/auto',
      })
    },
  },

  alias: {
    utils: resolve(__dirname, './utils'),
  },

  router: {
    trailingSlash: true,
  },
}
