import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import { parse, parseFragment } from 'parse5'

const EXPECTED_ARTICLE_COUNT = 15
const EXPECTED_SOURCE_LINK_COUNT = 47
const EXPECTED_EXACT_LINK_COUNT = 39
const EXPECTED_REWRITTEN_LINK_COUNT = 2
const EXPECTED_RETIRED_LINK_COUNT = 6
const EXPECTED_ADDED_LINK_COUNT = 3
const EXPECTED_SOURCE_IMAGE_COUNT = 9
const EXPECTED_CURRENT_IMAGE_COUNT = 8

const IGNORED_TEXT_TAGS = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'svg',
])
const BLOCK_TAGS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'br',
  'dd',
  'details',
  'div',
  'dl',
  'dt',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'summary',
  'ul',
])
const CELL_BOUNDARY_TAGS = new Set([
  'blockquote',
  'br',
  'dd',
  'div',
  'dt',
  'li',
  'ol',
  'p',
  'pre',
  'ul',
])
const CELL_BOUNDARY = '\u241e'

const NON_TABLE_SOURCE_REPLACEMENTS = [
  {
    slug: 'hub-intro',
    from: '* Discordサーバーに参加し、自己紹介チャンネルで自己紹介をお願いします。 * Discord連携をお願いします。',
    to: 'Discordサーバーに参加し、自己紹介チャンネルで自己紹介をお願いします。 Discord連携をお願いします。',
    reason:
      'Restore the two literal source asterisks as Markdown list markers.',
  },
  {
    slug: 'rule',
    from: 'サーバー退出時は必ずOFFにしてください。また、',
    to: 'サーバー退出時は必ずOFFにしてください。 また、',
    reason: 'Separate the closing emphasis marker from the following sentence.',
  },
  {
    slug: 'rule',
    from: '参加方法：http://acecore.systems/acesv',
    to: '参加方法：https://asv-wiki.acecore.net/article/in/',
    reason: 'Replace the confirmed 404 participation URL with the Wiki guide.',
  },
  {
    slug: 'rule',
    from: 'Discord：https://discord.gg/dkrn6NtU5E',
    to: 'Discord：https://discord.gg/acsv',
    reason: 'Replace the invalid Discord invite with the verified invite.',
  },
  {
    slug: 'how-to-discordsrv-link',
    from: 'ディスコードに参加するXXX（XXXのとこにディスコードリンクを埋め込み）',
    to: 'Discordに参加する',
    reason: 'Replace the legacy authoring placeholder with the final heading.',
  },
]

const CURRENT_TEXT_ADDITIONS = [
  {
    slug: 'how-to-discordsrv-link',
    text: 'エースサーバー公式Discordに参加',
    reason: 'Add a usable Discord call to action where the placeholder was.',
  },
  {
    slug: 'promotion',
    text: '（2026年7月28日時点でリンク先の応答を確認できないため、リンク掲載を終了）',
    reason: 'Explain why the three FRESTU destinations are no longer linked.',
  },
  {
    slug: 'promotion',
    text: '（2026年7月28日時点で掲載ページを確認できないため、リンク掲載を終了）',
    reason: 'Explain why the Monocraft destination is no longer linked.',
  },
  {
    slug: 'promotion',
    text: '（掲載ページが404のため、リンク掲載を終了）',
    count: 2,
    reason:
      'Explain why the two confirmed 404 listing destinations are retired.',
  },
]

const TABLE_TEXT_REPLACEMENTS = [
  {
    slug: 'SurvivalCommand',
    from: '使用方法h',
    to: '使用方法',
    reason: 'Correct the inherited LunaChat table-header typo.',
  },
]

const LINK_REWRITES = [
  {
    slug: 'hub-intro',
    text: 'Discord連携',
    from: 'https://asv-wiki.acecore.net/article/how%20to%20discordsrv%20link',
    to: '/article/how-to-discordsrv-link/',
  },
  {
    slug: 'in',
    text: 'マイクラとDiscordを連携する',
    from: 'https://asv-wiki.acecore.net/article/how%20to%20discordsrv%20link',
    to: '/article/how-to-discordsrv-link/',
  },
]

