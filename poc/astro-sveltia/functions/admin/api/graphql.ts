import {
  Kind,
  parse,
  type ArgumentNode,
  type FieldNode,
  type OperationDefinitionNode,
  type SelectionSetNode,
  type ValueNode,
} from 'graphql'

import {
  CMS_REPOSITORY,
  hasExpectedCmsRepositoryConfig,
  isAllowedCmsDeletePath,
  isAllowedCmsWritePath,
  isCmsMarkdownPath,
  isCmsMediaPath,
  normalizeCmsPath,
  type CmsRuntimeEnv,
} from './_cms-policy.ts'
import { getAccessIdentity, type AccessIdentity } from './_access-auth.ts'
import {
  validateCmsAddition,
  type ValidatedCmsAddition,
} from './_content-validation.ts'
import {
  GitHubApiError,
  type CmsGitTree,
  fetchCmsTree,
  getGitHubToken,
  githubJson,
  githubRequest,
  isRecord,
  readGitHubResponseJson,
} from './_github-api.ts'
import {
  CmsStateError,
  authorizeCmsApiAttempt,
  beginCmsMutation,
  completeCmsMutation,
  failCmsMutation,
  markCmsMutationUnknown,
  resumeCmsMutation,
  type CmsMutationReservation,
} from './_cms-state.ts'

type GraphqlPayload = {
  query: string
  variables: Record<string, unknown>
}

type CmsDeletion = {
  path: string
}

type CmsCommitInput = {
  expectedHeadOid: string
  additions: ValidatedCmsAddition[]
  deletions: CmsDeletion[]
}

type AuthenticatedIdentity = Extract<AccessIdentity, { ok: true }>
type ReadQueryMode =
  'default-branch' | 'head' | 'file-contents' | 'file-history'
type ReadAuthorization = {
  contentBlobs: Map<number, string>
  contentPaths: Map<number, string>
  contentPathSet: Set<string>
  fileHistoryPaths: Map<number, string>
  fileHistoryPathSet: Set<string>
  modes: Set<ReadQueryMode>
}

class CmsDefinitivePublicationError extends CmsStateError {}

const SHA_PATTERN = /^[a-f0-9]{40}$/iu
const MAX_GRAPHQL_QUERY_CHARS = 128 * 1024
const MAX_READ_VARIABLE_BYTES = 64 * 1024
const MAX_READ_VARIABLE_DEPTH = 64
const MAX_GRAPHQL_REPOSITORY_FIELDS = 500
const MAX_GRAPHQL_FILE_CONTENT_FIELDS = 250
const MAX_GRAPHQL_FILE_HISTORY_FIELDS = 40
const MAX_REQUEST_BYTES = 16 * 1024 * 1024
const MAX_CHANGE_COUNT = 40
const MAX_TOTAL_CONTENT_BYTES = 10 * 1024 * 1024
const MAX_GRAPHQL_BLOB_SIZE = 10 * 1024 * 1024
const SVELTIA_READ_ALIAS_PATTERN =
  /^(?<kind>content|commit|history)_(?<index>0|[1-9]\d{0,2})$/u
export const CMS_PROJECTED_TREE_LIMITS = {
  maxFiles: 1000,
  maxContentBytes: 64 * 1024 * 1024,
  maxMediaBytes: 512 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
} as const

export const onRequestPost: PagesFunction<CmsRuntimeEnv> = async ({
  request,
  env,
}) => {
  const requestBoundaryError = validateBrowserRequestBoundary(request)

  if (requestBoundaryError) return requestBoundaryError

  const auth = await getAccessIdentity(request, env)

  if (!auth.ok) {
    return json({ message: auth.message }, auth.status)
  }

  if (!hasExpectedCmsRepositoryConfig(env)) {
    return json(
      { message: 'CMS repository設定がallowlistと一致しません。' },
      503,
    )
  }

  try {
    await authorizeCmsApiAttempt({
      discordId: auth.discordId,
      env,
      request,
    })

    const bodyText = await readRequestText(request)

    if (bodyText === null) {
      return json({ message: 'CMS保存データが大きすぎます。' }, 413)
    }

    const payload = parseGraphqlPayload(bodyText)

    if (!payload || payload.query.length > MAX_GRAPHQL_QUERY_CHARS) {
      return json({ message: 'CMS GraphQL requestが不正です。' }, 400)
    }

    const operation = parseOperation(payload.query)

    if (!operation) {
      return json({ message: 'CMS GraphQL operationが不正です。' }, 400)
    }

    if (operation.operation === 'query') {
      return await handleReadQuery({ env, operation, payload })
    }

    if (operation.operation === 'mutation') {
      if (env.CMS_PUBLICATION_MODE?.trim().toLowerCase() !== 'direct') {
        return json({ message: 'CMS publication modeの設定が不正です。' }, 503)
      }

      return await handleCommitMutation({
        auth,
        bodyText,
        env,
        operation,
        payload,
        request,
      })
    }

    return json({ message: 'CMS GraphQL operationは許可されていません。' }, 403)
  } catch (error) {
    return toErrorResponse(error)
  }
}

async function handleReadQuery({
  env,
  operation,
  payload,
}: {
  env: CmsRuntimeEnv
  operation: OperationDefinitionNode
  payload: GraphqlPayload
}) {
  if (
    getJsonEncodedSize(payload.variables, MAX_READ_VARIABLE_BYTES, 0) >
    MAX_READ_VARIABLE_BYTES
  ) {
    return json({ message: 'CMS GraphQL query変数が大きすぎます。' }, 413)
  }

  const authorization = validateReadOperation(operation, payload.variables)

  if (!authorization) {
    return json({ message: 'CMSで許可されていないGraphQL queryです。' }, 403)
  }

  const token = await getGitHubToken(env)

  if (authorization.contentBlobs.size > 0) {
    const tree = await fetchCmsTree(token)
    const blobsByPath = new Map(
      tree.tree
        .filter((item) => item.type === 'blob')
        .map((item) => [item.path, item]),
    )
    let requestedBytes = 0

    for (const [index, sha] of authorization.contentBlobs) {
      const path = authorization.contentPaths.get(index)
      const blob = path ? blobsByPath.get(path) : undefined

      if (!path || !isCmsMarkdownPath(path) || !blob || blob.sha !== sha) {
        return json({ message: 'CMS管理対象外のGit blobです。' }, 403)
      }

      if (!Number.isSafeInteger(blob.size) || (blob.size as number) < 0) {
        return json(
          { message: 'GitHub treeのfile sizeを安全に確認できません。' },
          502,
        )
      }

      requestedBytes += blob.size as number

      if (
        !Number.isSafeInteger(requestedBytes) ||
        requestedBytes > CMS_PROJECTED_TREE_LIMITS.maxContentBytes
      ) {
        return json(
          { message: 'CMS GraphQL本文の読み取り量が大きすぎます。' },
          413,
        )
      }
    }
  }

  const response = await githubRequest({
    body: {
      query: payload.query,
      variables: payload.variables,
    },
    method: 'POST',
    path: '/graphql',
    token,
  })
  const responseJson = await readGitHubResponseJson(response)

  return json(sanitizeGraphqlReadResponse(responseJson), response.status)
}

