import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CURATED_ARTICLE_DESCRIPTIONS,
  SEO_LIMITS,
  ROOT_DESCRIPTION,
  ROOT_META_TITLE,
  buildArticleMetaDescription,
  buildArticleMetaTitle,
  unnaturalDescriptionReasons,
} from '../utils/seo-metadata.mjs'

const within = (value, minimum, maximum) =>
  value.length >= minimum && value.length <= maximum

test('root metadata stays in the Bing-recommended ranges', () => {
  assert.equal(
    within(ROOT_META_TITLE, SEO_LIMITS.titleMin, SEO_LIMITS.titleMax),
    true
  )
  assert.equal(
    within(
      ROOT_DESCRIPTION,
      SEO_LIMITS.descriptionMin,
      SEO_LIMITS.descriptionMax
    ),
    true
  )
  assert.deepEqual(unnaturalDescriptionReasons(ROOT_DESCRIPTION), [])
})

test('article title retains the article topic and adds the official Wiki context', () => {
  const title = buildArticleMetaTitle('ルール')
  assert.match(title, /ルール/)
  assert.match(title, /エースサーバー公式Wiki/)
  assert.equal(within(title, SEO_LIMITS.titleMin, SEO_LIMITS.titleMax), true)
})

test('article description uses the article body instead of generic filler', () => {
  const description = buildArticleMetaDescription({
    title: 'ワールド移動コマンド',
    description: '利用できるコマンドの案内です。',
    body: '<p>/helpでヘルプを表示し、/msgでほかの参加者へ個別メッセージを送信できます。</p><p>権限によって利用できるコマンドが異なるため、実行前に条件を確認してください。</p><p>サバイバルワールドで便利な移動・保護・コミュニケーション用コマンドも一覧で紹介します。</p>',
  })
  assert.match(description, /\/help/)
  assert.match(description, /権限/)
  assert.equal(
    within(description, SEO_LIMITS.descriptionMin, SEO_LIMITS.descriptionMax),
    true
  )
  assert.match(description, /[。！？!?.]$/)
  assert.doesNotMatch(description, /…$/)
})

test('all current Wiki articles have unique, natural curated descriptions', () => {
  const descriptions = Object.values(CURATED_ARTICLE_DESCRIPTIONS)
  assert.equal(descriptions.length, 15)
  assert.equal(new Set(descriptions).size, descriptions.length)
  for (const description of descriptions) {
    assert.equal(
      within(description, SEO_LIMITS.descriptionMin, SEO_LIMITS.descriptionMax),
      true
    )
    assert.deepEqual(unnaturalDescriptionReasons(description), [])
  }
})

test('short articles get a topic-specific natural completion', () => {
  const description = buildArticleMetaDescription({
    title: 'くわ王国',
    body: '<p>建築を楽しむ参加者コミュニティです。</p>',
  })
  assert.match(description, /くわ王国/)
  assert.equal(
    within(description, SEO_LIMITS.descriptionMin, SEO_LIMITS.descriptionMax),
    true
  )
  assert.match(description, /[。！？!?.]$/)
  assert.doesNotMatch(description, /…$/)
})
