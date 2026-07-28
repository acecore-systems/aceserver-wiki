import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'

import { parse as parseYaml } from 'yaml'

import {
  assertMarkdownBody,
  buildDraftMigrationPlan,
} from './import-newt-drafts.mjs'

const root = new URL('../', import.meta.url)
const contentDirectory = new URL('src/content/wiki/', root)
const allowedCategories = new Set([
  'イントロダクション',
  '生活鯖について',
  'その他サーバーについて',
  'ディスコードについて',
  'コミュニティ紹介',
  'その他',
])
const frontmatterPattern = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/u

const plan = await buildDraftMigrationPlan({
  verifyRepositoryState: true,
})
const committedManifest = await readFile(plan.targetManifestUrl, 'utf8')

assert(
  committedManifest.replace(/\r\n?/gu, '\n') === plan.manifest,
  'Committed full-migration manifest is not the deterministic importer output.',
)
assert(
  plan.generatedManifest.inventory.newtArticleCount === 32 &&
    plan.generatedManifest.inventory.publicMarkdownCount === 15 &&
    plan.generatedManifest.inventory.draftMarkdownCount === 17 &&
    plan.generatedManifest.inventory.totalMarkdownCount === 32,
  'Full Newt inventory must remain 15 public + 17 draft = 32.',
)
assert(
  plan.generatedManifest.inventory.retainedPublicAssetCount === 11 &&
    plan.generatedManifest.inventory.publicDraftAssetCount === 0 &&
    plan.generatedManifest.inventory.archivedDraftAssetCount === 7 &&
    plan.generatedManifest.inventory.exactExistingPublicAssetMatchCount === 1 &&
    plan.generatedManifest.inventory.uniqueDraftAssetCount === 7 &&
    plan.generatedManifest.deferredDraftAssets.length ===
      plan.generatedManifest.inventory.deferredDraftAssetReferenceCount,
  'Draft assets must stay off the public path while all seven are archived and one also exactly matches an existing public asset.',
)
assert(
  plan.generatedManifest.inventory.formerlyPublishedDraftCount === 16 &&
    plan.generatedManifest.inventory.neverPublishedDraftCount === 1 &&
    plan.generatedManifest.inventory.emptyBodyDraftCount === 1,
  'Draft publication history must remain 16 formerly published and one never-published empty article.',
)
assert(
  plan.generatedManifest.uiEvidence.appExport.availableOnCurrentPlan ===
    false &&
    plan.generatedManifest.uiEvidence.evidencePath ===
      'migration/newt-full-export-2026-07-29/model-view-schema.json' &&
    plan.generatedManifest.uiEvidence.evidenceBytes === 2964 &&
    plan.generatedManifest.uiEvidence.evidenceSha256 ===
      '074003a7c9713d07cf463cc2eded30ace45de821984648f9eff7cb34a837afd1' &&
    plan.generatedManifest.uiEvidence.views.length === 3 &&
    plan.generatedManifest.uiEvidence.views.every(
      ({ type }) => type === 'table',
    ),
  'Newt UI evidence for plan-limited export and three table views is missing.',
)
assert(
  plan.generatedManifest.publicEvidence.snapshotPath ===
    'migration/newt-public-content-snapshot.json' &&
    plan.generatedManifest.publicEvidence.snapshotBytes === 273425 &&
    plan.generatedManifest.publicEvidence.snapshotSha256 ===
      '2a131f05cf56e0eddf5f3ea635dabbfe40da00378342f0879df9deea21f1bd4c' &&
    plan.generatedManifest.publicEvidence.snapshotOrigin ===
      'https://bba3fffa.aceserver-wiki.pages.dev' &&
    plan.generatedManifest.publicEvidence.snapshotCapturedAt ===
      '2026-07-27T11:39:46.639Z' &&
    plan.generatedManifest.publicInventory.every(
      ({
        sourceMetaSha256,
        snapshotMetaSha256,
        sourceCategoryRawSha256,
        snapshotCategoryRawSha256,
      }) =>
        sourceMetaSha256 === snapshotMetaSha256 &&
        sourceCategoryRawSha256 === snapshotCategoryRawSha256,
    ),
  'The 15 public articles must retain exact snapshot meta and category provenance.',
)
assertDeepEqual(
  plan.generatedManifest.publicEvidence.categoryNameChanges,
  [
    {
      newtId: '63628c7db48748bdc77e6f61',
      originalSlug: 'Hoe Kingdom',
      categoryId: '635cac9d06cfd5386b36b3dc',
      snapshotName: 'コミュニティ紹介',
      fullApiName: 'コミュニティについて',
    },
    {
      newtId: '63c6641ef6bd29a2e7b03c03',
      originalSlug: 'Asutan　Kingdom',
      categoryId: '635cac9d06cfd5386b36b3dc',
      snapshotName: 'コミュニティ紹介',
      fullApiName: 'コミュニティについて',
    },
  ],
  'The two intentional public category-name changes differ from the locked snapshot.',
)
assertDeepEqual(
  plan.generatedManifest.sourceInventory.categories.map(
    ({ newtId, name, sortOrder }) => ({ newtId, name, sortOrder }),
  ),
  [
    {
      newtId: '67c9569b395b530d6401f83a',
      name: 'ロビーサーバー',
      sortOrder: 23,
    },
    {
      newtId: '67c9514e33281c1d6502bd9e',
      name: 'ディスコードについて',
      sortOrder: 22,
    },
    {
      newtId: '67c94e6c395b530d64ff9669',
      name: 'その他サーバーについて',
      sortOrder: 21,
    },
    {
      newtId: '635d02e606cfd5386b3720de',
      name: '資源サーバー',
      sortOrder: 26,
    },
    {
      newtId: '635d016906cfd5386b370c3e',
      name: 'アズカバンサーバー',
      sortOrder: 29,
    },
    {
      newtId: '635d007306cfd5386b36f752',
      name: '生活鯖について',
      sortOrder: 20,
    },
    {
      newtId: '635cac9d06cfd5386b36b3dc',
      name: 'コミュニティについて',
      sortOrder: 40,
    },
    {
      newtId: '61e936ac8b1cc500187ad308',
      name: 'その他',
      sortOrder: 50,
    },
    {
      newtId: '61e92e9f616290001858f8a4',
      name: 'イントロダクション',
      sortOrder: 10,
    },
  ],
  'The independent nine-category API inventory changed.',
)
assertDeepEqual(
  plan.generatedManifest.sourceInventory.links.map(
    ({ newtId, text, href }) => ({ newtId, text, href }),
  ),
  [
    {
      newtId: '641696afb836a015edcad52a',
      text: 'ワールドマップ',
      href: 'https://asv.acecore.net/world-map/',
    },
    {
      newtId: '6347cd906892c6a352914f05',
      text: 'Acecore',
      href: 'https://acecore.net',
    },
    {
      newtId: '6347cd5f6892c6a352914185',
      text: 'エースサーバーポータル',
      href: 'https://asv.acecore.net',
    },
  ],
  'The independent three-link API inventory changed.',
)
assertDeepEqual(
  plan.generatedManifest.sourceCollisionAudit,
  {
    articleIdExactCollisionCount: 0,
    sourceSlugExactCollisionCount: 0,
    sourceSlugNfcCaseInsensitiveCollisionCount: 0,
    sourceBodySha256ExactCollisionCount: 0,
    titleCollisionGroupCount: 2,
    titleCollisionGroups: [
      {
        title: 'ルール',
        articles: [
          {
            newtId: '67d56eb21c808a95b6824af7',
            originalSlug: 'discord-rule',
            currentlyPublished: true,
          },
          {
            newtId: '635d1140350db340aac3584f',
            originalSlug: 'SurvivalRules',
            currentlyPublished: false,
          },
        ],
      },
      {
        title: 'プラグイン一覧',
        articles: [
          {
            newtId: '635be0c506cfd5386b2fee26',
            originalSlug: 'AzkabanPluginsList',
            currentlyPublished: false,
          },
          {
            newtId: '635bdd2b06cfd5386b2f3c46',
            originalSlug: 'ResetServerPluginsList',
            currentlyPublished: false,
          },
          {
            newtId: '635966e2f8dd31b69e7a6ccb',
            originalSlug: 'SurvivalPluginsList',
            currentlyPublished: true,
          },
        ],
      },
    ],
  },
  'Source ID, slug, body-hash, or display-title collision evidence changed.',
)
assert(
  plan.generatedManifest.publicationPolicy.allImportedArticlesRemainDraft ===
    true &&
    plan.generatedManifest.publicationPolicy
      .editorialReviewRequiredBeforePublishing === true,
  'Imported Newt articles must remain fail-closed drafts pending review.',
)
assertDeepEqual(
  plan.generatedManifest.publicationPolicy.additionalSecurityReview.map(
    ({ targetSlug, status }) => ({ targetSlug, status }),
  ),
  [
    {
      targetSlug: 'survival-rules-legacy',
      status: 'review-required',
    },
    { targetSlug: 'member', status: 'review-required' },
  ],
  'The two content-specific publication review gates changed.',
)
assertDeepEqual(
  plan.generatedManifest.knownDuplicateContent.map(
    ({ containingOriginalSlug, containedOriginalSlug, relation }) => ({
      containingOriginalSlug,
      containedOriginalSlug,
      relation,
    }),
  ),
  [
    {
      containingOriginalSlug: 'Azkaban',
      containedOriginalSlug: 'AzkabanPluginsList',
      relation: 'source-body-contains-exact-source-body',
    },
  ],
  'The known Azkaban plugin-list duplication evidence changed.',
)
assertDeepEqual(
  plan.generatedManifest.knownSupersededContent,
  [
    {
      legacyNewtId: '635d1140350db340aac3584f',
      legacyOriginalSlug: 'SurvivalRules',
      archivedTargetSlug: 'survival-rules-legacy',
      currentPublicNewtId: '63453173d2720e3d2d563c0a',
      currentPublicTargetSlug: 'rule',
      relation: 'legacy-article-redirects-to-current-public-article',
      redirectFrom: '/article/SurvivalRules/',
      redirectTo: '/article/rule/',
      publicationDefault: 'do-not-publish',
    },
  ],
  'The known SurvivalRules supersession evidence changed.',
)
assert(
  plan.generatedManifest.draftAssetArchive.assets.length === 7 &&
    plan.generatedManifest.draftAssetArchive.assets.every(
      ({ observedHttpStatus }) => observedHttpStatus === 200,
    ) &&
    plan.generatedManifest.draftAssetArchive.publicDraftAssetCount === 0,
  'Draft asset archive evidence must retain seven reachable sources and zero public draft assets.',
)