async function handleCommitMutation({
  auth,
  bodyText,
  env,
  operation,
  payload,
  request,
}: {
  auth: AuthenticatedIdentity
  bodyText: string
  env: CmsRuntimeEnv
  operation: OperationDefinitionNode
  payload: GraphqlPayload
  request: Request
}) {
  if (!isCmsCommitOperation(operation, payload.variables)) {
    return json({ message: 'CMSで許可されていないGraphQL mutationです。' }, 403)
  }

  const parsed = parseCmsCommitInput(payload.variables.input)

  if (!parsed.ok) {
    return json({ message: parsed.message }, 403)
  }

  const commitInput = parsed.value
  const changedPaths = [
    ...commitInput.additions.map(({ path }) => path),
    ...commitInput.deletions.map(({ path }) => path),
  ]
  const mutation = await beginCmsMutation({
    bodyText,
    discordId: auth.discordId,
    discordRoleIds: auth.discordRoleIds,
    env,
    expectedHeadOid: commitInput.expectedHeadOid,
    mutationBytes: commitInput.additions.reduce(
      (total, addition) => total + addition.byteSize,
      0,
    ),
    paths: changedPaths,
    request,
  })

  if (mutation.kind === 'replay') {
    return json(mutation.response, mutation.status, {
      'X-CMS-Idempotent-Replay': 'true',
      'X-Request-ID': mutation.requestId,
    })
  }

  const { reservation } = mutation
  let token: string

  try {
    token = await getGitHubToken(env)
  } catch (error) {
    if (mutation.kind === 'reconcile') {
      await markCmsMutationUnknown({
        env,
        message: describeMutationFailure(error).message,
        reservation,
      })
    } else {
      const failure = describeMutationFailure(error)

      await failCmsMutation({
        env,
        message: failure.message,
        reservation,
        status: failure.status,
      })
    }

    throw error
  }

  if (mutation.kind === 'reconcile') {
    try {
      const recovered = await reconcilePublication({
        commitInput,
        reservation,
        token,
      })

      if (recovered.kind === 'published') {
        await completeCmsMutation({
          branch: recovered.branch,
          commitOid: recovered.commitOid,
          env,
          reservation,
          response: recovered.response,
          status: 200,
        })

        await deleteCmsBranch(reservation.publicationBranch, token)

        return json(recovered.response, 200, {
          'X-CMS-Audit-Status': 'recorded',
          'X-CMS-Reconciled': 'true',
          'X-Request-ID': reservation.requestId,
        })
      }

      await resumeCmsMutation({ env, reservation })
    } catch (error) {
      if (error instanceof CmsDefinitivePublicationError) {
        await deleteCmsBranch(reservation.publicationBranch, token)
        await failCmsMutation({
          env,
          message: error.message,
          reservation,
          status: error.status,
        })
      } else {
        await markCmsMutationUnknown({
          env,
          message: describeMutationFailure(error).message,
          reservation,
        })
      }

      throw error
    }
  }

  let mainSha: string

  try {
    const mainRef = await githubJson<unknown>({
      path: branchRefPath(CMS_REPOSITORY.branch),
      token,
    })
    const parsedMainSha = getGitRefSha(mainRef)

    if (!parsedMainSha) {
      throw new GitHubApiError('GitHub branch responseが不正です。', 502)
    }

    mainSha = parsedMainSha
  } catch (error) {
    const failure = describeMutationFailure(error)

    await failCmsMutation({
      env,
      message: failure.message,
      reservation,
      status: failure.status,
    })

    throw error
  }

  if (mainSha !== commitInput.expectedHeadOid) {
    const message =
      'mainが更新されています。CMSを再読み込みしてから、もう一度保存してください。'

    await failCmsMutation({
      env,
      message,
      reservation,
      status: 409,
    })
    await deleteCmsBranch(reservation.publicationBranch, token)

    return json({ message }, 409, {
      'X-Request-ID': reservation.requestId,
    })
  }

  try {
    const tree = await fetchCmsTree(token, mainSha)

    assertProjectedCmsTreeWithinLimits(tree, commitInput)
  } catch (error) {
    const failure = describeMutationFailure(error)

    await failCmsMutation({
      env,
      message: failure.message,
      reservation,
      status: failure.status,
    })

    throw error
  }

  try {
    const staged = await ensurePublicationCommit({
      commitInput,
      reservation,
      token,
    })
    const commitOid = getCommitOid(staged)

    await publishDirectCommit({
      commitOid,
      expectedHeadOid: mainSha,
      token,
    })

    const response = withCmsExtension(staged, {
      branch: CMS_REPOSITORY.branch,
      mode: 'direct',
    })

    await completeCmsMutation({
      branch: CMS_REPOSITORY.branch,
      commitOid,
      env,
      reservation,
      response,
      status: 200,
    })
    await deleteCmsBranch(reservation.publicationBranch, token)

    return json(response, 200, mutationResponseHeaders(reservation))
  } catch (error) {
    if (error instanceof CmsDefinitivePublicationError) {
      await deleteCmsBranch(reservation.publicationBranch, token)
      await failCmsMutation({
        env,
        message: error.message,
        reservation,
        status: error.status,
      })
    } else {
      await markCmsMutationUnknown({
        env,
        message: describeMutationFailure(error).message,
        reservation,
      })
    }

    throw error
  }
}

async function commitChanges({
  branch,
  commitInput,
  expectedHeadOid,
  reservation,
  token,
}: {
  branch: string
  commitInput: CmsCommitInput
  expectedHeadOid: string
  reservation: CmsMutationReservation
  token: string
}) {
  const changedPaths = [
    ...commitInput.additions.map(({ path }) => path),
    ...commitInput.deletions.map(({ path }) => path),
  ]
  const mutation = buildCmsCommitMutation(commitInput.additions)
  const result = await githubJson<Record<string, unknown>>({
    body: {
      query: mutation,
      variables: {
        input: {
          branch: {
            repositoryNameWithOwner: `${CMS_REPOSITORY.owner}/${CMS_REPOSITORY.name}`,
            branchName: branch,
          },
          expectedHeadOid,
          fileChanges: {
            additions: commitInput.additions.map(({ path, contents }) => ({
              path,
              contents,
            })),
            deletions: commitInput.deletions,
          },
          message: {
            body: [
              `Request ID: ${reservation.requestId}`,
              reservation.commitMarker,
            ].join('\n'),
            headline: buildCommitHeadline(changedPaths),
          },
        },
      },
    },
    method: 'POST',
    path: '/graphql',
    token,
  })

  ensureCommitSucceeded(result)
  return result
}

