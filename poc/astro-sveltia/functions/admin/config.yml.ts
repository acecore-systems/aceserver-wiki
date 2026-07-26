export const onRequestGet: PagesFunction<Env> = async ({ request, next }) => {
  const response = await next()

  if (!response.ok) {
    return response
  }

  const origin = new URL(request.url).origin
  const source = new TextDecoder().decode(await response.arrayBuffer())
  const config = source
    .replace(/^(\s*api_root:\s*).+$/m, `$1${origin}/admin/api/github`)
    .replace(/^(\s*graphql_api_root:\s*).+$/m, `$1${origin}/admin/api/graphql`)

  return new Response(config, {
    status: response.status,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/yaml; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
