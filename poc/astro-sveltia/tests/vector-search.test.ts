import { describe, expect, it } from 'vitest'

import {
  buildWikiVectorCorpus,
  chunkWikiVectorSource,
  SEARCH_DISTANCE_METRIC,
  SEARCH_EMBEDDING_DIMENSIONS,
  SEARCH_EMBEDDING_MODEL,
  SEARCH_MAXIMUM_CHUNK_CHARACTERS,
  SEARCH_NAMESPACE,
  type WikiVectorSource,
} from '../src/lib/vector-search'

const createSource = (
  overrides: Partial<WikiVectorSource> = {},
): WikiVectorSource => ({
  url: '/article/vector-search/',
  title: 'Vectorize検索',
  description: '意味の近いWiki記事を検索するための説明です。',
  category: 'その他',
  body: `導入文です。

## 安全な同期

公開Markdownから作った内容ハッシュで差分だけを同期します。

![検索対象にしない画像説明](/uploads/wiki/vector-search.png)

[Cloudflareの資料](https://developers.cloudflare.com/vectorize/)も参照します。

\`\`\`markdown
## コード内の見出し
検索対象にしないコードです。
\`\`\`

## 日本語検索

表記揺れがあっても、意味の近い案内を見つけられるようにします。`,
  ...overrides,
})

describe('Wiki Vectorize corpus', () => {
  it('公開Markdownから決定的なBGE-M3 corpusを作る', async () => {
    const first = await buildWikiVectorCorpus([
      createSource(),
      createSource({
        url: '/article/another/',
        title: '別の記事',
        category: 'イントロダクション',
        body: '## 概要\n\nもう一つの公開記事です。',
      }),
    ])
    const second = await buildWikiVectorCorpus([
      createSource({
        url: '/article/another/',
        title: '別の記事',
        category: 'イントロダクション',
        body: '## 概要\n\nもう一つの公開記事です。',
      }),
      createSource(),
    ])

    expect(first).toEqual(second)
    expect(first.embedding).toEqual({
      model: SEARCH_EMBEDDING_MODEL,
      dimensions: SEARCH_EMBEDDING_DIMENSIONS,
      metric: SEARCH_DISTANCE_METRIC,
    })
    expect(first.sourceCount).toBe(2)
    expect(first.vectorCount).toBe(first.chunks.length)
    expect(first.localeCounts).toEqual({ ja: first.vectorCount })
    expect(first.version).toMatch(/^[0-9a-f]{20}$/u)

    const vectorChunk = first.chunks.find(
      ({ metadata }) => metadata.url === '/article/vector-search/',
    )
    expect(vectorChunk).toBeDefined()
    expect(vectorChunk?.id).toMatch(/^v1-[0-9a-f]{48}$/u)
    expect(vectorChunk?.namespace).toBe(SEARCH_NAMESPACE)
    expect(vectorChunk?.metadata).toMatchObject({
      url: '/article/vector-search/',
      title: 'Vectorize検索',
      category: 'その他',
      locale: 'ja',
    })
    expect(vectorChunk?.text).toContain('安全な同期')
    expect(vectorChunk?.text).toContain('Cloudflareの資料')
    expect(vectorChunk?.text).not.toMatch(
      /uploads\/wiki|コード内の見出し|検索対象にしないコード/u,
    )
  })

  it('本文として使われる連続見出しの文言も検索対象に残す', async () => {
    const chunks = await chunkWikiVectorSource(
      createSource({
        body: `###### Discordアカウントと連携すると遊べます。
###### 以下の手順に沿って設定してください。

## Discordに参加する

公式Discordへ参加してください。`,
      }),
    )
    const text = chunks.map((chunk) => chunk.text).join(' ')

    expect(text).toContain('Discordアカウントと連携すると遊べます。')
    expect(text).toContain('以下の手順に沿って設定してください。')
    expect(text).toContain('Discordに参加する')
  })

  it('長い記事を上限内のoverlap付きchunkへ分割する', async () => {
    const paragraphs = Array.from(
      { length: 14 },
      (_value, index) =>
        `段落${index + 1}です。${'日本語の検索文脈を保つ文章です。'.repeat(7)}`,
    )
    const chunks = await chunkWikiVectorSource(
      createSource({
        body: `## 長い節\n\n${paragraphs.join('\n\n')}`,
      }),
    )

    expect(chunks.length).toBeGreaterThan(2)
    expect(
      chunks.every(
        ({ text }) => text.length <= SEARCH_MAXIMUM_CHUNK_CHARACTERS,
      ),
    ).toBe(true)
    expect(
      chunks.slice(1).some(({ text }, index) => {
        const previousText = chunks[index].text
        return paragraphs.some(
          (paragraph) =>
            previousText.includes(paragraph) && text.includes(paragraph),
        )
      }),
    ).toBe(true)
    expect(new Set(chunks.map(({ id }) => id)).size).toBe(chunks.length)
  })

  it('metadataだけの変更でもIDを更新する', async () => {
    const [before] = await chunkWikiVectorSource(createSource())
    const [after] = await chunkWikiVectorSource(
      createSource({ category: '生活鯖について' }),
    )

    expect(before.text).toBe(after.text)
    expect(before.id).not.toBe(after.id)
  })

  it('不正または重複した公開URLを拒否する', async () => {
    await expect(
      buildWikiVectorCorpus([createSource({ url: 'https://example.com/' })]),
    ).rejects.toThrow('Invalid Wiki vector source URL')
    await expect(
      buildWikiVectorCorpus([createSource(), createSource()]),
    ).rejects.toThrow('Duplicate Wiki vector source URL')
  })
})
