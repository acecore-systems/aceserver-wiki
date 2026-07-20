import { promises as fs } from 'fs'
import { resolve } from 'path'
import { createClient } from 'newt-client-js'
import { htmlToText } from 'html-to-text'
import { inspectImageAlts } from './utils/image-alt.mjs'
import {
  ROOT_DESCRIPTION,
  ROOT_META_TITLE,
  SITE_URL,
  articlePath,
  canonicalUrl,
} from './utils/seo'

const token = process.env.NEWT_CDN_API_TOKEN

if (!token) {
  throw new Error(
    'NEWT_CDN_API_TOKEN is required to build the static Wiki content.'
  )
}

const publicConfig = {
  spaceUid: 'aceserver',
  appUid: 'wiki',
  apiType: 'cdn',
  articleModelUid: 'article',
  categoryModelUid: 'category',
  linkModelUid: 'link',
}

const serverConfig = {
  ...publicConfig,
  token,
}

let articlesPromise

const fetchArticles = () => {
  if (!articlesPromise) {
    const client = createClient({
      spaceUid: serverConfig.spaceUid,
      token: serverConfig.token,
      apiType: serverConfig.apiType,
    })

    articlesPromise = client
      .getContents({
        appUid: serverConfig.appUid,
        modelUid: serverConfig.articleModelUid,
        query: {
          depth: 2,
          order: ['sortOrder'],
          select: ['_id', 'title', 'slug', 'body'],
          limit: 1000,
        },
      })
      .then(({ items }) => items)
  }

  return articlesPromise
}

const createSitemap = (articles) => {
  const locations = [
    `${SITE_URL}/`,
    ...articles.map((article) => canonicalUrl(articlePath(article.slug))),
  ]

  const urls = [...new Set(locations)]
    .map((location) => `  <url><loc>${location}</loc></url>`)
    .join('\n')

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`
}

const createSearchIndex = (articles) =>
  JSON.stringify(
    articles.map((article) => ({
      _id: article._id,
      title: article.title,
      slug: article.slug,
      text: htmlToText(article.body || '', {
        selectors: [{ selector: 'img', format: 'skip' }],
      }),
    })),
    null,
    2
  )

const addNoindexToNotFoundPage = async () => {
  const notFoundPath = resolve(__dirname, 'dist', '404.html')
  const html = await fs.readFile(notFoundPath, 'utf8')
  if (/<meta\b(?=[^>]*\bname=["']robots["'])[^>]*>/i.test(html)) return
  const updated = html.replace(
    '</head>',
    '<meta name="robots" content="noindex, nofollow"></head>'
  )
  await fs.writeFile(notFoundPath, updated, 'utf8')
}

const auditGeneratedImageAlts = async (articles) => {
  const routes = ['/', ...articles.map((article) => articlePath(article.slug))]
  const summary = {
    urls: routes.length,
    images: 0,
    missingAlt: 0,
    emptyAlt: 0,
  }
  const failures = []

  for (const route of routes) {
    const pathname = decodeURIComponent(route)
    const file =
      pathname === '/'
        ? resolve(__dirname, 'dist', 'index.html')
        : resolve(
            __dirname,
            'dist',
            pathname.replace(/^\//, '').replace(/\/$/, ''),
            'index.html'
          )
    const html = await fs.readFile(file, 'utf8')
    const audit = inspectImageAlts(html)
    summary.images += audit.images
    summary.missingAlt += audit.missing
    summary.emptyAlt += audit.empty

    for (const issue of audit.issues) {
      failures.push(
        route +
          ': ' +
          issue.state +
          ' alt (' +
          (issue.source || 'src missing') +
          ')'
      )
    }
  }

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ imageAltAudit: summary }))
  if (failures.length > 0) {
    throw new Error('Generated image alt audit failed:\n' + failures.join('\n'))
  }
}

export default {
  publicRuntimeConfig: {
    ...publicConfig,
  },

  privateRuntimeConfig: {
    token,
  },

  // Target: https://go.nuxtjs.dev/config-target
  target: 'static',

  generate: {
    fallback: '404.html',
    async routes() {
      const articles = await fetchArticles()
      return articles.map((article) => articlePath(article.slug))
    },
  },

  hooks: {
    async 'generate:done'() {
      const articles = await fetchArticles()
      await Promise.all([
        fs.writeFile(
          resolve(__dirname, 'dist', 'sitemap.xml'),
          createSitemap(articles),
          'utf8'
        ),
        fs.writeFile(
          resolve(__dirname, 'dist', 'search-index.json'),
          createSearchIndex(articles),
          'utf8'
        ),
        addNoindexToNotFoundPage(),
      ])
      await auditGeneratedImageAlts(articles)
    },
  },

  // Global page headers: https://go.nuxtjs.dev/config-head
  head: {
    title: ROOT_META_TITLE,
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
      {
        hid: 'msvalidate.01',
        name: 'msvalidate.01',
        content: 'B670753BF4A50FA5437E5694CB04BAFD',
      },
    ],
    link: [{ rel: 'icon', type: 'image/x-icon', href: '/favicon.ico' }],
  },

  // Global CSS: https://go.nuxtjs.dev/config-css
  css: ['~/assets/css/style.css'],

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
    [
      '@nuxtjs/google-adsense',
      {
        id: 'ca-pub-3935803464310919',
        pageLevelAds: true, // 自動広告を表示させる場合
      },
    ],
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
