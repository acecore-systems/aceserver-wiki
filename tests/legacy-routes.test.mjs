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
      'https://asv-wiki.acecore.net/'
    )
  })
}

test('Pages invokes the middleware only for the legacy MediaWiki entry', async () => {
  const routes = JSON.parse(
    await readFile(new URL('../static/_routes.json', import.meta.url), 'utf8')
  )
  assert.deepEqual(routes, {
    version: 1,
    include: ['/index.php'],
    exclude: [],
  })
})
