import {
  CMS_REPOSITORY,
  hasExpectedCmsRepositoryConfig,
  type CmsRuntimeEnv,
} from '../_cms-policy.ts'
import { getAccessIdentity, type AccessIdentity } from '../_access-auth.ts'
import { CmsStateError, authorizeCmsApiAttempt } from '../_cms-state.ts'
import {
  GitHubApiError,
  copyGitHubResponse,
  fetchCmsTree,
  getAllowedCmsBlobShas,
  getGitHubToken,
  githubJson,
  githubRequest,
} from '../_github-api.ts'

const SHA_PATTERN = /^[a-f0-9]{40}$/iu

type ReadTarget = { kind: 'tree'; ref: string } | { kind: 'blob'; sha: string }
type AuthenticatedIdentity = Extract<AccessIdentity, { ok: true }>

export const onRequest: PagesFunction<CmsRuntimeEnv> = async ({
  request,
  env,
}) => {
  const requestBoundaryError = validateBrowserRequestBoundary(request)

  if (requestBoundaryError) return requestBoundaryError

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

  if (!hasExpectedCmsRepositoryConfig(env)) {
    return json(
      { message: 'CMS repository設定がallowlistと一致しません。' },
      503,
    )
  }

  const method = request.method.toUpperCase()

  if (method !== 'GET' && method !== 'HEAD') {
    return json({ message: 'Method not allowed' }, 405, {
      Allow: 'GET, HEAD',
    })
  }

  const proxyPath = getProxyPath(request)

  try {
    if (proxyPath === 'user') {
      await authorizeCmsApiAttempt({
        discordId: auth.discordId,
        env,
        request,
      })
      const token = await getGitHubToken(env)

      return await handleCurrentUser({ auth, method, token })
    }

    if (isCollaboratorCheckPath(proxyPath, auth)) {
      return noContent()
    }

    const target = getReadTarget(proxyPath, new URL(request.url))

    if (!target) {
      return json(
        { message: 'CMS proxyで許可されていないGitHub APIです。' },
        403,
      )
    }

    await authorizeCmsApiAttempt({
      discordId: auth.discordId,
      env,
      request,
    })
    const token = await getGitHubToken(env)

    if (target.kind === 'tree') {
      return await handleTreeRead({ method, ref: target.ref, token })
    }

    return await handleBlobRead({ method, request, sha: target.sha, token })
  } catch (error) {
    return toErrorResponse(error)
  }
}

async function handleCurrentUser({
  auth,
  method,
  token,
}: {
  auth: AuthenticatedIdentity
  method: string
  token: string
}) {
  if (method === 'HEAD') return noContent()

  await githubJson({
    path: `/repos/${CMS_REPOSITORY.owner}/${CMS_REPOSITORY.name}`,
    token,
  })

  return json({
    avatar_url: '',
    email: null,
    html_url: '',
    id: 0,
    login: getProxyLogin(auth),
    name: `Discord user ${auth.discordId}`,
    type: 'User',
  })
}

async function handleTreeRead({
  method,
  ref,
  token,
}: {
  method: string
  ref: string
  token: string
}) {
  if (method === 'HEAD') return noContent()

  const tree = await fetchCmsTree(token, ref)

  return json(tree)
}

async function handleBlobRead({
  method,
  request,
  sha,
  token,
}: {
  method: string
  request: Request
  sha: string
  token: string
}) {
  const tree = await fetchCmsTree(token)

  if (!getAllowedCmsBlobShas(tree).has(sha)) {
    return json({ message: 'CMS管理対象外のGit blobです。' }, 403)
  }

  if (method === 'HEAD') return noContent()

  const response = await githubRequest({
    accept: request.headers.get('Accept') || 'application/vnd.github.raw',
    path: `/repos/${CMS_REPOSITORY.owner}/${CMS_REPOSITORY.name}/git/blobs/${sha}`,
    token,
  })

  return copyGitHubResponse(response)
}

function getReadTarget(proxyPath: string, sourceUrl: URL): ReadTarget | null {
  const repoRoot = `repos/${CMS_REPOSITORY.owner}/${CMS_REPOSITORY.name}`
  const treePrefix = `${repoRoot}/git/trees/`
  const blobPrefix = `${repoRoot}/git/blobs/`

  if (proxyPath.startsWith(treePrefix)) {
    const ref = proxyPath.slice(treePrefix.length)
    const queryNames = Array.from(sourceUrl.searchParams.keys())

    if (
      (!SHA_PATTERN.test(ref) && ref !== CMS_REPOSITORY.branch) ||
      queryNames.some((name) => name !== 'recursive') ||
      sourceUrl.searchParams.getAll('recursive').length !== 1 ||
      sourceUrl.searchParams.get('recursive') !== '1'
    ) {
      return null
    }

    return { kind: 'tree', ref }
  }

  if (proxyPath.startsWith(blobPrefix) && sourceUrl.search === '') {
    const sha = proxyPath.slice(blobPrefix.length)

    return SHA_PATTERN.test(sha) ? { kind: 'blob', sha } : null
  }

  return null
}

function getProxyPath(request: Request) {
  const pathname = new URL(request.url).pathname

  return pathname
    .replace(/^\/admin\/api\/github\/?/u, '')
    .replace(/^api\/v3\/?/u, '')
    .replace(/^\/+/u, '')
}

function isCollaboratorCheckPath(
  proxyPath: string,
  auth: AuthenticatedIdentity,
) {
  const prefix = `repos/${CMS_REPOSITORY.owner}/${CMS_REPOSITORY.name}/collaborators/`

  if (!proxyPath.startsWith(prefix)) return false

  return proxyPath.slice(prefix.length) === getProxyLogin(auth)
}

function getProxyLogin(auth: AuthenticatedIdentity) {
  return `discord-${auth.discordId}`
}

function validateBrowserRequestBoundary(request: Request) {
  const fetchSite = request.headers.get('Sec-Fetch-Site')?.trim().toLowerCase()

  if (fetchSite && fetchSite !== 'same-origin') {
    return json(
      { message: 'CMS GitHub API requestはsame-originに限定されています。' },
      403,
    )
  }

  return null
}

function toErrorResponse(error: unknown) {
  if (error instanceof CmsStateError) {
    return json(
      { message: error.message },
      error.status,
      error.retryAfterSeconds
        ? { 'Retry-After': String(error.retryAfterSeconds) }
        : undefined,
    )
  }

  if (error instanceof GitHubApiError) {
    return json({ message: error.message }, error.status)
  }

  console.error(
    JSON.stringify({
      message: 'CMS GitHub proxy failed',
      error: error instanceof Error ? error.message : String(error),
    }),
  )

  return json({ message: 'CMS GitHub proxyでエラーが発生しました。' }, 500)
}

function json(data: unknown, status = 200, headers?: HeadersInit) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers,
    },
  })
}

function noContent() {
  return new Response(null, {
    status: 204,
    headers: {
      'Cache-Control': 'no-store',
    },
  })
}