function validateReadOperation(
  operation: OperationDefinitionNode,
  variables: Record<string, unknown>,
) {
  if (
    operation.operation !== 'query' ||
    operation.directives?.length ||
    !variablesMatchDefinitions(operation, variables) ||
    operation.selectionSet.selections.length !== 1
  ) {
    return null
  }

  const root = operation.selectionSet.selections[0]

  if (
    root.kind !== Kind.FIELD ||
    root.name.value !== 'repository' ||
    root.alias ||
    !root.selectionSet ||
    !hasExactArguments(root, ['owner', 'name']) ||
    !argumentMatches(root, 'owner', CMS_REPOSITORY.owner, variables) ||
    !argumentMatches(root, 'name', CMS_REPOSITORY.name, variables)
  ) {
    return null
  }

  const authorization: ReadAuthorization = {
    contentBlobs: new Map(),
    contentPaths: new Map(),
    contentPathSet: new Set(),
    fileHistoryPaths: new Map(),
    fileHistoryPathSet: new Set(),
    modes: new Set(),
  }

  return validateRepositorySelection(
    root.selectionSet,
    variables,
    authorization,
  ) && validateReadAuthorization(authorization)
    ? authorization
    : null
}

function sanitizeGraphqlReadResponse(value: unknown) {
  if (!isRecord(value) || !isRecord(value.data)) return value

  const repository = value.data.repository

  if (!isRecord(repository)) return value

  return {
    ...value,
    data: {
      ...value.data,
      repository: Object.fromEntries(
        Object.entries(repository).map(([key, field]) => [
          key,
          sanitizeRepositoryReadField(field),
        ]),
      ),
    },
  }
}

function sanitizeRepositoryReadField(value: unknown) {
  if (!isRecord(value) || !isRecord(value.target)) return value

  const history = value.target.history

  if (!isRecord(history) || !Array.isArray(history.nodes)) return value

  return {
    ...value,
    target: {
      ...value.target,
      history: {
        ...history,
        nodes: history.nodes.map(sanitizeHistoryNode),
      },
    },
  }
}

function sanitizeHistoryNode(value: unknown) {
  if (value === null) return null
  if (!isRecord(value)) return {}

  const sanitized: Record<string, unknown> = {}

  if (typeof value.oid === 'string' && SHA_PATTERN.test(value.oid)) {
    sanitized.oid = value.oid
  }

  if (typeof value.committedDate === 'string' || value.committedDate === null) {
    sanitized.committedDate = value.committedDate
  }

  if (Object.hasOwn(value, 'message')) {
    sanitized.message = ''
  }

  if (Object.hasOwn(value, 'author')) {
    sanitized.author = sanitizeHistoryAuthor(value.author)
  }

  return sanitized
}

function sanitizeHistoryAuthor(value: unknown) {
  if (value === null) return null
  if (!isRecord(value)) return null

  const sanitized: Record<string, unknown> = {}

  if (Object.hasOwn(value, 'name')) sanitized.name = 'Anonymous'
  if (Object.hasOwn(value, 'email')) sanitized.email = ''
  if (Object.hasOwn(value, 'avatarUrl')) sanitized.avatarUrl = ''
  if (Object.hasOwn(value, 'user')) sanitized.user = null

  return sanitized
}

function assertProjectedCmsTreeWithinLimits(
  tree: CmsGitTree,
  commitInput: CmsCommitInput,
) {
  const files = new Map<string, number>()

  for (const item of tree.tree) {
    if (item.type !== 'blob') continue

    if (
      files.has(item.path) ||
      !Number.isSafeInteger(item.size) ||
      (item.size as number) < 0
    ) {
      throw new GitHubApiError(
        'GitHub treeのfile sizeを安全に確認できません。',
        502,
      )
    }

    files.set(item.path, item.size as number)
  }

  for (const { path } of commitInput.deletions) {
    files.delete(path)
  }

  for (const { byteSize, path } of commitInput.additions) {
    files.set(path, byteSize)
  }

  if (files.size > CMS_PROJECTED_TREE_LIMITS.maxFiles) {
    throw new CmsStateError(
      `CMS管理対象fileは${CMS_PROJECTED_TREE_LIMITS.maxFiles}件までです。削除してから再試行してください。`,
      413,
    )
  }

  let contentBytes = 0
  let mediaBytes = 0
  let totalBytes = 0

  for (const [path, size] of files) {
    totalBytes += size

    if (
      !Number.isSafeInteger(totalBytes) ||
      totalBytes > CMS_PROJECTED_TREE_LIMITS.maxTotalBytes
    ) {
      throw new CmsStateError(
        'CMS管理対象fileの合計は512 MiBまでです。fileを削除してから再試行してください。',
        413,
      )
    }

    if (isCmsMarkdownPath(path)) {
      contentBytes += size

      if (
        !Number.isSafeInteger(contentBytes) ||
        contentBytes > CMS_PROJECTED_TREE_LIMITS.maxContentBytes
      ) {
        throw new CmsStateError(
          'CMS Markdownの合計は64 MiBまでです。記事を削除してから再試行してください。',
          413,
        )
      }

      continue
    }

    if (!isCmsMediaPath(path)) {
      throw new GitHubApiError(
        'GitHub treeにCMS管理対象外のfileが含まれています。',
        502,
      )
    }

    mediaBytes += size

    if (
      !Number.isSafeInteger(mediaBytes) ||
      mediaBytes > CMS_PROJECTED_TREE_LIMITS.maxMediaBytes
    ) {
      throw new CmsStateError(
        'CMS画像の合計は512 MiBまでです。画像を削除してから再試行してください。',
        413,
      )
    }
  }
}

function getJsonEncodedSize(value: unknown, limit: number, depth: number) {
  if (depth > MAX_READ_VARIABLE_DEPTH) return limit + 1

  if (value === null) return 4
  if (value === true) return 4
  if (value === false) return 5

  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value).length : limit + 1
  }

  if (typeof value === 'string') {
    if (value.length > limit) return limit + 1

    return new TextEncoder().encode(JSON.stringify(value)).byteLength
  }

  if (Array.isArray(value)) {
    let size = 2

    for (const item of value) {
      if (size > 2) size += 1
      size += getJsonEncodedSize(item, limit - size, depth + 1)

      if (size > limit) return limit + 1
    }

    return size
  }

  if (isRecord(value)) {
    let size = 2

    for (const [key, item] of Object.entries(value)) {
      if (size > 2) size += 1
      size += getJsonEncodedSize(key, limit - size, depth + 1) + 1

      if (size > limit) return limit + 1

      size += getJsonEncodedSize(item, limit - size, depth + 1)

      if (size > limit) return limit + 1
    }

    return size
  }

  return limit + 1
}

