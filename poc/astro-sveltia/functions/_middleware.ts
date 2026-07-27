const LEGACY_ROOT_TITLES = new Set([
  'メインページ',
  'カテゴリ:メインサーバーについて',
])

const LEGACY_ARTICLE_REDIRECTS = new Map([
  ['/article/SurvivalRules', '/article/rule/'],
  ['/article/SurvivalRules/', '/article/rule/'],
])

const ADMIN_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "base-uri 'none'",
  "connect-src 'self'",
  "font-src 'self' data:",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "img-src 'self' data: blob:",
  "manifest-src 'self'",
  "media-src 'self' blob:",
  "object-src 'none'",
  "script-src 'self' https://unpkg.com",
  "style-src 'self' 'unsafe-inline'",
  "worker-src 'self' blob:",
].join('; ')

const PUBLIC_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "connect-src 'self' https://*.doubleclick.net https://*.google.com https://*.googlesyndication.com",
  "font-src 'self' data:",
  "form-action 'self'",
  "frame-ancestors 'none'",
  'frame-src https://*.doubleclick.net https://*.google.com https://*.googlesyndication.com',
  "img-src 'self' data: blob: https:",
  "object-src 'none'",
  "script-src 'self' https://pagead2.googlesyndication.com https://*.googlesyndication.com",
  "style-src 'self' 'unsafe-inline'",
  'upgrade-insecure-requests',
].join('; ')

export const onRequest: PagesFunction = async ({ next, request }) => {
  const url = new URL(request.url)
  const redirect = getLegacyRedirect(url)
  const response = redirect
    ? Response.redirect(new URL(redirect, url.origin), 301)
    : await next()

  return withSecurityHeaders(response, url)
}

function getLegacyRedirect(url: URL) {
  const queryEntries = [...url.searchParams]
  const isLegacyRoot =
    queryEntries.length === 0 ||
    (queryEntries.length === 1 &&
      queryEntries[0][0] === 'title' &&
      LEGACY_ROOT_TITLES.has(queryEntries[0][1]))

  if (url.pathname === '/index.php' && isLegacyRoot) return '/'

  return LEGACY_ARTICLE_REDIRECTS.get(url.pathname) ?? null
}

function withSecurityHeaders(response: Response, url: URL) {
  const headers = new Headers(response.headers)
  const isAdmin =
    url.pathname === '/admin' || url.pathname.startsWith('/admin/')

  headers.set(
    'Content-Security-Policy',
    isAdmin ? ADMIN_CONTENT_SECURITY_POLICY : PUBLIC_CONTENT_SECURITY_POLICY,
  )
  headers.set('Cross-Origin-Opener-Policy', 'same-origin')
  headers.set('Cross-Origin-Resource-Policy', 'same-site')
  headers.set('Permissions-Policy', buildPermissionsPolicy())
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin')
  headers.set('X-Content-Type-Options', 'nosniff')
  headers.set('X-DNS-Prefetch-Control', 'off')
  headers.set('X-Frame-Options', 'DENY')

  if (url.protocol === 'https:') {
    headers.set(
      'Strict-Transport-Security',
      'max-age=31536000; includeSubDomains',
    )
  }

  if (isAdmin) headers.set('Cache-Control', 'no-store')

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

function buildPermissionsPolicy() {
  return [
    'accelerometer=()',
    'camera=()',
    'geolocation=()',
    'gyroscope=()',
    'microphone=()',
    'payment=()',
    'usb=()',
  ].join(', ')
}