const expectedByFileName = new Map([
  ...plan.generatedManifest.publicInventory.map((article) => [
    `${article.targetSlug}.md`,
    article,
  ]),
  ...plan.generatedManifest.draftInventory.map((article) => [
    `${article.targetSlug}.md`,
    article,
  ]),
])
assert(
  expectedByFileName.size === 32,
  'Case-sensitive target Markdown paths must be unique.',
)
assert(
  new Set(
    [...expectedByFileName.keys()].map((fileName) => fileName.toLowerCase()),
  ).size === 32,
  'Case-insensitive target Markdown paths must be unique.',
)

const markdownEntries = (
  await readdir(contentDirectory, { withFileTypes: true })
)
  .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
  .map(({ name }) => name)
  .toSorted()
assertDeepEqual(
  markdownEntries,
  [...expectedByFileName.keys()].toSorted(),
  'Repository Markdown inventory differs from 15 public + 17 draft files.',
)

const orders = []
const draftBodies = new Map()
let publicCount = 0
let draftCount = 0
let formerlyPublishedDraftCount = 0
let neverPublishedDraftCount = 0
let emptyBodyDraftCount = 0
for (const fileName of markdownEntries) {
  const evidence = expectedByFileName.get(fileName)
  const source = await readFile(new URL(fileName, contentDirectory), 'utf8')
  const { data, body } = parseMarkdown(source, fileName)

  assert(
    typeof data.title === 'string' &&
      data.title.trim().length > 0 &&
      data.title.length <= 100,
    `Invalid title: ${fileName}`,
  )
  assert(
    typeof data.description === 'string' &&
      data.description.trim().length > 0 &&
      data.description.length <= 240,
    `Invalid description: ${fileName}`,
  )
  assert(
    allowedCategories.has(data.category),
    `Unknown canonical category in ${fileName}: ${data.category}`,
  )
  assert(
    Number.isSafeInteger(data.order) && data.order >= 0 && data.order <= 9999,
    `Invalid display order: ${fileName}`,
  )
  assert(
    data.draft === evidence.draft,
    `Draft state differs from migration evidence: ${fileName}`,
  )
  orders.push(data.order)

  if (data.draft) {
    assertMarkdownBody(body, fileName)
    assertIndependentDraftSemantics(body, fileName)
    assert(
      evidence.sourcePublishedAt === null,
      `Imported Newt article was not unpublished at export time: ${fileName}`,
    )
    if (evidence.sourceFirstPublishedAt === null) {
      neverPublishedDraftCount += 1
    } else {
      assert(
        typeof evidence.sourceFirstPublishedAt === 'string' &&
          Number.isFinite(Date.parse(evidence.sourceFirstPublishedAt)),
        `Invalid firstPublishedAt evidence: ${fileName}`,
      )
      formerlyPublishedDraftCount += 1
    }
    if (body.trim() === '') emptyBodyDraftCount += 1
    assert(
      countOccurrences(body, '画像は移行保留です') ===
        evidence.deferredAssetCount,
      `Deferred image-note count differs from manifest: ${fileName}`,
    )
    draftBodies.set(fileName, body)
    draftCount += 1
    const generated = plan.generatedArticles.find(
      ({ targetSlug }) => `${targetSlug}.md` === fileName,
    )
    assert(
      generated && generated.markdown === source.replace(/\r\n?/gu, '\n'),
      `Draft Markdown is not deterministic importer output: ${fileName}`,
    )
  } else {
    assert(
      typeof evidence.sourceCategoryId === 'string' &&
        typeof evidence.sourceCategoryName === 'string' &&
        allowedCategories.has(evidence.targetCategory) &&
        /^[0-9a-f]{64}$/u.test(evidence.sourceMetaSha256) &&
        evidence.sourceMetaSha256 === sha256Json(evidence.sourceMeta),
      `Published source meta/category evidence is invalid: ${fileName}`,
    )
    publicCount += 1
  }
}