function validateRepositorySelection(
  selectionSet: SelectionSetNode,
  variables: Record<string, unknown>,
  authorization: ReadAuthorization,
) {
  if (
    selectionSet.selections.length === 0 ||
    selectionSet.selections.length > MAX_GRAPHQL_REPOSITORY_FIELDS
  ) {
    return false
  }

  const responseNames = new Set<string>()

  return selectionSet.selections.every((selection) => {
    if (selection.kind !== Kind.FIELD || selection.directives?.length) {
      return false
    }

    const responseName = selection.alias?.value || selection.name.value

    if (responseNames.has(responseName)) return false
    responseNames.add(responseName)

    if (selection.name.value === 'defaultBranchRef') {
      const valid =
        !selection.alias &&
        !selection.arguments?.length &&
        !!selection.selectionSet &&
        validateLeafSelection(selection.selectionSet, ['name'])

      if (valid) authorization.modes.add('default-branch')

      return valid
    }

    if (selection.name.value === 'ref') {
      const readKind = getSveltiaRefReadKind(selection)
      const alias = getSveltiaReadAlias(selection)

      const valid =
        !!readKind &&
        !!selection.selectionSet &&
        hasExactArguments(selection, ['qualifiedName']) &&
        argumentMatches(
          selection,
          'qualifiedName',
          CMS_REPOSITORY.branch,
          variables,
        ) &&
        validateRefSelection(selection.selectionSet, readKind)

      if (!valid || !readKind) return false

      if (readKind === 'head') {
        authorization.modes.add('head')
        return true
      }

      const path = getRefHistoryPath(selection.selectionSet)

      if (!alias || !path) return false

      if (readKind === 'content-metadata') {
        if (
          authorization.contentPaths.has(alias.index) ||
          authorization.contentPathSet.has(path)
        ) {
          return false
        }

        authorization.modes.add('file-contents')
        authorization.contentPaths.set(alias.index, path)
        authorization.contentPathSet.add(path)
        return true
      }

      if (
        authorization.fileHistoryPaths.has(alias.index) ||
        authorization.fileHistoryPathSet.has(path)
      ) {
        return false
      }

      authorization.modes.add('file-history')
      authorization.fileHistoryPaths.set(alias.index, path)
      authorization.fileHistoryPathSet.add(path)
      return true
    }

    if (selection.name.value === 'object') {
      const oid = getArgumentString(selection, 'oid', variables)
      const alias = getSveltiaReadAlias(selection)

      if (
        !oid ||
        !SHA_PATTERN.test(oid) ||
        alias?.kind !== 'content' ||
        authorization.contentBlobs.has(alias.index) ||
        !selection.selectionSet ||
        !hasExactArguments(selection, ['oid']) ||
        !validateBlobObjectSelection(selection.selectionSet)
      ) {
        return false
      }

      authorization.modes.add('file-contents')
      authorization.contentBlobs.set(alias.index, oid)
      return true
    }

    return false
  })
}

function validateReadAuthorization(authorization: ReadAuthorization) {
  if (authorization.modes.size !== 1) return false

  const mode = authorization.modes.values().next().value

  if (mode === 'file-contents') {
    const contentIndices = Array.from(authorization.contentPaths.keys()).sort(
      (left, right) => left - right,
    )

    return (
      authorization.contentPaths.size > 0 &&
      authorization.contentPaths.size <= MAX_GRAPHQL_FILE_CONTENT_FIELDS &&
      hasContiguousIndices(contentIndices, contentIndices[0], 250) &&
      Array.from(authorization.contentBlobs.keys()).every((index) =>
        authorization.contentPaths.has(index),
      ) &&
      Array.from(authorization.contentPaths).every(
        ([index, path]) =>
          authorization.contentBlobs.has(index) === isCmsMarkdownPath(path),
      ) &&
      authorization.fileHistoryPaths.size === 0
    )
  }

  if (mode === 'file-history') {
    const historyIndices = Array.from(
      authorization.fileHistoryPaths.keys(),
    ).sort((left, right) => left - right)

    return (
      authorization.fileHistoryPaths.size > 0 &&
      authorization.fileHistoryPaths.size <= MAX_GRAPHQL_FILE_HISTORY_FIELDS &&
      hasContiguousIndices(historyIndices, 0) &&
      authorization.contentPaths.size === 0 &&
      authorization.contentBlobs.size === 0
    )
  }

  return (
    authorization.contentPaths.size === 0 &&
    authorization.contentBlobs.size === 0 &&
    authorization.fileHistoryPaths.size === 0
  )
}

function hasContiguousIndices(
  indices: number[],
  expectedStart: number | undefined,
  startMultiple = 1,
) {
  return (
    expectedStart !== undefined &&
    expectedStart % startMultiple === 0 &&
    indices.every((index, position) => index === expectedStart + position)
  )
}

type SveltiaRefReadKind = 'head' | 'content-metadata' | 'file-history'

function getSveltiaRefReadKind(
  selection: FieldNode,
): SveltiaRefReadKind | null {
  if (!selection.alias) return 'head'

  const alias = getSveltiaReadAlias(selection)

  if (alias?.kind === 'commit') return 'content-metadata'
  if (alias?.kind === 'history') return 'file-history'

  return null
}

function getSveltiaReadAlias(selection: FieldNode) {
  const match = selection.alias?.value.match(SVELTIA_READ_ALIAS_PATTERN)

  if (!match?.groups) return null

  return {
    kind: match.groups.kind as 'commit' | 'content' | 'history',
    index: Number(match.groups.index),
  }
}

function validateRefSelection(
  selectionSet: SelectionSetNode,
  readKind: SveltiaRefReadKind,
) {
  if (selectionSet.selections.length !== 1) return false

  const target = selectionSet.selections[0]

  return (
    target.kind === Kind.FIELD &&
    target.name.value === 'target' &&
    !target.alias &&
    !target.arguments?.length &&
    !target.directives?.length &&
    !!target.selectionSet &&
    validateTypedSelection(target.selectionSet, 'Commit', (commitSelection) =>
      validateCommitSelection(commitSelection, readKind),
    )
  )
}

function getRefHistoryPath(selectionSet: SelectionSetNode) {
  const target = selectionSet.selections[0]

  if (
    target?.kind !== Kind.FIELD ||
    !target.selectionSet ||
    target.selectionSet.selections.length !== 1
  ) {
    return null
  }

  const fragment = target.selectionSet.selections[0]

  if (
    fragment.kind !== Kind.INLINE_FRAGMENT ||
    fragment.selectionSet.selections.length !== 1
  ) {
    return null
  }

  const history = fragment.selectionSet.selections[0]

  if (history.kind !== Kind.FIELD) return null

  const path = getArgument(history, 'path')?.value

  return path?.kind === Kind.STRING ? path.value : null
}

function validateBlobObjectSelection(selectionSet: SelectionSetNode) {
  return validateTypedSelection(selectionSet, 'Blob', (blobSelection) => {
    return validateLeafSelection(blobSelection, ['text'])
  })
}

function validateTypedSelection(
  selectionSet: SelectionSetNode,
  typeName: string,
  validator: (selectionSet: SelectionSetNode) => boolean,
) {
  if (selectionSet.selections.length !== 1) return false

  const fragment = selectionSet.selections[0]

  return (
    fragment.kind === Kind.INLINE_FRAGMENT &&
    fragment.typeCondition?.name.value === typeName &&
    !fragment.directives?.length &&
    validator(fragment.selectionSet)
  )
}

