export const MEMBERSHIP_URL = 'https://wiki-membership.internal/v1/member'
export const SNOWFLAKE = /^[1-9][0-9]{16,19}$/u

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

// Bound bytes and body-read time, including peers that stall after headers.
export async function readJson(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<unknown> {
  if (!body) throw new Error('Missing body')
  const reader = body.getReader()
  let expired = false
  const timer = setTimeout(() => {
    expired = true
    void reader.cancel().catch(() => {})
  }, 8000)
  try {
    let size = 0
    const chunks: Uint8Array[] = []
    while (true) {
      const { value, done } = await reader.read()
      if (expired) throw new Error('Body timeout')
      if (done) break
      size += value.byteLength
      if (size > maxBytes) {
        await reader.cancel()
        throw new Error('Body too large')
      }
      chunks.push(value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } finally {
    clearTimeout(timer)
    reader.releaseLock()
  }
}