const RETIRED_LINKS = [
  {
    slug: 'promotion',
    text: 'プロフィール',
    href: 'https://frestu.com/accounts/AceCoreS',
  },
  {
    slug: 'promotion',
    text: 'Discordフレンド募集',
    href: 'https://frestu.com/boards/discord_friends/posts',
  },
  {
    slug: 'promotion',
    text: 'ゲーム友達募集',
    href: 'https://frestu.com/boards/game_friends/posts',
  },
  {
    slug: 'promotion',
    text: 'ものくらふと',
    href: 'https://monocraft.net/servers/SIa6esbbmANs2GVbUecW',
  },
  {
    slug: 'promotion',
    text: 'Japan Minecraft Servers',
    href: 'https://minecraft.jp/servers/mc.acecore.systems',
  },
  {
    slug: 'promotion',
    text: 'Discoparty',
    href: 'https://discoparty.jp/s/DC709GK11w',
  },
]

const ADDED_LINKS = [
  {
    slug: 'rule',
    text: 'https://asv-wiki.acecore.net/article/in/',
    href: 'https://asv-wiki.acecore.net/article/in/',
  },
  {
    slug: 'rule',
    text: 'https://discord.gg/acsv',
    href: 'https://discord.gg/acsv',
  },
  {
    slug: 'how-to-discordsrv-link',
    text: 'エースサーバー公式Discordに参加',
    href: 'https://discord.gg/acsv',
  },
]

const ALT_BY_LOCAL_PATH = new Map([
  [
    '/uploads/wiki/rule-handshake.jpg',
    {
      from: '手を振ってください, ハンドシェイク, 契約, 結論, ルール, 単語, 雲, エージェンシー, 書かれました',
      to: '握手とルールを表すイメージ',
    },
  ],
  [
    '/uploads/wiki/rule-circuit-board.jpg',
    {
      from: 'ボード, エレクトロニクス, コンピューター, 電気工学, 現在, プリント回路基板, データ, Cpu',
      to: 'レッドストーン回路を表す基板のイメージ',
    },
  ],
  [
    '/uploads/wiki/discord-link-step-a.png',
    {
      from: 'image_2026-07-15_095728508.png',
      to: 'Discordのルール認証で押すAリアクション',
    },
  ],
  [
    '/uploads/wiki/discord-link-server.png',
    {
      from: 'E3FA5126-3C9F-48A9-A08E-6DBFFC93E8BF.png',
      to: 'Minecraftでエースサーバーを追加する手順',
    },
  ],
  [
    '/uploads/wiki/server-philosophy-icon.png',
    {
      from: 'icon2.png',
      to: 'エースサーバーのアイコン',
    },
  ],
  [
    '/uploads/wiki/join-header.jpg',
    {
      from: 'ヘッダー画像',
      to: 'エースサーバーへ参加するプレイヤー',
    },
  ],
  [
    '/uploads/wiki/play-header.jpg',
    {
      from: '男の子, 子供達, 道, トレイル, 公園, ブラザーズ, 木, 葉っぱ, 秋, 子供, 自然, 楽しい',
      to: 'エースサーバーで一緒に遊ぶイメージ',
    },
  ],
  [
    '/uploads/wiki/promotion-header.jpg',
    {
      from: '',
      to: 'エースサーバーの宣伝イメージ',
    },
  ],
])

