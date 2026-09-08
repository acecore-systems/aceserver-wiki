import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import { buildDraftMigrationPlan } from './import-newt-drafts.mjs'

const root = new URL('../', import.meta.url)
const plan = await buildDraftMigrationPlan()
const repeatedPlan = await buildDraftMigrationPlan()
const committedManifest = await readFile(plan.targetManifestUrl, 'utf8')
const { generatedManifest } = plan
const fullAssetManifestRaw = await readFile(
  new URL('migration/newt-full-assets-2026-07-29-manifest.json', root),
  'utf8',
)
const normalizedFullAssetManifestRaw = fullAssetManifestRaw.replace(
  /\r\n?/gu,
  '\n',
)
const fullAssetManifest = JSON.parse(normalizedFullAssetManifestRaw)
assert.equal(
  createHash('sha256').update(normalizedFullAssetManifestRaw).digest('hex'),
  'b0d2b00b274cfe2e9c8faccfcb6835e1b480cdf0b017a399b443e7c3ec156663',
  'The complete Newt asset manifest changed.',
)

assert.equal(
  committedManifest.replace(/\r\n?/gu, '\n'),
  plan.manifest,
  'Committed migration manifest is not reproducible from the archived Newt evidence.',
)
assert.equal(
  repeatedPlan.manifest,
  plan.manifest,
  'Archived Newt evidence did not produce a deterministic manifest.',
)
assert.deepEqual(generatedManifest.inventory, {
  newtArticleCount: 32,
  publicMarkdownCount: 15,
  draftMarkdownCount: 17,
  totalMarkdownCount: 32,
  retainedPublicAssetCount: 11,
  publicDraftAssetCount: 0,
  archivedDraftAssetCount: 7,
  exactExistingPublicAssetMatchCount: 1,
  uniqueDraftAssetCount: 7,
  deferredDraftAssetReferenceCount: 8,
  newtCategoryCount: 9,
  newtLinkCount: 3,
  formerlyPublishedDraftCount: 16,
  neverPublishedDraftCount: 1,
  emptyBodyDraftCount: 1,
})
assert.equal(
  generatedManifest.publicEvidence.snapshotSha256,
  '434808037b459837c5a69ae3f42d17dab9b4c69559b8fe40d6a084d02d000019',
)
assert(
  generatedManifest.publicInventory.every(
    ({
      sourceMetaSha256,
      snapshotMetaSha256,
      sourceCategoryRawSha256,
      snapshotCategoryRawSha256,
    }) =>
      sourceMetaSha256 === snapshotMetaSha256 &&
      sourceCategoryRawSha256 === snapshotCategoryRawSha256,
  ),
  'The archived public snapshot no longer matches the full API meta/category evidence.',
)
assert.deepEqual(generatedManifest.sourceCollisionAudit, {
  ...generatedManifest.sourceCollisionAudit,
  articleIdExactCollisionCount: 0,
  sourceSlugExactCollisionCount: 0,
  sourceSlugNfcCaseInsensitiveCollisionCount: 0,
  sourceBodySha256ExactCollisionCount: 0,
  titleCollisionGroupCount: 2,
})
assert.deepEqual(
  generatedManifest.publicationPolicy.additionalSecurityReview.map(
    ({ targetSlug, status }) => ({ targetSlug, status }),
  ),
  [
    {
      targetSlug: 'survival-rules-legacy',
      status: 'review-required',
    },
    { targetSlug: 'member', status: 'review-required' },
  ],
)
assert.equal(generatedManifest.knownDuplicateContent.length, 1)
assert.equal(generatedManifest.knownSupersededContent.length, 1)
assert(
  generatedManifest.draftAssetArchive.assets.every(
    ({ archivePath, observedHttpStatus }) =>
      archivePath?.startsWith('migration/newt-draft-assets-2026-07-29/') &&
      observedHttpStatus === 200,
  ),
  'Every unique draft asset must be self-contained in the migration archive.',
)
assert(
  generatedManifest.deferredDraftAssets.every(
    ({ preservedAt, preservedSha256 }) =>
      preservedAt.startsWith('migration/newt-draft-assets-2026-07-29/') &&
      /^[0-9a-f]{64}$/u.test(preservedSha256),
  ),
  'Every deferred source image must resolve to a hashed archived asset.',
)

