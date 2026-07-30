import { readdir, readFile } from 'node:fs/promises'

import { parse } from 'parse5'
import { parse as parseYaml } from 'yaml'

import { WIKI_CATEGORIES, WIKI_QUICK_ARTICLE_IDS } from '../src/config/wiki.ts'
import { isExternalHttpUrl } from '../src/lib/external-link-policy.ts'

const root = new URL('../', import.meta.url)
const dist = new URL('dist/', root)
const contentDirectory = new URL('src/content/wiki/', root)
const cmsConfig = parseYaml(
  await readFile(new URL('public/admin/config.yml', root), 'utf8'),
)
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
const cspNoncePlaceholder = '__CSP_NONCE__'
const emptyCategoryMessage = '現在、公開中の記事はありません。'
const articles = await readPublishedArticles()
const publishedArticleCountByCategory = new Map(
  WIKI_CATEGORIES.map(({ name }) => [
    name,
    articles.filter(({ data }) => data.category === name).length,
  ]),
)
const quickArticles = WIKI_QUICK_ARTICLE_IDS.flatMap((id) => {
  const article = articles.find(({ slug }) => slug === id)
  return article ? [article] : []
})
const expectedQuickArticlePaths = quickArticles.map(({ slug }) =>
  articlePath(slug),
)
const startArticle =
  articles.find(({ slug }) => slug === 'rinen') ??
  quickArticles.at(0) ??
  articles.at(0)
const [
  adminInit,
  adminStyles,
  globalStyles,
  markdownStyles,
  wikiLayout,
  mobileMenuScript,
] = await Promise.all([
  readFile(new URL('admin/init.js', dist), 'utf8'),
  readFile(new URL('admin/shell.css', dist), 'utf8'),
  readFile(new URL('src/styles/global.css', root), 'utf8'),
  readFile(new URL('src/styles/markdown.css', root), 'utf8'),
  readFile(new URL('src/layouts/WikiLayout.astro', root), 'utf8'),
  readFile(new URL('mobile-menu.js', dist), 'utf8'),
])
const normalizedGlobalStyles = normalizeCss(globalStyles)
const normalizedMarkdownStyles = normalizeCss(markdownStyles)
const desktopHeaderStyles = normalizeCss(
  cssMediaBlock(globalStyles, '(min-width: 67.5rem)'),
)
const sideNavigationDeclarations = [
  ...normalizedGlobalStyles.matchAll(/\.side-navigation\s*\{([^{}]*)\}/gu),
].map((match) => match[1])
const desktopSideNavigationDeclarations = [
  ...desktopHeaderStyles.matchAll(/\.side-navigation\s*\{([^{}]*)\}/gu),
].map((match) => match[1])

assert(
  cmsConfig.output?.omit_empty_optional_fields === true,
  'Sveltia CMS must omit empty optional fields before strict Astro validation.',
)
assert(
  adminInit.includes('保存すると自動で公開されます') &&
    adminInit.includes('通常は数分でサイトに反映されます。') &&
    adminInit.includes('公開方法の案内を閉じる'),
  'CMS editor must explain that saving publishes automatically.',
)
assert(
  adminStyles.includes('.cms-publish-notice'),
  'CMS publication guidance must be styled.',
)
assert(
  wikiLayout.includes("import '../styles/global.css'") &&
    wikiLayout.includes("import '../styles/markdown.css'") &&
    wikiLayout.indexOf("import '../styles/global.css'") <
      wikiLayout.indexOf("import '../styles/markdown.css'"),
  'The Wiki layout must load the shared Markdown stylesheet after the global shell styles.',
)
assert(
  mobileMenuScript.trim().length > 0,
  'The CSP-compatible mobile menu script must be included in the build output.',
)
assert(
  normalizedMarkdownStyles.includes(
    '.article__body { width: min(100%, var(--reading-width));',
  ) &&
    normalizedMarkdownStyles.includes(
      '.article__body table { display: block;',
    ) &&
    normalizedMarkdownStyles.includes(
      '.article__body :where(img, video) { display: block; max-width: 100%;',
    ),
  'Markdown content must preserve a readable measure, local table scrolling, and responsive media.',
)
assert(
  normalizedGlobalStyles.includes(
    '.site-links, .site-search { display: none; }',
  ) &&
    normalizedGlobalStyles.includes(
      '.mobile-menu { margin-inline-start: auto; }',
    ),
  'Mobile must default to the menu while hiding the desktop links and search.',
)
assert(
  desktopHeaderStyles.includes('.site-links { display: flex;') &&
    desktopHeaderStyles.includes('.site-search { display: flex; }') &&
    desktopHeaderStyles.includes('.mobile-menu { display: none; }'),
  'The complete desktop header must start at the shared 67.5rem shell breakpoint.',
)
assert(
  desktopSideNavigationDeclarations.some((declarations) =>
    /(?:^|;)\s*display:\s*block\s*(?:;|$)/u.test(declarations),
  ) &&
    sideNavigationDeclarations.every(
      (declarations) =>
        !/(?:^|;)\s*(?:position\s*:\s*(?:sticky|fixed|absolute)\b|max-(?:height|block-size)\s*:|overflow(?:-(?:x|y|block|inline))?\s*:)/u.test(
          declarations,
        ),
    ),
  'Desktop article navigation must remain in document flow without an internal scrollbar.',
)
assert(
  !globalStyles.includes('@media (min-width: 600px)') &&
    !globalStyles.includes('@media (min-width: 896px)'),
  'Legacy header breakpoints must not reintroduce a duplicate tablet/desktop navigation state.',
)
assert(
  normalizedGlobalStyles.includes(
    "button, input[type='search'] { min-height: 2.75rem; }",
  ) &&
    normalizedGlobalStyles.includes(
      '.mobile-menu > summary { display: inline-flex; min-height: 2.75rem;',
    ),
  'Primary form and menu controls must preserve a 44px minimum target size.',
)

