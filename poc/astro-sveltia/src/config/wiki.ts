export const SITE_ORIGIN = 'https://asv-wiki.acecore.net'
export const SITE_NAME = 'エースサーバー公式Wiki'
export const ACECORE_ORGANIZATION_NAME = 'Acecore'
export const ACECORE_LEGAL_NAME = '株式会社Acecore'
export const ACECORE_ORIGIN = 'https://acecore.net/'
export const HEADER_TITLE = 'エースサーバーWIKI'
export const ROOT_META_TITLE =
  'エースサーバー公式Wiki｜ルール・参加方法・コマンド案内'
export const ROOT_DESCRIPTION =
  'エースサーバーの公式Wikiです。Minecraftサーバーへの参加方法、基本ルール、Discord連携、コマンドやプラグイン、Hubと各ワールドの遊び方、運営方針、コミュニティ情報をまとめています。初めて参加する方も、プレイ中に仕様や注意点を確認したい方も、必要な記事をカテゴリから探せます。'
export const SEARCH_META_TITLE = `サイト内検索 | ${SITE_NAME}`
export const SEARCH_DESCRIPTION =
  'エースサーバー公式Wikiの記事をタイトルと本文から検索できます。'
export const BING_SITE_VERIFICATION = 'B670753BF4A50FA5437E5694CB04BAFD'
export const ADSENSE_CLIENT = 'ca-pub-3935803464310919'
export const WIKI_ICON_PATH = '/uploads/wiki/wiki-icon.png'
export const WIKI_QUICK_ARTICLE_IDS = [
  'in',
  'rule',
  'SurvivalCommand',
] as const

export const WIKI_CATEGORIES = [
  { id: '61e92e9f616290001858f8a4', name: 'イントロダクション' },
  { id: '635d007306cfd5386b36f752', name: '生活鯖について' },
  { id: '67c94e6c395b530d64ff9669', name: 'その他サーバーについて' },
  { id: '67c9514e33281c1d6502bd9e', name: 'ディスコードについて' },
  { id: '635cac9d06cfd5386b36b3dc', name: 'コミュニティ紹介' },
  { id: '61e936ac8b1cc500187ad308', name: 'その他' },
] as const

export const WIKI_HEADER_LINKS = [
  {
    text: 'ワールドマップ',
    href: 'https://asv.acecore.net/world-map/',
  },
  {
    text: 'Acecore',
    href: 'https://acecore.net',
  },
  {
    text: 'エースサーバーポータル',
    href: 'https://asv.acecore.net',
  },
  {
    text: 'Aceserverグッズ',
    href: 'https://shop.acecore.net/collections/aceserver/',
  },
] as const

export const ARTICLE_REDIRECTS = new Map<string, string>([
  ['/article/SurvivalRules', '/article/rule/'],
  ['/article/SurvivalRules/', '/article/rule/'],
  ['/article/how to discordsrv link', '/article/how-to-discordsrv-link/'],
  ['/article/how to discordsrv link/', '/article/how-to-discordsrv-link/'],
  ['/article/About management team', '/article/about-management-team/'],
  ['/article/About management team/', '/article/about-management-team/'],
  ['/article/Hoe Kingdom', '/article/hoe-kingdom/'],
  ['/article/Hoe Kingdom/', '/article/hoe-kingdom/'],
  ['/article/Asutan　Kingdom', '/article/asutan-kingdom/'],
  ['/article/Asutan　Kingdom/', '/article/asutan-kingdom/'],
])
