import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  canonicalCategoryFor,
  descriptionFor,
  normalizeDraftHtml,
} from '../scripts/import-newt-drafts.mjs'

describe('Newt draft converter', () => {
  it('normalizes source HTML without publishing or copying remote images', () => {
    const normalized = normalizeDraftHtml(
      [
        '<style>body { color: red }</style>',
        '<script>alert(1)</script>',
        '<h1>見出し</h1>',
        '<details><summary>回答</summary><p>本文</p></details>',
        '<select><option>運営</option><option>サポーター</option></select>',
        '<img src="https://example.com/image.png" alt="手順画像">',
        '<a href="https://aceserver-wiki.acecore.systems/article/Legacy%20Draft">旧記事</a>',
        '<table><tr><th>項目</th><th>値</th></tr><tr><td>A</td><td>B</td></tr></table>',
      ].join(''),
      {
        articleId: 'draft-id',
        originalSlug: 'Draft',
        internalTargets: new Map([
          ['Legacy Draft', 'legacy-draft'],
          ['legacy-draft', 'legacy-draft'],
        ]),
      },
    )

    assert.match(normalized.markdown, /## 見出し/u)
    assert.match(normalized.markdown, /#### 回答/u)
    assert.match(normalized.markdown, /運営/u)
    assert.match(
      normalized.markdown,
      /\[旧記事\]\(\/article\/legacy-draft\/\)/u,
    )
    assert.match(normalized.markdown, /\| 項目 \| 値 \|/u)
    assert.match(normalized.markdown, /\*画像は移行保留です（手順画像）\*/u)
    assert.doesNotMatch(normalized.markdown, /<[^>]+>|^#\s|!\[/mu)
    assert.deepEqual(normalized.assetReferences, [
      {
        context: 'body.img',
        sourceUrl: 'https://example.com/image.png',
        alt: '手順画像',
        disposition: 'inventory-only-not-copied',
      },
    ])
    assert.deepEqual(normalized.removedSourceElements, [
      { element: 'script', count: 1 },
      { element: 'style', count: 1 },
    ])
  })

  it('fails closed for dangerous or unmapped internal links', () => {
    const options = {
      articleId: 'draft-id',
      originalSlug: 'Draft',
      internalTargets: new Map(),
    }

    assert.throws(
      () =>
        normalizeDraftHtml('<a href="javascript:alert(1)">危険</a>', options),
      /Unsupported link scheme/u,
    )
    assert.throws(
      () => normalizeDraftHtml('<a href="/article/Unknown/">不明</a>', options),
      /has no explicit migration target/u,
    )
  })

  it('maps legacy categories explicitly and rejects unknown categories', () => {
    assert.equal(
      canonicalCategoryFor(
        {
          _id: '635d02e606cfd5386b3720de',
          name: '資源サーバー',
        },
        'draft-id',
      ),
      'その他サーバーについて',
    )
    assert.throws(
      () => canonicalCategoryFor({ _id: 'unknown', name: '未知' }, 'draft-id'),
      /Unknown Newt category ID/u,
    )
  })

  it('requires explicit text when the Newt description is empty', () => {
    assert.match(
      descriptionFor(
        {
          meta: { description: '' },
        },
        '64166697b836a015edbf22da',
      ),
      /各種申請/u,
    )
    assert.throws(
      () => descriptionFor({ meta: { description: '' } }, 'unknown'),
      /requires an explicit mapping/u,
    )
  })
})
