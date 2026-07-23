import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { ensureImageAlts, inspectImageAlts } from '../shared/lib/image-alt.js'

test('article images keep meaningful alt text and repair empty or missing alt', () => {
  const html = [
    '<img src="first.png">',
    '<img src="second.png" alt="">',
    '<img src="third.png" alt="既存の説明">',
  ].join('')
  const repaired = ensureImageAlts(html, 'Discord連携')

  assert.match(
    repaired,
    /<img\b(?=[^>]*src="first\.png")(?=[^>]*alt="Discord連携の説明画像 1")[^>]*>/,
  )
  assert.match(
    repaired,
    /<img\b(?=[^>]*src="second\.png")(?=[^>]*alt="Discord連携の説明画像 2")[^>]*>/,
  )
  assert.match(
    repaired,
    /<img\b(?=[^>]*src="third\.png")(?=[^>]*alt="既存の説明")[^>]*>/,
  )
  assert.deepEqual(inspectImageAlts(repaired), {
    images: 3,
    missing: 0,
    empty: 0,
    issues: [],
  })
})

test('image alt fallback escapes article titles for safe HTML attributes', () => {
  const repaired = ensureImageAlts(
    '<img src="guide.png" alt=" ">',
    'A&B "案内"',
  )
  assert.match(repaired, /alt="A&amp;B &quot;案内&quot;の説明画像"/)
})

test('known article image keeps its curated description', () => {
  const repaired = ensureImageAlts(
    '<img src="https://cdn.pixabay.com/photo/2020/03/22/15/25/fetch-4957501_1280.jpg">',
    '宣伝方法',
  )
  assert.match(repaired, /alt="エースサーバーの宣伝イメージ"/)
})

test('image audit distinguishes missing and empty alt attributes', () => {
  const audit = inspectImageAlts(
    '<img src="missing.png"><img src="empty.png" alt="&nbsp;"><img src="ok.png" alt="説明">',
  )
  assert.equal(audit.images, 3)
  assert.equal(audit.missing, 1)
  assert.equal(audit.empty, 1)
  assert.deepEqual(
    audit.issues.map(({ state, source }) => ({ state, source })),
    [
      { state: 'missing', source: 'missing.png' },
      { state: 'empty', source: 'empty.png' },
    ],
  )
})

test('header and article components supply useful alt context', async () => {
  const [header, article] = await Promise.all([
    readFile(new URL('../app/components/Header.vue', import.meta.url), 'utf8'),
    readFile(new URL('../app/components/Article.vue', import.meta.url), 'utf8'),
  ])
  assert.match(header, /:alt="title \+ 'のロゴ'"/)
  assert.match(header, /aria-hidden="true"/)
  assert.match(
    article,
    /ensureImageAlts\(this\.article\.body, this\.article\.title\)/,
  )
})
