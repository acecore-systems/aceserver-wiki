import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const COMMIT_PATTERN = /^[0-9a-f]{40}$/iu
const CORPUS_VERSION_PATTERN = /^[0-9a-f]{20}$/iu
const MAX_MARKER_BYTES = 4096

export function parseBuildMetadata(text) {
  if (Buffer.byteLength(text, 'utf8') > MAX_MARKER_BYTES) {
    throw new Error('Pages build marker is unexpectedly large.')
  }

  const payload = JSON.parse(text)
  if (
    typeof payload?.commit !== 'string' ||
    !COMMIT_PATTERN.test(payload.commit)
  ) {
    throw new Error('Pages build marker must contain a full 40-character SHA.')
  }
  if (
    typeof payload?.searchCorpusVersion !== 'string' ||
    !CORPUS_VERSION_PATTERN.test(payload.searchCorpusVersion)
  ) {
    throw new Error(
      'Pages build marker must contain a 20-character search corpus version.',
    )
  }

  return {
    commit: payload.commit.toLowerCase(),
    searchCorpusVersion: payload.searchCorpusVersion.toLowerCase(),
  }
}

export function parseBuildMarker(text) {
  return parseBuildMetadata(text).commit
}

export async function readDeployedBuild(
  targetUrl,
  {
    fetchImpl = globalThis.fetch,
    fetchTimeoutMs = Number(process.env.DEPLOYMENT_FETCH_TIMEOUT_MS || 10_000),
  } = {},
) {
  const url = new URL(targetUrl)
  if (url.protocol !== 'https:') {
    throw new Error('Pages build marker URL must use HTTPS.')
  }

  const response = await fetchImpl(url, {
    headers: {
      Accept: 'application/json',
      'Cache-Control': 'no-cache, no-store',
    },
    cache: 'no-store',
    signal: AbortSignal.timeout(fetchTimeoutMs),
  })
  if (!response.ok) {
    throw new Error(`Pages build marker returned HTTP ${response.status}.`)
  }
  return parseBuildMetadata(await response.text())
}

export async function readDeployedCommit(targetUrl, options = {}) {
  return (await readDeployedBuild(targetUrl, options)).commit
}

export async function assertDeployedBuild(
  targetUrl,
  expectedCommit,
  expectedCorpusVersion,
  {
    fetchImpl = globalThis.fetch,
    fetchTimeoutMs = Number(process.env.DEPLOYMENT_FETCH_TIMEOUT_MS || 10_000),
    logger = console,
  } = {},
) {
  if (!COMMIT_PATTERN.test(expectedCommit)) {
    throw new Error('Expected commit must be a full 40-character Git SHA.')
  }
  if (!CORPUS_VERSION_PATTERN.test(expectedCorpusVersion)) {
    throw new Error(
      'Expected search corpus version must contain 20 hexadecimal characters.',
    )
  }

  const expected = {
    commit: expectedCommit.toLowerCase(),
    searchCorpusVersion: expectedCorpusVersion.toLowerCase(),
  }
  const deployed = await readDeployedBuild(targetUrl, {
    fetchImpl,
    fetchTimeoutMs,
  })
  if (
    deployed.commit !== expected.commit ||
    deployed.searchCorpusVersion !== expected.searchCorpusVersion
  ) {
    throw new Error(
      'Production changed or its search corpus differs from this workflow build.',
    )
  }

  logger.log(JSON.stringify({ event: 'pages_build_confirmed', ...expected }))
  return deployed
}

export async function waitForDeployment(
  targetUrl,
  expectedCommit,
  {
    timeoutMs = Number(process.env.DEPLOYMENT_WAIT_TIMEOUT_MS || 600_000),
    pollMs = Number(process.env.DEPLOYMENT_WAIT_POLL_MS || 15_000),
    fetchImpl = globalThis.fetch,
    fetchTimeoutMs = Number(process.env.DEPLOYMENT_FETCH_TIMEOUT_MS || 10_000),
    sleepImpl = (milliseconds) =>
      new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)),
    logger = console,
  } = {},
) {
  if (!COMMIT_PATTERN.test(expectedCommit)) {
    throw new Error('Expected commit must be a full 40-character Git SHA.')
  }

  const normalizedExpectedCommit = expectedCommit.toLowerCase()
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const deployedCommit = await readDeployedCommit(targetUrl, {
        fetchImpl,
        fetchTimeoutMs,
      })
      if (deployedCommit === normalizedExpectedCommit) {
        logger.log(
          JSON.stringify({
            event: 'pages_deployment_ready',
            commit: normalizedExpectedCommit,
          }),
        )
        return normalizedExpectedCommit
      }
    } catch {
      // The marker can be temporarily unavailable while Pages promotes a build.
    }
    await sleepImpl(pollMs)
  }

  throw new Error(
    `Timed out waiting for Pages deployment ${normalizedExpectedCommit}.`,
  )
}

function isDirectExecution() {
  if (!process.argv[1]) return false
  return (
    resolve(process.argv[1]).toLowerCase() ===
    fileURLToPath(import.meta.url).toLowerCase()
  )
}

if (isDirectExecution()) {
  const targetUrl = process.argv[2]
  const command = process.argv[3]

  if (!targetUrl || !command) {
    throw new Error(
      'Usage: node scripts/wait-for-deployment.mjs <marker-url> <commit-sha|--print-current|--assert-current> [commit-sha corpus-file]',
    )
  }

  if (command === '--print-current') {
    console.log(await readDeployedCommit(targetUrl))
  } else if (command === '--assert-current') {
    const expectedCommit = process.argv[4]
    const corpusFile = process.argv[5]
    if (!expectedCommit || !corpusFile) {
      throw new Error(
        '--assert-current requires an expected commit and corpus JSON file.',
      )
    }
    const corpus = JSON.parse(await readFile(resolve(corpusFile), 'utf8'))
    await assertDeployedBuild(targetUrl, expectedCommit, corpus?.version)
  } else {
    await waitForDeployment(targetUrl, command)
  }
}