export async function validateNuxtContentParity({ root, manifest, snapshot }) {
  assert(root instanceof URL, 'Content parity root must be a URL.')
  assert(
    manifest.articles.length === EXPECTED_ARTICLE_COUNT,
    `Expected ${EXPECTED_ARTICLE_COUNT} manifest articles.`,
  )
  assert(
    snapshot.articles.length === EXPECTED_ARTICLE_COUNT,
    `Expected ${EXPECTED_ARTICLE_COUNT} archived articles.`,
  )

  const archivedBySourceSlug = new Map(
    snapshot.articles.map((article) => [article.sourceSlug, article]),
  )
  const sourceLinks = []
  const currentLinks = []
  const sourceImages = []
  const currentImages = []
  let tableCount = 0

  for (const article of manifest.articles) {
    const archived = archivedBySourceSlug.get(article.sourceSlug)
    assert(
      archived,
      `Archived source article is missing: ${article.sourceSlug}`,
    )

    await validateAuditedMarkdownHash(root, article)

    const sourceDocument = parseFragment(archived.article.body)
    const renderedDocument = parse(
      await readFile(
        new URL(`dist/article/${article.targetSlug}/index.html`, root),
        'utf8',
      ),
    )
    const renderedBody = findByClass(renderedDocument, 'article__body')
    assert(
      renderedBody,
      `Rendered article body is missing: ${article.targetSlug}`,
    )

    const sourceText = applySourceTextReplacements(
      article.targetSlug,
      visibleTextWithoutTables(sourceDocument),
    )
    const currentText = removeAllowedCurrentTextAdditions(
      article.targetSlug,
      visibleTextWithoutTables(renderedBody),
    )

    assertEqualText(
      currentText,
      sourceText,
      `Non-table visible text differs: ${article.targetSlug}`,
    )

    const sourceTables = semanticTables(sourceDocument, article.targetSlug, {
      collapseRowspanAliases: true,
    })
    const renderedTables = semanticTables(renderedBody, article.targetSlug, {
      collapseRowspanAliases: false,
    })
    assertDeepEqual(
      renderedTables,
      sourceTables,
      `Semantic table data differs: ${article.targetSlug}`,
    )
    tableCount += sourceTables.length

    sourceLinks.push(
      ...extractLinks(sourceDocument).map((link) => ({
        slug: article.targetSlug,
        ...link,
      })),
    )
    currentLinks.push(
      ...extractLinks(renderedBody).map((link) => ({
        slug: article.targetSlug,
        ...link,
      })),
    )
    sourceImages.push(
      ...extractImages(sourceDocument).map((image) => ({
        slug: article.targetSlug,
        ...image,
      })),
    )
    currentImages.push(
      ...extractImages(renderedBody).map((image) => ({
        slug: article.targetSlug,
        ...image,
      })),
    )
  }

  const linkSummary = validateLinks(sourceLinks, currentLinks)
  const imageSummary = validateImages({
    manifest,
    sourceImages,
    currentImages,
  })

  return {
    articleCount: EXPECTED_ARTICLE_COUNT,
    nonTableTextMatches: EXPECTED_ARTICLE_COUNT,
    tableCount,
    links: linkSummary,
    images: imageSummary,
  }
}

export function semanticTableModelsFromFragment(html, slug = 'fixture') {
  return semanticTables(parseFragment(html), slug, {
    collapseRowspanAliases: true,
  })
}

async function validateAuditedMarkdownHash(root, article) {
  const source = (
    await readFile(new URL(article.markdownPath, root), 'utf8')
  ).replace(/\r\n?/gu, '\n')

  assert(
    Buffer.byteLength(source, 'utf8') === article.markdownBytes,
    `Audited Markdown byte count changed: ${article.targetSlug}`,
  )
  assert(
    sha256(source) === article.markdownSha256,
    `Audited Markdown SHA-256 changed: ${article.targetSlug}`,
  )
}

function applySourceTextReplacements(slug, sourceText) {
  let output = sourceText

  for (const replacement of NON_TABLE_SOURCE_REPLACEMENTS.filter(
    (item) => item.slug === slug,
  )) {
    output = replaceExactly(
      output,
      replacement.from,
      replacement.to,
      1,
      `${slug}: ${replacement.reason}`,
    )
  }

  return normalizeVisibleText(output)
}

function removeAllowedCurrentTextAdditions(slug, currentText) {
  let output = currentText

  for (const addition of CURRENT_TEXT_ADDITIONS.filter(
    (item) => item.slug === slug,
  )) {
    output = replaceExactly(
      output,
      addition.text,
      '',
      addition.count ?? 1,
      `${slug}: ${addition.reason}`,
    )
  }

  return normalizeVisibleText(output)
}

function semanticTables(rootNode, slug, { collapseRowspanAliases }) {
  return findElements(rootNode, 'table').map((table, tableIndex) => {
    const { rows, inheritedColumnsByRow } = expandedTableRows(table, slug)
    const normalizedRows = rows.map((row) =>
      row.map((cell) =>
        cell.map((phrase) =>
          applyTableTextReplacements(slug, phrase, tableIndex),
        ),
      ),
    )

    return collapseRowspanAliases
      ? collapseAliasRows(normalizedRows, inheritedColumnsByRow)
      : normalizedRows
  })
}

