import { describe, expect, it } from 'vitest'

import { onRequestGet } from '../functions/admin/config.yml.ts'

describe('Sveltia config delivery', () => {
  it('rewrites GitHub API roots to the current protected origin', async () => {
    const response = await onRequestGet({
      request: new Request('https://wiki-admin.example.test/admin/config.yml'),
      next: async () =>
        new Response(
          [
            'backend:',
            '  api_root: /admin/api/github',
            '  graphql_api_root: /admin/api/graphql',
          ].join('\n'),
          {
            headers: { 'Content-Type': 'application/yaml' },
          },
        ),
    } as Parameters<typeof onRequestGet>[0])
    const config = new TextDecoder().decode(await response.arrayBuffer())

    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(config).toContain(
      'api_root: https://wiki-admin.example.test/admin/api/github',
    )
    expect(config).toContain(
      'graphql_api_root: https://wiki-admin.example.test/admin/api/graphql',
    )
  })
})
