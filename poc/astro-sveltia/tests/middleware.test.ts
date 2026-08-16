import { describe, expect, it } from 'vitest'

import { onRequest } from '../functions/_middleware.ts'

describe('Pages middleware', () => {
  it('preserves the legacy MediaWiki root redirect', async () => {
    const response = await onRequest({
      request: new Request(
        'https://asv-wiki.acecore.net/index.php?title=メインページ',
      ),
      next: async () => new Response('not reached'),
    } as Parameters<typeof onRequest>[0])

    expect(response.status).toBe(301)
    expect(response.headers.get('Location')).toBe(
      'https://asv-wiki.acecore.net/',
    )
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
  })

  it('redirects the legacy short how URL to the current article', async () => {
    const response = await onRequest({
      request: new Request(
        'https://asv-wiki.acecore.net/article/how?source=bing',
      ),
      next: async () => new Response('not reached'),
    } as Parameters<typeof onRequest>[0])

    expect(response.status).toBe(301)
    expect(response.headers.get('Location')).toBe(
      'https://asv-wiki.acecore.net/article/howto/?source=bing',
    )
  })

  it('applies a stricter policy and no-store to the CMS surface', async () => {
    const response = await onRequest({
      request: new Request('https://asv-wiki.acecore.net/admin/index.html'),
      next: async () =>
        new Response('<!doctype html>', {
          headers: { 'Content-Type': 'text/html' },
        }),
    } as Parameters<typeof onRequest>[0])

    const policy = response.headers.get('Content-Security-Policy') || ''

    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(policy).toContain("default-src 'none'")
    expect(policy).toContain('https://unpkg.com')
    expect(policy).toContain(
      "font-src 'self' data: https://fonts.gstatic.com",
    )
    expect(policy).toContain(
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    )
    expect(policy).not.toContain('pagead2.googlesyndication.com')
  })

  it('uses a per-response strict nonce policy on public pages', async () => {
    const response = await onRequest({
      request: new Request('https://asv-wiki.acecore.net/article/rule/'),
      next: async () => new Response('wiki'),
    } as Parameters<typeof onRequest>[0])

    const policy = response.headers.get('Content-Security-Policy') || ''

    expect(policy).toMatch(/script-src 'nonce-[a-f0-9]{32}'/u)
    expect(policy).toContain("'strict-dynamic'")
    expect(policy).toContain("frame-src 'none'")
    expect(policy).not.toContain("'unsafe-eval'")
    expect(policy).not.toContain("script-src 'self' https:")
    expect(policy).not.toContain('https://unpkg.com')
    expect(response.headers.get('X-Frame-Options')).toBe('DENY')
  })

  it('keeps the public search index out of search-engine results', async () => {
    const response = await onRequest({
      request: new Request('https://asv-wiki.acecore.net/search-index.json'),
      next: async () =>
        new Response('[]', {
          headers: { 'Content-Type': 'application/json' },
        }),
    } as Parameters<typeof onRequest>[0])

    expect(response.headers.get('X-Robots-Tag')).toBe('noindex')
  })

  it('keeps the Pagefind index out of search-engine results', async () => {
    const response = await onRequest({
      request: new Request(
        'https://asv-wiki.acecore.net/pagefind/index/abcd.pf_index',
      ),
      next: async () =>
        new Response('index', {
          headers: { 'Content-Type': 'application/octet-stream' },
        }),
    } as Parameters<typeof onRequest>[0])

    expect(response.headers.get('X-Robots-Tag')).toBe('noindex')
  })

  it('keeps the Vectorize corpus out of search-engine results', async () => {
    const response = await onRequest({
      request: new Request('https://asv-wiki.acecore.net/vector-corpus.json'),
      next: async () =>
        new Response('{}', {
          headers: { 'Content-Type': 'application/json' },
        }),
    } as Parameters<typeof onRequest>[0])

    expect(response.headers.get('X-Robots-Tag')).toBe('noindex')
  })

  it('does not cache the deployment marker used by index synchronization', async () => {
    const response = await onRequest({
      request: new Request(
        'https://asv-wiki.acecore.net/.well-known/aceserver-wiki-build.json',
      ),
      next: async () =>
        new Response('{}', {
          headers: {
            'Cache-Control': 'public, max-age=3600',
            'Content-Type': 'application/json',
          },
        }),
    } as Parameters<typeof onRequest>[0])

    expect(response.headers.get('Cache-Control')).toBe('no-store')
  })
})
