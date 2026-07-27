import { readFile } from 'node:fs/promises'

import { parse } from 'parse5'
import { parse as parseYaml } from 'yaml'

const root = new URL('../', import.meta.url)
const dist = new URL('dist/', root)
const manifest = JSON.parse(
  await readFile(
    new URL('migration/newt-public-payload-manifest.json', root),
    'utf8',
  ),
)
const rootDescription =
  'エースサーバーの公式Wikiです。Minecraftサーバーへの参加方法、基本ルール、Discord連携、コマンドやプラグイン、Hubと各ワールドの遊び方、運営方針、コミュニティ情報をまとめています。初めて参加する方も、プレイ中に仕様や注意点を確認したい方も、必要な記事をカテゴリから探せます。'
const adsenseSource =
  'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-3935803464310919'

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
  hasScriptSource(rootDocument, adsenseSource),
  'AdSense Auto Ads loader is missing from the public root.',
)
assert(
  manifest.links.every(({ href }) => hasAnchorHref(rootDocument, href)),
  'A migrated header link is missing from the root.',
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

const notFoundDocument = await readHtml('404.html')
assert(metaContent(notFoundDocument, 'name', 'robots') === 'noindex, nofollow')
assert(
  !hasScriptSource(notFoundDocument, adsenseSource),
  'The 404 page must not load advertising.',
)

for (const article of manifest.articles) {
  const document = await readHtml(`article/${article.targetSlug}/index.html`)
  const markdown = await readFile(
    new URL(`src/content/wiki/${article.targetSlug}.md`, root),
    'utf8',
  )
  const frontmatter = parseFrontmatter(markdown)
  const seoTitle = frontmatter.seoTitle ?? frontmatter.title

  assert(
    elementText(findElement(document, 'title')) ===
      `${seoTitle}｜エースサーバー公式Wiki`,
    `Article title differs: ${article.targetSlug}`,
  )
  assert(
    metaContent(document, 'name', 'description') === frontmatter.description,
    `Article description differs: ${article.targetSlug}`,
  )
  assert(metaContent(document, 'name', 'robots') === 'index, follow')
  assert(
    linkHref(document, 'canonical') ===
      `https://asv-wiki.acecore.net/article/${article.targetSlug}/`,
    `Article canonical differs: ${article.targetSlug}`,
  )
  assert(
    metaContent(document, 'name', 'twitter:card') === 'summary_large_image',
    `Article Twitter card differs: ${article.targetSlug}`,
  )
  assert(
    hasScriptSource(document, adsenseSource),
    `Article does not load AdSense: ${article.targetSlug}`,
  )
}

const philosophyDocument = await readHtml('article/rinen/index.html')
assert(
  metaContent(philosophyDocument, 'property', 'og:image') ===
    'https://asv-wiki.acecore.net/uploads/wiki/server-philosophy-og.png',
  'The migrated article OG image is missing.',
)

const searchIndex = JSON.parse(
  await readFile(new URL('search-index.json', dist), 'utf8'),
)
assert(searchIndex.length === 15, 'Search index must contain 15 articles.')
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
assert(
  (sitemap.match(/<url>/gu) ?? []).length === 16,
  'Sitemap must contain the root and 15 articles.',
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
  'Validated 18 built pages/endpoints, 15 article canonicals, search index, sitemap, robots, SEO, OG, AdSense, and CSP-compatible search script.',
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

function hasAnchorHref(document, href) {
  return findElements(document, 'a').some(
    (node) => getAttribute(node, 'href') === href,
  )
}

function parseFrontmatter(source) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(source)
  assert(match, 'Markdown frontmatter is missing.')
  return parseYaml(match[1])
}

function assert(condition, message = 'Build validation failed.') {
  if (!condition) throw new Error(message)
}
