import { describe, expect, it } from 'vitest'

import { onRequest } from '../functions/admin/api/refresh-session.ts'
import { CMS_PRODUCTION_HOSTNAME } from '../functions/admin/api/_cms-policy.ts'
import routesSource from '../public/_routes.json?raw'

const origin = `https://${CMS_PRODUCTION_HOSTNAME}`

describe('CMS Access session refresh', () => {
  it('clears only the host cookie from a same-origin production POST', async () => {
    const response = await onRequest({
      request: new Request(`${origin}/admin/api/refresh-session`, {
        method: 'POST',
        headers: { Origin: origin, 'Sec-Fetch-Site': 'same-origin' },
      }),
    } as Parameters<typeof onRequest>[0])

    expect(response.status).toBe(303)
    expect(response.headers.get('Location')).toBe('/admin/')
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(response.headers.get('Set-Cookie')).toBe(
      'CF_Authorization=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax',
    )
  })

  it.each([
    ['GET', origin, 'same-origin', CMS_PRODUCTION_HOSTNAME],
    ['POST', '', 'same-origin', CMS_PRODUCTION_HOSTNAME],
    ['POST', 'https://evil.example', 'cross-site', CMS_PRODUCTION_HOSTNAME],
    ['POST', origin, 'same-site', CMS_PRODUCTION_HOSTNAME],
    ['POST', origin, 'same-origin', 'preview.pages.dev'],
  ])(
    'rejects a non-production or cross-origin refresh request',
    async (method, requestOrigin, site, hostname) => {
      const response = await onRequest({
        request: new Request(
          `https://${hostname}/admin/api/refresh-session`,
          {
            method,
            headers: { Origin: requestOrigin, 'Sec-Fetch-Site': site },
          },
        ),
      } as Parameters<typeof onRequest>[0])

      expect([403, 405]).toContain(response.status)
      expect(response.headers.get('Set-Cookie')).toBeNull()
    },
  )

  it('keeps the refresh endpoint in the Pages Functions route set', () => {
    const routes = JSON.parse(routesSource) as {
      include?: string[]
      exclude?: string[]
    }

    expect(routes.include).toContain('/admin/api/refresh-session')
    expect(routes.exclude).not.toContain('/admin/api/refresh-session')
  })
})