function expandedTableRows(table, slug) {
  const rows = findElements(table, 'tr').filter(
    (row) => closestAncestor(row, 'table') === table,
  )
  const output = []
  const inheritedColumnsByRow = []
  const futureCells = new Map()

  rows.forEach((row, rowIndex) => {
    const cells = (row.childNodes ?? []).filter(
      (node) => node.tagName === 'td' || node.tagName === 'th',
    )
    const outputRow = []
    const inheritedColumns = new Set()
    const scheduled = futureCells.get(rowIndex)

    if (scheduled) {
      for (const [column, content] of scheduled) {
        outputRow[column] = content
        inheritedColumns.add(column)
      }
    }

    let column = 0

    for (const cell of cells) {
      while (outputRow[column] !== undefined) column += 1

      const content = semanticCellPhrases(cell)
      const rowSpan = positiveIntegerAttribute(cell, 'rowspan')
      const columnSpan = positiveIntegerAttribute(cell, 'colspan')

      for (let offset = 0; offset < columnSpan; offset += 1) {
        outputRow[column + offset] = content

        for (let rowOffset = 1; rowOffset < rowSpan; rowOffset += 1) {
          const targetRow = rowIndex + rowOffset
          const target = futureCells.get(targetRow) ?? new Map()
          target.set(column + offset, content)
          futureCells.set(targetRow, target)
        }
      }

      column += columnSpan
    }

    if (outputRow.some((cell) => cell !== undefined)) {
      output.push(outputRow)
      inheritedColumnsByRow.push(inheritedColumns)
    }
  })

  assert(output.length > 0, `Encountered an empty table: ${slug}`)

  const columnCount = Math.max(...output.map((row) => row.length))
  return {
    rows: output.map((row) =>
      Array.from({ length: columnCount }, (_, index) => row[index] ?? []),
    ),
    inheritedColumnsByRow,
  }
}

function collapseAliasRows(rows, inheritedColumnsByRow) {
  const collapsed = []

  rows.forEach((row, rowIndex) => {
    const previous = collapsed.at(-1)
    const inheritedColumns = inheritedColumnsByRow[rowIndex] ?? new Set()

    if (!previous) {
      collapsed.push(structuredClone(row))
      return
    }

    const differingColumns = row
      .map((cell, index) =>
        JSON.stringify(cell) === JSON.stringify(previous[index]) ? -1 : index,
      )
      .filter((index) => index >= 0)
    const nonEmptyValueColumns = row
      .map((cell, index) => (index > 0 && cell.length > 0 ? index : -1))
      .filter((index) => index >= 0)
    const isRowspanAlias =
      differingColumns.length === 1 &&
      differingColumns[0] === 0 &&
      nonEmptyValueColumns.length > 0 &&
      nonEmptyValueColumns.every((index) => inheritedColumns.has(index))

    if (isRowspanAlias) {
      previous[0].push(...row[0])
      return
    }

    collapsed.push(structuredClone(row))
  })

  return collapsed
}

function semanticCellPhrases(cell) {
  const output = []

  const visit = (node) => {
    if (node.nodeName === '#text') {
      output.push(node.value)
      return
    }
    if (IGNORED_TEXT_TAGS.has(node.tagName)) return

    const isBoundary = CELL_BOUNDARY_TAGS.has(node.tagName)
    if (isBoundary) output.push(CELL_BOUNDARY)
    for (const child of node.childNodes ?? []) visit(child)
    if (isBoundary) output.push(CELL_BOUNDARY)
  }

  for (const child of cell.childNodes ?? []) visit(child)

  return output
    .join('')
    .split(new RegExp(`${CELL_BOUNDARY}|\\s*／\\s*`, 'gu'))
    .map(normalizeVisibleText)
    .filter(Boolean)
}

function applyTableTextReplacements(slug, phrase, tableIndex) {
  let output = phrase

  for (const replacement of TABLE_TEXT_REPLACEMENTS.filter(
    (item) => item.slug === slug,
  )) {
    if (output === replacement.from) {
      output = replacement.to
    }
  }

  assert(
    output,
    `A semantic table cell became empty unexpectedly: ${slug} table ${tableIndex}`,
  )
  return output
}

function visibleTextWithoutTables(rootNode) {
  const output = []

  const visit = (node) => {
    if (node.nodeName === '#text') {
      output.push(node.value)
      return
    }
    if (node.tagName === 'table' || IGNORED_TEXT_TAGS.has(node.tagName)) return

    const isBlock = BLOCK_TAGS.has(node.tagName)
    if (isBlock) output.push(' ')
    for (const child of node.childNodes ?? []) visit(child)
    if (isBlock) output.push(' ')
  }

  visit(rootNode)
  return normalizeVisibleText(output.join(''))
}