const rootDocument = await readHtml('index.html')
const sideNavigation = findElements(rootDocument, 'nav').find(
  (node) => getAttribute(node, 'aria-label') === '記事一覧',
)

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
const editLinks = findElements(rootDocument, 'a').filter(
  (node) =>
    getAttribute(node, 'href') === '/admin/' &&
    getAttribute(node, 'class').split(/\s+/u).includes('edit-link') &&
    getAttribute(node, 'aria-label') === 'Wikiを編集' &&
    elementText(node) === '編集',
)
assert(
  editLinks.length === 2,
  'Desktop and mobile edit links must use the clear Wiki edit CTA.',
)
const startArticleLink = findElements(rootDocument, 'a').find((node) =>
  hasClass(node, 'home__start'),
)
if (startArticle) {
  assert(
    getAttribute(startArticleLink, 'href') === articlePath(startArticle.slug) &&
      elementText(startArticleLink).trim() === 'Wikiを読む',
    'The root start CTA differs from the current published article inventory.',
  )
} else {
  assert(
    !startArticleLink,
    'The root must omit its start CTA when no articles are published.',
  )
}
const mainContent = findElements(rootDocument, 'div').find(
  (node) => getAttribute(node, 'id') === 'main-content',
)
assert(
  mainContent && getAttribute(mainContent, 'tabindex') === '-1',
  'The skip link target must focus the page content after the side navigation.',
)
assert(
  hasAnchorWithText(rootDocument, '#main-content', '本文へ移動'),
  'The page must provide a content skip link.',
)
assertTrustedScriptNonce(rootDocument, '/mobile-menu.js')
assertExecutableScriptsAreTrusted(rootDocument, 'Root')
const quickArticleNavigation = findElements(rootDocument, 'nav').find((node) =>
  hasClass(node, 'home__quick-links'),
)
if (expectedQuickArticlePaths.length === 0) {
  assert(
    !quickArticleNavigation,
    'The root must omit quick navigation when no quick articles are published.',
  )
} else {
  assert(quickArticleNavigation, 'The root quick navigation is missing.')
  assertDeepEqual(
    findElements(quickArticleNavigation, 'a').map((node) =>
      getAttribute(node, 'href'),
    ),
    expectedQuickArticlePaths,
    'The root quick links differ from the current published article inventory.',
  )
}
assert(sideNavigation, 'The desktop article navigation is missing.')
assert(
  findElements(sideNavigation, 'details').length === 0 &&
    findElements(sideNavigation, 'summary').length === 0,
  'Desktop article categories must stay expanded without disclosure controls.',
)
assert(
  findElements(sideNavigation, 'section').length > 1 &&
    findElements(sideNavigation, 'h2').length > 1,
  'Desktop article categories must render as visible grouped lists.',
)
for (const surface of [
  {
    label: 'Home',
    sectionClass: 'home__category',
    emptyClass: 'home__empty',
  },
  {
    label: 'Mobile navigation',
    sectionClass: 'mobile-menu__category',
    emptyClass: 'mobile-menu__empty',
  },
  {
    label: 'Side navigation',
    sectionClass: 'side-navigation__category',
    emptyClass: 'side-navigation__empty',
  },
]) {
  assertCategoryEmptyStates(rootDocument, surface)
}

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
assertTrustedScriptNonce(searchDocument, '/mobile-menu.js')
assertTrustedScriptNonce(searchDocument, '/search.js')
assertExecutableScriptsAreTrusted(searchDocument, 'Search')
assert(
  !hasScriptSource(searchDocument, adsenseSource),
  'Unmoderated search results must not load AdSense.',
)
assert(
  elementText(searchDocument).includes(
    'エースサーバー公式Wikiの記事をタイトルと本文から検索できます。',
  ),
  'Search must explain what the query covers.',
)

