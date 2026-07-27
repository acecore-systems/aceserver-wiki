import { ARTICLE_REDIRECTS } from '../src/config/wiki'

const LEGACY_ROOT_TITLES = new Set([
  'メインページ',
  'カテゴリ:メインサーバーについて',
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

const CSP_NONCE_PLACEHOLDER = '__CSP_NONCE__'

export const onRequest: PagesFunction = async ({ next, request }) => {
  const url = new URL(request.url)
  const redirect = getLegacyRedirect(url)
  const response = redirect
    ? Response.redirect(new URL(redirect, url.origin), 301)
    : await next(withoutHtmlConditionalHeaders(request, url))

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

  let decodedPath: string

  try {
    decodedPath = decodeURIComponent(url.pathname).normalize('NFC')
  } catch {
    return null
  }

  const redirectPath = ARTICLE_REDIRECTS.get(decodedPath)

  if (!redirectPath) return null

  const destination = new URL(redirectPath, url.origin)
  destination.search = url.search

  return `${destination.pathname}${destination.search}`
}

async function withSecurityHeaders(response: Response, url: URL) {
  const headers = new Headers(response.headers)
  const isAdmin =
    url.pathname === '/admin' || url.pathname.startsWith('/admin/')
  const nonce = createNonce()

  headers.set(
    'Content-Security-Policy',
    isAdmin
      ? ADMIN_CONTENT_SECURITY_POLICY
      : buildPublicContentSecurityPolicy(nonce),
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

  let body: BodyInit | null = response.body
  const isPublicHtml =
    !isAdmin && headers.get('Content-Type')?.toLowerCase().includes('text/html')

  if (isPublicHtml) {
    headers.delete('Content-Length')
    headers.delete('ETag')
    headers.delete('Last-Modified')
    headers.set('Cache-Control', 'no-store')

    if (response.body) {
      const html = await response.text()
      body = html.replaceAll(
        `nonce="${CSP_NONCE_PLACEHOLDER}"`,
        `nonce="${nonce}"`,
      )
    }
  }

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

function withoutHtmlConditionalHeaders(request: Request, url: URL) {
  if (
    (request.method !== 'GET' && request.method !== 'HEAD') ||
    !isLikelyHtmlPath(url.pathname)
  ) {
    return request
  }

  const headers = new Headers(request.headers)
  headers.delete('If-Modified-Since')
  headers.delete('If-None-Match')

  return new Request(request, { headers })
}

function isLikelyHtmlPath(pathname: string) {
  if (
    pathname === '/' ||
    pathname.endsWith('/') ||
    pathname.endsWith('.html')
  ) {
    return true
  }

  const lastSegment = pathname.slice(pathname.lastIndexOf('/') + 1)
  return !lastSegment.includes('.')
}

function buildPublicContentSecurityPolicy(nonce: string) {
  return [
    "default-src 'self'",
    "base-uri 'none'",
    "connect-src 'self'",
    "font-src 'self' data:",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "frame-src 'none'",
    "img-src 'self' data: blob:",
    "object-src 'none'",
    `script-src 'nonce-${nonce}' 'strict-dynamic' 'self'`,
    "style-src 'self' 'unsafe-inline'",
    'upgrade-insecure-requests',
  ].join('; ')
}

function createNonce() {
  return crypto.randomUUID().replaceAll('-', '')
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
