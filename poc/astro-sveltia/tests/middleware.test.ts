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
    expect(policy).not.toContain('pagead2.googlesyndication.com')
  })

  it('allows only the public advertising script hosts on wiki pages', async () => {
    const response = await onRequest({
      request: new Request('https://asv-wiki.acecore.net/article/rule/'),
      next: async () => new Response('wiki'),
    } as Parameters<typeof onRequest>[0])

    const policy = response.headers.get('Content-Security-Policy') || ''

    expect(policy).toContain('pagead2.googlesyndication.com')
    expect(policy).not.toContain('https://unpkg.com')
    expect(response.headers.get('X-Frame-Options')).toBe('DENY')
  })
})