assert(
  publicCount === 15 && draftCount === 17,
  `Expected 15 public and 17 draft Markdown files; received ${publicCount} and ${draftCount}.`,
)
assert(
  new Set(orders).size === orders.length,
  'Migration display orders must be unique across all 32 Markdown files.',
)
assert(
  formerlyPublishedDraftCount === 16 &&
    neverPublishedDraftCount === 1 &&
    emptyBodyDraftCount === 1 &&
    draftBodies.get('communication.md')?.trim() === '',
  'Independent draft history/body validation differs from 16 former + one empty never-published Communication article.',
)
assert(
  draftBodies
    .get('survival-guide-facility.md')
    ?.includes('\n### あすたん王国　X-200 Z-400\n') &&
    !draftBodies
      .get('survival-guide-facility.md')
      ?.includes('    ### あすたん王国'),
  'Facility headings remain incorrectly nested under a list.',
)
assert(
  draftBodies
    .get('world.md')
    ?.includes('倉庫、植林場、採掘場を用意してます。\n\n**主な施設**'),
  'World shared-facility strong text remains malformed.',
)
assert(
  draftBodies
    .get('survival-rules-legacy.md')
    ?.includes('参加方法：https://asv-wiki.acecore.net/article/in/') &&
    !draftBodies
      .get('survival-rules-legacy.md')
      ?.includes('https://aceserver-wiki.acecore.systems'),
  'SurvivalRules still contains the retired participation URL.',
)