const notFoundDocument = await readHtml('404.html')
assert(metaContent(notFoundDocument, 'name', 'robots') === 'noindex, nofollow')
assertTrustedScriptNonce(notFoundDocument, '/mobile-menu.js')
assertExecutableScriptsAreTrusted(notFoundDocument, '404')
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
  assertTrustedScriptNonce(document, '/mobile-menu.js')
  assertExecutableScriptsAreTrusted(document, `Article: ${article.slug}`)
  const articleBody = findElements(document, 'div').find((node) =>
    getAttribute(node, 'class').split(/\s+/u).includes('article__body'),
  )
  assert(articleBody, `Article body is missing: ${article.slug}`)
  const breadcrumbs = findElements(document, 'nav').find(
    (node) => getAttribute(node, 'aria-label') === 'パンくずリスト',
  )
  assert(
    breadcrumbs && elementText(breadcrumbs).includes(article.data.title),
    `Article breadcrumb is missing: ${article.slug}`,
  )
  const visibleDescription = findElements(document, 'p').find((node) =>
    getAttribute(node, 'class').split(/\s+/u).includes('article__description'),
  )
  assert(
    elementText(visibleDescription).trim() === article.data.description,
    `Article description must be visible: ${article.slug}`,
  )
  assertExternalLinksAreUgc(articleBody, article.slug)
}

const builtArticleDirectories = await readBuiltArticleDirectories()
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

const vectorCorpus = JSON.parse(
  await readFile(new URL('vector-corpus.json', dist), 'utf8'),
)
const vectorChunks = vectorCorpus.chunks
const articleByUrl = new Map(
  articles.map((article) => [articlePath(article.slug), article]),
)
assert(vectorCorpus.schemaVersion === 1, 'Vector corpus schema must be v1.')
assert(
  vectorCorpus.embedding?.model === '@cf/baai/bge-m3' &&
    vectorCorpus.embedding?.dimensions === 1024 &&
    vectorCorpus.embedding?.metric === 'cosine',
  'Vector corpus embedding contract differs from BGE-M3 1024/cosine.',
)
assert(
  vectorCorpus.chunking?.targetCharacters === 850 &&
    vectorCorpus.chunking?.maximumCharacters === 1200 &&
    vectorCorpus.chunking?.overlapCharacters === 120,
  'Vector corpus chunking contract differs.',
)
assert(
  vectorCorpus.sourceCount === articles.length,
  'Vector corpus source count differs from the current published Markdown inventory.',
)
assert(
  Array.isArray(vectorChunks) &&
    vectorCorpus.vectorCount === vectorChunks.length &&
    vectorChunks.length >= articles.length &&
    vectorChunks.length <= 500,
  'Vector corpus vector count is invalid.',
)
assert(
  vectorCorpus.localeCounts?.ja === vectorChunks.length,
  'Vector corpus Japanese locale count is invalid.',
)
assert(
  /^[0-9a-f]{20}$/u.test(vectorCorpus.version),
  'Vector corpus version is invalid.',
)
assert(
  new Set(vectorChunks.map(({ id }) => id)).size === vectorChunks.length &&
    vectorChunks.every(({ id }) => /^v1-[0-9a-f]{48}$/u.test(id)),
  'Vector corpus IDs must be unique v1 SHA-256 digests.',
)
assertDeepEqual(
  [...new Set(vectorChunks.map(({ metadata }) => metadata.url))].toSorted(),
  articles.map(({ slug }) => articlePath(slug)).toSorted(),
  'Vector corpus URLs differ from the current published Markdown inventory.',
)
assert(
  vectorChunks.every(({ metadata, namespace, text }) => {
    const article = articleByUrl.get(metadata.url)

    return (
      article &&
      namespace === 'ja' &&
      metadata.locale === 'ja' &&
      metadata.title === article.data.title &&
      metadata.category === article.data.category &&
      typeof metadata.section === 'string' &&
      metadata.section.length > 0 &&
      typeof metadata.excerpt === 'string' &&
      metadata.excerpt.length <= 220 &&
      typeof text === 'string' &&
      text.length > 0 &&
      text.length <= 1200 &&
      !text.includes('/uploads/wiki/') &&
      !text.includes('検索対象にしない画像説明') &&
      !/\]\(https?:\/\//u.test(text)
    )
  }),
  'Vector corpus contains invalid content or metadata.',
)

