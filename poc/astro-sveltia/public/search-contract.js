const MAX_NETWORK_RESULT_COUNT = 3
const MAX_PATH_DECODE_PASSES = 4
const MAX_URL_LENGTH = 500
const CANONICAL_PATH_ORIGIN = 'https://url-validation.invalid'
const REQUEST_ID_PATTERN =
  /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/iu

const NETWORK_SOURCES = Object.freeze({
  acecore: {
    label: 'Acecore',
    origin: 'https://acecore.net',
  },
  systems: {
    label: 'Acecore Systems',
    origin: 'https://systems.acecore.net',
  },
  schools: {
    label: 'Acecore Schools',
    origin: 'https://schools.acecore.net',
  },
  wiki: {
    label: 'Aceserver WIKI',
    origin: 'https://asv-wiki.acecore.net',
  },
  portal: {
    label: 'Aceserver Portal',
    origin: 'https://asv.acecore.net',
  },
  'world-foundation': {
    label: 'World Foundation',
    origin: 'https://world-foundation.acecore.net',
  },
})

export function normalizeNetworkSearchResults(payload, ownSource) {
  if (
    !isRecord(payload) ||
    payload.ok !== true ||
    !isStrictRequestId(payload.requestId) ||
    !Array.isArray(payload.results)
  ) {
    return []
  }

  const results = []
  const seenUrls = new Set()

  for (const value of payload.results) {
    if (!isRecord(value)) continue

    const source = readText(value.source, 40)
    const sourceConfig = Object.prototype.hasOwnProperty.call(
      NETWORK_SOURCES,
      source,
    )
      ? NETWORK_SOURCES[source]
      : undefined
    const title = readText(value.title, 240)
    const section = readText(value.section, 240) || title
    const excerpt = readText(value.excerpt, 500)
    const sourceLabel = readText(value.sourceLabel, 80)
    const rank = normalizeRank(value.rank)
    const url = normalizeNetworkUrl(value.url, source, sourceConfig?.origin)

    if (
      !sourceConfig ||
      source === ownSource ||
      sourceLabel !== sourceConfig.label ||
      !title ||
      !excerpt ||
      !rank ||
      !url ||
      seenUrls.has(url)
    ) {
      continue
    }

    seenUrls.add(url)
    results.push({ title, section, excerpt, url, rank, sourceLabel })
  }

  return results
    .sort((left, right) => left.rank - right.rank)
    .slice(0, MAX_NETWORK_RESULT_COUNT)
}

function normalizeNetworkUrl(value, source, allowedOrigin) {
  const rawUrl = getRawUrl(value)
  if (!rawUrl || !allowedOrigin) return null

  const canonicalPrefix = allowedOrigin + '/'
  if (!rawUrl.startsWith(canonicalPrefix)) return null

  const pathname = getSafePublicPathname(rawUrl.slice(allowedOrigin.length))
  if (!pathname || !isPublicNetworkPath(source, pathname)) return null

  try {
    const url = new URL(pathname, allowedOrigin)
    return url.origin === allowedOrigin && !url.search && !url.hash
      ? url.href
      : null
  } catch {
    return null
  }
}

function isPublicNetworkPath(source, pathname) {
  if (source === 'wiki') {
    return pathname.startsWith('/article/')
  }

  if (source === 'portal') {
    return ![
      '/vector-corpus.json',
      '/404',
      '/404/',
      '/404.html',
      '/404.html/',
    ].includes(pathname)
  }

  return true
}

export function getSafePublicPathname(value) {
  const rawPathname = getRawUrl(value)
  if (
    !rawPathname ||
    !rawPathname.startsWith('/') ||
    rawPathname.startsWith('//')
  ) {
    return null
  }

  let pathname = rawPathname
  for (let pass = 0; pass < MAX_PATH_DECODE_PASSES; pass += 1) {
    pathname = pathname.normalize('NFKC')
    if (hasUnsafePathSyntax(pathname)) return null
    if (!pathname.includes('%')) break
    if (/%(?:2f|5c)/iu.test(pathname)) return null

    try {
      pathname = decodeURIComponent(pathname)
    } catch {
      return null
    }
  }

  pathname = pathname.normalize('NFKC')
  if (hasUnsafePathSyntax(pathname) || pathname.includes('%')) {
    return null
  }

  try {
    const url = new URL(pathname, CANONICAL_PATH_ORIGIN)
    return url.origin === CANONICAL_PATH_ORIGIN && !url.search && !url.hash
      ? url.pathname
      : null
  } catch {
    return null
  }
}

function getRawUrl(value) {
  if (
    typeof value !== 'string' ||
    !value ||
    [...value].length > MAX_URL_LENGTH
  ) {
    return null
  }

  const rawUrl = value.normalize('NFKC')
  if (
    !rawUrl ||
    [...rawUrl].length > MAX_URL_LENGTH ||
    /[\s\u0000-\u001F\u007F]/u.test(rawUrl) ||
    rawUrl.includes('\\') ||
    rawUrl.includes('?') ||
    rawUrl.includes('#') ||
    /[<>"']/u.test(rawUrl)
  ) {
    return null
  }

  return rawUrl
}

function hasUnsafePathSyntax(pathname) {
  if (
    !pathname.startsWith('/') ||
    pathname.includes('//') ||
    pathname.includes('\\') ||
    pathname.includes('?') ||
    pathname.includes('#') ||
    /[\s\u0000-\u001F\u007F]/u.test(pathname) ||
    pathname.split('/').some((segment) => segment === '.' || segment === '..')
  ) {
    return true
  }

  const firstSegment = pathname.split('/')[1]?.toLowerCase()
  return firstSegment === 'admin' || firstSegment === 'api'
}

function normalizeRank(value) {
  return Number.isSafeInteger(value) &&
    value > 0 &&
    value <= MAX_NETWORK_RESULT_COUNT
    ? value
    : null
}

function isStrictRequestId(value) {
  return typeof value === 'string' && REQUEST_ID_PATTERN.test(value)
}

function readText(value, maximumLength) {
  return typeof value === 'string'
    ? value
        .normalize('NFKC')
        .replace(/\s+/gu, ' ')
        .trim()
        .slice(0, maximumLength)
    : ''
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
