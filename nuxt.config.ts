import { ROOT_DESCRIPTION, ROOT_META_TITLE } from './shared/lib/seo-metadata.js'

const hasNewtToken = Boolean(process.env.NEWT_CDN_API_TOKEN)

export default defineNuxtConfig({
  compatibilityDate: '2026-07-23',
  modules: ['@nuxt/eslint'],
  css: ['~/assets/css/style.css'],
  devtools: {
    enabled: false,
  },
  runtimeConfig: {
    newtCdnApiToken: process.env.NEWT_CDN_API_TOKEN,
  },
  app: {
    head: {
      title: ROOT_META_TITLE,
      htmlAttrs: {
        lang: 'ja',
      },
      meta: [
        { charset: 'utf-8' },
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
        { name: 'description', content: ROOT_DESCRIPTION },
        { name: 'format-detection', content: 'telephone=no' },
        {
          name: 'msvalidate.01',
          content: 'B670753BF4A50FA5437E5694CB04BAFD',
        },
      ],
      link: [{ rel: 'icon', type: 'image/x-icon', href: '/favicon.ico' }],
      script: [
        {
          async: true,
          crossorigin: 'anonymous',
          src: 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-3935803464310919',
        },
      ],
    },
  },
  nitro: {
    prerender: {
      crawlLinks: hasNewtToken,
      failOnError: true,
      routes: hasNewtToken
        ? ['/', '/search/', '/sitemap.xml', '/search-index.json']
        : [],
    },
  },
})
