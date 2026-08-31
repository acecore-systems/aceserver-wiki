export const onRequest: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.CMS_AI) {
    return new Response(
      JSON.stringify({ message: 'CMS AIのService Bindingが未設定です。' }),
      {
        headers: {
          'Cache-Control': 'no-store',
          'Content-Type': 'application/json; charset=utf-8',
        },
        status: 503,
      },
    )
  }

  return env.CMS_AI.fetch(request)
}