function validateLinks(sourceLinks, currentLinks) {
  assert(
    sourceLinks.length === EXPECTED_SOURCE_LINK_COUNT,
    `Expected ${EXPECTED_SOURCE_LINK_COUNT} source article links, received ${sourceLinks.length}.`,
  )

  const rewrittenSource = sourceLinks.map((link) => {
    const rewrite = LINK_REWRITES.find(
      (candidate) =>
        candidate.slug === link.slug &&
        candidate.text === link.text &&
        candidate.from === link.href,
    )
    return rewrite ? { ...link, href: rewrite.to } : link
  })
  const rewriteMatches = LINK_REWRITES.filter((rewrite) =>
    sourceLinks.some(
      (link) =>
        link.slug === rewrite.slug &&
        link.text === rewrite.text &&
        link.href === rewrite.from,
    ),
  )
  assert(
    rewriteMatches.length === EXPECTED_REWRITTEN_LINK_COUNT,
    'A declared legacy link rewrite is missing from the source snapshot.',
  )

  const retainedSource = removeExactEntries(
    rewrittenSource,
    RETIRED_LINKS,
    'retired source link',
  )
  const retainedCurrent = removeExactEntries(
    currentLinks,
    ADDED_LINKS,
    'added current link',
  )

  assertDeepEqual(
    retainedCurrent,
    retainedSource,
    'Retained article links differ after the explicit rewrite and retirement policy.',
  )
  assert(
    retainedSource.length ===
      EXPECTED_EXACT_LINK_COUNT + EXPECTED_REWRITTEN_LINK_COUNT,
    'Unexpected retained source-link count.',
  )
  assert(
    RETIRED_LINKS.length === EXPECTED_RETIRED_LINK_COUNT,
    'Unexpected retired-link policy count.',
  )
  assert(
    ADDED_LINKS.length === EXPECTED_ADDED_LINK_COUNT,
    'Unexpected added-link policy count.',
  )

  for (const retired of RETIRED_LINKS) {
    assert(
      !currentLinks.some((link) => entriesEqual(link, retired)),
      `A retired link remains active: ${JSON.stringify(retired)}`,
    )
  }

  return {
    source: EXPECTED_SOURCE_LINK_COUNT,
    exact: EXPECTED_EXACT_LINK_COUNT,
    rewritten: EXPECTED_REWRITTEN_LINK_COUNT,
    retired: EXPECTED_RETIRED_LINK_COUNT,
    added: EXPECTED_ADDED_LINK_COUNT,
    current: currentLinks.length,
  }
}

function validateImages({ manifest, sourceImages, currentImages }) {
  assert(
    sourceImages.length === EXPECTED_SOURCE_IMAGE_COUNT,
    `Expected ${EXPECTED_SOURCE_IMAGE_COUNT} source article images, received ${sourceImages.length}.`,
  )
  assert(
    currentImages.length === EXPECTED_CURRENT_IMAGE_COUNT,
    `Expected ${EXPECTED_CURRENT_IMAGE_COUNT} current article images, received ${currentImages.length}.`,
  )

  const assetBySourceUrl = new Map(
    manifest.assets.map((asset) => [asset.sourceUrl, asset]),
  )
  const removedBySource = new Map(
    manifest.removedAssets.map((asset) => [asset.source, asset]),
  )
  const expectedCurrentImages = []

  for (const image of sourceImages) {
    const removed = removedBySource.get(image.src)
    if (removed) {
      assert(
        removed.articleSlug === image.slug && removed.alt === image.alt,
        `Removed-image evidence differs: ${image.src}`,
      )
      continue
    }

    const asset = assetBySourceUrl.get(image.src)
    assert(
      asset,
      `Source article image is absent from the manifest: ${image.src}`,
    )
    const localPath = publicAssetUrl(asset.localPath)
    const altRewrite = ALT_BY_LOCAL_PATH.get(localPath)
    assert(altRewrite, `Image alt rewrite is not allowlisted: ${localPath}`)
    assert(
      image.alt === altRewrite.from,
      `Archived image alt differs from the exact allowlist: ${localPath}`,
    )
    expectedCurrentImages.push({
      slug: image.slug,
      src: localPath,
      alt: altRewrite.to,
    })
  }

  assertDeepEqual(
    currentImages,
    expectedCurrentImages,
    'Current article images or alt rewrites differ from migration evidence.',
  )
  assert(
    ALT_BY_LOCAL_PATH.size === EXPECTED_CURRENT_IMAGE_COUNT,
    'Unexpected image-alt allowlist count.',
  )

  return {
    source: EXPECTED_SOURCE_IMAGE_COUNT,
    preserved: EXPECTED_CURRENT_IMAGE_COUNT,
    altRewritten: EXPECTED_CURRENT_IMAGE_COUNT,
    removedBroken: manifest.removedAssets.length,
  }
}