function validateCommitSelection(
  selectionSet: SelectionSetNode,
  readKind: SveltiaRefReadKind,
) {
  if (selectionSet.selections.length !== 1) return false

  const history = selectionSet.selections[0]

  if (
    history.kind !== Kind.FIELD ||
    history.alias ||
    history.name.value !== 'history' ||
    history.directives?.length ||
    !history.selectionSet
  ) {
    return false
  }

  const first = getArgument(history, 'first')?.value

  if (first?.kind !== Kind.INT) return false

  const firstValue = Number(first.value)
  const pathArgument = getArgument(history, 'path')

  if (readKind === 'head') {
    return (
      hasExactArguments(history, ['first']) &&
      firstValue === 1 &&
      validateHistorySelection(history.selectionSet, readKind)
    )
  }

  if (
    !hasExactArguments(history, ['first', 'path']) ||
    pathArgument?.value.kind !== Kind.STRING ||
    firstValue !== (readKind === 'content-metadata' ? 1 : 100)
  ) {
    return false
  }

  const path = normalizeCmsPath(pathArgument.value.value)

  return (
    !!path &&
    path === pathArgument.value.value &&
    isAllowedCmsWritePath(path) &&
    validateHistorySelection(history.selectionSet, readKind)
  )
}

function validateHistorySelection(
  selectionSet: SelectionSetNode,
  readKind: SveltiaRefReadKind,
) {
  if (selectionSet.selections.length !== 1) return false

  const nodes = selectionSet.selections[0]

  return (
    nodes.kind === Kind.FIELD &&
    nodes.name.value === 'nodes' &&
    !nodes.alias &&
    !nodes.arguments?.length &&
    !nodes.directives?.length &&
    !!nodes.selectionSet &&
    validateCommitNodeSelection(nodes.selectionSet, readKind)
  )
}

function validateCommitNodeSelection(
  selectionSet: SelectionSetNode,
  readKind: SveltiaRefReadKind,
) {
  const expectedFields =
    readKind === 'head'
      ? new Set(['oid', 'message'])
      : readKind === 'content-metadata'
        ? new Set(['author', 'committedDate'])
        : new Set(['oid', 'author', 'committedDate'])

  if (selectionSet.selections.length !== expectedFields.size) return false

  const selectedFields = new Set<string>()

  return selectionSet.selections.every((selection) => {
    if (
      selection.kind !== Kind.FIELD ||
      selection.alias ||
      selection.directives?.length
    ) {
      return false
    }

    if (selectedFields.has(selection.name.value)) return false
    selectedFields.add(selection.name.value)

    if (
      selection.name.value !== 'author' &&
      expectedFields.has(selection.name.value)
    ) {
      return !selection.arguments?.length && !selection.selectionSet
    }

    if (
      readKind === 'head' ||
      selection.name.value !== 'author' ||
      !expectedFields.has('author')
    ) {
      return false
    }

    return (
      !selection.arguments?.length &&
      !!selection.selectionSet &&
      validateAuthorSelection(selection.selectionSet, readKind)
    )
  })
}

function validateAuthorSelection(
  selectionSet: SelectionSetNode,
  readKind: Exclude<SveltiaRefReadKind, 'head'>,
) {
  const expectedFields =
    readKind === 'content-metadata'
      ? new Set(['name', 'email', 'user'])
      : new Set(['name', 'email', 'avatarUrl', 'user'])

  if (selectionSet.selections.length !== expectedFields.size) return false

  const selectedFields = new Set<string>()

  return selectionSet.selections.every((selection) => {
    if (
      selection.kind !== Kind.FIELD ||
      selection.alias ||
      selection.directives?.length
    ) {
      return false
    }

    if (selectedFields.has(selection.name.value)) return false
    selectedFields.add(selection.name.value)

    if (
      selection.name.value !== 'user' &&
      expectedFields.has(selection.name.value)
    ) {
      return !selection.arguments?.length && !selection.selectionSet
    }

    if (
      selection.name.value !== 'user' ||
      !expectedFields.has('user') ||
      selection.alias
    ) {
      return false
    }

    return (
      !selection.arguments?.length &&
      !!selection.selectionSet &&
      validateAuthorUserSelection(selection.selectionSet, readKind)
    )
  })
}

function validateAuthorUserSelection(
  selectionSet: SelectionSetNode,
  readKind: Exclude<SveltiaRefReadKind, 'head'>,
) {
  if (readKind === 'file-history') {
    return (
      selectionSet.selections.length === 1 &&
      validateLeafSelection(selectionSet, ['login'])
    )
  }

  if (selectionSet.selections.length !== 2) return false

  const responseNames = new Set<string>()

  return selectionSet.selections.every((selection) => {
    if (
      selection.kind !== Kind.FIELD ||
      selection.arguments?.length ||
      selection.directives?.length ||
      selection.selectionSet
    ) {
      return false
    }

    const responseName = selection.alias?.value || selection.name.value

    if (responseNames.has(responseName)) return false
    responseNames.add(responseName)

    return (
      (selection.name.value === 'databaseId' &&
        selection.alias?.value === 'id') ||
      (selection.name.value === 'login' && !selection.alias)
    )
  })
}

function validateLeafSelection(
  selectionSet: SelectionSetNode,
  allowedNames: string[],
) {
  const allowed = new Set(allowedNames)

  return (
    selectionSet.selections.length > 0 &&
    selectionSet.selections.every((selection) => {
      return (
        selection.kind === Kind.FIELD &&
        allowed.has(selection.name.value) &&
        !selection.alias &&
        !selection.arguments?.length &&
        !selection.directives?.length &&
        !selection.selectionSet
      )
    })
  )
}

function isCmsCommitOperation(
  operation: OperationDefinitionNode,
  variables: Record<string, unknown>,
) {
  if (
    operation.operation !== 'mutation' ||
    operation.directives?.length ||
    operation.selectionSet.selections.length !== 1 ||
    Object.keys(variables).length !== 1 ||
    !Object.hasOwn(variables, 'input')
  ) {
    return false
  }

  const root = operation.selectionSet.selections[0]

  if (
    root.kind !== Kind.FIELD ||
    root.name.value !== 'createCommitOnBranch' ||
    root.alias ||
    root.directives?.length ||
    !root.selectionSet ||
    !hasExactArguments(root, ['input'])
  ) {
    return false
  }

  const input = getArgument(root, 'input')?.value

  return input?.kind === Kind.VARIABLE && input.name.value === 'input'
}

