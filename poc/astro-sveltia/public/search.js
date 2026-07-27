;(() => {
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
      const response = await fetch('/search-index.json', {
        headers: { Accept: 'application/json' },
      })

      if (!response.ok) throw new Error(`Search index: ${response.status}`)

      const items = await response.json()
      const normalizedQuery = query.toLocaleLowerCase('ja-JP')
      const matches = items.filter((item) =>
        `${item.title}\n${item.text}`
          .toLocaleLowerCase('ja-JP')
          .includes(normalizedQuery),
      )

      status.textContent = `${matches.length}件の記事が見つかりました。`

      for (const item of matches) {
        const listItem = document.createElement('li')
        const link = document.createElement('a')
        const excerpt = document.createElement('p')
        const normalizedText = item.text.toLocaleLowerCase('ja-JP')
        const matchIndex = normalizedText.indexOf(normalizedQuery)
        const excerptStart = Math.max(0, matchIndex - 45)
        const excerptEnd = Math.min(
          item.text.length,
          Math.max(matchIndex + query.length + 75, excerptStart + 120),
        )

        link.href = item.url
        link.textContent = item.title
        excerpt.textContent = `${excerptStart > 0 ? '…' : ''}${item.text.slice(
          excerptStart,
          excerptEnd,
        )}${excerptEnd < item.text.length ? '…' : ''}`
        listItem.appendChild(link)
        listItem.appendChild(excerpt)
        results.appendChild(listItem)
      }
    } catch {
      status.textContent =
        '検索データを読み込めませんでした。時間をおいて再度お試しください。'
    }
  }

  void runSearch()
})()
