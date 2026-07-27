const MAX_FORM_BYTES = 16 * 1024
const MAX_PROVIDER_RESPONSE_BYTES = 32 * 1024

const securityHeaders = {
  'Content-Security-Policy':
    "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy':
    'camera=(), geolocation=(), microphone=(), payment=(), usb=()',
  'Referrer-Policy': 'no-referrer',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
} as const

export function withSecurityHeaders(
  response: Response,
  cacheControl = 'no-store',
): Response {
  const headers = new Headers(response.headers)
  headers.set('Cache-Control', cacheControl)
  for (const [name, value] of Object.entries(securityHeaders)) {
    headers.set(name, value)
  }
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  })
}

export function jsonResponse(
  body: Record<string, unknown>,
  init: ResponseInit = {},
  cacheControl = 'no-store',
): Response {
  const headers = new Headers(init.headers)
  headers.set('Content-Type', 'application/json; charset=utf-8')
  return withSecurityHeaders(
    new Response(JSON.stringify(body), { ...init, headers }),
    cacheControl,
  )
}

export function oauthError(
  status: number,
  error: string,
  description: string,
): Response {
  return jsonResponse(
    { error, error_description: description },
    {
      headers: { Pragma: 'no-cache' },
      status,
    },
  )
}

export function redirectResponse(location: string): Response {
  return withSecurityHeaders(
    new Response(null, {
      headers: { Location: location, Pragma: 'no-cache' },
      status: 303,
    }),
  )
}

export function redirectOAuthError(
  redirectUri: string,
  state: string,
  error: string,
): Response {
  const target = new URL(redirectUri)
  target.searchParams.set('error', error)
  target.searchParams.set('state', state)
  return redirectResponse(target.toString())
}

function parseContentLength(headers: Headers): number | null {
  const raw = headers.get('Content-Length')
  if (raw === null) {
    return null
  }
  if (!/^\d{1,10}$/u.test(raw)) {
    throw new Error('invalid_content_length')
  }
  return Number(raw)
}

async function readStreamLimited(
  stream: ReadableStream<Uint8Array> | null,
  declaredLength: number | null,
  maximumBytes: number,
): Promise<Uint8Array> {
  if (declaredLength !== null && declaredLength > maximumBytes) {
    throw new Error('body_too_large')
  }
  if (stream === null) {
    return new Uint8Array()
  }

  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let byteLength = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      byteLength += value.byteLength
      if (byteLength > maximumBytes) {
        await reader.cancel('body_too_large')
        throw new Error('body_too_large')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const output = new Uint8Array(byteLength)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }
  return output
}

function requireFormContentType(headers: Headers): void {
  const contentType = headers.get('Content-Type')
  if (
    contentType === null ||
    contentType.split(';', 1)[0].trim().toLowerCase() !==
      'application/x-www-form-urlencoded'
  ) {
    throw new Error('invalid_content_type')
  }
}

export async function readFormBody(request: Request): Promise<URLSearchParams> {
  requireFormContentType(request.headers)
  const bytes = await readStreamLimited(
    request.body,
    parseContentLength(request.headers),
    MAX_FORM_BYTES,
  )
  return new URLSearchParams(new TextDecoder().decode(bytes))
}

export async function readProviderJson(response: Response): Promise<unknown> {
  const bytes = await readStreamLimited(
    response.body,
    parseContentLength(response.headers),
    MAX_PROVIDER_RESPONSE_BYTES,
  )
  const text = new TextDecoder().decode(bytes)
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new Error('invalid_provider_response')
  }
}

export function hasDuplicateParameters(parameters: URLSearchParams): boolean {
  const names = new Set<string>()
  for (const name of parameters.keys()) {
    if (names.has(name)) {
      return true
    }
    names.add(name)
  }
  return false
}