function parseCmsCommitInput(
  value: unknown,
): { ok: true; value: CmsCommitInput } | { ok: false; message: string } {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'branch',
      'expectedHeadOid',
      'fileChanges',
      'message',
    ]) ||
    !isRecord(value.branch) ||
    !hasOnlyKeys(value.branch, ['repositoryNameWithOwner', 'branchName']) ||
    value.branch.repositoryNameWithOwner !==
      `${CMS_REPOSITORY.owner}/${CMS_REPOSITORY.name}` ||
    value.branch.branchName !== CMS_REPOSITORY.branch ||
    typeof value.expectedHeadOid !== 'string' ||
    !SHA_PATTERN.test(value.expectedHeadOid) ||
    !isRecord(value.fileChanges) ||
    !hasOnlyKeys(value.fileChanges, ['additions', 'deletions']) ||
    !isRecord(value.message) ||
    !hasOnlyKeys(value.message, ['headline']) ||
    typeof value.message.headline !== 'string' ||
    value.message.headline.length > 500
  ) {
    return {
      ok: false,
      message: 'CMS commit inputが不正です。',
    }
  }

  const additionsValue = value.fileChanges.additions ?? []
  const deletionsValue = value.fileChanges.deletions ?? []

  if (!Array.isArray(additionsValue) || !Array.isArray(deletionsValue)) {
    return { ok: false, message: 'CMS file changesが不正です。' }
  }

  if (
    additionsValue.length + deletionsValue.length === 0 ||
    additionsValue.length + deletionsValue.length > MAX_CHANGE_COUNT
  ) {
    return {
      ok: false,
      message: `1回の保存は1件以上${MAX_CHANGE_COUNT}件以下にしてください。`,
    }
  }

  const additions: ValidatedCmsAddition[] = []
  const deletions: CmsDeletion[] = []
  const paths = new Set<string>()
  let totalContentBytes = 0

  for (const addition of additionsValue) {
    if (
      !isRecord(addition) ||
      !hasOnlyKeys(addition, ['path', 'contents']) ||
      typeof addition.path !== 'string' ||
      typeof addition.contents !== 'string'
    ) {
      return { ok: false, message: 'CMS追加ファイルが不正です。' }
    }

    const path = normalizeCmsPath(addition.path)

    if (
      !path ||
      path !== addition.path ||
      !isAllowedCmsWritePath(path) ||
      paths.has(path)
    ) {
      return {
        ok: false,
        message: 'CMS管理対象外または重複した追加pathです。',
      }
    }

    const validation = validateCmsAddition(path, addition.contents)

    if (!validation.ok) {
      return {
        ok: false,
        message: `${path}: ${validation.message}`,
      }
    }

    totalContentBytes += validation.addition.byteSize

    if (totalContentBytes > MAX_TOTAL_CONTENT_BYTES) {
      return {
        ok: false,
        message: '1回に保存できるファイル合計は10 MiBまでです。',
      }
    }

    paths.add(path)
    additions.push(validation.addition)
  }

  for (const deletion of deletionsValue) {
    if (
      !isRecord(deletion) ||
      !hasOnlyKeys(deletion, ['path']) ||
      typeof deletion.path !== 'string'
    ) {
      return { ok: false, message: 'CMS削除ファイルが不正です。' }
    }

    const path = normalizeCmsPath(deletion.path)

    if (
      !path ||
      path !== deletion.path ||
      !isAllowedCmsDeletePath(path) ||
      paths.has(path)
    ) {
      return {
        ok: false,
        message: 'CMS管理対象外または重複した削除pathです。',
      }
    }

    paths.add(path)
    deletions.push({ path })
  }

  return {
    ok: true,
    value: {
      expectedHeadOid: value.expectedHeadOid,
      additions,
      deletions,
    },
  }
}

type PublicationBranchState =
  | { kind: 'missing' }
  | { kind: 'base' }
  | {
      kind: 'commit'
      commitOid: string
      result: Record<string, unknown>
    }

async function ensurePublicationCommit({
  commitInput,
  reservation,
  token,
}: {
  commitInput: CmsCommitInput
  reservation: CmsMutationReservation
  token: string
}) {
  let state = await inspectPublicationBranch(reservation, commitInput, token)

  if (state.kind === 'missing') {
    try {
      const expectedRef = `refs/heads/${reservation.publicationBranch}`
      const created = await githubJson<unknown>({
        body: {
          ref: expectedRef,
          sha: reservation.expectedHeadOid,
        },
        method: 'POST',
        path: `/repos/${CMS_REPOSITORY.owner}/${CMS_REPOSITORY.name}/git/refs`,
        token,
      })

      if (
        !isRecord(created) ||
        created.ref !== expectedRef ||
        getGitRefSha(created) !== reservation.expectedHeadOid
      ) {
        throw new GitHubApiError('GitHub branch作成結果を確認できません。', 502)
      }

      state = { kind: 'base' }
    } catch (error) {
      if (!(error instanceof GitHubApiError) || error.status !== 422) {
        throw error
      }

      state = await inspectPublicationBranch(reservation, commitInput, token)

      if (state.kind === 'missing') {
        throw new GitHubApiError(
          'GitHubにCMS保存用branchを作成できませんでした。',
          502,
        )
      }
    }
  }

  if (state.kind === 'commit') return state.result

  if (state.kind !== 'base') {
    throw new GitHubApiError('CMS保存用branchを作成できませんでした。', 409)
  }

  return await commitChanges({
    branch: reservation.publicationBranch,
    commitInput,
    expectedHeadOid: reservation.expectedHeadOid,
    reservation,
    token,
  })
}

async function inspectPublicationBranch(
  reservation: CmsMutationReservation,
  commitInput: CmsCommitInput,
  token: string,
): Promise<PublicationBranchState> {
  const ref = await getOptionalGitRef(reservation.publicationBranch, token)

  if (!ref) return { kind: 'missing' }
  if (ref === reservation.expectedHeadOid) return { kind: 'base' }

  const commit = await githubJson<unknown>({
    path: `/repos/${CMS_REPOSITORY.owner}/${CMS_REPOSITORY.name}/git/commits/${encodeURIComponent(ref)}`,
    token,
  })

  if (
    !isRecord(commit) ||
    commit.sha !== ref ||
    typeof commit.message !== 'string' ||
    !commit.message.split(/\r?\n/gu).includes(reservation.commitMarker) ||
    !Array.isArray(commit.parents) ||
    commit.parents.length !== 1 ||
    !isRecord(commit.parents[0]) ||
    commit.parents[0].sha !== reservation.expectedHeadOid
  ) {
    throw new CmsStateError(
      'CMS保存用branchのcommitをidempotency markerで照合できません。',
      409,
    )
  }

  if (!(await verifyPublicationCommit(ref, commitInput, token))) {
    throw new CmsStateError(
      'CMS保存用branchのcommit内容をpathとblob SHAで照合できません。',
      409,
    )
  }

  const committedDate =
    isRecord(commit.committer) && typeof commit.committer.date === 'string'
      ? commit.committer.date
      : null

  return {
    kind: 'commit',
    commitOid: ref,
    result: recoveredCommitResult(ref, committedDate),
  }
}

