import { describe, expect, it, vi } from 'vitest'

import { onRequestGet } from '../functions/admin/config.yml.ts'
import adminInit from '../public/admin/init.js?raw'

describe('Sveltia config delivery', () => {
  it('CMSの公開案内で記事・画像削除をPull Requestへ案内する', async () => {
    expect(adminInit).toContain('記事・画像の削除は参照確認を伴うPull Request')
  })

  it('rewrites GitHub API roots to the current protected origin', async () => {
    const next = vi.fn(async (request: Request) => {
      expect(request.headers.get('If-Modified-Since')).toBeNull()
      expect(request.headers.get('If-None-Match')).toBeNull()

      return new Response(
        [
          'backend:',
          '  api_root: /admin/api/github',
          '  graphql_api_root: /admin/api/graphql',
        ].join('\n'),
        {
          headers: {
            'Content-Type': 'application/yaml',
            ETag: '"stale-config"',
          },
        },
      )
    })
    const response = await onRequestGet({
      request: new Request('https://wiki-admin.example.test/admin/config.yml', {
        headers: {
          'If-Modified-Since': 'Sun, 26 Jul 2026 00:00:00 GMT',
          'If-None-Match': '"stale-config"',
        },
      }),
      next,
    } as unknown as Parameters<typeof onRequestGet>[0])
    const config = new TextDecoder().decode(await response.arrayBuffer())

    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(response.headers.get('ETag')).toBeNull()
    expect(config).toContain(
      'api_root: https://wiki-admin.example.test/admin/api/github',
    )
    expect(config).toContain(
      'graphql_api_root: https://wiki-admin.example.test/admin/api/graphql',
    )
  })
})
