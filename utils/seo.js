import {
  ROOT_DESCRIPTION,
  ROOT_META_TITLE,
  buildArticleMetaDescription,
  buildArticleMetaTitle,
} from './seo-metadata.mjs'
import { ensureImageAlts } from './image-alt.mjs'

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

export { ensureImageAlts }