function extractLinks(rootNode) {
  return findElements(rootNode, 'a').map((anchor) => ({
    text: normalizeVisibleText(elementText(anchor)),
    href: getAttribute(anchor, 'href'),
  }))
}

function extractImages(rootNode) {
  return findElements(rootNode, 'img').map((image) => ({
    src: getAttribute(image, 'src'),
    alt: getAttribute(image, 'alt').normalize('NFC'),
  }))
}

function removeExactEntries(entries, removals, label) {
  const output = [...entries]

  for (const removal of removals) {
    const matches = output
      .map((entry, index) => (entriesEqual(entry, removal) ? index : -1))
      .filter((index) => index >= 0)
    assert(
      matches.length === 1,
      `Expected exactly one ${label}: ${JSON.stringify(removal)}; received ${matches.length}.`,
    )
    output.splice(matches[0], 1)
  }

  return output
}

function entriesEqual(actual, expected) {
  return (
    actual.slug === expected.slug &&
    actual.text === expected.text &&
    actual.href === expected.href
  )
}

function publicAssetUrl(localPath) {
  assert(
    localPath.startsWith('public/'),
    `Expected a public asset path: ${localPath}`,
  )
  return `/${localPath.slice('public/'.length)}`
}

function replaceExactly(value, from, to, expectedCount, description) {
  const count = countOccurrences(value, from)
  assert(
    count === expectedCount,
    `${description}; expected ${expectedCount} exact occurrence(s), received ${count}.`,
  )
  return value.split(from).join(to)
}

function countOccurrences(value, search) {
  assert(search, 'Cannot count an empty parity marker.')
  let count = 0
  let offset = 0

  while (true) {
    const index = value.indexOf(search, offset)
    if (index < 0) return count
    count += 1
    offset = index + search.length
  }
}

function normalizeVisibleText(value) {
  return value
    .normalize('NFC')
    .replace(/\u00a0/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
}

function positiveIntegerAttribute(node, name) {
  const value = Number.parseInt(getAttribute(node, name), 10)
  return Number.isInteger(value) && value > 0 ? value : 1
}

function closestAncestor(node, tagName) {
  let ancestor = node.parentNode

  while (ancestor) {
    if (ancestor.tagName === tagName) return ancestor
    ancestor = ancestor.parentNode
  }

  return null
}

function findByClass(rootNode, className) {
  return findElements(rootNode).find((node) =>
    getAttribute(node, 'class').split(/\s+/u).includes(className),
  )
}

function findElements(rootNode, tagName) {
  const matches = []
  const visit = (node) => {
    if (!tagName || node.tagName === tagName) {
      if (node.tagName) matches.push(node)
    }
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
  if (IGNORED_TEXT_TAGS.has(node.tagName)) return ''
  return (node.childNodes ?? []).map(elementText).join('')
}

function assertEqualText(actual, expected, message) {
  if (actual === expected) return

  const difference = firstDifference(actual, expected)
  throw new Error(
    `${message}\nDifference index: ${difference.index}\nExpected: ${JSON.stringify(difference.expected)}\nReceived: ${JSON.stringify(difference.actual)}`,
  )
}

function firstDifference(actual, expected) {
  let index = 0
  while (
    index < actual.length &&
    index < expected.length &&
    actual[index] === expected[index]
  ) {
    index += 1
  }

  return {
    index,
    expected: expected.slice(Math.max(0, index - 80), index + 160),
    actual: actual.slice(Math.max(0, index - 80), index + 160),
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function assertDeepEqual(actual, expected, message) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) return
  throw new Error(
    `${message}\nExpected: ${JSON.stringify(expected)}\nReceived: ${JSON.stringify(actual)}`,
  )
}
