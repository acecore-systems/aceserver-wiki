import { describe, expect, it } from 'vitest'

import {
  collapseRowspanAliasRows,
  normalizeKnownMigratedMarkdown,
  replaceMarkdownTableMarker,
} from '../scripts/newt-markdown-normalization.mjs'

describe('Nuxt/Newt Markdown migration normalization', () => {
  it('keeps every row of a nested table indented and separates trailing text', () => {
    const markdown =
      '    WIKITABLETOKEN0ENDその他のクライアントを使用したい場合は質問してください。'
    const table = [
      '| 許可 | グレー | 禁止 |',
      '| --- | --- | --- |',
      '| Forge | Feather | WURST |',
    ].join('\n')

    expect(
      replaceMarkdownTableMarker(markdown, 'WIKITABLETOKEN0END', table),
    ).toBe(
      [
        '    | 許可 | グレー | 禁止 |',
        '    | --- | --- | --- |',
        '    | Forge | Feather | WURST |',
        '',
        '    その他のクライアントを使用したい場合は質問してください。',
      ].join('\n'),
    )
  })

  it('rejects a table marker outside the expected line position', () => {
    expect(() =>
      replaceMarkdownTableMarker(
        'prefix WIKITABLETOKEN0END',
        'WIKITABLETOKEN0END',
        '| A |',
      ),
    ).toThrow(
      'must appear exactly once as the first non-whitespace content on a line',
    )
  })

  it('rejects a missing or duplicate table marker', () => {
    expect(() =>
      replaceMarkdownTableMarker('本文', 'WIKITABLETOKEN0END', '| A |'),
    ).toThrow(
      'must appear exactly once as the first non-whitespace content on a line',
    )
    expect(() =>
      replaceMarkdownTableMarker(
        'WIKITABLETOKEN0END\nWIKITABLETOKEN0END',
        'WIKITABLETOKEN0END',
        '| A |',
      ),
    ).toThrow(
      'must appear exactly once as the first non-whitespace content on a line',
    )
  })

  it('collapses only aliases whose remaining cells came from a rowspan', () => {
    expect(
      collapseRowspanAliasRows(
        [
          ['/co i', '同じ説明'],
          ['/co inspect', '同じ説明'],
        ],
        [new Set(), new Set([1])],
      ),
    ).toEqual([['/co i ／ /co inspect', '同じ説明']])
  })

  it('keeps legitimate adjacent rows with independently repeated values', () => {
    expect(
      collapseRowspanAliasRows(
        [
          ['A', '同じ説明'],
          ['B', '同じ説明'],
        ],
        [new Set(), new Set()],
      ),
    ).toEqual([
      ['A', '同じ説明'],
      ['B', '同じ説明'],
    ])
  })

  it('restores Hub headings and the two source list items', () => {
    const markdown = [
      '## -   エースタウン',
      '',
      '\\* Discordサーバーに参加し、自己紹介チャンネルで自己紹介をお願いします。 \\* [Discord連携](/article/how-to-discordsrv-link/)をお願いします。（詳細は参加方法のページに記載）',
    ].join('\n')

    const normalized = normalizeKnownMigratedMarkdown(markdown, 'hub-intro')

    expect(normalized).toContain('## エースタウン')
    expect(normalized).toContain(
      '- Discordサーバーに参加し、自己紹介チャンネルで自己紹介をお願いします。',
    )
    expect(normalized).toContain(
      '- [Discord連携](/article/how-to-discordsrv-link/)をお願いします。',
    )
    expect(normalized).not.toContain('\\*')
  })

  it('unnests the rule sections and replaces invalid participation links', () => {
    const normalized = normalizeKnownMigratedMarkdown(
      [
        '### -   整地ルール',
        '',
        '    ## トラップ・回路',
        '',
        '    -   **サーバー退出時は必ずOFFにしてください。**また、負荷を確認します。',
        '',
        '    参加方法：http://acecore.systems/acesv',
        '    Discord：https://discord.gg/dkrn6NtU5E',
      ].join('\n'),
      'rule',
    )

    expect(normalized).toContain('### 整地ルール')
    expect(normalized).toContain('\n## トラップ・回路')
    expect(normalized).toContain(
      '**サーバー退出時は必ずOFFにしてください。** また、',
    )
    expect(normalized).toContain(
      '参加方法：https://asv-wiki.acecore.net/article/in/',
    )
    expect(normalized).toContain('Discord：https://discord.gg/acsv')
    expect(normalized).not.toContain('    ##')
  })

  it('replaces the Discord placeholder with the verified invite', () => {
    const normalized = normalizeKnownMigratedMarkdown(
      '## ディスコードに参加するXXX（XXXのとこにディスコードリンクを埋め込み）',
      'how to discordsrv link',
    )

    expect(normalized).toBe(
      [
        '## Discordに参加する',
        '',
        '[エースサーバー公式Discordに参加](https://discord.gg/acsv)',
      ].join('\n'),
    )
  })

  it('removes confirmed unavailable promotion destinations', () => {
    const normalized = normalizeKnownMigratedMarkdown(
      [
        '-   FRESTU',
        '    1.  [プロフィール](https://frestu.com/accounts/AceCoreS)',
        '    2.  [Discordフレンド募集](https://frestu.com/boards/discord_friends/posts)',
        '    3.  [ゲーム友達募集](https://frestu.com/boards/game_friends/posts)',
        '-   [ものくらふと](https://monocraft.net/servers/SIa6esbbmANs2GVbUecW)',
        '-   [Japan Minecraft Servers](https://minecraft.jp/servers/mc.acecore.systems)',
        '-   [Discoparty](https://discoparty.jp/s/DC709GK11w)',
      ].join('\n'),
      'promotion',
    )

    expect(normalized).not.toMatch(
      /frestu\.com|monocraft\.net|minecraft\.jp|discoparty\.jp/u,
    )
    expect(normalized).toContain('リンク掲載を終了')
    expect(normalized).toContain('1.  プロフィール')
    expect(normalized).toContain('2.  Discordフレンド募集')
    expect(normalized).toContain('3.  ゲーム友達募集')
  })
})