console.log(
  `Validated full Newt migration acceptance: ${publicCount} unchanged public files, ${draftCount} deterministic draft files, ${plan.generatedManifest.deferredDraftAssets.length} deferred asset references, seven archived assets, one exact existing-public-asset match, and zero public draft assets.`,
)

function parseMarkdown(source, fileName) {
  const match = frontmatterPattern.exec(source)
  assert(match, `Markdown frontmatter is missing: ${fileName}`)

  let data
  try {
    data = parseYaml(match[1], {
      schema: 'core',
      strict: true,
      uniqueKeys: true,
    })
  } catch {
    throw new Error(`Invalid YAML frontmatter: ${fileName}`)
  }
  assert(
    data && typeof data === 'object' && !Array.isArray(data),
    `Markdown frontmatter must be an object: ${fileName}`,
  )

  return { data, body: match[2] }
}

function assertIndependentDraftSemantics(body, fileName) {
  assert(
    !/^(?: {0,3})#{2,6}[ \t]+-[ \t]+/mu.test(body),
    `Heading contains a leaked list marker: ${fileName}`,
  )
  assert(
    !/^(?: {4,}|\t+)#{2,6}[ \t]+/mu.test(body),
    `Heading remains indented as code or list content: ${fileName}`,
  )
  assert(
    !body.includes('https://aceserver-wiki.acecore.systems'),
    `Retired Wiki origin remains in draft Markdown: ${fileName}`,
  )
  for (const line of body.split(/\r?\n/u)) {
    assert(
      countOccurrences(line, '**') % 2 === 0,
      `Strong marker is unbalanced on a line in ${fileName}: ${line}`,
    )
  }
}

function countOccurrences(value, needle) {
  return value.split(needle).length - 1
}

function sha256Json(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function assertDeepEqual(actual, expected, message) {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${message}\nExpected: ${JSON.stringify(expected)}\nReceived: ${JSON.stringify(actual)}`,
  )
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}
