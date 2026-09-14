import type { MembershipEnv } from './worker-configuration'
import { readDiscordMembership } from './discord'
import { isRecord, MEMBERSHIP_URL, readJson, SNOWFLAKE } from './protocol'

const json = (value: unknown, status: number) =>
  Response.json(value, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  })

// No public routes, workers.dev, or preview URLs. Service-binding-only.
// This is not a generic Discord proxy; the guild is fixed by Worker config.
export default {
  async fetch(request: Request, env: MembershipEnv): Promise<Response> {
    if (request.url !== MEMBERSHIP_URL || request.method !== 'POST')
      return json({ ok: false }, 404)
    if (request.headers.get('Content-Type') !== 'application/json')
      return json({ ok: false }, 400)
    let input: unknown
    try {
      input = await readJson(request.body, 1024)
    } catch {
      return json({ ok: false }, 400)
    }
    if (
      !isRecord(input) ||
      typeof input.discordId !== 'string' ||
      !SNOWFLAKE.test(input.discordId) ||
      input.guildId !== env.WIKI_GUILD_ID ||
      !SNOWFLAKE.test(env.WIKI_GUILD_ID)
    )
      return json({ ok: false }, 400)
    try {
      // Read each request; no credential cache delaying rotations.
      const token = await env.DISCORD_BOT_TOKEN.get()
      const membership = await readDiscordMembership(
        env.WIKI_GUILD_ID,
        input.discordId,
        token,
      )
      if (!membership.ok) return json({ ok: false }, membership.status)
      return json(
        {
          ok: true,
          guildId: env.WIKI_GUILD_ID,
          discordId: input.discordId,
          roles: membership.roles,
        },
        200,
      )
    } catch {
      // Never log token values, provider responses, or identities.
      return json({ ok: false }, 503)
    }
  },
} satisfies ExportedHandler<MembershipEnv>
