// Site-owned bot credential. Never read/reuse the user's OAuth token.
export async function readDiscordMembership(guildId: string, discordId: string, botToken?: string):
  Promise<{ ok: true; roles: string[] } | { ok: false; status: number; message: string }> {
  const unavailable = { ok: false as const, status: 503, message: 'Discordの所属確認を利用できません。' }
  const denied = { ok: false as const, status: 403, message: 'このDiscordユーザーにはCMS編集権限がありません。' }
  if (!botToken?.trim()) return unavailable
  let response: Response
  try {
    response = await fetch(`https://discord.com/api/v10/guilds/${guildId}/members/${discordId}`, {
      headers: { Authorization: `Bot ${botToken}`, Accept: 'application/json' },
      redirect: 'error', signal: AbortSignal.timeout(8000),
    })
  } catch { return unavailable }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    return response.status === 404 ? denied : unavailable
  }
  // Bound the response before parsing; don't log provider errors or credentials.
  const reader = response.body?.getReader()
  if (!reader) return unavailable
  let size = 0
  const chunks: Uint8Array[] = []
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 65536) { await reader.cancel(); return unavailable }
      chunks.push(value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes))
    if (!value || typeof value !== 'object') return unavailable
    const member = value as Record<string, unknown>
    const user = member.user as Record<string, unknown> | undefined
    if (!user || user.id !== discordId || (member.pending !== undefined && typeof member.pending !== 'boolean') ||
      !Array.isArray(member.roles) || member.roles.length > 256 ||
      member.roles.some(role => typeof role !== 'string' || !/^[1-9][0-9]{16,19}$/.test(role))) return unavailable
    if (member.pending === true) return denied
    return { ok: true, roles: [...new Set(member.roles)] }
  } catch { return unavailable }
  finally { reader.releaseLock() }
}
