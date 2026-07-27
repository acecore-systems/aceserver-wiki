import { SignJWT, importPKCS8 } from 'jose'

import {
  CMS_REPOSITORY,
  isAllowedCmsDirectoryPath,
  isAllowedCmsWritePath,
  normalizeCmsPath,
  type CmsRuntimeEnv,
} from './_cms-policy.ts'

const GITHUB_API_VERSION = '2022-11-28'
const USER_AGENT = 'aceserver-wiki-sveltia-content-gateway'
const INSTALLATION_TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000
const MAX_GITHUB_JSON_BYTES = 16 * 1024 * 1024
const MAX_PRIVATE_KEY_PEM_CHARS = 32 * 1024
const MIN_PRIVATE_KEY_DER_BYTES = 256
const MAX_PRIVATE_KEY_DER_BYTES = 16 * 1024
const SHA_PATTERN = /^[a-f0-9]{40}$/iu
const BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u
const RSA_ALGORITHM_IDENTIFIER = Uint8Array.of(
  0x30,
  0x0d,
  0x06,
  0x09,
  0x2a,
  0x86,
  0x48,
  0x86,
  0xf7,
  0x0d,
  0x01,
  0x01,
  0x01,
  0x05,
  0x00,
)

// Only the repository-scoped GitHub App credential is cached. No request
// identity, request body, or authorization decision is stored globally.
const installationTokenCache = new Map<
  string,
  { token: string; expiresAt: number }
>()

export class GitHubApiError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'GitHubApiError'
    this.status = status
  }
}

