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
const SHA_PATTERN = /^[a-f0-9]{40}$/iu

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
  const privateKey = env.CMS_GITHUB_APP_PRIVATE_KEY?.replace(
    /\\n/gu,
    '\n',
  ).trim()

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
    const signingKey = await importPKCS8(privateKey, 'RS256')
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
