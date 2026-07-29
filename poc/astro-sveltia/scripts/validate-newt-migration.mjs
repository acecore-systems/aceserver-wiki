import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'

import { unflatten } from 'devalue'
import { parse as parseHtml } from 'parse5'
import { parse as parseYaml } from 'yaml'

import { validateNuxtContentParity } from './validate-newt-content-parity.mjs'

const root = new URL('../', import.meta.url)
const contentDirectory = new URL('src/content/wiki/', root)
const mediaDirectory = new URL('public/uploads/wiki/', root)
const initialManifestRaw = (
  await readFile(
    new URL('migration/newt-initial-production-manifest.json', root),
    'utf8',
  )
).replace(/\r\n?/gu, '\n')
const initialManifest = JSON.parse(initialManifestRaw)
const manifest = JSON.parse(
  await readFile(
    new URL('migration/newt-public-payload-manifest.json', root),
    'utf8',
  ),
)
const snapshot = JSON.parse(
  await readFile(
    new URL('migration/newt-public-content-snapshot.json', root),
    'utf8',
  ),
)
const validateCurrent = process.argv.includes('--current')

validateArchivedEvidence()

if (validateCurrent) {
  const parity = await validateCurrentMigration()
  console.log(
    `Validated the current 15-article legacy migration: ${parity.nonTableTextMatches}/15 non-table text bodies, ${parity.tableCount} semantic tables, ${parity.links.source} source links (${parity.links.exact} exact, ${parity.links.rewritten} rewritten, ${parity.links.retired} retired with labels preserved), ${parity.links.added} added links, ${parity.images.preserved}/${parity.images.source} preserved article images, ${parity.search.query} search ${parity.search.source} source/${parity.search.current} current results with no source loss, 11 hashed stored assets, and four redirects.`,
  )
} else {
  console.log(
    'Validated the reconstructible 15-article Nuxt/Newt source snapshot against the rollback reproduction manifest and preserved initial-production evidence.',
  )
}

