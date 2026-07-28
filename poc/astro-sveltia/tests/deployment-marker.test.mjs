import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  assertDeployedBuild,
  parseBuildMarker,
  parseBuildMetadata,
} from '../scripts/wait-for-deployment.mjs'

const COMMIT = 'a'.repeat(40)
const CORPUS_VERSION = 'b'.repeat(20)
const MARKER_URL =
  'https://asv-wiki.acecore.net/.well-known/aceserver-wiki-build.json'

test('build markerのcommitとcorpus versionを検証する', () => {
  const marker = JSON.stringify({
    commit: COMMIT.toUpperCase(),
    searchCorpusVersion: CORPUS_VERSION.toUpperCase(),
  })

  assert.deepEqual(parseBuildMetadata(marker), {
    commit: COMMIT,
    searchCorpusVersion: CORPUS_VERSION,
  })
  assert.equal(parseBuildMarker(marker), COMMIT)
  assert.throws(
    () => parseBuildMetadata(JSON.stringify({ commit: COMMIT })),
    /search corpus version/u,
  )
})

test('公開commitとcorpus versionの両方が一致した場合だけ同期を許可する', async () => {
  const fetchImpl = async () =>
    Response.json({
      commit: COMMIT,
      searchCorpusVersion: CORPUS_VERSION,
    })
  const silentLogger = { log() {} }

  await assert.doesNotReject(
    assertDeployedBuild(MARKER_URL, COMMIT, CORPUS_VERSION, {
      fetchImpl,
      logger: silentLogger,
    }),
  )
  await assert.rejects(
    assertDeployedBuild(MARKER_URL, COMMIT, 'c'.repeat(20), {
      fetchImpl,
      logger: silentLogger,
    }),
    /search corpus differs/u,
  )
})

test('HTTPと過大markerを拒否する', () => {
  assert.throws(
    () => parseBuildMetadata('x'.repeat(4097)),
    /unexpectedly large/u,
  )
})
