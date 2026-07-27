import { readdir, readFile } from 'node:fs/promises'

import { parse } from 'parse5'
import { parse as parseYaml } from 'yaml'

import { isExternalHttpUrl } from '../src/lib/external-link-policy.ts'

const root = new URL('../', import.meta.url)
const dist = new URL('dist/', root)
const contentDirectory = new URL('src/content/wiki/', root)
const site = process.env.ASTRO_SITE_URL ?? 'https://asv-wiki.acecore.net'
const rootDescription =
  'エースサーバーの公式Wikiです。Minecraftサーバーへの参加方法、基本ルール、Discord連携、コマンドやプラグイン、Hubと各ワールドの遊び方、運営方針、コミュニティ情報をまとめています。初めて参加する方も、プレイ中に仕様や注意点を確認したい方も、必要な記事をカテゴリから探せます。'
const adsenseSource =
  'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-3935803464310919'
const expectedHeaderLinks = [
  'https://asv.acecore.net/world-map/',
  'https://acecore.net',
  'https://asv.acecore.net',
]
const articles = await readPublishedArticles()

const rootDocument = await readHtml('index.html')

assert(
  elementText(findElement(rootDocument, 'title')) ===
    'エースサーバー公式Wiki｜ルール・参加方法・コマンド案内',
  'Root title differs from the curated production title.',
)
assert(metaContent(rootDocument, 'name', 'description') === rootDescription)
assert(metaContent(rootDocument, 'name', 'robots') === 'index, follow')
assert(
  metaContent(rootDocument, 'name', 'msvalidate.01') ===
    'B670753BF4A50FA5437E5694CB04BAFD',
)
assert(linkHref(rootDocument, 'canonical') === 'https://asv-wiki.acecore.net/')
assert(
  !hasScriptSource(rootDocument, adsenseSource),
  'Unmoderated Wiki root must not load AdSense.',
)
assert(
  expectedHeaderLinks.every((href) => hasAnchorHref(rootDocument, href)),
  'A configured header link is missing from the root.',
)

const searchDocument = await readHtml('search/index.html')
assert(
  elementText(findElement(searchDocument, 'title')) ===
    'サイト内検索 | エースサーバー公式Wiki',
)
assert(metaContent(searchDocument, 'name', 'robots') === 'noindex, follow')
assert(
  linkHref(searchDocument, 'canonical') ===
    'https://asv-wiki.acecore.net/search/',
)
assert(
  hasScriptSource(searchDocument, '/search.js'),
  'Search must load its CSP-compatible same-origin external script.',
)
assertTrustedScriptNonce(searchDocument, '/search.js')
assert(
  !hasScriptSource(searchDocument, adsenseSource),
  'Unmoderated search results must not load AdSense.',
)

const notFoundDocument = await readHtml('404.html')
assert(metaContent(notFoundDocument, 'name', 'robots') === 'noindex, nofollow')
assert(
  !hasScriptSource(notFoundDocument, adsenseSource),
  'The 404 page must not load advertising.',
)

for (const article of articles) {
  const document = await readHtml(`article/${article.slug}/index.html`)
  const seoTitle = article.data.seoTitle ?? article.data.title
  const expectedOgImage = article.data.ogImage
    ? new URL(article.data.ogImage, 'https://asv-wiki.acecore.net').toString()
    : ''

  assert(
    elementText(findElement(document, 'title')) ===
      `${seoTitle}｜エースサーバー公式Wiki`,
    `Article title differs: ${article.slug}`,
  )
  assert(
    metaContent(document, 'name', 'description') === article.data.description,
    `Article description differs: ${article.slug}`,
  )
  assert(metaContent(document, 'name', 'robots') === 'index, follow')
  assert(
    linkHref(document, 'canonical') ===
      new URL(
        articlePath(article.slug),
        'https://asv-wiki.acecore.net',
      ).toString(),
    `Article canonical differs: ${article.slug}`,
  )
  assert(
    metaContent(document, 'name', 'twitter:card') === 'summary_large_image',
    `Article Twitter card differs: ${article.slug}`,
  )
  assert(
    metaContent(document, 'property', 'og:image') === expectedOgImage,
    `Article OG image differs: ${article.slug}`,
  )
  assert(
    metaContent(document, 'name', 'twitter:image') === expectedOgImage,
    `Article Twitter image differs: ${article.slug}`,
  )
  assert(
    !hasScriptSource(document, adsenseSource),
    `Unmoderated article must not load AdSense: ${article.slug}`,
  )
  const articleBody = findElements(document, 'div').find((node) =>
    getAttribute(node, 'class').split(/\s+/u).includes('article__body'),
  )
  assert(articleBody, `Article body is missing: ${article.slug}`)
  assertExternalLinksAreUgc(articleBody, article.slug)
}

const builtArticleDirectories = (
  await readdir(new URL('article/', dist), {
    withFileTypes: true,
  })
)
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .toSorted()
assertDeepEqual(
  builtArticleDirectories,
  articles.map(({ slug }) => slug).toSorted(),
  'Built article inventory differs from the current published Markdown inventory.',
)

