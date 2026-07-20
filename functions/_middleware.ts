export const onRequest = async ({ request, next }) => {
  const url = new URL(request.url)
  if (url.pathname === '/index.php') {
    url.pathname = '/'
    url.search = ''
    url.hash = ''
    return Response.redirect(url.toString(), 301)
  }

  return next()
}
