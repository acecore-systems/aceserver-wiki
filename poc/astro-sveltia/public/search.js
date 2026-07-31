;(() => {
  const LOCAL_SEARCH_TIMEOUT_MS = 5_000
  const NETWORK_SEARCH_TIMEOUT_MS = 3_500
  const PAGEFIND_TIMEOUT_MS = 3_500
  const MAX_RESULT_COUNT = 5
  const MAX_PATH_DECODE_PASSES = 4
  const MAX_URL_LENGTH = 500
  const CANONICAL_PATH_ORIGIN = 'https://url-validation.invalid'
  const REQUEST_ID_PATTERN =
    /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/iu

  const runSearch = async () => {
    const queryInput = document.querySelector('#search-query')
    const status = document.querySelector('.search-status')
    const localSection = document.querySelector('[data-local-search-results]')
    const localList = document.querySelector('[data-local-search-list]')
    const query = normalizeQuery(
      new URLSearchParams(window.location.search).get('q'),
    )

    if (queryInput && !queryInput.value) queryInput.value = query
    if (!query || !status || !localSection || !localList) return

    status.textContent = '意味が近いWIKIの記事を検索しています…'
    const semanticResults = await loadSemanticResults(query)
    const localResults =
      semanticResults.length > 0
        ? semanticResults
        : await loadPagefindResults(query)

    appendResults(localList, localResults)
    if (localResults.length > 0) {
      localSection.hidden = false
      status.textContent = ''
    } else {
      status.textContent = '一致する公開記事は見つかりませんでした。'
    }

    void loadNetworkResults(query)
  }

  void runSearch()

  async function loadSemanticResults(query) {
    const controller = new AbortController()
    const timeout = window.setTimeout(
      () => controller.abort(),
      LOCAL_SEARCH_TIMEOUT_MS,
    )

    try {
      const response = await fetch('/api/search', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-Acecore-Search-Client': getSearchClientId(),
        },
        body: JSON.stringify({ query }),
        signal: controller.signal,
      })

      if (!response.ok) return []
      return normalizeLocalResults(await response.json())
    } catch {
      return []
    } finally {
      window.clearTimeout(timeout)
    }
  }

  async function loadPagefindResults(query) {
    try {
      const pagefind = await withTimeout(
        import('/pagefind/pagefind.js'),
        PAGEFIND_TIMEOUT_MS,
      )
      const search = await withTimeout(
        pagefind.search(query),
        PAGEFIND_TIMEOUT_MS,
      )
      const entries = await Promise.all(
        search.results
          .slice(0, MAX_RESULT_COUNT)
          .map((result) => withTimeout(result.data(), PAGEFIND_TIMEOUT_MS)),
      )

      return entries
        .map((entry, index) => normalizePagefindResult(entry, index + 1))
        .filter(Boolean)
    } catch {
      return []
    }
  }

  async function loadNetworkResults(query) {
    const section = document.querySelector('[data-network-search-results]')
    const list = document.querySelector('[data-network-search-list]')
    if (!section || !list) return

    const controller = new AbortController()
    const timeout = window.setTimeout(
      () => controller.abort(),
      NETWORK_SEARCH_TIMEOUT_MS,
    )

    try {
      const response = await fetch('https://acecore.net/api/network-search', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query, locale: 'ja' }),
        signal: controller.signal,
      })
      if (!response.ok) return

      const { normalizeNetworkSearchResults } =
        await import('/search-contract.js')
      const results = normalizeNetworkSearchResults(
        await response.json(),
        'wiki',
      )
      if (results.length === 0) return

      appendResults(list, results, true)
      section.hidden = false
    } catch {
      // Related sites must never delay or replace the local WIKI results.
    } finally {
      window.clearTimeout(timeout)
    }
  }

  function normalizeLocalResults(payload) {
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
      const result = normalizeLocalResult(value, results.length + 1)
      if (!result || seenUrls.has(result.url)) continue

      seenUrls.add(result.url)
      results.push(result)
      if (results.length >= MAX_RESULT_COUNT) break
    }

    return results
  }

  function normalizeLocalResult(value, fallbackRank) {
    if (!isRecord(value)) return null

    const title = readText(value.title, 240)
    const section = readText(value.section, 240) || title
    const excerpt = readText(value.excerpt, 500)
    const url = normalizeLocalUrl(value.url)
    const rank = normalizeRank(value.rank, fallbackRank)
    if (!title || !excerpt || !url || !rank) return null

    return { title, section, excerpt, url, rank }
  }

  function normalizePagefindResult(value, rank) {
    if (!isRecord(value) || !isRecord(value.meta)) return null

    const title = readPagefindText(value.meta.title, 240)
    const excerpt = readPagefindText(value.excerpt, 500)
    const url = normalizeLocalUrl(value.url)
    if (!title || !excerpt || !url) return null

    return { title, section: title, excerpt, url, rank }
  }

  function normalizeLocalUrl(value) {
    return getSafePublicPathname(value)
  }

  function getSafePublicPathname(value) {
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
    if (hasUnsafePathSyntax(pathname) || pathname.includes('%')) return null

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

  function normalizeRank(value, fallbackRank) {
    if (value === undefined && fallbackRank > 0) return fallbackRank
    return Number.isSafeInteger(value) && value > 0 && value <= 100
      ? value
      : null
  }

  function isStrictRequestId(value) {
    return typeof value === 'string' && REQUEST_ID_PATTERN.test(value)
  }

  function normalizeQuery(value) {
    return readText(value, 160)
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

  function readPagefindText(value, maximumLength) {
    return readText(
      typeof value === 'string' ? value.replace(/<[^>]*>/gu, ' ') : value,
      maximumLength,
    )
  }

  function isRecord(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
  }

  function appendResults(list, results, includeSource = false) {
    for (const result of results) {
      const listItem = document.createElement('li')
      const link = document.createElement('a')
      const excerpt = document.createElement('p')

      link.href = result.url
      link.textContent = result.title
      excerpt.textContent = result.excerpt
      listItem.appendChild(link)

      if (includeSource && result.sourceLabel) {
        const source = document.createElement('span')
        source.className = 'search-results__source'
        source.textContent = result.sourceLabel
        listItem.appendChild(source)
      }

      listItem.appendChild(excerpt)
      list.appendChild(listItem)
    }
  }

  function getSearchClientId() {
    const storageKey = 'acecore-search-client'

    try {
      const current = window.localStorage.getItem(storageKey)
      if (current) return current

      const created = crypto.randomUUID()
      window.localStorage.setItem(storageKey, created)
      return created
    } catch {
      return crypto.randomUUID()
    }
  }

  function withTimeout(promise, milliseconds) {
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        reject(new Error('SearchTimeoutError'))
      }, milliseconds)

      promise.then(
        (value) => {
          window.clearTimeout(timeout)
          resolve(value)
        },
        (error) => {
          window.clearTimeout(timeout)
          reject(error)
        },
      )
    })
  }
})()
