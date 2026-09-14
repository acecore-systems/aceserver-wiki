// Worker-only provider call. The credential never crosses the service binding.
import { isRecord, readJson } from './protocol'
export async function readDiscordMembership(
  guildId: string,
  discordId: string,
  botToken?: string,
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
  if (!botToken?.trim()) return unavailable
  let response: Response
  try {
    response = await fetch(
      `https://discord.com/api/v10/guilds/${guildId}/members/${discordId}`,
      {
        headers: {
          Authorization: `Bot ${botToken}`,
          Accept: 'application/json',
        },
        redirect: 'manual',
        signal: AbortSignal.timeout(8000),
      },
    )
  } catch {
    return unavailable
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    return response.status === 404 ? denied : unavailable
  }
  // Bound the response before parsing; don't log provider errors or credentials.
  try {
    const member = await readJson(response.body, 65536)
    if (!isRecord(member)) return unavailable
    const user = member.user
    if (
      !isRecord(user) ||
      user.id !== discordId ||
      (member.pending !== undefined && typeof member.pending !== 'boolean') ||
      !Array.isArray(member.roles) ||
      member.roles.length > 256 ||
      member.roles.some(
        (role) => typeof role !== 'string' || !/^[1-9][0-9]{16,19}$/.test(role),
      )
    )
      return unavailable
    if (member.pending === true) return denied
    return { ok: true, roles: [...new Set(member.roles)] }
  } catch {
    return unavailable
  }
}