async function verifyPublicationCommit(
  commitOid: string,
  commitInput: CmsCommitInput,
  token: string,
) {
  const details = await githubJson<unknown>({
    path: `/repos/${CMS_REPOSITORY.owner}/${CMS_REPOSITORY.name}/commits/${commitOid}?per_page=100`,
    token,
  })

  if (
    !isRecord(details) ||
    details.sha !== commitOid ||
    !Array.isArray(details.files)
  ) {
    throw new GitHubApiError('GitHub commit responseが不正です。', 502)
  }

  const actualPaths = new Set<string>()

  for (const file of details.files) {
    if (
      !isRecord(file) ||
      typeof file.filename !== 'string' ||
      normalizeCmsPath(file.filename) !== file.filename
    ) {
      throw new GitHubApiError('GitHub commit files responseが不正です。', 502)
    }

    actualPaths.add(file.filename)

    if (file.status === 'renamed') {
      if (
        typeof file.previous_filename !== 'string' ||
        normalizeCmsPath(file.previous_filename) !== file.previous_filename
      ) {
        throw new GitHubApiError(
          'GitHub renamed file responseが不正です。',
          502,
        )
      }

      actualPaths.add(file.previous_filename)
    }
  }

  const expectedPaths = new Set([
    ...commitInput.additions.map(({ path }) => path),
    ...commitInput.deletions.map(({ path }) => path),
  ])

  if (
    actualPaths.size !== expectedPaths.size ||
    Array.from(expectedPaths).some((path) => !actualPaths.has(path))
  ) {
    return false
  }

  const tree = await fetchCmsTree(token, commitOid)
  const blobShas = new Map(
    tree.tree
      .filter((item) => item.type === 'blob')
      .map((item) => [item.path, item.sha]),
  )

  for (const addition of commitInput.additions) {
    if (blobShas.get(addition.path) !== (await getGitBlobOid(addition))) {
      return false
    }
  }

  return commitInput.deletions.every(({ path }) => !blobShas.has(path))
}

async function getGitBlobOid(addition: ValidatedCmsAddition) {
  const header = new TextEncoder().encode(`blob ${addition.byteSize}\0`)
  const object = new Uint8Array(header.byteLength + addition.byteSize)

  object.set(header)
  decodeBase64Into(addition.contents, object, header.byteLength)

  const digest = await crypto.subtle.digest('SHA-1', object)

  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
}

function decodeBase64Into(
  value: string,
  destination: Uint8Array,
  offset: number,
) {
  let accumulator = 0
  let bitCount = 0
  let outputIndex = offset

  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)

    if (code === 61) break

    const decoded = decodeBase64Char(code)

    if (decoded < 0) {
      throw new GitHubApiError('CMS base64 dataが不正です。', 400)
    }

    accumulator = (accumulator << 6) | decoded
    bitCount += 6

    if (bitCount < 8) continue

    bitCount -= 8
    destination[outputIndex] = (accumulator >> bitCount) & 0xff
    outputIndex += 1
    accumulator &= (1 << bitCount) - 1
  }

  if (outputIndex !== destination.byteLength) {
    throw new GitHubApiError('CMS base64 sizeが不正です。', 400)
  }
}

function decodeBase64Char(code: number) {
  if (code >= 65 && code <= 90) return code - 65
  if (code >= 97 && code <= 122) return code - 71
  if (code >= 48 && code <= 57) return code + 4
  if (code === 43) return 62
  if (code === 47) return 63

  return -1
}

async function getOptionalGitRef(branch: string, token: string) {
  try {
    const value = await githubJson<unknown>({
      path: branchRefPath(branch),
      token,
    })
    const sha = getGitRefSha(value)

    if (!sha) {
      throw new GitHubApiError('GitHub branch responseが不正です。', 502)
    }

    return sha
  } catch (error) {
    if (error instanceof GitHubApiError && error.status === 404) return null

    throw error
  }
}

async function reconcilePublication({
  commitInput,
  reservation,
  token,
}: {
  commitInput: CmsCommitInput
  reservation: CmsMutationReservation
  token: string
}) {
  const staged = await inspectPublicationBranch(reservation, commitInput, token)

  if (staged.kind !== 'commit') {
    return { kind: 'retry' as const }
  }

  await publishDirectCommit({
    commitOid: staged.commitOid,
    expectedHeadOid: reservation.expectedHeadOid,
    token,
  })

  return {
    kind: 'published' as const,
    branch: CMS_REPOSITORY.branch,
    commitOid: staged.commitOid,
    response: withCmsExtension(staged.result, {
      branch: CMS_REPOSITORY.branch,
      mode: 'direct',
    }),
  }
}

async function publishDirectCommit({
  commitOid,
  expectedHeadOid,
  token,
}: {
  commitOid: string
  expectedHeadOid: string
  token: string
}) {
  const mainRef = await githubJson<unknown>({
    path: branchRefPath(CMS_REPOSITORY.branch),
    token,
  })
  const mainSha = getGitRefSha(mainRef)

  if (!mainSha) {
    throw new GitHubApiError('GitHub branch responseが不正です。', 502)
  }

  if (mainSha === commitOid) return

  if (mainSha !== expectedHeadOid) {
    const comparison = await githubJson<unknown>({
      path: `/repos/${CMS_REPOSITORY.owner}/${CMS_REPOSITORY.name}/compare/${encodeURIComponent(commitOid)}...${encodeURIComponent(mainSha)}`,
      token,
    })

    if (
      isRecord(comparison) &&
      (comparison.status === 'ahead' || comparison.status === 'identical')
    ) {
      return
    }

    throw new CmsDefinitivePublicationError(
      'mainが別の履歴へ進んだため、CMS commitを自動反映できません。',
      409,
    )
  }

  const updated = await githubJson<unknown>({
    body: {
      sha: commitOid,
      force: false,
    },
    method: 'PATCH',
    path: `/repos/${CMS_REPOSITORY.owner}/${CMS_REPOSITORY.name}/git/refs/heads/${CMS_REPOSITORY.branch}`,
    token,
  })

  if (getGitRefSha(updated) !== commitOid) {
    throw new GitHubApiError('mainの更新結果を確認できません。', 502)
  }
}

function recoveredCommitResult(
  commitOid: string,
  committedDate: string | null,
) {
  return {
    data: {
      createCommitOnBranch: {
        commit: {
          oid: commitOid,
          committedDate,
        },
      },
    },
  }
}

function branchRefPath(branch: string) {
  const encodedBranch = branch.split('/').map(encodeURIComponent).join('/')

  return `/repos/${CMS_REPOSITORY.owner}/${CMS_REPOSITORY.name}/git/ref/heads/${encodedBranch}`
}

async function deleteCmsBranch(branch: string, token: string) {
  try {
    const encodedBranch = branch.split('/').map(encodeURIComponent).join('/')
    const response = await githubRequest({
      method: 'DELETE',
      path: `/repos/${CMS_REPOSITORY.owner}/${CMS_REPOSITORY.name}/git/refs/heads/${encodedBranch}`,
      token,
    })

    if (!response.ok && response.status !== 404) {
      console.error(
        JSON.stringify({
          message: 'Failed to remove CMS branch',
          branch,
          status: response.status,
        }),
      )
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        message: 'Failed to remove CMS branch',
        branch,
        error: error instanceof Error ? error.message : String(error),
      }),
    )
  }
}

function buildCmsCommitMutation(additions: ValidatedCmsAddition[]) {
  const fileShaQuery = additions
    .map(({ path, byteSize }, index) => {
      return byteSize <= MAX_GRAPHQL_BLOB_SIZE
        ? `file_${index}: file(path: ${JSON.stringify(path)}) { oid }`
        : ''
    })
    .filter(Boolean)
    .join('\n')

  return `
    mutation CmsCommit($input: CreateCommitOnBranchInput!) {
      createCommitOnBranch(input: $input) {
        commit {
          oid
          committedDate
          ${fileShaQuery}
        }
      }
    }
  `
}

