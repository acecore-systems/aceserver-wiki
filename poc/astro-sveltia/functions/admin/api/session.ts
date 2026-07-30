import { getAccessIdentity } from './_access-auth.ts'
import type { CmsRuntimeEnv } from './_cms-policy.ts'

export const onRequestGet: PagesFunction<CmsRuntimeEnv> = async ({
  request,
  env,
}) => {
  const auth = await getAccessIdentity(request, env)

  if (!auth.ok) {
    return json(
      {
        message: auth.message,
        reauthenticate: auth.reauthenticate === true,
      },
      auth.status,
    )
  }

  return json({
    authenticated: true,
    user: {
      id: auth.discordId,
      login: `discord-${auth.discordId}`,
      name: `Discord user ${auth.discordId}`,
    },
  })
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  })
}
