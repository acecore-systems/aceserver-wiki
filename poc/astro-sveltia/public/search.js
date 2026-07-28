;(() => {
  const SEMANTIC_TIMEOUT_MS = 1800

  const runSearch = async () => {
    const queryInput = document.querySelector('#search-query')
    const status = document.querySelector('.search-status')
    const results = document.querySelector('.search-results')
    const query =
      new URLSearchParams(window.location.search).get('q')?.trim() ?? ''

    if (queryInput && !queryInput.value) queryInput.value = query
    if (!query || !status || !results) return

    status.textContent = '検索しています…'

    try {
      const items = await loadKeywordIndex()
      const normalizedQuery = query.toLocaleLowerCase('ja-JP')
      const matches = items.filter((item) =>
        `${item.title}\n${item.text}`
          .toLocaleLowerCase('ja-JP')
          .includes(normalizedQuery),
      )

      status.textContent = `${matches.length}件の記事が見つかりました。`

      for (const item of matches) {
        const normalizedText = item.text.toLocaleLowerCase('ja-JP')
        const matchIndex = normalizedText.indexOf(normalizedQuery)
        const excerptStart = Math.max(0, matchIndex - 45)
        const excerptEnd = Math.min(
          item.text.length,
          Math.max(matchIndex + query.length + 75, excerptStart + 120),
        )
        appendResult(results, {
          ...item,
          excerpt: `${excerptStart > 0 ? '…' : ''}${item.text.slice(
            excerptStart,
            excerptEnd,
          )}${excerptEnd < item.text.length ? '…' : ''}`,
        })
      }

      const semanticResults = await loadSemanticResults(query)
      const seenUrls = new Set(matches.map(({ url }) => url))
      const related = semanticResults.filter(({ url }) => {
        if (seenUrls.has(url)) return false
        seenUrls.add(url)
        return true
      })

      for (const item of related) {
        appendResult(results, item, true)
      }

      if (related.length > 0) {
        status.textContent =
          matches.length > 0
            ? `${matches.length}件の記事と${related.length}件の関連候補が見つかりました。`
            : `${related.length}件の関連候補が見つかりました。`
      }
    } catch {
      status.textContent =
        '検索データを読み込めませんでした。時間をおいて再度お試しください。'
    }
  }

  void runSearch()

  async function loadKeywordIndex() {
    const response = await fetch('/search-index.json', {
      headers: { Accept: 'application/json' },
    })

    if (!response.ok) throw new Error(`Search index: ${response.status}`)

    return response.json()
  }

  async function loadSemanticResults(query) {
    const length = [...query.normalize('NFKC')].length
    if (length < 2 || length > 160) return []

    const controller = new AbortController()
    const timeout = window.setTimeout(
      () => controller.abort(),
      SEMANTIC_TIMEOUT_MS,
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

      const payload = await response.json()
      return payload?.ok && Array.isArray(payload.results)
        ? payload.results
        : []
    } catch {
      return []
    } finally {
      window.clearTimeout(timeout)
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

  function appendResult(results, item, related = false) {
    const listItem = document.createElement('li')
    const link = document.createElement('a')
    const excerpt = document.createElement('p')

    link.href = item.url
    link.textContent = item.title
    excerpt.textContent = item.excerpt
    listItem.appendChild(link)

    if (related) {
      const badge = document.createElement('span')
      badge.className = 'search-results__related'
      badge.textContent = '関連'
      listItem.appendChild(badge)
    }

    listItem.appendChild(excerpt)
    results.appendChild(listItem)
  }
})()
