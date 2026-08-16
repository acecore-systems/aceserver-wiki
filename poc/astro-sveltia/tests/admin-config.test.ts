import { describe, expect, it, vi } from 'vitest'

import { onRequestGet } from '../functions/admin/config.yml.ts'
import adminIndex from '../public/admin/index.html?raw'
import adminInit from '../public/admin/init.js?raw'

const SVELTIA_CMS_SCRIPT_URL =
  'https://unpkg.com/@sveltia/cms@0.191.1/dist/sveltia-cms.js'
const SVELTIA_CMS_INTEGRITY =
  'sha384-1e+sEYxphmj/Z7BnuanO53c4BveZJ5fdJIkHSuHRO2T7jmC7Ih0BeJPK6x5XHxx6'

describe('Sveltia config delivery', () => {
  it('検証済みのSveltia CMS配布物をバージョンとSRIで固定する', () => {
    expect(adminIndex).toContain(`src="${SVELTIA_CMS_SCRIPT_URL}"`)
    expect(adminIndex).toContain(`integrity="${SVELTIA_CMS_INTEGRITY}"`)
  })

  it('CMSの公開案内で保存は直接公開、削除は管理者対応と案内する', async () => {
    expect(adminInit).toContain('保存すると自動で公開されます')
    expect(adminInit).toContain('CMSから記事・画像は削除できません')
    expect(adminInit).toContain('削除が必要な場合は管理者へ依頼してください')
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
