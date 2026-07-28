const CANONICAL_DISCORD_INVITE = 'https://discord.gg/acsv'
const CANONICAL_JOIN_ARTICLE = 'https://asv-wiki.acecore.net/article/in/'

export function replaceMarkdownTableMarker(markdown, marker, table) {
  const markerLine = new RegExp(
    `^([\\t ]*)${escapeRegExp(marker)}([^\\n]*)$`,
    'mu',
  )
  const markerOccurrences = markdown.match(
    new RegExp(escapeRegExp(marker), 'gu'),
  )

  if (markerOccurrences?.length !== 1 || !markerLine.test(markdown)) {
    throw new Error(
      `Markdown table marker must appear exactly once as the first non-whitespace content on a line: ${marker}`,
    )
  }

  return markdown.replace(
    markerLine,
    (_match, indentation, trailingContent) => {
      const renderedTable = table
        .split('\n')
        .map((line) => `${indentation}${line}`)
        .join('\n')
      const trailing = trailingContent.trim()

      return trailing
        ? `${renderedTable}\n\n${indentation}${trailing}`
        : renderedTable
    },
  )
}

export function collapseRowspanAliasRows(rows, inheritedColumnsByRow) {
  const collapsed = []

  rows.forEach((row, rowIndex) => {
    const previous = collapsed.at(-1)
    const inheritedColumns = inheritedColumnsByRow[rowIndex] ?? new Set()
    const nonEmptyValueColumns = row
      .map((cell, index) => (index > 0 && cell ? index : -1))
      .filter((index) => index >= 0)

    if (!previous) {
      collapsed.push([...row])
      return
    }

    const differingColumns = row
      .map((cell, index) => (cell === previous[index] ? -1 : index))
      .filter((index) => index >= 0)
    const isRowspanAlias =
      differingColumns.length === 1 &&
      differingColumns[0] === 0 &&
      nonEmptyValueColumns.length > 0 &&
      nonEmptyValueColumns.every((index) => inheritedColumns.has(index))

    if (isRowspanAlias) {
      previous[0] = `${previous[0]} ／ ${row[0]}`
      return
    }

    collapsed.push([...row])
  })

  return collapsed
}

export function normalizeKnownMigratedMarkdown(markdown, sourceSlug) {
  let normalized = markdown.replace(/^(#{2,6})[ \t]+-[ \t]+/gmu, '$1 ')

  if (sourceSlug === 'hub-intro') {
    normalized = normalized.replace(
      /\\\* Discordサーバーに参加し、自己紹介チャンネルで自己紹介をお願いします。 \\\* \[Discord連携\]\(\/article\/how-to-discordsrv-link\/\)をお願いします。（詳細は参加方法のページに記載）/u,
      [
        '- Discordサーバーに参加し、自己紹介チャンネルで自己紹介をお願いします。',
        '- [Discord連携](/article/how-to-discordsrv-link/)をお願いします。（詳細は参加方法のページに記載）',
      ].join('\n'),
    )
  }

  if (sourceSlug === 'how to discordsrv link') {
    normalized = normalized.replace(
      '## ディスコードに参加するXXX（XXXのとこにディスコードリンクを埋め込み）',
      [
        '## Discordに参加する',
        '',
        `[エースサーバー公式Discordに参加](${CANONICAL_DISCORD_INVITE})`,
      ].join('\n'),
    )
  }

  if (sourceSlug === 'rule') {
    normalized = unindentFromHeading(normalized, '## トラップ・回路')
      .replace(
        '**サーバー退出時は必ずOFFにしてください。**また、',
        '**サーバー退出時は必ずOFFにしてください。** また、',
      )
      .replace(
        '参加方法：http://acecore.systems/acesv',
        `参加方法：${CANONICAL_JOIN_ARTICLE}`,
      )
      .replace(
        'Discord：https://discord.gg/dkrn6NtU5E',
        `Discord：${CANONICAL_DISCORD_INVITE}`,
      )
  }

  if (sourceSlug === 'promotion') {
    normalized = normalized
      .replace(
        /- {3}FRESTU\n {4}1\. {2}\[プロフィール\]\(https:\/\/frestu\.com\/accounts\/AceCoreS\)\n {4}2\. {2}\[Discordフレンド募集\]\(https:\/\/frestu\.com\/boards\/discord_friends\/posts\)\n {4}3\. {2}\[ゲーム友達募集\]\(https:\/\/frestu\.com\/boards\/game_friends\/posts\)/u,
        [
          '-   FRESTU（2026年7月28日時点でリンク先の応答を確認できないため、リンク掲載を終了）',
          '    1.  プロフィール',
          '    2.  Discordフレンド募集',
          '    3.  ゲーム友達募集',
        ].join('\n'),
      )
      .replace(
        '-   [ものくらふと](https://monocraft.net/servers/SIa6esbbmANs2GVbUecW)',
        '-   ものくらふと（2026年7月28日時点で掲載ページを確認できないため、リンク掲載を終了）',
      )
      .replace(
        '-   [Japan Minecraft Servers](https://minecraft.jp/servers/mc.acecore.systems)',
        '-   Japan Minecraft Servers（掲載ページが404のため、リンク掲載を終了）',
      )
      .replace(
        '-   [Discoparty](https://discoparty.jp/s/DC709GK11w)',
        '-   Discoparty（掲載ページが404のため、リンク掲載を終了）',
      )
  }

  return normalized
}

function unindentFromHeading(markdown, heading) {
  const start = markdown.indexOf(`    ${heading}`)

  if (start < 0) return markdown

  return (
    markdown.slice(0, start) + markdown.slice(start).replace(/^ {4}/gmu, '')
  )
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}