function ensureCommitSucceeded(result: Record<string, unknown>) {
  if (Array.isArray(result.errors) && result.errors.length > 0) {
    const firstError = result.errors[0]
    const message =
      isRecord(firstError) && typeof firstError.message === 'string'
        ? firstError.message
        : 'GitHub GraphQL mutationが失敗しました。'

    throw new GitHubApiError(message, 502)
  }

  if (
    !isRecord(result.data) ||
    !isRecord(result.data.createCommitOnBranch) ||
    !isRecord(result.data.createCommitOnBranch.commit) ||
    typeof result.data.createCommitOnBranch.commit.oid !== 'string' ||
    !SHA_PATTERN.test(result.data.createCommitOnBranch.commit.oid)
  ) {
    throw new GitHubApiError(
      'GitHub GraphQL mutation responseが不正です。',
      502,
    )
  }
}

function withCmsExtension(
  result: Record<string, unknown>,
  cms: Record<string, unknown>,
) {
  const extensions = isRecord(result.extensions) ? result.extensions : {}

  return {
    ...result,
    extensions: {
      ...extensions,
      cms,
    },
  }
}

function parseGraphqlPayload(text: string): GraphqlPayload | null {
  try {
    const value: unknown = JSON.parse(text)

    if (
      !isRecord(value) ||
      !hasOnlyKeys(value, ['query', 'variables', 'operationName']) ||
      typeof value.query !== 'string' ||
      (value.variables !== undefined && !isRecord(value.variables)) ||
      (value.operationName !== undefined &&
        value.operationName !== null &&
        typeof value.operationName !== 'string')
    ) {
      return null
    }

    return {
      query: value.query,
      variables: value.variables || {},
    }
  } catch {
    return null
  }
}

function parseOperation(query: string) {
  try {
    const document = parse(query)

    if (document.definitions.length !== 1) return null

    const definition = document.definitions[0]

    return definition.kind === Kind.OPERATION_DEFINITION ? definition : null
  } catch {
    return null
  }
}

function variablesMatchDefinitions(
  operation: OperationDefinitionNode,
  variables: Record<string, unknown>,
) {
  const defined = new Set(
    (operation.variableDefinitions || []).map(
      ({ variable }) => variable.name.value,
    ),
  )

  return Object.keys(variables).every((name) => defined.has(name))
}

function hasExactArguments(field: FieldNode, names: string[]) {
  const argumentsList = field.arguments || []

  return (
    argumentsList.length === names.length &&
    new Set(argumentsList.map(({ name }) => name.value)).size ===
      names.length &&
    names.every((name) => argumentsList.some((arg) => arg.name.value === name))
  )
}

function argumentMatches(
  field: FieldNode,
  name: string,
  expected: string,
  variables: Record<string, unknown>,
) {
  return getArgumentString(field, name, variables) === expected
}

function getArgument(field: FieldNode, name: string): ArgumentNode | undefined {
  return field.arguments?.find((argument) => argument.name.value === name)
}

function getArgumentString(
  field: FieldNode,
  name: string,
  variables: Record<string, unknown>,
) {
  const value = getArgument(field, name)?.value

  return value ? resolveStringValue(value, variables) : null
}

function resolveStringValue(
  value: ValueNode,
  variables: Record<string, unknown>,
) {
  if (value.kind === Kind.STRING) return value.value

  if (value.kind === Kind.VARIABLE) {
    const variable = variables[value.name.value]

    return typeof variable === 'string' ? variable : null
  }

  return null
}

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: string[]) {
  const allowed = new Set(allowedKeys)

  return Object.keys(value).every((key) => allowed.has(key))
}

function buildCommitHeadline(changedPaths: string[]) {
  const extraCount = changedPaths.length - 1

  return (
    `cms: update ${summarizePath(changedPaths[0])}` +
    `${extraCount > 0 ? ` (+${extraCount})` : ''}`
  )
}

function summarizePath(path: string) {
  return path.length > 200 ? `${path.slice(0, 197)}...` : path
}

function getGitRefSha(value: unknown) {
  if (!isRecord(value) || !isRecord(value.object)) return null

  return typeof value.object.sha === 'string' &&
    SHA_PATTERN.test(value.object.sha)
    ? value.object.sha
    : null
}

function getCommitOid(result: Record<string, unknown>) {
  const data = result.data

  if (
    !isRecord(data) ||
    !isRecord(data.createCommitOnBranch) ||
    !isRecord(data.createCommitOnBranch.commit) ||
    typeof data.createCommitOnBranch.commit.oid !== 'string' ||
    !SHA_PATTERN.test(data.createCommitOnBranch.commit.oid)
  ) {
    throw new GitHubApiError(
      'GitHub commit responseからcommit OIDを取得できません。',
      502,
    )
  }

  return data.createCommitOnBranch.commit.oid
}

function validateBrowserRequestBoundary(request: Request) {
  const requestUrl = new URL(request.url)
  const origin = request.headers.get('Origin')
  const contentType = request.headers
    .get('Content-Type')
    ?.split(';', 1)[0]
    .trim()
    .toLowerCase()
  const fetchSite = request.headers.get('Sec-Fetch-Site')?.trim().toLowerCase()

  if (origin !== requestUrl.origin) {
    return json({ message: 'CMS GraphQL requestのoriginが不正です。' }, 403)
  }

  if (fetchSite && fetchSite !== 'same-origin') {
    return json(
      { message: 'CMS GraphQL requestはsame-originに限定されています。' },
      403,
    )
  }

  if (contentType !== 'application/json') {
    return json(
      { message: 'CMS GraphQL requestはapplication/jsonで送信してください。' },
      415,
    )
  }

  return null
}

async function readRequestText(request: Request) {
  const contentLength = Number(request.headers.get('Content-Length') || 0)

  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    return null
  }

  if (!request.body) return ''

  const reader = request.body.getReader()
  const decoder = new TextDecoder('utf-8', {
    fatal: true,
    ignoreBOM: false,
  })
  const chunks: string[] = []
  let totalBytes = 0

  try {
    while (true) {
      const { done, value } = await reader.read()

      if (done) break

      totalBytes += value.byteLength

      if (totalBytes > MAX_REQUEST_BYTES) {
        await reader.cancel().catch(() => undefined)
        return null
      }

      chunks.push(decoder.decode(value, { stream: true }))
    }

    chunks.push(decoder.decode())
    return chunks.join('')
  } catch {
    return null
  } finally {
    reader.releaseLock()
  }
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
      message: 'CMS GraphQL proxy failed',
      error: error instanceof Error ? error.message : String(error),
    }),
  )

  return json({ message: 'CMS GraphQL proxyでエラーが発生しました。' }, 500)
}

function describeMutationFailure(error: unknown) {
  if (error instanceof CmsStateError || error instanceof GitHubApiError) {
    return {
      message: error.message,
      status: error.status,
    }
  }

  return {
    message: 'CMS保存処理で予期しないエラーが発生しました。',
    status: 500,
  }
}

function mutationResponseHeaders(reservation: { requestId: string }) {
  return {
    'X-CMS-Audit-Status': 'recorded',
    'X-Request-ID': reservation.requestId,
  }
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
