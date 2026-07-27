const textEncoder = new TextEncoder()

export function encodeBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }

  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '')
}

function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/')
  const binary = atob(
    normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='),
  )
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

function decodeBase64UrlUnsignedInteger(value: string): bigint {
  const bytes = decodeBase64Url(value)
  if (bytes.length === 0 || bytes[0] === 0) {
    throw new Error('invalid_unsigned_integer')
  }

  let result = 0n
  for (const byte of bytes) {
    result = (result << 8n) | BigInt(byte)
  }
  return result
}

function rsaModulusBitLength(modulus: string): number {
  const bytes = decodeBase64Url(modulus)
  if (bytes.length === 0 || bytes[0] === 0) {
    return 0
  }

  return (bytes.length - 1) * 8 + (32 - Math.clz32(bytes[0]))
}

export function randomToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength)
  crypto.getRandomValues(bytes)
  return encodeBase64Url(bytes)
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', textEncoder.encode(value)),
  )

  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  )
}

export async function hmacSha256Hex(
  key: string,
  value: string,
): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    textEncoder.encode(key),
    { hash: 'SHA-256', name: 'HMAC' },
    false,
    ['sign'],
  )
  const digest = new Uint8Array(
    await crypto.subtle.sign('HMAC', cryptoKey, textEncoder.encode(value)),
  )

  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  )
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', textEncoder.encode(verifier)),
  )
  return encodeBase64Url(digest)
}

export async function timingSafeTextEqual(
  provided: string,
  expected: string,
): Promise<boolean> {
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', textEncoder.encode(provided)),
    crypto.subtle.digest('SHA-256', textEncoder.encode(expected)),
  ])

  return crypto.subtle.timingSafeEqual(providedHash, expectedHash)
}

function decodePemBody(pem: string): ArrayBuffer {
  const match = pem
    .trim()
    .match(
      /^-----BEGIN PRIVATE KEY-----\s+([A-Za-z0-9+/=\s]+)\s+-----END PRIVATE KEY-----$/u,
    )
  if (!match) {
    throw new Error('invalid_signing_private_key')
  }

  const binary = atob(match[1].replace(/\s+/gu, ''))
  return Uint8Array.from(binary, (character) => character.charCodeAt(0)).buffer
}

export type PublicSigningJwk = JsonWebKey & {
  alg: 'RS256'
  e: string
  kid: string
  kty: 'RSA'
  n: string
  use: 'sig'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parsePublicSigningJwk(raw: string): PublicSigningJwk {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('invalid_signing_public_jwk')
  }

  if (!isRecord(parsed)) {
    throw new Error('invalid_signing_public_jwk')
  }

  let exponent: bigint
  let modulusBits: number
  try {
    if (
      typeof parsed.e !== 'string' ||
      !/^[A-Za-z0-9_-]{2,16}$/u.test(parsed.e) ||
      typeof parsed.n !== 'string' ||
      !/^[A-Za-z0-9_-]{256,1366}$/u.test(parsed.n)
    ) {
      throw new Error('invalid_rsa_parameter')
    }
    exponent = decodeBase64UrlUnsignedInteger(parsed.e)
    modulusBits = rsaModulusBitLength(parsed.n)
  } catch {
    throw new Error('invalid_signing_public_jwk')
  }

  if (
    ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth'].some((name) => name in parsed) ||
    parsed.kty !== 'RSA' ||
    parsed.alg !== 'RS256' ||
    parsed.use !== 'sig' ||
    typeof parsed.kid !== 'string' ||
    !/^[A-Za-z0-9._~-]{1,128}$/u.test(parsed.kid) ||
    modulusBits < 2048 ||
    modulusBits > 8192 ||
    exponent < 3n ||
    exponent > 0xffffffffn ||
    exponent % 2n === 0n ||
    ('ext' in parsed && parsed.ext !== true) ||
    ('key_ops' in parsed &&
      (!Array.isArray(parsed.key_ops) ||
        parsed.key_ops.length !== 1 ||
        parsed.key_ops[0] !== 'verify'))
  ) {
    throw new Error('invalid_signing_public_jwk')
  }

  return {
    alg: 'RS256',
    e: parsed.e,
    ext: true,
    key_ops: ['verify'],
    kid: parsed.kid,
    kty: 'RSA',
    n: parsed.n,
    use: 'sig',
  }
}

async function importSigningKeys(
  privateKeyPem: string,
  publicJwk: PublicSigningJwk,
): Promise<{ privateKey: CryptoKey; publicKey: CryptoKey }> {
  const [privateKey, publicKey] = await Promise.all([
    crypto.subtle.importKey(
      'pkcs8',
      decodePemBody(privateKeyPem),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign'],
    ),
    crypto.subtle.importKey(
      'jwk',
      publicJwk,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    ),
  ])
  if (
    !('modulusLength' in privateKey.algorithm) ||
    typeof privateKey.algorithm.modulusLength !== 'number' ||
    privateKey.algorithm.modulusLength < 2048 ||
    privateKey.algorithm.modulusLength > 8192
  ) {
    throw new Error('signing_key_too_small')
  }

  return { privateKey, publicKey }
}

export async function signIdToken(
  privateKeyPem: string,
  publicJwk: PublicSigningJwk,
  claims: Record<string, string | number | boolean>,
): Promise<string> {
  const header = encodeBase64Url(
    textEncoder.encode(
      JSON.stringify({ alg: 'RS256', kid: publicJwk.kid, typ: 'JWT' }),
    ),
  )
  const payload = encodeBase64Url(textEncoder.encode(JSON.stringify(claims)))
  const signingInput = `${header}.${payload}`
  const { privateKey, publicKey } = await importSigningKeys(
    privateKeyPem,
    publicJwk,
  )
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      privateKey,
      textEncoder.encode(signingInput),
    ),
  )

  const verified = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    publicKey,
    signature,
    textEncoder.encode(signingInput),
  )
  if (!verified) {
    throw new Error('signing_key_mismatch')
  }

  return `${signingInput}.${encodeBase64Url(signature)}`
}
