export const SITE_URL = 'https://asv-wiki.acecore.net'

export const SITE_TITLE = 'エースサーバー Wiki'

export const ROOT_DESCRIPTION =
  'エースサーバーのルール、参加方法、コマンド、プラグイン情報をまとめた公式Wikiです。'

export const articlePath = (slug) =>
  `/article/${encodeURIComponent(slug || '')}/`

export const canonicalUrl = (path) => `${SITE_URL}${path}`