assert.deepEqual(
  {
    schemaVersion: fullAssetManifest.schemaVersion,
    service: fullAssetManifest.source?.service,
    spaceUid: fullAssetManifest.source?.spaceUid,
    bytes: fullAssetManifest.archive?.bytes,
    sha256: fullAssetManifest.archive?.sha256,
    entryCount: fullAssetManifest.archive?.entryCount,
    fileCount: fullAssetManifest.archive?.fileCount,
    directoryCount: fullAssetManifest.archive?.directoryCount,
    totalUncompressedBytes: fullAssetManifest.archive?.totalUncompressedBytes,
    unsafeEntryCount: fullAssetManifest.archive?.unsafeEntryCount,
  },
  {
    schemaVersion: 1,
    service: 'Newt',
    spaceUid: 'aceserver',
    bytes: 56_092_455,
    sha256: '28c12ec7a436c672a0fc562cad4d3f114f9e8ad1967050743078cefc51f5b4e1',
    entryCount: 144,
    fileCount: 72,
    directoryCount: 72,
    totalUncompressedBytes: 57_115_787,
    unsafeEntryCount: 0,
  },
  'The complete Newt asset archive inventory changed.',
)
assert.deepEqual(fullAssetManifest.archive.retention, {
  status: 'local-backup-verified-and-organized',
  verifiedOn: '2026-07-29',
  localZipSha256Verified: true,
  localExtractedFolderName: 'Aceserver-Newt完全バックアップ-2026-07-29',
  localExtractedFileCount: 72,
  localExtractedBytes: 57_115_787,
  organizedCopy: {
    status: 'created-and-verified',
    createdOn: '2026-07-30',
    localFolderName: 'Aceserver-Newt画像整理-2026-07-29',
    layout: 'flat-deduplicated-by-sha256',
    sourceFileCount: 72,
    fileCount: 69,
    duplicateFileCount: 3,
    bytes: 50_087_418,
    manifestFileName: '_manifest.json',
    manifestSha256:
      'fe3c3532f4c81f8f10a618f004f4482df1f931cf965895840ff9fbd80fc9a741',
    mappingFileName: '_manifest.csv',
    mappingSha256:
      'bb196b2ea9079f34c0709d2a4341356df6a35031337ba60afe230054f78847e2',
  },
  remoteCopy: {
    status: 'not-planned',
    decisionOn: '2026-07-30',
    policy: 'local-curation-before-selective-wiki-import',
  },
})
assert.equal(
  new Set(fullAssetManifest.files.map(({ path }) => path)).size,
  72,
  'The complete Newt asset archive must have 72 unique file paths.',
)
assert(
  fullAssetManifest.files.every(
    ({ path, bytes, sha256 }) =>
      path &&
      !/(^|[/\\])\.\.($|[/\\])/u.test(path) &&
      Number.isInteger(bytes) &&
      bytes > 0 &&
      /^[0-9a-f]{64}$/u.test(sha256),
  ),
  'The complete Newt asset archive has an invalid file entry.',
)
assert.equal(
  fullAssetManifest.files.reduce((total, { bytes }) => total + bytes, 0),
  fullAssetManifest.archive.totalUncompressedBytes,
  'The complete Newt asset archive byte total changed.',
)

const fullAssetHashes = new Set(
  fullAssetManifest.files.map(({ sha256 }) => sha256),
)
for (const { sourceUrl, sha256 } of generatedManifest.draftAssetArchive
  .assets) {
  if (!new URL(sourceUrl).hostname.endsWith('storage.googleapis.com')) {
    continue
  }
  assert(
    fullAssetHashes.has(sha256),
    `A Newt-managed draft asset is absent from the complete Newt archive: ${sha256}`,
  )
}
assert.deepEqual(
  generatedManifest.retainedPublicAssets
    .filter(({ sha256 }) => fullAssetHashes.has(sha256))
    .map(({ localPath }) => localPath)
    .sort(),
  [
    'public/uploads/wiki/discord-link-server.png',
    'public/uploads/wiki/discord-link-step-a.png',
    'public/uploads/wiki/rule-handshake.jpg',
    'public/uploads/wiki/server-philosophy-icon.png',
    'public/uploads/wiki/server-philosophy-og.png',
    'public/uploads/wiki/wiki-cover.png',
  ],
  'The known overlap between the current public assets and the complete Newt archive changed.',
)

const evidenceBySlug = new Map(
  generatedManifest.draftInventory.map((article) => [
    article.targetSlug,
    article,
  ]),
)
assert.equal(plan.generatedArticles.length, 17)
for (const article of plan.generatedArticles) {
  const evidence = evidenceBySlug.get(article.targetSlug)
  assert(
    evidence,
    `Generated draft is absent from the manifest: ${article.targetSlug}`,
  )
  assert.equal(
    Buffer.byteLength(article.markdown, 'utf8'),
    evidence.markdownBytes,
    `Generated draft byte count changed: ${article.targetSlug}`,
  )
  assert.match(article.markdown, /\ndraft: true\n---\n/u)
}

const markdownBySlug = new Map(
  plan.generatedArticles.map(({ targetSlug, markdown }) => [
    targetSlug,
    markdown,
  ]),
)
assert.match(
  markdownBySlug.get('survival-guide-facility'),
  /\n### あすたん王国　X-200 Z-400\n/u,
)
assert.match(
  markdownBySlug.get('world'),
  /倉庫、植林場、採掘場を用意してます。\n\n\*\*主な施設\*\*/u,
)
assert.match(
  markdownBySlug.get('survival-rules-legacy'),
  /参加方法：https:\/\/asv-wiki\.acecore\.net\/article\/in\//u,
)

assert.equal(
  new URL('migration/newt-full-draft-migration-manifest.json', root).href,
  plan.targetManifestUrl.href,
)

console.log(
  'Validated the self-contained Newt migration archive: 32 articles, 9 categories, 3 links, 17 reproducible draft conversions, 7 referenced draft assets, all 72 Newt media files, and no live Wiki inventory dependency.',
)
