import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { onRequest } from '../functions/_middleware.ts'

for (const requestUrl of [
  'https://asv-wiki.acecore.net/index.php',
  'https://asv-wiki.acecore.net/index.php?title=メインページ',
  'https://asv-wiki.acecore.net/index.php?title=カテゴリ:メインサーバーについて',
]) {
  test(`${requestUrl} redirects to the canonical Wiki root`, async () => {
    const response = await onRequest({
      request: new Request(requestUrl),
      next: async () => new Response('not found', { status: 404 }),
    })

    assert.equal(response.status, 301)
    assert.equal(
      response.headers.get('location'),
      'https://asv-wiki.acecore.net/',
    )
  })
}

for (const requestUrl of [
  'https://asv-wiki.acecore.net/article/SurvivalRules',
  'https://asv-wiki.acecore.net/article/SurvivalRules/',
  'https://asv-wiki.acecore.net/article/SurvivalRules/?utm_source=bing',
]) {
  test(`${requestUrl} redirects to the current rules article`, async () => {
    const response = await onRequest({
      request: new Request(requestUrl),
      next: async () => new Response('not found', { status: 404 }),
    })

    assert.equal(response.status, 301)
    assert.equal(
      response.headers.get('location'),
      'https://asv-wiki.acecore.net/article/rule/',
    )
  })
}

for (const requestUrl of [
  'https://asv-wiki.acecore.net/index.php?title=特別:ログイン&returnto=メインページ',
  'https://asv-wiki.acecore.net/index.php?title=メインページ&action=edit',
  'https://asv-wiki.acecore.net/index.php?oldid=12345',
  'https://asv-wiki.acecore.net/index.php?title=存在しない旧記事',
  'https://asv-wiki.acecore.net/article/world/',
  'https://asv-wiki.acecore.net/article/community/',
  'https://asv-wiki.acecore.net/article/LoginPassword/',
  'https://asv-wiki.acecore.net/article/Q%26A/',
  'https://asv-wiki.acecore.net/article/Application%20method/',
]) {
  test(`${requestUrl} falls through to the noindex not-found page`, async () => {
    let nextCalled = false
    const response = await onRequest({
      request: new Request(requestUrl),
      next: async () => {
        nextCalled = true
        return new Response('not found', { status: 404 })
      },
    })

    assert.equal(nextCalled, true)
    assert.equal(response.status, 404)
  })
}

test('Pages invokes the middleware only for the legacy MediaWiki entry', async () => {
  const routes = JSON.parse(
    await readFile(new URL('../public/_routes.json', import.meta.url), 'utf8'),
  )
  assert.deepEqual(routes, {
    version: 1,
    include: [
      '/index.php',
      '/article/SurvivalRules',
      '/article/SurvivalRules/',
    ],
    exclude: [],
  })
})