const searchIndex = JSON.parse(
  await readFile(new URL('search-index.json', dist), 'utf8'),
)
assert(
  searchIndex.length === articles.length,
  'Search index count differs from the current published Markdown inventory.',
)
assertDeepEqual(
  searchIndex.map(({ url }) => url).toSorted(),
  articles.map(({ slug }) => articlePath(slug)).toSorted(),
  'Search index URLs differ from the current published Markdown inventory.',
)
assert(
  searchIndex.every(
    ({ text }) =>
      !text.includes('/uploads/wiki/') &&
      !text.includes('検索対象にしない画像説明') &&
      !/\]\(https?:\/\//u.test(text),
  ),
  'Search index contains image or link markup.',
)

const searchScript = await readFile(new URL('search.js', dist), 'utf8')
assert(
  searchScript.includes('queryInput && !queryInput.value'),
  'Search initialization must not overwrite a query the user already typed.',
)

const sitemap = await readFile(new URL('sitemap.xml', dist), 'utf8')
const sitemapLocations = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/gu)].map(
  ([, location]) => location,
)
assertDeepEqual(
  sitemapLocations.toSorted(),
  [
    'https://asv-wiki.acecore.net/',
    ...articles.map(({ slug }) =>
      new URL(articlePath(slug), 'https://asv-wiki.acecore.net').toString(),
    ),
  ].toSorted(),
  'Sitemap URLs differ from the current published Markdown inventory.',
)
assert(!sitemap.includes('<lastmod>'), 'Sitemap must not invent lastmod.')
assert(
  !sitemap.includes('/search/'),
  'The noindex search page must not enter the sitemap.',
)

const robots = await readFile(new URL('robots.txt', dist), 'utf8')
assert(
  robots.replace(/\r\n/gu, '\n') ===
    'User-agent: *\nAllow: /\n\nSitemap: https://asv-wiki.acecore.net/sitemap.xml\n',
  'robots.txt differs from the production contract.',
)

console.log(
  `Validated ${articles.length} current published articles, canonicals, search index, sitemap, robots, SEO, OG, disabled AdSense on UGC surfaces, and CSP-compatible search script.`,
)

async function readHtml(path) {
  return parse(await readFile(new URL(path, dist), 'utf8'))
}

function findElements(rootNode, tagName) {
  const matches = []
  const visit = (node) => {
    if (node.tagName === tagName) matches.push(node)
    for (const child of node.childNodes ?? []) visit(child)
  }
  visit(rootNode)
  return matches
}

function findElement(rootNode, tagName) {
  return findElements(rootNode, tagName)[0]
}

function getAttribute(node, name) {
  return node?.attrs?.find((attribute) => attribute.name === name)?.value ?? ''
}

function elementText(node) {
  if (!node) return ''
  if (node.nodeName === '#text') return node.value
  return (node.childNodes ?? []).map(elementText).join('')
}

function metaContent(document, key, value) {
  return getAttribute(
    findElements(document, 'meta').find(
      (node) => getAttribute(node, key) === value,
    ),
    'content',
  )
}

function linkHref(document, relation) {
  return getAttribute(
    findElements(document, 'link').find(
      (node) => getAttribute(node, 'rel') === relation,
    ),
    'href',
  )
}

function hasScriptSource(document, source) {
  return findElements(document, 'script').some(
    (node) => getAttribute(node, 'src') === source,
  )
}

function assertTrustedScriptNonce(document, source) {
  const script = findElements(document, 'script').find(
    (node) => getAttribute(node, 'src') === source,
  )

  assert(
    getAttribute(script, 'nonce') === '__CSP_NONCE__',
    `Trusted script is missing its CSP nonce placeholder: ${source}`,
  )
}

function hasAnchorHref(document, href) {
  return findElements(document, 'a').some(
    (node) => getAttribute(node, 'href') === href,
  )
}

function assertExternalLinksAreUgc(document, slug) {
  for (const anchor of findElements(document, 'a')) {
    const href = getAttribute(anchor, 'href')

    if (!isExternalHttpUrl(href, site)) continue

    const rel = new Set(getAttribute(anchor, 'rel').split(/\s+/u))

    assert(
      rel.has('ugc') && rel.has('nofollow'),
      `External article link must be marked as UGC: ${slug} -> ${href}`,
    )
  }
}

function parseFrontmatter(source) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(source)
  assert(match, 'Markdown frontmatter is missing.')
  return parseYaml(match[1])
}

async function readPublishedArticles() {
  const entries = await readdir(contentDirectory, { withFileTypes: true })
  const markdownFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => entry.name)
    .toSorted()

  return (
    await Promise.all(
      markdownFiles.map(async (fileName) => {
        const source = await readFile(
          new URL(fileName, contentDirectory),
          'utf8',
        )

        return {
          slug: fileName.slice(0, -'.md'.length),
          data: parseFrontmatter(source),
        }
      }),
    )
  ).filter(({ data }) => data.draft !== true)
}

function articlePath(slug) {
  return `/article/${encodeURIComponent(slug)}/`
}

function assertDeepEqual(actual, expected, message) {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${message}\nExpected: ${JSON.stringify(expected)}\nReceived: ${JSON.stringify(actual)}`,
  )
}

function assert(condition, message = 'Build validation failed.') {
  if (!condition) throw new Error(message)
}