const buildMarker = JSON.parse(
  await readFile(
    new URL('.well-known/aceserver-wiki-build.json', dist),
    'utf8',
  ),
)
assert(
  buildMarker.commit ===
    (process.env.CF_PAGES_COMMIT_SHA ??
      process.env.GITHUB_SHA ??
      process.env.COMMIT_SHA ??
      'local'),
  'Deployment marker commit differs from the current build.',
)
assert(
  buildMarker.searchCorpusVersion === vectorCorpus.version,
  'Deployment marker corpus version differs from the current build.',
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
  `Validated ${articles.length} current published articles, category states, canonicals, keyword/vector search corpora, sitemap, robots, SEO, OG, disabled AdSense on UGC surfaces, and CSP-compatible scripts.`,
)

async function readHtml(path) {
  return parse(await readFile(new URL(path, dist), 'utf8'))
}

async function readBuiltArticleDirectories() {
  try {
    return (
      await readdir(new URL('article/', dist), {
        withFileTypes: true,
      })
    )
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .toSorted()
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
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

function hasClass(node, className) {
  return getAttribute(node, 'class').split(/\s+/u).includes(className)
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
    getAttribute(script, 'nonce') === cspNoncePlaceholder,
    `Trusted script is missing its CSP nonce placeholder: ${source}`,
  )
}

function assertExecutableScriptsAreTrusted(document, label) {
  for (const script of findElements(document, 'script')) {
    const type = getAttribute(script, 'type')
      .split(';', 1)[0]
      .trim()
      .toLowerCase()
    const isExecutable =
      type === '' ||
      type === 'module' ||
      /^(?:application|text)\/(?:java|ecma)script$/u.test(type)

    if (!isExecutable) continue

    const source = getAttribute(script, 'src') || '(inline)'
    assert(
      getAttribute(script, 'nonce') === cspNoncePlaceholder,
      `${label} executable script is missing its CSP nonce placeholder: ${source}`,
    )
  }
}

function assertCategoryEmptyStates(
  document,
  { label, sectionClass, emptyClass },
) {
  const sections = findElements(document, 'section').filter((node) =>
    hasClass(node, sectionClass),
  )

  assert(
    sections.length === WIKI_CATEGORIES.length,
    `${label} category count differs from the configured inventory.`,
  )

  for (const [index, category] of WIKI_CATEGORIES.entries()) {
    const section = sections[index]
    const articleCount = publishedArticleCountByCategory.get(category.name) ?? 0
    const expectedEmpty = articleCount === 0
    const emptyMessages = findElements(section, 'p').filter((node) =>
      hasClass(node, emptyClass),
    )
    const lists = findElements(section, 'ul')

    assert(
      elementText(findElement(section, 'h2')).trim() === category.name,
      `${label} category order or name differs: ${category.name}`,
    )
    assert(
      emptyMessages.length === (expectedEmpty ? 1 : 0),
      `${label} empty state differs: ${category.name}`,
    )
    assert(
      expectedEmpty
        ? lists.length === 0 &&
            elementText(emptyMessages[0]).trim() === emptyCategoryMessage
        : lists.length === 1 &&
            findElements(lists[0], 'li').length === articleCount,
      `${label} category content differs: ${category.name}`,
    )
  }
}

function hasAnchorHref(document, href) {
  return findElements(document, 'a').some(
    (node) => getAttribute(node, 'href') === href,
  )
}

function hasAnchorWithText(document, href, text) {
  return findElements(document, 'a').some(
    (node) =>
      getAttribute(node, 'href') === href && elementText(node).trim() === text,
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

function cssMediaBlock(source, query) {
  const marker = `@media ${query}`
  const markerIndex = source.indexOf(marker)
  assert(markerIndex >= 0, `CSS media query is missing: ${query}`)

  const openingBraceIndex = source.indexOf('{', markerIndex + marker.length)
  assert(openingBraceIndex >= 0, `CSS media query is invalid: ${query}`)

  let depth = 0
  for (let index = openingBraceIndex; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    if (source[index] !== '}') continue

    depth -= 1
    if (depth === 0) {
      return source.slice(openingBraceIndex + 1, index)
    }
  }

  throw new Error(`CSS media query is not closed: ${query}`)
}

function normalizeCss(source) {
  return source.replace(/\s+/gu, ' ').trim()
}

function assert(condition, message = 'Build validation failed.') {
  if (!condition) throw new Error(message)
}
