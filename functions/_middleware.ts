const LEGACY_ROOT_TITLES = new Set([
  'メインページ',
  'カテゴリ:メインサーバーについて',
])

export const onRequest = async ({ request, next }) => {
  const url = new URL(request.url)
  const queryEntries = [...url.searchParams]
  const isLegacyRoot =
    queryEntries.length === 0 ||
    (queryEntries.length === 1 &&
      queryEntries[0][0] === 'title' &&
      LEGACY_ROOT_TITLES.has(queryEntries[0][1]))

  if (url.pathname === '/index.php' && isLegacyRoot) {
    return Response.redirect(`${url.origin}/`, 301)
  }

  return next()
}
