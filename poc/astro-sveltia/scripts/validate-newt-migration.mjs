import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'

import { parse } from 'yaml'

const root = new URL('../', import.meta.url)
const contentDirectory = new URL('src/content/wiki/', root)
const mediaDirectory = new URL('public/uploads/wiki/', root)
const manifest = JSON.parse(
  await readFile(
    new URL('migration/newt-public-payload-manifest.json', root),
    'utf8',
  ),
)
const contentFiles = (await readdir(contentDirectory)).toSorted()
const mediaFiles = (await readdir(mediaDirectory)).toSorted()

assert(manifest.source.articleCount === 15, 'Expected 15 source articles.')
assert(manifest.source.categoryCount === 6, 'Expected six source categories.')
assert(manifest.source.headerLinkCount === 3, 'Expected three header links.')
assert(
  manifest.source.totalSourceBodyBytes === 53234,
  'Source body byte evidence changed.',
)
assert(manifest.articles.length === 15, 'Expected 15 article evidence rows.')
assert(manifest.assets.length === 11, 'Expected 11 verified assets.')
assert(
  manifest.removedAssets.length === 1,
  'Expected one removed broken asset.',
)
assert(
  manifest.redirects.length === 4,
  'Expected four normalized URL redirects.',
)

assertDeepEqual(
  manifest.categories.map(({ name }) => name),
  [
    'イントロダクション',
    '生活鯖について',
    'その他サーバーについて',
    'ディスコードについて',
    'コミュニティ紹介',
    'その他',
  ],
  'Category display order changed.',
)
assert(
  !manifest.articles.some(
    ({ category }) => category === 'その他サーバーについて',
  ),
  'The source-empty category is no longer empty.',
)
assertDeepEqual(
  contentFiles,
  manifest.articles.map(({ targetSlug }) => `${targetSlug}.md`).toSorted(),
  'Markdown file inventory differs from the manifest.',
)
assertDeepEqual(
  mediaFiles,
  manifest.assets
    .map(({ localPath }) => localPath.split('/').at(-1))
    .toSorted(),
  'Media file inventory differs from the manifest.',
)

for (const article of manifest.articles) {
  const source = await readFile(
    new URL(`${article.targetSlug}.md`, contentDirectory),
    'utf8',
  )
  const canonicalSource = source.replace(/\r\n?/gu, '\n')
  const parsed = parseMarkdown(canonicalSource, article.targetSlug)

  assert(
    Buffer.byteLength(canonicalSource, 'utf8') === article.markdownBytes,
    `Markdown byte count changed: ${article.targetSlug}`,
  )
  assert(
    sha256(canonicalSource) === article.markdownSha256,
    `Markdown SHA-256 changed: ${article.targetSlug}`,
  )
  assert(
    parsed.data.title === article.title,
    `Markdown title differs from evidence: ${article.targetSlug}`,
  )
  assert(
    parsed.data.category === article.category,
    `Markdown category differs from evidence: ${article.targetSlug}`,
  )
  assert(
    parsed.data.order === article.order,
    `Markdown order differs from evidence: ${article.targetSlug}`,
  )
  assert(
    !/<(?:!--[\s\S]*?--|!doctype\b[^>]*|\/?[a-z][a-z0-9:-]*(?:\s[^<>]*?)?\s*\/?>)/iu.test(
      parsed.body,
    ),
    `Raw HTML remains: ${article.targetSlug}`,
  )
  assert(
    !/^(?: {0,3})#(?:[ \t]+|$)/mu.test(parsed.body),
    `A body h1 remains: ${article.targetSlug}`,
  )
  assert(
    !/https:\/\/(?:cdn\.pixabay\.com|storage\.googleapis\.com)/u.test(
      parsed.body,
    ),
    `Remote image URL remains: ${article.targetSlug}`,
  )
  assert(
    !parsed.body.includes('/img/リスト.png'),
    `Broken image reference remains: ${article.targetSlug}`,
  )
}

for (const asset of manifest.assets) {
  const bytes = await readFile(new URL(asset.localPath, root))

  assert(
    bytes.byteLength === asset.bytes,
    `Asset byte count changed: ${asset.localPath}`,
  )
  assert(
    sha256(bytes) === asset.sha256,
    `Asset SHA-256 changed: ${asset.localPath}`,
  )
  assert(
    detectImageMediaType(bytes) === asset.mediaType,
    `Asset magic bytes changed: ${asset.localPath}`,
  )
}

const commands = await readFile(
  new URL('SurvivalCommand.md', contentDirectory),
  'utf8',
)
assert(
  commands.includes(
    '| /co inspect | インスペクターモードのON、OFFの切り替え |',
  ),
  'The /co inspect rowspan was not expanded into its destination row.',
)
assert(
  commands.includes('| /lock | 対象のブロックを保護します。 |'),
  'The /lock rowspan was not expanded into its destination row.',
)

const communityTimeline = await readFile(
  new URL('asutan-kingdom.md', contentDirectory),
  'utf8',
)
assert(
  communityTimeline.includes('#### 2022年12月18日　あすたん王国設立'),
  'The first details/summary item was not converted to Markdown.',
)
assert(
  !communityTimeline.includes('<details'),
  'A details element remains in Markdown.',
)

const internalLinkArticles = await Promise.all(
  ['hub-intro.md', 'in.md'].map((name) =>
    readFile(new URL(name, contentDirectory), 'utf8'),
  ),
)
assert(
  internalLinkArticles.every((source) =>
    source.includes('/article/how-to-discordsrv-link/'),
  ),
  'A Discord-link article URL was not rewritten to its canonical slug.',
)

console.log(
  'Validated 15 Markdown articles, 11 hashed assets, four redirects, category order, rowspan expansion, and removed broken media.',
)

function parseMarkdown(source, slug) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/u.exec(source)
  assert(match, `Missing YAML frontmatter: ${slug}`)

  return {
    data: parse(match[1]),
    body: match[2],
  }
}

function detectImageMediaType(bytes) {
  if (
    bytes.length >= 20 &&
    bytes
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) &&
    bytes.subarray(-8, -4).toString('ascii') === 'IEND'
  ) {
    return 'image/png'
  }

  if (
    bytes.length >= 4 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff &&
    bytes.at(-2) === 0xff &&
    bytes.at(-1) === 0xd9
  ) {
    return 'image/jpeg'
  }

  return null
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function assertDeepEqual(actual, expected, message) {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${message}\nExpected: ${JSON.stringify(expected)}\nReceived: ${JSON.stringify(actual)}`,
  )
}