function validateArchivedEvidence() {
  assert(
    sha256(initialManifestRaw) ===
      '837e0102d9cec317b464bec0e1bba9fe7c2bf9c14371403274ce1b757583e923',
    'The preserved initial-production manifest changed.',
  )
  assert(
    initialManifest.schemaVersion === 1,
    'Unexpected initial-production manifest schema.',
  )
  assert(
    initialManifest.source.origin === 'https://asv-wiki.acecore.net',
    'Unexpected initial-production source origin.',
  )
  assert(manifest.schemaVersion === 1, 'Unexpected migration manifest schema.')
  assert(manifest.source.articleCount === 15, 'Expected 15 source articles.')
  assert(manifest.source.categoryCount === 6, 'Expected six source categories.')
  assert(
    manifest.source.headerLinkCount === 3,
    'Expected three source header links.',
  )
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
  assert(snapshot.schemaVersion === 1, 'Unexpected source snapshot schema.')
  assert(
    snapshot.source.origin === 'https://bba3fffa.aceserver-wiki.pages.dev',
    'The source snapshot must point to the recorded rollback deployment.',
  )
  assert(
    manifest.source.origin === snapshot.source.origin,
    'Manifest and snapshot origins differ.',
  )
  assert(
    typeof snapshot.source.rawPayload === 'string' &&
      sha256(snapshot.source.rawPayload) ===
        manifest.source.rootPayloadSha256 &&
      manifest.source.rootPayloadSha256 === snapshot.source.rootPayloadSha256,
    'Archived root payload SHA-256 differs from the manifest.',
  )
  const decodedRootPayload = decodeArchivedPayload(snapshot.source.rawPayload)
  assertDeepEqual(
    decodedRootPayload.data?.['wiki-data'],
    snapshot.wikiData,
    'Decoded root payload differs from the archived Wiki data.',
  )
  assert(
    snapshot.source.capturedAt ===
      new Date(snapshot.source.prerenderedAt).toISOString(),
    'Snapshot capture timestamp is not deterministic.',
  )
  assert(
    snapshot.source.articleCount === manifest.source.articleCount,
    'Snapshot article count differs from the migration manifest.',
  )
  assert(
    snapshot.source.categoryCount === manifest.source.categoryCount,
    'Snapshot category count differs from the migration manifest.',
  )
  assert(
    snapshot.source.headerLinkCount === manifest.source.headerLinkCount,
    'Snapshot header-link count differs from the migration manifest.',
  )
  assert(
    snapshot.source.totalSourceBodyBytes ===
      manifest.source.totalSourceBodyBytes,
    'Snapshot source-body size differs from the migration manifest.',
  )
  assert(
    snapshot.articles.length === manifest.articles.length,
    'Snapshot article inventory differs from the migration manifest.',
  )
  assert(
    !hasSensitiveObjectKey(snapshot),
    'The public source snapshot contains a credential-like object key.',
  )
  assertDeepEqual(
    initialManifest.articles.map(sourceArticleEvidence),
    manifest.articles.map(sourceArticleEvidence),
    'Initial-production and rollback article-body evidence differ.',
  )
  assertDeepEqual(
    initialManifest.assets,
    manifest.assets,
    'Initial-production and rollback asset evidence differ.',
  )
  assertDeepEqual(
    initialManifest.removedAssets,
    manifest.removedAssets,
    'Initial-production and rollback removed-asset evidence differ.',
  )
  assertDeepEqual(
    initialManifest.redirects,
    manifest.redirects,
    'Initial-production and rollback redirect evidence differ.',
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
  assertDeepEqual(
    snapshot.wikiData.categories.map(({ _id, name }) => ({
      id: _id,
      name,
    })),
    manifest.categories,
    'Archived source categories differ from the manifest.',
  )
  assertDeepEqual(
    snapshot.wikiData.links.map(({ _id, text, href }) => ({
      id: _id,
      text,
      href,
    })),
    manifest.links,
    'Archived source header links differ from the manifest.',
  )
  assertDeepEqual(
    snapshot.wikiData.articles.map(({ _id, slug, title }) => ({
      id: _id,
      sourceSlug: slug,
      title,
    })),
    manifest.articles.map(({ id, sourceSlug, title }) => ({
      id,
      sourceSlug,
      title,
    })),
    'Archived source article order or identity differs from the manifest.',
  )
  assert(
    !manifest.articles.some(
      ({ category }) => category === 'その他サーバーについて',
    ),
    'The source-empty category is no longer empty in the evidence.',
  )

  for (const article of manifest.articles) {
    const archived = snapshot.articles.find(
      ({ sourceSlug }) => sourceSlug === article.sourceSlug,
    )

    assert(
      archived,
      `Archived source article is missing: ${article.sourceSlug}`,
    )
    assert(
      archived.id === article.id,
      `Archived article ID differs: ${article.sourceSlug}`,
    )
    assert(
      archived.article.slug === article.sourceSlug,
      `Archived article slug differs: ${article.sourceSlug}`,
    )
    assert(
      archived.article.title === article.title,
      `Archived article title differs: ${article.sourceSlug}`,
    )
    assert(
      archived.article.category?.name === article.category,
      `Archived article category differs: ${article.sourceSlug}`,
    )
    assert(
      typeof archived.rawPayload === 'string' &&
        sha256(archived.rawPayload) === article.sourcePayloadSha256 &&
        archived.payloadSha256 === article.sourcePayloadSha256,
      `Archived article payload SHA-256 differs: ${article.sourceSlug}`,
    )
    const decodedArticlePayload = decodeArchivedPayload(archived.rawPayload)
    assertDeepEqual(
      decodedArticlePayload.data?.[`article:${article.sourceSlug}`],
      archived.article,
      `Decoded article payload differs: ${article.sourceSlug}`,
    )
    assert(
      Buffer.byteLength(archived.article.body, 'utf8') ===
        article.sourceBodyBytes &&
        archived.bodyBytes === article.sourceBodyBytes,
      `Archived article body byte count differs: ${article.sourceSlug}`,
    )
    assert(
      sha256(archived.article.body) === article.sourceBodySha256 &&
        archived.bodySha256 === article.sourceBodySha256,
      `Archived article body SHA-256 differs: ${article.sourceSlug}`,
    )
  }
}

async function validateCurrentMigration() {
  const contentFiles = (await readdir(contentDirectory)).toSorted()
  const mediaFiles = (await readdir(mediaDirectory)).toSorted()
  const expectedPublicFiles = manifest.articles.map(
    ({ targetSlug }) => `${targetSlug}.md`,
  )

  assertDeepEqual(
    expectedPublicFiles.filter((fileName) => !contentFiles.includes(fileName)),
    [],
    'A Markdown file from the legacy 15-article migration is missing.',
  )
  assertDeepEqual(
    mediaFiles,
    manifest.assets
      .map(({ localPath }) => localPath.split('/').at(-1))
      .toSorted(),
    'Media file inventory differs from the migration manifest.',
  )

  for (const article of manifest.articles) {
    const source = await readFile(
      new URL(`${article.targetSlug}.md`, contentDirectory),
      'utf8',
    )
    const canonicalSource = source.replace(/\r\n?/gu, '\n')
    const parsed = parseMarkdown(canonicalSource, article.targetSlug)

    assert(
      parsed.data.title === article.title,
      `Markdown title differs from migration evidence: ${article.targetSlug}`,
    )
    assert(
      parsed.data.category === article.category,
      `Markdown category differs from migration evidence: ${article.targetSlug}`,
    )
    assert(
      parsed.data.order === article.order,
      `Markdown order differs from migration evidence: ${article.targetSlug}`,
    )
    assert(
      parsed.data.draft === false,
      `Published migration article is not explicitly public: ${article.targetSlug}`,
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
    assert(
      !/^#{2,6}[ \t]+-[ \t]+/mu.test(parsed.body),
      `A migrated heading still contains a list marker: ${article.targetSlug}`,
    )
    assert(
      !/^ {4,}##[ \t]+/mu.test(parsed.body),
      `A top-level section remains nested in a list: ${article.targetSlug}`,
    )
    assert(
      !/XXX|acecore\.systems\/acesv|discord\.gg\/dkrn6NtU5E/iu.test(
        parsed.body,
      ),
      `A known legacy placeholder or invalid participation URL remains: ${article.targetSlug}`,
    )
    assert(
      !/(?:frestu\.com|monocraft\.net\/servers|discoparty\.jp|minecraft\.jp\/servers)/iu.test(
        parsed.body,
      ),
      `A confirmed unavailable promotion link remains: ${article.targetSlug}`,
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
      '| /co i ／ /co inspect | インスペクターモードのON、OFFの切り替え |',
    ),
    'The /co inspect rowspan aliases were not collapsed into one Markdown row.',
  )
  assert(
    commands.includes('| /cprivate ／ /lock | 対象のブロックを保護します。 |'),
    'The /lock rowspan aliases were not collapsed into one Markdown row.',
  )
  assert(
    !commands.includes('使用方法h'),
    'The inherited command-table header typo remains.',
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

  const hub = await readFile(new URL('hub-intro.md', contentDirectory), 'utf8')
  assert(
    hub.includes(
      '- Discordサーバーに参加し、自己紹介チャンネルで自己紹介をお願いします。',
    ) &&
      hub.includes(
        '- [Discord連携](/article/how-to-discordsrv-link/)をお願いします。',
      ),
    'The two source Hub requirements were not restored as a Markdown list.',
  )

  const rules = await readFile(new URL('rule.md', contentDirectory), 'utf8')
  assert(
    rules.includes(
      [
        '| 許可 | グレー | 禁止 |',
        '| --- | --- | --- |',
        '| Forge ／ Fabric ／ Lunar ／ Badlion | Feather | WURST',
      ].join('\n'),
    ),
    'The allowed-client table is not valid three-column Markdown.',
  )
  assert(
    rules.includes('参加方法：https://asv-wiki.acecore.net/article/in/') &&
      rules.includes('Discord：https://discord.gg/acsv'),
    'The streaming-description template does not use current participation URLs.',
  )

  const discordLinkGuide = await readFile(
    new URL('how-to-discordsrv-link.md', contentDirectory),
    'utf8',
  )
  assert(
    discordLinkGuide.includes(
      '[エースサーバー公式Discordに参加](https://discord.gg/acsv)',
    ),
    'The Discord-link guide is missing the verified invite.',
  )

  const parity = await validateNuxtContentParity({
    root,
    manifest,
    snapshot,
  })
  await validateRenderedMigration()
  return parity
}

async function validateRenderedMigration() {
  const rootDocument = parseHtml(
    await readFile(new URL('dist/index.html', root), 'utf8'),
  )
  assert(
    findElements(rootDocument, 'a').some(
      (node) =>
        getAttribute(node, 'href') === '/article/rinen/' &&
        elementText(node).trim() === 'Wikiを読む',
    ),
    'The Nuxt home-page start CTA is missing from the rendered site.',
  )

  const ruleDocument = parseHtml(
    await readFile(new URL('dist/article/rule/index.html', root), 'utf8'),
  )
  const articleBody = findElements(ruleDocument, 'div').find((node) =>
    getAttribute(node, 'class').split(/\s+/u).includes('article__body'),
  )

  assert(articleBody, 'The rendered rule article body is missing.')
  assert(
    findElements(articleBody, 'table').length === 1,
    'The rule article must render its allowed-client data as one table.',
  )
  assert(
    findElements(articleBody, 'strong').some((node) =>
      elementText(node).includes('サーバー退出時は必ずOFF'),
    ),
    'The server-exit warning must render as strong emphasis.',
  )
  assert(
    !elementText(articleBody).includes('**'),
    'Unparsed Markdown emphasis is visible in the rule article.',
  )

  const trapHeading = findElements(articleBody, 'h2').find(
    (node) => elementText(node).trim() === 'トラップ・回路',
  )
  assert(trapHeading, 'The trap/circuit section heading is missing.')
  assert(
    !hasAncestor(trapHeading, 'li'),
    'The trap/circuit section remains nested inside a list item.',
  )
}

function parseMarkdown(source, slug) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/u.exec(source)
  assert(match, `Missing YAML frontmatter: ${slug}`)

  return {
    data: parseYaml(match[1]),
    body: match[2],
  }
}

function sourceArticleEvidence(article) {
  return {
    id: article.id,
    sourceSlug: article.sourceSlug,
    targetSlug: article.targetSlug,
    title: article.title,
    category: article.category,
    order: article.order,
    sourceBodyBytes: article.sourceBodyBytes,
    sourceBodySha256: article.sourceBodySha256,
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

function getAttribute(node, name) {
  return node?.attrs?.find((attribute) => attribute.name === name)?.value ?? ''
}

function elementText(node) {
  if (!node) return ''
  if (node.nodeName === '#text') return node.value
  return (node.childNodes ?? []).map(elementText).join('')
}

function hasAncestor(node, tagName) {
  let ancestor = node.parentNode

  while (ancestor) {
    if (ancestor.tagName === tagName) return true
    ancestor = ancestor.parentNode
  }

  return false
}

function hasSensitiveObjectKey(value) {
  if (!value || typeof value !== 'object') return false

  if (
    Object.keys(value).some((key) =>
      /(?:authorization|password|secret|token|api[-_]?key)/iu.test(key),
    )
  ) {
    return true
  }

  return Object.values(value).some(hasSensitiveObjectKey)
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

function decodeArchivedPayload(rawPayload) {
  return unflatten(JSON.parse(rawPayload), {
    ShallowReactive: (payload) => payload,
  })
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
