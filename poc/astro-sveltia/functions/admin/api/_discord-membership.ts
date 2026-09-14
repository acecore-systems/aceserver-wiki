import {
  isRecord,
  MEMBERSHIP_URL,
  readJson,
  SNOWFLAKE,
} from '../../../workers/discord-membership/protocol'

export async function readDiscordMembership(
  guildId: string,
  discordId: string,
  service?: Pick<Fetcher, 'fetch'>,
): Promise<
  { ok: true; roles: string[] } | { ok: false; status: number; message: string }
> {
  const unavailable = {
    ok: false as const,
    status: 503,
    message: 'Discordの所属確認を利用できません。',
  }
  const denied = {
    ok: false as const,
    status: 403,
    message: 'このDiscordユーザーにはCMS編集権限がありません。',
  }
  if (!service || !SNOWFLAKE.test(guildId) || !SNOWFLAKE.test(discordId))
    return unavailable
  try {
    const response = await service.fetch(MEMBERSHIP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ guildId, discordId }),
      redirect: 'manual',
      signal: AbortSignal.timeout(10000),
    })
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => {})
      return response.status === 403 ? denied : unavailable
    }
    const value = await readJson(response.body, 16384)
    if (
      !isRecord(value) ||
      value.ok !== true ||
      value.guildId !== guildId ||
      value.discordId !== discordId ||
      !Array.isArray(value.roles) ||
      value.roles.length > 256 ||
      value.roles.some(
        (role) => typeof role !== 'string' || !SNOWFLAKE.test(role),
      )
    )
      return unavailable
    return { ok: true, roles: [...new Set(value.roles)] }
  } catch {
    return unavailable
  }
}
