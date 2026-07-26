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
  isAllowedCmsWritePath,
  normalizeCmsPath,
  sanitizeCmsBranchPart,
  type CmsRuntimeEnv,
} from './_cms-policy.ts'
import { getAccessIdentity, type AccessIdentity } from './_access-auth.ts'
import {
  validateCmsAddition,
  type ValidatedCmsAddition,
} from './_content-validation.ts'
import {
  GitHubApiError,
  copyGitHubResponse,
  fetchCmsTree,
  getAllowedCmsBlobShas,
  getGitHubToken,
  githubJson,
  githubRequest,
  isRecord,
} from './_github-api.ts'

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
type PublicationMode = 'direct' | 'review'

const SHA_PATTERN = /^[a-f0-9]{40}$/iu
const MAX_GRAPHQL_QUERY_CHARS = 128 * 1024
const MAX_REQUEST_BYTES = 16 * 1024 * 1024
const MAX_CHANGE_COUNT = 40
const MAX_TOTAL_CONTENT_BYTES = 10 * 1024 * 1024
const MAX_GRAPHQL_BLOB_SIZE = 10 * 1024 * 1024

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
      const publicationMode = getPublicationMode(env.CMS_PUBLICATION_MODE)

      if (!publicationMode) {
        return json({ message: 'CMS publication modeの設定が不正です。' }, 503)
      }

      return await handleCommitMutation({
        auth,
        env,
        operation,
        payload,
        publicationMode,
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
  const authorization = validateReadOperation(operation, payload.variables)

  if (!authorization) {
    return json({ message: 'CMSで許可されていないGraphQL queryです。' }, 403)
  }

  const token = await getGitHubToken(env)

  if (authorization.blobShas.size > 0) {
    const tree = await fetchCmsTree(token)
    const allowedShas = getAllowedCmsBlobShas(tree)

    if (
      Array.from(authorization.blobShas).some((sha) => !allowedShas.has(sha))
    ) {
      return json({ message: 'CMS管理対象外のGit blobです。' }, 403)
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

  return copyGitHubResponse(response)
}

async function handleCommitMutation({
  auth,
  env,
  operation,
  payload,
  publicationMode,
}: {
  auth: AuthenticatedIdentity
  env: CmsRuntimeEnv
  operation: OperationDefinitionNode
  payload: GraphqlPayload
  publicationMode: PublicationMode
}) {
  if (!isCmsCommitOperation(operation, payload.variables)) {
    return json({ message: 'CMSで許可されていないGraphQL mutationです。' }, 403)
  }

  const parsed = parseCmsCommitInput(payload.variables.input)

  if (!parsed.ok) {
    return json({ message: parsed.message }, 403)
  }

  const commitInput = parsed.value
  const token = await getGitHubToken(env)
  const mainRef = await githubJson<unknown>({
    path: `/repos/${CMS_REPOSITORY.owner}/${CMS_REPOSITORY.name}/git/ref/heads/${CMS_REPOSITORY.branch}`,
    token,
  })
  const mainSha = getGitRefSha(mainRef)

  if (!mainSha) {
    throw new GitHubApiError('GitHub branch responseが不正です。', 502)
  }

  if (mainSha !== commitInput.expectedHeadOid) {
    return json(
      {
        message:
          'mainが更新されています。CMSを再読み込みしてから、もう一度保存してください。',
      },
      409,
    )
  }

  const changedPaths = [
    ...commitInput.additions.map(({ path }) => path),
    ...commitInput.deletions.map(({ path }) => path),
  ]

  if (publicationMode === 'direct') {
    const result = await commitChanges({
      branch: CMS_REPOSITORY.branch,
      commitInput,
      discordId: auth.discordId,
      expectedHeadOid: mainSha,
      token,
    })

    return json(
      withCmsExtension(result, {
        branch: CMS_REPOSITORY.branch,
        mode: 'direct',
      }),
    )
  }

  const branch = await createCmsBranch({
    baseSha: mainSha,
    primaryPath: changedPaths[0],
    token,
  })

  try {
    const result = await commitChanges({
      branch,
      commitInput,
      discordId: auth.discordId,
      expectedHeadOid: mainSha,
      token,
    })
    const pullRequest = await openPullRequest({
      branch,
      changedPaths,
      discordId: auth.discordId,
      token,
    })

    return json(
      withCmsExtension(result, {
        branch,
        mode: 'review',
        pull_request: {
          number: pullRequest.number,
          html_url: pullRequest.html_url,
        },
      }),
    )
  } catch (error) {
    await deleteCmsBranch(branch, token)
    throw error
  }
}

async function commitChanges({
  branch,
  commitInput,
  discordId,
  expectedHeadOid,
  token,
}: {
  branch: string
  commitInput: CmsCommitInput
  discordId: string
  expectedHeadOid: string
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
            body: `Discord user ID: ${discordId}`,
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

  const authorization = { blobShas: new Set<string>() }

  return validateRepositorySelection(
    root.selectionSet,
    variables,
    authorization,
  )
    ? authorization
    : null
}

function validateRepositorySelection(
  selectionSet: SelectionSetNode,
  variables: Record<string, unknown>,
  authorization: { blobShas: Set<string> },
) {
  if (
    selectionSet.selections.length === 0 ||
    selectionSet.selections.length > 100
  ) {
    return false
  }

  return selectionSet.selections.every((selection) => {
    if (selection.kind !== Kind.FIELD || selection.directives?.length) {
      return false
    }

    if (selection.name.value === 'defaultBranchRef') {
      return (
        !selection.arguments?.length &&
        !!selection.selectionSet &&
        validateLeafSelection(selection.selectionSet, ['name'])
      )
    }

    if (selection.name.value === 'ref') {
      return (
        !!selection.selectionSet &&
        hasExactArguments(selection, ['qualifiedName']) &&
        argumentMatches(
          selection,
          'qualifiedName',
          CMS_REPOSITORY.branch,
          variables,
        ) &&
        validateRefSelection(selection.selectionSet)
      )
    }

    if (selection.name.value === 'object') {
      const oid = getArgumentString(selection, 'oid', variables)

      if (
        !oid ||
        !SHA_PATTERN.test(oid) ||
        authorization.blobShas.has(oid) ||
        !selection.selectionSet ||
        !hasExactArguments(selection, ['oid']) ||
        !validateBlobObjectSelection(selection.selectionSet)
      ) {
        return false
      }

      authorization.blobShas.add(oid)
      return true
    }

    return false
  })
}

function validateRefSelection(selectionSet: SelectionSetNode) {
  if (selectionSet.selections.length !== 1) return false

  const target = selectionSet.selections[0]

  return (
    target.kind === Kind.FIELD &&
    target.name.value === 'target' &&
    !target.alias &&
    !target.arguments?.length &&
    !target.directives?.length &&
    !!target.selectionSet &&
    validateTypedSelection(
      target.selectionSet,
      'Commit',
      validateCommitSelection,
    )
  )
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

function validateCommitSelection(selectionSet: SelectionSetNode) {
  if (
    selectionSet.selections.length === 0 ||
    selectionSet.selections.length > 100
  ) {
    return false
  }

  return selectionSet.selections.every((selection) => {
    if (
      selection.kind !== Kind.FIELD ||
      selection.alias ||
      selection.name.value !== 'history' ||
      selection.directives?.length ||
      !selection.selectionSet
    ) {
      return false
    }

    const argumentNames = (selection.arguments || []).map(
      ({ name }) => name.value,
    )

    if (
      !argumentNames.includes('first') ||
      argumentNames.some((name) => name !== 'first' && name !== 'path') ||
      new Set(argumentNames).size !== argumentNames.length
    ) {
      return false
    }

    const first = getArgument(selection, 'first')?.value

    if (first?.kind !== Kind.INT) return false

    const firstValue = Number(first.value)
    const pathArgument = getArgument(selection, 'path')

    if (!pathArgument) {
      return (
        firstValue === 1 &&
        validateHistorySelection(selection.selectionSet, 'head')
      )
    }

    if (
      !Number.isInteger(firstValue) ||
      firstValue < 1 ||
      firstValue > 100 ||
      pathArgument.value.kind !== Kind.STRING
    ) {
      return false
    }

    const path = normalizeCmsPath(pathArgument.value.value)

    if (
      !path ||
      path !== pathArgument.value.value ||
      !isAllowedCmsWritePath(path)
    ) {
      return false
    }

    return validateHistorySelection(selection.selectionSet, 'file')
  })
}

function validateHistorySelection(
  selectionSet: SelectionSetNode,
  historyKind: 'file' | 'head',
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
    validateCommitNodeSelection(nodes.selectionSet, historyKind)
  )
}

function validateCommitNodeSelection(
  selectionSet: SelectionSetNode,
  historyKind: 'file' | 'head',
) {
  const leafFields =
    historyKind === 'head'
      ? new Set(['oid', 'message'])
      : new Set(['oid', 'committedDate'])

  if (selectionSet.selections.length === 0) return false

  return selectionSet.selections.every((selection) => {
    if (
      selection.kind !== Kind.FIELD ||
      selection.alias ||
      selection.directives?.length
    ) {
      return false
    }

    if (leafFields.has(selection.name.value)) {
      return !selection.arguments?.length && !selection.selectionSet
    }

    if (historyKind === 'head' || selection.name.value !== 'author') {
      return false
    }

    return (
      !selection.arguments?.length &&
      !!selection.selectionSet &&
      validateAuthorSelection(selection.selectionSet)
    )
  })
}

function validateAuthorSelection(selectionSet: SelectionSetNode) {
  const leafFields = new Set(['name', 'email', 'avatarUrl'])

  if (selectionSet.selections.length === 0) return false

  return selectionSet.selections.every((selection) => {
    if (
      selection.kind !== Kind.FIELD ||
      selection.alias ||
      selection.directives?.length
    ) {
      return false
    }

    if (leafFields.has(selection.name.value)) {
      return !selection.arguments?.length && !selection.selectionSet
    }

    if (selection.name.value !== 'user') return false

    return (
      !selection.arguments?.length &&
      !!selection.selectionSet &&
      validateLeafSelection(selection.selectionSet, ['databaseId', 'login'])
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
      !isAllowedCmsWritePath(path) ||
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

async function createCmsBranch({
  baseSha,
  primaryPath,
  token,
}: {
  baseSha: string
  primaryPath: string
  token: string
}) {
  const base = sanitizeCmsBranchPart(primaryPath)

  for (let index = 0; index < 3; index += 1) {
    const id = crypto.randomUUID().slice(0, 8)
    const branch = `cms/asv/${timestamp()}-${base}-${id}`

    try {
      await githubJson({
        body: {
          ref: `refs/heads/${branch}`,
          sha: baseSha,
        },
        method: 'POST',
        path: `/repos/${CMS_REPOSITORY.owner}/${CMS_REPOSITORY.name}/git/refs`,
        token,
      })

      return branch
    } catch (error) {
      if (!(error instanceof GitHubApiError) || error.status !== 422) {
        throw error
      }
    }
  }

  throw new GitHubApiError('CMS保存用branchを作成できませんでした。', 409)
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

async function openPullRequest({
  branch,
  changedPaths,
  discordId,
  token,
}: {
  branch: string
  changedPaths: string[]
  discordId: string
  token: string
}) {
  const primaryPath = summarizePath(changedPaths[0])
  const extraCount = changedPaths.length - 1
  const title =
    `cms: update ${primaryPath}` +
    `${extraCount > 0 ? ` (+${extraCount})` : ''}`
  const result = await githubJson<unknown>({
    body: {
      base: CMS_REPOSITORY.branch,
      body: [
        'Sveltia CMSの保存をDiscord認証済みユーザーから受け付けました。',
        '',
        `- Discord user ID: ${discordId}`,
        '- Files:',
        ...changedPaths.map((path) => `  - \`${path}\``),
        '',
        '画像とMarkdownは同じcommitに含まれています。',
        'CIでschema、content、buildを確認してからmainに取り込んでください。',
      ].join('\n'),
      head: branch,
      title,
    },
    method: 'POST',
    path: `/repos/${CMS_REPOSITORY.owner}/${CMS_REPOSITORY.name}/pulls`,
    token,
  })

  if (
    !isRecord(result) ||
    typeof result.number !== 'number' ||
    typeof result.html_url !== 'string'
  ) {
    throw new GitHubApiError('GitHub pull request responseが不正です。', 502)
  }

  return {
    number: result.number,
    html_url: result.html_url,
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

function getPublicationMode(value: string | undefined): PublicationMode | null {
  const normalized = value?.trim().toLowerCase()

  if (normalized === 'review') return 'review'
  if (normalized === 'direct') return 'direct'

  return null
}

function timestamp() {
  return new Date().toISOString().replace(/\D/gu, '').slice(0, 14)
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