export async function getGitHubToken(env: CmsRuntimeEnv) {
  const clientId = env.CMS_GITHUB_APP_CLIENT_ID?.trim()
  const installationId = env.CMS_GITHUB_APP_INSTALLATION_ID?.trim()
  const privateKey = env.CMS_GITHUB_APP_PRIVATE_KEY

  if (
    !clientId ||
    !installationId ||
    !/^\d+$/u.test(installationId) ||
    !privateKey
  ) {
    throw new GitHubApiError('CMS GitHub Appの認証設定がありません。', 503)
  }

  const cacheKey = `${clientId}:${installationId}:${CMS_REPOSITORY.name}`
  const cached = installationTokenCache.get(cacheKey)

  if (
    cached &&
    cached.expiresAt - INSTALLATION_TOKEN_REFRESH_BUFFER_MS > Date.now()
  ) {
    return cached.token
  }

  let appJwt: string

  try {
    const signingKey = await importPKCS8(
      normalizeGitHubAppPrivateKey(privateKey),
      'RS256',
    )
    const now = Math.floor(Date.now() / 1000)

    appJwt = await new SignJWT({})
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer(clientId)
      .setIssuedAt(now - 60)
      .setExpirationTime(now + 9 * 60)
      .sign(signingKey)
  } catch {
    throw new GitHubApiError('CMS GitHub Appの秘密鍵を読み込めません。', 503)
  }

  const response = await githubFetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${appJwt}`,
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
        'X-GitHub-Api-Version': GITHUB_API_VERSION,
      },
      body: JSON.stringify({
        repositories: [CMS_REPOSITORY.name],
        permissions: {
          contents: 'write',
          pull_requests: 'write',
        },
      }),
    },
  )
  const data = await readResponseJson(response)

  if (
    !response.ok ||
    !isRecord(data) ||
    typeof data.token !== 'string' ||
    typeof data.expires_at !== 'string'
  ) {
    const message =
      isRecord(data) && typeof data.message === 'string'
        ? data.message
        : 'CMS GitHub Appのinstallation tokenを発行できません。'

    throw new GitHubApiError(message, response.ok ? 502 : response.status)
  }

  const expiresAt = Date.parse(data.expires_at)

  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    throw new GitHubApiError('CMS GitHub App tokenの有効期限が不正です。', 502)
  }

  installationTokenCache.set(cacheKey, {
    token: data.token,
    expiresAt,
  })

  return data.token
}

export type CmsGitTreeItem = {
  path: string
  mode: string
  type: 'blob' | 'tree'
  sha: string
  size?: number
  url?: string
}

export type CmsGitTree = {
  sha: string
  tree: CmsGitTreeItem[]
  truncated: boolean
  url?: string
}

export async function githubRequest({
  accept = 'application/vnd.github+json',
  body,
  method = 'GET',
  path,
  token,
}: {
  accept?: string
  body?: unknown
  method?: string
  path: string
  token: string
}) {
  if (!path.startsWith('/')) {
    throw new GitHubApiError('GitHub API pathが不正です。', 500)
  }

  const headers = new Headers({
    Accept: accept,
    Authorization: `Bearer ${token}`,
    'User-Agent': USER_AGENT,
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
  })

  if (body !== undefined) headers.set('Content-Type', 'application/json')

  return await githubFetch(`https://api.github.com${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

export async function githubJson<T>(
  options: Parameters<typeof githubRequest>[0],
) {
  const response = await githubRequest(options)
  const data = await readResponseJson(response)

  if (!response.ok) {
    const message =
      isRecord(data) && typeof data.message === 'string'
        ? data.message
        : 'GitHub APIでエラーが発生しました。'

    throw new GitHubApiError(message, response.status)
  }

  return data as T
}

export async function fetchCmsTree(
  token: string,
  ref: string = CMS_REPOSITORY.branch,
) {
  const data = await githubJson<unknown>({
    path: `/repos/${CMS_REPOSITORY.owner}/${CMS_REPOSITORY.name}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
    token,
  })

  if (
    !isRecord(data) ||
    typeof data.sha !== 'string' ||
    !SHA_PATTERN.test(data.sha) ||
    !Array.isArray(data.tree) ||
    typeof data.truncated !== 'boolean'
  ) {
    throw new GitHubApiError('GitHub tree responseが不正です。', 502)
  }

  if (data.truncated) {
    throw new GitHubApiError(
      'GitHub treeが省略されたためCMS対象を安全に判定できません。',
      502,
    )
  }

  const tree = data.tree.flatMap((item): CmsGitTreeItem[] => {
    if (!isRecord(item)) return []

    const path =
      typeof item.path === 'string' ? normalizeCmsPath(item.path) : null
    const type = item.type
    const sha = item.sha
    const mode = item.mode

    if (
      path === null ||
      (type !== 'blob' && type !== 'tree') ||
      typeof sha !== 'string' ||
      !SHA_PATTERN.test(sha) ||
      typeof mode !== 'string'
    ) {
      return []
    }

    const allowed =
      type === 'blob'
        ? isAllowedCmsWritePath(path)
        : isAllowedCmsDirectoryPath(path)

    if (!allowed) return []

    return [
      {
        path,
        type,
        sha,
        mode,
        ...(typeof item.size === 'number' ? { size: item.size } : {}),
        ...(typeof item.url === 'string' ? { url: item.url } : {}),
      },
    ]
  })

  return {
    sha: data.sha,
    tree,
    truncated: data.truncated,
    ...(typeof data.url === 'string' ? { url: data.url } : {}),
  } satisfies CmsGitTree
}

export function getAllowedCmsBlobShas(tree: CmsGitTree) {
  return new Set(
    tree.tree.filter((item) => item.type === 'blob').map((item) => item.sha),
  )
}

export function copyGitHubResponse(response: Response) {
  const headers = new Headers()

  for (const name of ['Content-Type', 'ETag', 'Link']) {
    const value = response.headers.get(name)

    if (value) headers.set(name, value)
  }

  headers.set('Cache-Control', 'no-store')

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export async function readGitHubResponseJson(response: Response) {
  return await readResponseJson(response)
}

async function githubFetch(input: string, init: RequestInit) {
  try {
    return await fetch(input, init)
  } catch (error) {
    console.error(
      JSON.stringify({
        message: 'GitHub API fetch failed',
        error: error instanceof Error ? error.message : String(error),
      }),
    )

    throw new GitHubApiError('GitHub APIへ接続できません。', 502)
  }
}

async function readResponseJson(response: Response) {
  const text = await readBoundedResponseText(response, MAX_GITHUB_JSON_BYTES)

  if (text === null) {
    throw new GitHubApiError(
      'GitHub API responseが許容サイズを超えました。',
      502,
    )
  }

  if (text === '') return null

  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new GitHubApiError('GitHub API responseがJSONではありません。', 502)
  }
}

async function readBoundedResponseText(
  response: Response,
  maximumBytes: number,
) {
  const contentLength = Number(response.headers.get('Content-Length') || 0)

  if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
    return null
  }

  if (!response.body) return ''

  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const chunks: string[] = []
  let totalBytes = 0

  try {
    while (true) {
      const { done, value } = await reader.read()

      if (done) break

      totalBytes += value.byteLength

      if (totalBytes > maximumBytes) {
        await reader.cancel().catch(() => undefined)
        return null
      }

      chunks.push(decoder.decode(value, { stream: true }))
    }

    chunks.push(decoder.decode())
    return chunks.join('')
  } catch {
    throw new GitHubApiError('GitHub API responseを読み取れません。', 502)
  } finally {
    reader.releaseLock()
  }
}

function normalizeGitHubAppPrivateKey(value: string) {
  if (value.length === 0 || value.length > MAX_PRIVATE_KEY_PEM_CHARS) {
    throw new Error('GitHub App private key size is invalid')
  }

  const pem = value.replace(/\\n/gu, '\n').replace(/\r\n?/gu, '\n').trim()
  const pkcs8 = decodePem(pem, 'PRIVATE KEY')

  if (pkcs8) {
    validateSingleDerSequence(pkcs8)
    return encodePem(pkcs8, 'PRIVATE KEY')
  }

  const pkcs1 = decodePem(pem, 'RSA PRIVATE KEY')

  if (!pkcs1) {
    throw new Error('GitHub App private key PEM label is invalid')
  }

  validateSingleDerSequence(pkcs1)

  const privateKey = encodeDerElement(0x04, pkcs1)
  const privateKeyInfo = concatenateBytes([
    Uint8Array.of(0x02, 0x01, 0x00),
    RSA_ALGORITHM_IDENTIFIER,
    privateKey,
  ])

  return encodePem(encodeDerElement(0x30, privateKeyInfo), 'PRIVATE KEY')
}

function decodePem(value: string, label: 'PRIVATE KEY' | 'RSA PRIVATE KEY') {
  const lines = value.split('\n')

  if (
    lines.length < 3 ||
    lines[0] !== `-----BEGIN ${label}-----` ||
    lines.at(-1) !== `-----END ${label}-----`
  ) {
    return null
  }

  const bodyLines = lines.slice(1, -1)

  if (
    bodyLines.some(
      (line) =>
        line.length === 0 ||
        line.length > 76 ||
        !/^[A-Za-z0-9+/]+={0,2}$/u.test(line),
    )
  ) {
    throw new Error('GitHub App private key PEM body is invalid')
  }

  const body = bodyLines.join('')

  if (
    body.length % 4 !== 0 ||
    !BASE64_PATTERN.test(body) ||
    body.length > Math.ceil((MAX_PRIVATE_KEY_DER_BYTES * 4) / 3) + 4
  ) {
    throw new Error('GitHub App private key base64 is invalid')
  }

  let binary: string

  try {
    binary = atob(body)
  } catch {
    throw new Error('GitHub App private key base64 is invalid')
  }

  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))

  if (
    bytes.byteLength < MIN_PRIVATE_KEY_DER_BYTES ||
    bytes.byteLength > MAX_PRIVATE_KEY_DER_BYTES ||
    bytesToBase64(bytes) !== body
  ) {
    throw new Error('GitHub App private key DER size is invalid')
  }

  return bytes
}

function validateSingleDerSequence(bytes: Uint8Array) {
  if (bytes[0] !== 0x30) {
    throw new Error('GitHub App private key DER is not a sequence')
  }

  const length = decodeDerLength(bytes, 1)

  if (length.contentOffset + length.contentLength !== bytes.byteLength) {
    throw new Error('GitHub App private key DER length is invalid')
  }
}

function decodeDerLength(bytes: Uint8Array, offset: number) {
  const first = bytes[offset]

  if (first === undefined) {
    throw new Error('GitHub App private key DER length is missing')
  }

  if (first < 0x80) {
    return {
      contentLength: first,
      contentOffset: offset + 1,
    }
  }

  const octetCount = first & 0x7f

  if (octetCount === 0 || octetCount > 4) {
    throw new Error('GitHub App private key DER length is invalid')
  }

  const lengthEnd = offset + 1 + octetCount

  if (
    lengthEnd > bytes.byteLength ||
    bytes[offset + 1] === 0 ||
    (octetCount === 1 && (bytes[offset + 1] ?? 0) < 0x80)
  ) {
    throw new Error('GitHub App private key DER length is not canonical')
  }

  let contentLength = 0

  for (let index = offset + 1; index < lengthEnd; index += 1) {
    contentLength = contentLength * 256 + (bytes[index] ?? 0)
  }

  return {
    contentLength,
    contentOffset: lengthEnd,
  }
}

function encodeDerElement(tag: number, content: Uint8Array) {
  return concatenateBytes([
    Uint8Array.of(tag),
    encodeDerLength(content.byteLength),
    content,
  ])
}

function encodeDerLength(length: number) {
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new Error('DER length is invalid')
  }

  if (length < 0x80) return Uint8Array.of(length)

  const octets: number[] = []
  let remaining = length

  while (remaining > 0) {
    octets.unshift(remaining & 0xff)
    remaining = Math.floor(remaining / 256)
  }

  return Uint8Array.of(0x80 | octets.length, ...octets)
}

function concatenateBytes(parts: Uint8Array[]) {
  const result = new Uint8Array(
    parts.reduce((total, part) => total + part.byteLength, 0),
  )
  let offset = 0

  for (const part of parts) {
    result.set(part, offset)
    offset += part.byteLength
  }

  return result
}

function encodePem(
  bytes: Uint8Array,
  label: 'PRIVATE KEY' | 'RSA PRIVATE KEY',
) {
  const body = bytesToBase64(bytes)
    .match(/.{1,64}/gu)
    ?.join('\n')

  if (!body) throw new Error('GitHub App private key PEM encoding failed')

  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----`
}

function bytesToBase64(bytes: Uint8Array) {
  const chunks: string[] = []
  const chunkSize = 0x8000

  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    chunks.push(
      String.fromCharCode(
        ...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)),
      ),
    )
  }

  return btoa(chunks.join(''))
}
