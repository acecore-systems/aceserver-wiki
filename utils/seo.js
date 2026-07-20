import {
  ROOT_DESCRIPTION,
  ROOT_META_TITLE,
  buildArticleMetaDescription,
  buildArticleMetaTitle,
} from './seo-metadata.mjs'

export {
  ROOT_DESCRIPTION,
  ROOT_META_TITLE,
  buildArticleMetaDescription,
  buildArticleMetaTitle,
}

export const SITE_URL = 'https://asv-wiki.acecore.net'

export const SITE_TITLE = 'エースサーバー Wiki'

export const articlePath = (slug) =>
  `/article/${encodeURIComponent(slug || '')}/`

export const canonicalUrl = (path) => `${SITE_URL}${path}`

const IMAGE_ALT_BY_SOURCE = {
  'https://cdn.pixabay.com/photo/2020/03/22/15/25/fetch-4957501_1280.jpg':
    'エースサーバーの宣伝イメージ',
}

export const ensureImageAlts = (html = '') =>
  html.replace(/<img\b[^>]*>/gi, (tag) => {
    if (/\balt\s*=/i.test(tag)) return tag

    const source = tag.match(/\bsrc\s*=\s*["']([^"']+)["']/i)
    const alt = (source && IMAGE_ALT_BY_SOURCE[source[1]]) || ''
    return tag.replace(/<img\b/i, `<img alt="${alt}"`)
  })
