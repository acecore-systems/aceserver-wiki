import { createHash } from 'node:crypto'
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { parseFragment, serialize } from 'parse5'
import TurndownService from 'turndown'

import {
  collapseRowspanAliasRows,
  replaceMarkdownTableMarker,
} from './newt-markdown-normalization.mjs'

const root = new URL('../', import.meta.url)
const contentDirectory = new URL('src/content/wiki/', root)
const mediaDirectory = new URL('public/uploads/wiki/', root)
const sourceDirectory = new URL('migration/newt-full-export-2026-07-29/', root)
const draftAssetArchiveDirectory = new URL(
  'migration/newt-draft-assets-2026-07-29/',
  root,
)
const sourceManifestUrl = new URL('manifest.json', sourceDirectory)
const uiEvidenceUrl = new URL('model-view-schema.json', sourceDirectory)
const publicManifestUrl = new URL(
  'migration/newt-public-payload-manifest.json',
  root,
)
const publicSnapshotUrl = new URL(
  'migration/newt-public-content-snapshot.json',
  root,
)
const targetManifestUrl = new URL(
  'migration/newt-full-draft-migration-manifest.json',
  root,
)

const expectedSourceExport = {
  manifestBytes: 1172,
  manifestSha256:
    'a7b42a3c1d048dad44db4f491843109f5dc1ebd9f24084997c4cd1ef562049d5',
  schemaVersion: 1,
  exportedAt: '2026-07-28T15:39:44.637Z',
  source: {
    spaceUid: 'aceserver',
    appUid: 'wiki',
    apiType: 'api',
    depth: 2,
  },
  files: [
    {
      modelUid: 'article',
      fileName: 'article.json',
      bytes: 144037,
      sha256:
        'af65a6c1380c68669d663dd55a594ed637b65efabea3923695167cedb3a1f8ae',
      total: 32,
      items: 32,
      uniqueIds: 32,
    },
    {
      modelUid: 'category',
      fileName: 'category.json',
      bytes: 4478,
      sha256:
        '2b0f856e9dfa304eb1c42262a8650b7ff8627dc5d596d7fa65cfb703cea482aa',
      total: 9,
      items: 9,
      uniqueIds: 9,
    },
    {
      modelUid: 'link',
      fileName: 'link.json',
      bytes: 1579,
      sha256:
        'd283d9b587acbfd5f8f259fa7a1bc283f605d90eeae021ea481c021e8106a7f3',
      total: 3,
      items: 3,
      uniqueIds: 3,
    },
  ],
}
const expectedUiEvidence = {
  bytes: 2964,
  sha256: '074003a7c9713d07cf463cc2eded30ace45de821984648f9eff7cb34a837afd1',
  capturedAt: '2026-07-29',
  source: {
    spaceUid: 'aceserver',
    appUid: 'wiki',
    appName: 'エースサーバーWIKI',
    captureMethod: 'Newt management UI JSON preview and view settings',
  },
}
const expectedPublicSnapshot = {
  bytes: 273425,
  sha256: '2a131f05cf56e0eddf5f3ea635dabbfe40da00378342f0879df9deea21f1bd4c',
  schemaVersion: 1,
  origin: 'https://bba3fffa.aceserver-wiki.pages.dev',
  capturedAt: '2026-07-27T11:39:46.639Z',
  articleCount: 15,
}

export const draftArticleMappings = [
  {
    id: '67c98735395b530d642e4a86',
    sourceSlug: 'Communication',
    targetSlug: 'communication',
    title: 'コミュニケーション',
    order: 160,
  },
  {
    id: '67c9553333281c1d6508140f',
    sourceSlug: 'Reset',
    targetSlug: 'reset',
    title: '資源鯖',
    order: 170,
  },
  {
    id: '67c952cc395b530d64002c05',
    sourceSlug: 'Azkaban',
    targetSlug: 'azkaban',
    title: 'アズカバン',
    order: 180,
  },
  {
    id: '6416a306b836a015edcee1b0',
    sourceSlug: 'LoginPassword',
    targetSlug: 'login-password',
    title: 'ログインパスワードについて',
    order: 190,
  },
  {
    id: '64166697b836a015edbf22da',
    sourceSlug: 'Application method',
    targetSlug: 'application-method',
    title: '各種申請方法',
    order: 200,
  },
  {
    id: '640521c30bc1cc52f761ec40',
    sourceSlug: 'Q&A',
    targetSlug: 'faq',
    title: 'よくある問い合わせ',
    order: 210,
  },
  {
    id: '63629edfb48748bdc780b9de',
    sourceSlug: 'Lobby',
    targetSlug: 'lobby',
    title: 'ロビーサーバー',
    order: 220,
  },
  {
    id: '635d1cb3350db340aac57fc5',
    sourceSlug: 'ResetOverview',
    targetSlug: 'reset-overview',
    title: '概要',
    order: 230,
  },
  {
    id: '635d1277350db340aac3d4b1',
    sourceSlug: 'SurvivalGuideFacility',
    targetSlug: 'survival-guide-facility',
    title: '施設案内',
    order: 240,
  },
  {
    id: '635d1140350db340aac3584f',
    sourceSlug: 'SurvivalRules',
    targetSlug: 'survival-rules-legacy',
    title: 'ルール',
    order: 250,
  },
  {
    id: '635d082a06cfd5386b37a26c',
    sourceSlug: 'AzkabanOverview',
    targetSlug: 'azkaban-overview',
    title: '概要 (overview)',
    order: 260,
  },
  {
    id: '635be0c506cfd5386b2fee26',
    sourceSlug: 'AzkabanPluginsList',
    targetSlug: 'azkaban-plugins-list',
    title: 'プラグイン一覧',
    order: 270,
  },
  {
    id: '635bdd2b06cfd5386b2f3c46',
    sourceSlug: 'ResetServerPluginsList',
    targetSlug: 'reset-server-plugins-list',
    title: 'プラグイン一覧',
    order: 280,
  },
  {
    id: '634d364c5466d2023bf0fcf1',
    sourceSlug: 'community',
    targetSlug: 'community',
    title: 'コミュニティ紹介',
    order: 290,
  },
  {
    id: '634532eed2720e3d2d580a91',
    sourceSlug: 'member',
    targetSlug: 'member',
    title: 'メンバー紹介',
    order: 300,
  },
  {
    id: '63453283d2720e3d2d57fc85',
    sourceSlug: 'event',
    targetSlug: 'event',
    title: 'イベント',
    order: 310,
  },
  {
    id: '6345322dd2720e3d2d5794dd',
    sourceSlug: 'world',
    targetSlug: 'world',
    title: 'ワールド案内',
    order: 320,
  },
]

const categoryMappings = new Map([
  [
    '61e92e9f616290001858f8a4',
    {
      sourceName: 'イントロダクション',
      targetName: 'イントロダクション',
    },
  ],
  [
    '635d007306cfd5386b36f752',
    { sourceName: '生活鯖について', targetName: '生活鯖について' },
  ],
  [
    '67c94e6c395b530d64ff9669',
    {
      sourceName: 'その他サーバーについて',
      targetName: 'その他サーバーについて',
    },
  ],
  [
    '67c9514e33281c1d6502bd9e',
    {
      sourceName: 'ディスコードについて',
      targetName: 'ディスコードについて',
    },
  ],
  [
    '635cac9d06cfd5386b36b3dc',
    {
      sourceName: 'コミュニティについて',
      targetName: 'コミュニティ紹介',
    },
  ],
  ['61e936ac8b1cc500187ad308', { sourceName: 'その他', targetName: 'その他' }],
  [
    '635d02e606cfd5386b3720de',
    {
      sourceName: '資源サーバー',
      targetName: 'その他サーバーについて',
    },
  ],
  [
    '635d016906cfd5386b370c3e',
    {
      sourceName: 'アズカバンサーバー',
      targetName: 'その他サーバーについて',
    },
  ],
])

const emptyDescriptionMappings = new Map([
  [
    '64166697b836a015edbf22da',
    'エースサーバーで利用できる各種申請の種類と、申請時に確認する項目をまとめた下書きです。',
  ],
  [
    '640521c30bc1cc52f761ec40',
    'エースサーバーへの参加やプレイ中によくある問い合わせと回答をまとめた下書きです。',
  ],
  [
    '634d364c5466d2023bf0fcf1',
    'エースサーバー内のコミュニティと、その活動内容や参加方法を紹介する下書きです。',
  ],
])

const legacyOrigins = new Set([
  'https://asv-wiki.acecore.net',
  'https://aceserver-wiki.acecore.systems',
  'https://aceserver-wiki.pages.dev',
])
const internalArticleAliases = new Map([['LobbyOverview', 'lobby']])
const publicationReviewMappings = [
  {
    newtId: '635d1140350db340aac3584f',
    targetSlug: 'survival-rules-legacy',
    status: 'review-required',
    checks: [
      'Treat this as the superseded predecessor of the current public rule article; normally do not publish it.',
      'Confirm that the Discord invite remains intended for public use.',
      'Review the deferred source image before copying or publishing it.',
    ],
  },
  {
    newtId: '634532eed2720e3d2d580a91',
    targetSlug: 'member',
    status: 'review-required',
    checks: [
      'Confirm that named members and roles are current.',
      'Confirm consent before republishing member-identifying information.',
      'Review the deferred source image before copying or publishing it.',
    ],
  },
]
const draftAssetAudit = [
  {
    sourceUrl:
      'https://storage.googleapis.com/p_631ae0ff4b26e8e308048763/2c8452ac-7ba8-45e4-abf3-b0c53717ec6b%2Funknown.png',
    observedHttpStatus: 200,
    bytes: 2607210,
    sha256: '3a03a7db524ca3c0d9f0631fe58b4c307d9ea57ba94346b1b0975731d816bd7c',
    archivePath: 'migration/newt-draft-assets-2026-07-29/azkaban-server.png',
  },
  {
    sourceUrl:
      'https://storage.googleapis.com/p_631ae0ff4b26e8e308048763/8f553592-b8d5-4581-b752-5efd617ceae1%2FLoginSecurity_register.png',
    observedHttpStatus: 200,
    bytes: 22999,
    sha256: '4a2805173589f6196fa66954f2a9382276ac87041cdf96d72a79809625e60aea',
    archivePath:
      'migration/newt-draft-assets-2026-07-29/login-security-register.png',
  },
  {
    sourceUrl:
      'https://storage.googleapis.com/p_631ae0ff4b26e8e308048763/cac5710f-19ce-4154-a5bb-77431261a2af%2FLoginSecurity_passlimit.png',
    observedHttpStatus: 200,
    bytes: 70853,
    sha256: 'ed7d95c4f95514c2a54488eec238552177dd0e9e78434abd2594d702f6051de5',
    archivePath:
      'migration/newt-draft-assets-2026-07-29/login-security-pass-limit.png',
  },
  {
    sourceUrl:
      'https://storage.googleapis.com/p_631ae0ff4b26e8e308048763/bf936ca1-2f07-46bb-ad23-9e2a6290ad25%2Fshaking-hands.jpg',
    observedHttpStatus: 200,
    bytes: 140587,
    sha256: '1a5fcfc9be301d1ca188e3825bb92b8eddf6945d22e55d73c73ce3e96382edbb',
    archivePath: 'migration/newt-draft-assets-2026-07-29/rule-handshake.jpg',
    existingLocalPath: 'public/uploads/wiki/rule-handshake.jpg',
    existingAssetExact: true,
  },
  {
    sourceUrl:
      'https://cdn.pixabay.com/photo/2020/05/18/16/17/social-media-5187243_960_720.png',
    observedHttpStatus: 200,
    bytes: 111592,
    sha256: '643d832e9d8f278dbe1eae7aea0595853167372ab9a4593dbb009de6fc447f31',
    archivePath: 'migration/newt-draft-assets-2026-07-29/member-header.png',
  },
  {
    sourceUrl:
      'https://cdn.pixabay.com/photo/2016/11/23/15/48/audience-1853662_960_720.jpg',
    observedHttpStatus: 200,
    bytes: 214847,
    sha256: '33af7060da4fc07120481bc5cc21b296136723954d8ceba65119780c846a6efb',
    archivePath: 'migration/newt-draft-assets-2026-07-29/event-header.jpg',
  },
  {
    sourceUrl:
      'https://storage.googleapis.com/p_631ae0ff4b26e8e308048763/0c380442-a2f7-42dd-9905-54dc76df8e58%2F2020-11-07_10.42.49.png',
    observedHttpStatus: 200,
    bytes: 2636141,
    sha256: 'c918c588c4253f8b9e6b448c6b55b55849cc7d94326bc658d05cf8293fd52a42',
    archivePath: 'migration/newt-draft-assets-2026-07-29/world-guide.png',
  },
]
const xhtmlNamespace = 'http://www.w3.org/1999/xhtml'
const targetSlugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u
const rawHtmlPattern =
  /<(?:!--[\s\S]*?--|!doctype\b[^>]*|\/?[a-z][a-z0-9:-]*(?:\s[^<>]*?)?\s*\/?>)/iu
const dangerousUriPattern = /\b(?:data|javascript|vbscript)\s*:/iu
const blockedSourceElements = new Set([
  'applet',
  'audio',
  'base',
  'button',
  'embed',
  'form',
  'iframe',
  'input',
  'link',
  'meta',
  'object',
  'textarea',
  'video',
])

const turndown = new TurndownService({
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
  emDelimiter: '*',
  headingStyle: 'atx',
  strongDelimiter: '**',
})

turndown.remove(['script', 'style'])

export async function buildDraftMigrationPlan({
  verifyRepositoryState = false,
} = {}) {
  const sourceManifestBytes = await readFile(sourceManifestUrl)
  const uiEvidenceBytes = await readFile(uiEvidenceUrl)
  const publicSnapshotBytes = await readFile(publicSnapshotUrl)

  assert(
    sourceManifestBytes.byteLength === expectedSourceExport.manifestBytes &&
      sha256(sourceManifestBytes) === expectedSourceExport.manifestSha256,
    'The full-export source manifest differs from the locked API evidence.',
  )
  assert(
    uiEvidenceBytes.byteLength === expectedUiEvidence.bytes &&
      sha256(uiEvidenceBytes) === expectedUiEvidence.sha256,
    'The Newt model/view UI evidence differs from the locked capture.',
  )
  assert(
    publicSnapshotBytes.byteLength === expectedPublicSnapshot.bytes &&
      sha256(publicSnapshotBytes) === expectedPublicSnapshot.sha256,
    'The locked public-content snapshot differs from the migration evidence.',
  )

  const sourceManifest = parseJson(sourceManifestBytes, 'source manifest')
  const uiEvidence = parseJson(uiEvidenceBytes, 'model-view-schema.json')
  const publicSnapshot = parseJson(
    publicSnapshotBytes,
    'newt-public-content-snapshot.json',
  )
  assertDeepEqual(
    {
      schemaVersion: sourceManifest.schemaVersion,
      exportedAt: sourceManifest.exportedAt,
      source: sourceManifest.source,
      files: sourceManifest.files,
    },
    {
      schemaVersion: expectedSourceExport.schemaVersion,
      exportedAt: expectedSourceExport.exportedAt,
      source: expectedSourceExport.source,
      files: expectedSourceExport.files,
    },
    'The full-export source manifest contract changed.',
  )
  assertDeepEqual(
    sourceManifest.recheckTotals,
    expectedSourceExport.files.map(({ modelUid, total }) => ({
      modelUid,
      status: 200,
      total,
    })),
    'The source API total recheck changed.',
  )
  assertDeepEqual(
    {
      schemaVersion: uiEvidence.schemaVersion,
      capturedAt: uiEvidence.capturedAt,
      source: uiEvidence.source,
    },
    {
      schemaVersion: 1,
      capturedAt: expectedUiEvidence.capturedAt,
      source: expectedUiEvidence.source,
    },
    'The Newt UI evidence header changed.',
  )
  assertDeepEqual(
    uiEvidence.models.map(({ name, uid, example }) => ({
      name,
      uid,
      fields:
        uid === 'article'
          ? [
              'title',
              'slug',
              'meta.title',
              'meta.description',
              'meta.ogImage',
              'body',
              'category',
              'sortOrder',
            ].filter((field) => hasObjectPath(example, field))
          : Object.keys(example).filter(
              (field) => field !== '_id' && field !== '_sys',
            ),
    })),
    [
      {
        name: '投稿',
        uid: 'article',
        fields: [
          'title',
          'slug',
          'meta.title',
          'meta.description',
          'meta.ogImage',
          'body',
          'category',
          'sortOrder',
        ],
      },
      {
        name: 'カテゴリ',
        uid: 'category',
        fields: ['name', 'sortOrder'],
      },
      { name: 'リンク', uid: 'link', fields: ['text', 'href'] },
    ],
    'The Newt model UI evidence changed.',
  )
  assertDeepEqual(
    uiEvidence.views,
    [
      {
        name: '投稿',
        type: 'table',
        modelName: '投稿',
        modelUid: 'article',
      },
      {
        name: 'カテゴリ',
        type: 'table',
        modelName: 'カテゴリ',
        modelUid: 'category',
      },
      {
        name: 'リンク',
        type: 'table',
        modelName: 'リンク',
        modelUid: 'link',
      },
    ],
    'The Newt table-view UI evidence changed.',
  )
  assertDeepEqual(
    {
      schemaVersion: publicSnapshot.schemaVersion,
      origin: publicSnapshot.source?.origin,
      capturedAt: publicSnapshot.source?.capturedAt,
      articleCount: publicSnapshot.source?.articleCount,
      snapshotArticleCount: publicSnapshot.articles?.length,
    },
    {
      schemaVersion: expectedPublicSnapshot.schemaVersion,
      origin: expectedPublicSnapshot.origin,
      capturedAt: expectedPublicSnapshot.capturedAt,
      articleCount: expectedPublicSnapshot.articleCount,
      snapshotArticleCount: expectedPublicSnapshot.articleCount,
    },
    'The locked public-content snapshot header changed.',
  )

  const sourceModels = new Map()
  for (const expectedFile of expectedSourceExport.files) {
    const fileUrl = new URL(expectedFile.fileName, sourceDirectory)
    const bytes = await readFile(fileUrl)

    assert(
      bytes.byteLength === expectedFile.bytes &&
        sha256(bytes) === expectedFile.sha256,
      `Raw Newt API evidence changed: ${expectedFile.fileName}`,
    )

    const payload = parseJson(bytes, expectedFile.fileName)
    assertApiCollection(payload, expectedFile)
    sourceModels.set(expectedFile.modelUid, payload.items)
  }

  const sourceArticles = sourceModels.get('article')
  const sourceCategories = sourceModels.get('category')
  const sourceLinks = sourceModels.get('link')
  assert(Array.isArray(sourceArticles), 'article.json was not loaded.')
  assert(Array.isArray(sourceCategories), 'category.json was not loaded.')
  assert(Array.isArray(sourceLinks), 'link.json was not loaded.')
  assertUnique(
    sourceArticles.map(({ _id }) => _id),
    'Newt article IDs',
  )
  assertUnique(
    sourceArticles.map(({ slug }) => slug),
    'Newt article slugs',
  )
  assertUnique(
    sourceArticles.map(({ slug }) =>
      slug.normalize('NFC').toLocaleLowerCase('en-US'),
    ),
    'NFC case-insensitive Newt article slugs',
  )
  const sourceBodyHashes = sourceArticles.map(({ body }) => sha256(body))
  assert(
    new Set(sourceBodyHashes).size === sourceBodyHashes.length,
    'Newt article source bodies must not have an exact SHA-256 collision.',
  )
  const sourceArticlesByTitle = new Map()
  for (const article of sourceArticles) {
    const title = article.title.normalize('NFC')
    const group = sourceArticlesByTitle.get(title) ?? []
    group.push({
      newtId: article._id,
      originalSlug: article.slug,
      currentlyPublished: isPublished(article),
    })
    sourceArticlesByTitle.set(title, group)
  }
  const sourceTitleCollisionGroups = [...sourceArticlesByTitle.entries()]
    .filter(([, articles]) => articles.length > 1)
    .map(([title, articles]) => ({ title, articles }))
  assertDeepEqual(
    sourceTitleCollisionGroups,
    [
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
    'The known duplicate Newt display-title groups changed.',
  )

  const publishedSourceArticles = sourceArticles.filter(isPublished)
  const draftSourceArticles = sourceArticles.filter(
    (article) => !isPublished(article),
  )
  assert(
    publishedSourceArticles.length === 15 && draftSourceArticles.length === 17,
    `Expected 15 published and 17 unpublished Newt articles; received ${publishedSourceArticles.length} and ${draftSourceArticles.length}.`,
  )
  const historicallyPublishedDrafts = draftSourceArticles.filter(
    (article) =>
      typeof article?._sys?.raw?.firstPublishedAt === 'string' &&
      article._sys.raw.firstPublishedAt.length > 0,
  )
  const neverPublishedDrafts = draftSourceArticles.filter(
    (article) => article?._sys?.raw?.firstPublishedAt === null,
  )
  const emptyBodyDrafts = draftSourceArticles.filter(
    (article) => article.body === '',
  )
  assert(
    historicallyPublishedDrafts.length === 16 &&
      neverPublishedDrafts.length === 1 &&
      neverPublishedDrafts[0]?._id === '67c98735395b530d642e4a86' &&
      emptyBodyDrafts.length === 1 &&
      emptyBodyDrafts[0]?._id === '67c98735395b530d642e4a86',
    'Expected 16 formerly published drafts and one never-published empty Communication draft.',
  )

  const publicManifestBytes = await readFile(publicManifestUrl)
  const publicManifest = parseJson(
    publicManifestBytes,
    'newt-public-payload-manifest.json',
  )
  assert(
    publicManifest.source?.articleCount === 15 &&
      publicManifest.articles?.length === 15,
    'The locked public migration inventory must contain 15 articles.',
  )
  assertUnique(
    publicSnapshot.articles.map(({ id }) => id),
    'public snapshot article IDs',
  )
  const publicSnapshotById = new Map(
    publicSnapshot.articles.map((evidence) => [evidence.id, evidence]),
  )

  const publishedSourceById = new Map(
    publishedSourceArticles.map((article) => [article._id, article]),
  )
  const publicInventory = []
  const publicCategoryNameChanges = []

  for (const evidence of publicManifest.articles) {
    const sourceArticle = publishedSourceById.get(evidence.id)
    const snapshotEvidence = publicSnapshotById.get(evidence.id)
    assert(
      sourceArticle,
      `Published Newt article is missing from the full export: ${evidence.id}`,
    )
    assert(
      snapshotEvidence?.article?._id === evidence.id &&
        snapshotEvidence.id === evidence.id,
      `Published Newt article is missing from the locked public snapshot: ${evidence.id}`,
    )
    assert(
      sourceArticle.slug === evidence.sourceSlug &&
        sourceArticle.title === evidence.title,
      `Published Newt identity changed: ${evidence.id}`,
    )
    assertDeepEqual(
      {
        title: sourceArticle.title,
        slug: sourceArticle.slug,
        body: sourceArticle.body,
        meta: sourceArticle.meta ?? null,
      },
      {
        title: snapshotEvidence.article.title,
        slug: snapshotEvidence.article.slug,
        body: snapshotEvidence.article.body,
        meta: snapshotEvidence.article.meta ?? null,
      },
      `Published Newt content differs from the locked public snapshot: ${evidence.id}`,
    )
    assert(
      sha256(sourceArticle.body) === evidence.sourceBodySha256,
      `Published Newt source body changed: ${evidence.id}`,
    )
    assert(
      snapshotEvidence.bodySha256 === evidence.sourceBodySha256 &&
        sha256(snapshotEvidence.article.body) === snapshotEvidence.bodySha256,
      `Published snapshot body hash changed: ${evidence.id}`,
    )
    assertDeepEqual(
      {
        id: sourceArticle.category?._id,
        raw: sourceArticle.category?._sys?.raw,
        customOrder: sourceArticle.category?._sys?.customOrder ?? null,
        sortOrder: sourceArticle.category?.sortOrder,
      },
      {
        id: snapshotEvidence.article.category?._id,
        raw: snapshotEvidence.article.category?._sys?.raw,
        customOrder:
          snapshotEvidence.article.category?._sys?.customOrder ?? null,
        sortOrder: snapshotEvidence.article.category?.sortOrder,
      },
      `Published Newt category provenance differs from the locked public snapshot: ${evidence.id}`,
    )
    const snapshotCategoryName = snapshotEvidence.article.category?.name
    const sourceCategoryName = sourceArticle.category?.name
    if (snapshotCategoryName !== sourceCategoryName) {
      publicCategoryNameChanges.push({
        newtId: evidence.id,
        originalSlug: evidence.sourceSlug,
        categoryId: sourceArticle.category?._id,
        snapshotName: snapshotCategoryName,
        fullApiName: sourceCategoryName,
      })
    }
    const sourceCategory = canonicalCategoryFor(
      sourceArticle.category,
      evidence.id,
    )
    assert(
      sourceCategory === evidence.category,
      `Published Newt category mapping changed: ${evidence.id}`,
    )

    if (verifyRepositoryState) {
      const currentMarkdown = await readFile(
        new URL(`${evidence.targetSlug}.md`, contentDirectory),
      )
      assert(
        sha256(currentMarkdown) === evidence.markdownSha256,
        `Published Markdown changed during full migration: ${evidence.targetSlug}`,
      )
      assert(
        /\ndraft: false\r?\n---(?:\r?\n|$)/u.test(
          currentMarkdown.toString('utf8'),
        ),
        `Published Markdown is no longer explicitly public: ${evidence.targetSlug}`,
      )
    }

    publicInventory.push({
      newtId: evidence.id,
      originalSlug: evidence.sourceSlug,
      targetSlug: evidence.targetSlug,
      markdownPath: evidence.markdownPath,
      sourceCategoryId: sourceArticle.category._id,
      sourceCategoryName: sourceArticle.category.name,
      snapshotCategoryName,
      targetCategory: sourceCategory,
      sourceMeta: sourceArticle.meta ?? null,
      sourceMetaSha256: sha256(JSON.stringify(sourceArticle.meta ?? null)),
      snapshotMetaSha256: sha256(
        JSON.stringify(snapshotEvidence.article.meta ?? null),
      ),
      sourceCategoryRawSha256: sha256(
        JSON.stringify(sourceArticle.category._sys.raw),
      ),
      snapshotCategoryRawSha256: sha256(
        JSON.stringify(snapshotEvidence.article.category._sys.raw),
      ),
      sourceBodySha256: evidence.sourceBodySha256,
      markdownSha256: evidence.markdownSha256,
      draft: false,
    })
  }

  assert(
    publishedSourceById.size === publicInventory.length,
    'The full export contains a published article outside the locked 15-file inventory.',
  )
  assert(
    publicSnapshotById.size === publicInventory.length,
    'The locked public snapshot contains an article outside the 15-file inventory.',
  )
  assertDeepEqual(
    publicCategoryNameChanges,
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
    'The intentional public category-name evolution changed.',
  )

  const mappingById = new Map(
    draftArticleMappings.map((mapping) => [mapping.id, mapping]),
  )
  assertUnique(
    draftArticleMappings.map(({ id }) => id),
    'draft mapping IDs',
  )
  assertUnique(
    draftArticleMappings.map(({ sourceSlug }) => sourceSlug),
    'draft source slugs',
  )
  assertUnique(
    draftArticleMappings.map(({ targetSlug }) => targetSlug.toLowerCase()),
    'case-insensitive draft target slugs',
  )
  assert(
    draftArticleMappings.every(({ targetSlug }) =>
      targetSlugPattern.test(targetSlug),
    ),
    'Draft target slugs must be lowercase ASCII kebab-case.',
  )
  assert(
    draftSourceArticles.every(({ _id }) => mappingById.has(_id)) &&
      mappingById.size === draftSourceArticles.length,
    'Every unpublished Newt article must have exactly one explicit mapping.',
  )

  const publicTargetSlugs = new Set(
    publicInventory.map(({ targetSlug }) => targetSlug.toLowerCase()),
  )
  assert(
    draftArticleMappings.every(
      ({ targetSlug }) => !publicTargetSlugs.has(targetSlug.toLowerCase()),
    ),
    'A draft target slug collides with the published 15-file inventory.',
  )

  const internalTargets = new Map(
    publicManifest.articles.flatMap(({ sourceSlug, targetSlug }) => [
      [sourceSlug, targetSlug],
      [targetSlug, targetSlug],
    ]),
  )
  for (const { sourceSlug, targetSlug } of draftArticleMappings) {
    internalTargets.set(sourceSlug, targetSlug)
    internalTargets.set(targetSlug, targetSlug)
  }
  for (const [sourceSlug, targetSlug] of internalArticleAliases) {
    assert(
      [...internalTargets.values()].includes(targetSlug),
      `Internal alias target does not exist: ${sourceSlug} -> ${targetSlug}`,
    )
    internalTargets.set(sourceSlug, targetSlug)
  }

  const sourceArticleById = new Map(
    draftSourceArticles.map((article) => [article._id, article]),
  )
  const generatedArticles = []
  const draftInventory = []
  const deferredAssets = []

  for (const mapping of draftArticleMappings) {
    const article = sourceArticleById.get(mapping.id)
    assert(article, `Mapped draft article is missing: ${mapping.id}`)
    assert(
      article.slug === mapping.sourceSlug &&
        article.title === mapping.title &&
        article._sys?.raw?.publishedAt === null,
      `Draft article identity or publication state changed: ${mapping.id}`,
    )
    assert(
      typeof article.body === 'string',
      `Draft article body must be a string: ${mapping.id}`,
    )

    const category = canonicalCategoryFor(article.category, mapping.id)
    const description = descriptionFor(article, mapping.id)
    const seoTitle = stringValue(article.meta?.title)
    const normalized = normalizeDraftHtml(article.body, {
      articleId: mapping.id,
      originalSlug: mapping.sourceSlug,
      internalTargets,
    })

    const metaImage = imageSource(article.meta?.ogImage)
    if (metaImage) {
      normalized.assetReferences.push({
        context: 'meta.ogImage',
        sourceUrl: metaImage,
        alt: '',
        disposition: 'inventory-only-not-copied',
      })
    }

    assertMarkdownBody(normalized.markdown, mapping.targetSlug)

    const frontmatter = serializeFrontmatter({
      title: mapping.title,
      seoTitle: seoTitle && seoTitle !== mapping.title ? seoTitle : undefined,
      description,
      category,
      order: mapping.order,
    })
    const markdown = `${frontmatter}\n${normalized.markdown}${normalized.markdown ? '\n' : ''}`
    const markdownPath = `src/content/wiki/${mapping.targetSlug}.md`

    const articleAssets = normalized.assetReferences.map((asset) => ({
      articleId: mapping.id,
      originalSlug: mapping.sourceSlug,
      ...asset,
    }))
    deferredAssets.push(...articleAssets)
    generatedArticles.push({
      fileUrl: new URL(`${mapping.targetSlug}.md`, contentDirectory),
      markdown,
      targetSlug: mapping.targetSlug,
    })
    draftInventory.push({
      newtId: mapping.id,
      originalSlug: mapping.sourceSlug,
      targetSlug: mapping.targetSlug,
      title: mapping.title,
      sourceCategoryId: article.category._id,
      sourceCategoryName: article.category.name,
      targetCategory: category,
      sourceSortOrder: article.sortOrder,
      sourceFirstPublishedAt: article._sys.raw.firstPublishedAt,
      sourcePublishedAt: article._sys.raw.publishedAt,
      targetOrder: mapping.order,
      sourceBodyBytes: Buffer.byteLength(article.body, 'utf8'),
      sourceBodySha256: sha256(article.body),
      markdownPath,
      markdownBytes: Buffer.byteLength(markdown, 'utf8'),
      markdownSha256: sha256(markdown),
      descriptionSource: emptyDescriptionMappings.has(mapping.id)
        ? 'explicit-empty-description-map'
        : 'newt-meta-description',
      deferredAssetCount: articleAssets.length,
      removedSourceElements: normalized.removedSourceElements,
      normalizedSourceElements: normalized.normalizedSourceElements,
      draft: true,
    })
  }

  if (verifyRepositoryState) {
    const expectedMarkdownNames = new Set([
      ...publicInventory.map(({ targetSlug }) => `${targetSlug}.md`),
      ...draftInventory.map(({ targetSlug }) => `${targetSlug}.md`),
    ])
    const currentMarkdownEntries = await readdir(contentDirectory, {
      withFileTypes: true,
    })
    const unexpectedMarkdown = currentMarkdownEntries
      .filter(
        (entry) =>
          entry.isFile() &&
          entry.name.endsWith('.md') &&
          !expectedMarkdownNames.has(entry.name),
      )
      .map(({ name }) => name)
    assert(
      unexpectedMarkdown.length === 0,
      `Unexpected Markdown files are outside the 15 public + 17 draft acceptance inventory: ${unexpectedMarkdown.join(', ')}`,
    )
  }

  const mediaInventory = publicManifest.assets.map(
    ({ localPath, bytes, sha256 }) => ({
      localPath,
      bytes,
      sha256,
    }),
  )
  const expectedMediaPaths = new Set(
    publicManifest.assets.map(({ localPath }) => localPath),
  )
  assert(
    expectedMediaPaths.size === 11 && mediaInventory.length === 11,
    'The locked public migration evidence must contain 11 unique assets.',
  )
  if (verifyRepositoryState) {
    for (const asset of publicManifest.assets) {
      const bytes = await readFile(
        new URL(
          asset.localPath.replace('public/uploads/wiki/', ''),
          mediaDirectory,
        ),
      )
      assert(
        bytes.byteLength === asset.bytes && sha256(bytes) === asset.sha256,
        `Existing public asset changed during draft migration: ${asset.localPath}`,
      )
    }
    const currentMediaEntries = await readdir(mediaDirectory, {
      withFileTypes: true,
    })
    const unexpectedMedia = currentMediaEntries
      .filter(
        (entry) =>
          entry.isFile() &&
          !expectedMediaPaths.has(`public/uploads/wiki/${entry.name}`),
      )
      .map(({ name }) => name)
    assert(
      unexpectedMedia.length === 0,
      `Draft-only media must not be copied during acceptance; unexpected files: ${unexpectedMedia.join(', ')}`,
    )
  }

  const archivedAssetNames = new Set(
    draftAssetAudit
      .filter(({ archivePath }) => archivePath)
      .map(({ archivePath }) => archivePath.split('/').at(-1)),
  )
  const currentArchivedAssetNames = (
    await readdir(draftAssetArchiveDirectory, { withFileTypes: true })
  )
    .filter((entry) => entry.isFile())
    .map(({ name }) => name)
    .toSorted()
  assertDeepEqual(
    currentArchivedAssetNames,
    [...archivedAssetNames].toSorted(),
    'Draft asset archive contains an unexpected file.',
  )

  const verifiedDraftAssets = []
  for (const asset of draftAssetAudit) {
    const archiveFileUrl = new URL(
      asset.archivePath.split('/').at(-1),
      draftAssetArchiveDirectory,
    )
    const bytes = await readFile(archiveFileUrl)
    assert(
      bytes.byteLength === asset.bytes && sha256(bytes) === asset.sha256,
      `Preserved draft asset differs: ${asset.sourceUrl}`,
    )
    if (asset.existingAssetExact) {
      const publicAssetEvidence = publicManifest.assets.find(
        ({ localPath }) => localPath === asset.existingLocalPath,
      )
      assert(
        publicAssetEvidence?.bytes === asset.bytes &&
          publicAssetEvidence?.sha256 === asset.sha256,
        `Existing public-asset evidence differs from the archived draft asset: ${asset.sourceUrl}`,
      )
      if (verifyRepositoryState) {
        const currentPublicAsset = await readFile(
          new URL(asset.existingLocalPath, root),
        )
        assert(
          currentPublicAsset.byteLength === asset.bytes &&
            sha256(currentPublicAsset) === asset.sha256,
          `Existing public asset changed during full-migration acceptance: ${asset.existingLocalPath}`,
        )
      }
    }
    verifiedDraftAssets.push(asset)
  }
  assert(
    verifiedDraftAssets.length === 7 &&
      verifiedDraftAssets.filter(({ archivePath }) => archivePath).length ===
        7 &&
      verifiedDraftAssets.filter(({ existingAssetExact }) => existingAssetExact)
        .length === 1,
    'Expected seven archived draft assets and one additional exact existing-asset match.',
  )
  const draftAssetBySource = new Map(
    verifiedDraftAssets.map((asset) => [asset.sourceUrl, asset]),
  )
  const preservedDeferredAssets = deferredAssets.map((reference) => {
    const preservation = draftAssetBySource.get(reference.sourceUrl)
    assert(
      preservation,
      `Draft asset reference lacks preserved evidence: ${reference.sourceUrl}`,
    )
    return {
      ...reference,
      preservedAt: preservation.archivePath ?? preservation.existingLocalPath,
      preservedSha256: preservation.sha256,
    }
  })

  const azkaban = sourceArticles.find(
    ({ _id }) => _id === '67c952cc395b530d64002c05',
  )
  const azkabanPlugins = sourceArticles.find(
    ({ _id }) => _id === '635be0c506cfd5386b2fee26',
  )
  assert(
    azkaban?.body.includes(azkabanPlugins?.body) &&
      azkabanPlugins?.body.length > 0,
    'The known Azkaban/AzkabanPluginsList source-body containment changed.',
  )
  const knownDuplicateContent = [
    {
      containingArticleId: azkaban._id,
      containingOriginalSlug: azkaban.slug,
      containedArticleId: azkabanPlugins._id,
      containedOriginalSlug: azkabanPlugins.slug,
      relation: 'source-body-contains-exact-source-body',
      containedSourceBodySha256: sha256(azkabanPlugins.body),
    },
  ]
  const knownSupersededContent = [
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
  ]

  const generatedManifest = {
    schemaVersion: 1,
    migrationPreparedOn: '2026-07-29',
    sourceExport: {
      directory: 'migration/newt-full-export-2026-07-29',
      manifestPath: 'migration/newt-full-export-2026-07-29/manifest.json',
      manifestBytes: sourceManifestBytes.byteLength,
      manifestSha256: sha256(sourceManifestBytes),
      exportedAt: sourceManifest.exportedAt,
      source: sourceManifest.source,
      files: sourceManifest.files,
    },
    uiEvidence: {
      evidencePath:
        'migration/newt-full-export-2026-07-29/model-view-schema.json',
      evidenceBytes: uiEvidenceBytes.byteLength,
      evidenceSha256: sha256(uiEvidenceBytes),
      observedOn: uiEvidence.capturedAt,
      source: uiEvidence.source,
      appExport: {
        availableOnCurrentPlan: false,
        result: 'plan-unavailable',
      },
      models: uiEvidence.models.map(({ name, uid }) => ({
        name,
        uid,
        fields:
          uid === 'article'
            ? [
                'title',
                'slug',
                'meta.title',
                'meta.description',
                'meta.ogImage',
                'body',
                'category',
                'sortOrder',
              ]
            : uid === 'category'
              ? ['name', 'sortOrder']
              : ['text', 'href'],
      })),
      views: uiEvidence.views.map(({ name, modelName, modelUid, type }) => ({
        name,
        modelName,
        modelUid,
        uid: modelUid,
        type,
      })),
    },
    inventory: {
      newtArticleCount: sourceArticles.length,
      publicMarkdownCount: publicInventory.length,
      draftMarkdownCount: draftInventory.length,
      totalMarkdownCount: publicInventory.length + draftInventory.length,
      retainedPublicAssetCount: mediaInventory.length,
      publicDraftAssetCount: 0,
      archivedDraftAssetCount: verifiedDraftAssets.filter(
        ({ archivePath }) => archivePath,
      ).length,
      exactExistingPublicAssetMatchCount: verifiedDraftAssets.filter(
        ({ existingAssetExact }) => existingAssetExact,
      ).length,
      uniqueDraftAssetCount: verifiedDraftAssets.length,
      deferredDraftAssetReferenceCount: preservedDeferredAssets.length,
      newtCategoryCount: sourceCategories.length,
      newtLinkCount: sourceLinks.length,
      formerlyPublishedDraftCount: historicallyPublishedDrafts.length,
      neverPublishedDraftCount: neverPublishedDrafts.length,
      emptyBodyDraftCount: emptyBodyDrafts.length,
    },
    sourceInventory: {
      categories: sourceCategories.map((category) => ({
        newtId: category._id,
        name: category.name,
        sortOrder: category.sortOrder,
        publishedAt: category._sys?.raw?.publishedAt ?? null,
      })),
      links: sourceLinks.map((link) => ({
        newtId: link._id,
        text: link.text,
        href: link.href,
        publishedAt: link._sys?.raw?.publishedAt ?? null,
      })),
    },
    sourceCollisionAudit: {
      articleIdExactCollisionCount:
        sourceArticles.length -
        new Set(sourceArticles.map(({ _id }) => _id)).size,
      sourceSlugExactCollisionCount:
        sourceArticles.length -
        new Set(sourceArticles.map(({ slug }) => slug)).size,
      sourceSlugNfcCaseInsensitiveCollisionCount:
        sourceArticles.length -
        new Set(
          sourceArticles.map(({ slug }) =>
            slug.normalize('NFC').toLocaleLowerCase('en-US'),
          ),
        ).size,
      sourceBodySha256ExactCollisionCount:
        sourceBodyHashes.length - new Set(sourceBodyHashes).size,
      titleCollisionGroupCount: sourceTitleCollisionGroups.length,
      titleCollisionGroups: sourceTitleCollisionGroups,
    },
    publicEvidence: {
      manifestPath: 'migration/newt-public-payload-manifest.json',
      manifestSha256: sha256(publicManifestBytes),
      snapshotPath: 'migration/newt-public-content-snapshot.json',
      snapshotBytes: publicSnapshotBytes.byteLength,
      snapshotSha256: sha256(publicSnapshotBytes),
      snapshotOrigin: publicSnapshot.source.origin,
      snapshotCapturedAt: publicSnapshot.source.capturedAt,
      categoryNameChanges: publicCategoryNameChanges,
    },
    publicInventory,
    draftInventory,
    publicationPolicy: {
      allImportedArticlesRemainDraft: true,
      editorialReviewRequiredBeforePublishing: true,
      additionalSecurityReview: publicationReviewMappings,
    },
    knownDuplicateContent,
    knownSupersededContent,
    draftAssetArchive: {
      observedOn: '2026-07-29',
      observedHttpStatus: 200,
      allSourcesReachableAtObservation: true,
      publicDraftAssetCount: 0,
      assets: verifiedDraftAssets,
    },
    retainedPublicAssets: mediaInventory,
    deferredDraftAssets: preservedDeferredAssets,
  }
  const manifest = `${JSON.stringify(generatedManifest, null, 2)}\n`

  return {
    generatedArticles,
    generatedManifest,
    manifest,
    targetManifestUrl,
  }
}

export async function runDraftMigrationImport({ checkOnly = false } = {}) {
  const plan = await buildDraftMigrationPlan({
    verifyRepositoryState: true,
  })

  if (checkOnly) {
    for (const generated of plan.generatedArticles) {
      const current = await readFile(generated.fileUrl, 'utf8')
      assert(
        current.replace(/\r\n?/gu, '\n') === generated.markdown,
        `Generated draft Markdown differs: ${generated.targetSlug}`,
      )
    }
    const currentManifest = await readFile(plan.targetManifestUrl, 'utf8')
    assert(
      currentManifest.replace(/\r\n?/gu, '\n') === plan.manifest,
      'Generated full-migration manifest differs from the committed manifest.',
    )
    console.log(
      'Verified deterministic Newt migration acceptance: 15 published Markdown files unchanged, 17 draft Markdown files exact, and 0 draft assets added to the public path.',
    )
    return plan
  }

  for (const generated of plan.generatedArticles) {
    await assertAbsentOrExact(
      generated.fileUrl,
      generated.markdown,
      `Refusing to overwrite edited draft Markdown: ${generated.targetSlug}`,
    )
  }
  await assertAbsentOrExact(
    plan.targetManifestUrl,
    plan.manifest,
    'Refusing to overwrite a different full-migration manifest.',
  )

  await mkdir(contentDirectory, { recursive: true })
  await Promise.all(
    plan.generatedArticles.map(({ fileUrl, markdown }) =>
      writeFile(fileUrl, markdown, 'utf8'),
    ),
  )
  await writeFile(plan.targetManifestUrl, plan.manifest, 'utf8')
  console.log(
    'Imported 17 unpublished Newt articles as draft:true Markdown; preserved the 15-file public inventory and added no draft assets to the public path.',
  )
  return plan
}

export function canonicalCategoryFor(category, articleId) {
  assert(
    category &&
      typeof category._id === 'string' &&
      typeof category.name === 'string',
    `Draft article category is missing: ${articleId}`,
  )
  const mapping = categoryMappings.get(category._id)
  assert(mapping, `Unknown Newt category ID for ${articleId}: ${category._id}`)
  assert(
    category.name === mapping.sourceName,
    `Newt category name changed for ${articleId}: expected ${mapping.sourceName}, received ${category.name}`,
  )
  return mapping.targetName
}

export function descriptionFor(article, articleId) {
  const sourceDescription = stringValue(article.meta?.description)
  const mappedDescription = emptyDescriptionMappings.get(articleId)

  if (sourceDescription) {
    assert(
      !mappedDescription,
      `A no-longer-empty description still has an override: ${articleId}`,
    )
    assert(
      sourceDescription.length <= 240,
      `Newt description exceeds the current schema: ${articleId}`,
    )
    return sourceDescription
  }

  assert(
    mappedDescription,
    `Empty Newt description requires an explicit mapping: ${articleId}`,
  )
  return mappedDescription
}

export function normalizeDraftHtml(
  source,
  { articleId, originalSlug, internalTargets },
) {
  assert(typeof source === 'string', `HTML body is not a string: ${articleId}`)
  const fragment = parseFragment(source)
  const removedSourceElementCounts = new Map()
  const normalizedSourceElementCounts = new Map()
  const assetReferences = []

  for (const element of findNodes(fragment, (node) => node.tagName)) {
    assert(
      !blockedSourceElements.has(element.tagName),
      `Blocked HTML element <${element.tagName}> in ${articleId}`,
    )
  }

  for (const tagName of ['style', 'script']) {
    for (const node of findNodes(
      fragment,
      (candidate) => candidate.tagName === tagName,
    )) {
      increment(removedSourceElementCounts, tagName)
      replaceNode(node, [])
    }
  }

  for (const heading of findNodes(fragment, (node) => node.tagName === 'h1')) {
    heading.nodeName = 'h2'
    heading.tagName = 'h2'
    increment(normalizedSourceElementCounts, 'h1-to-h2')
  }

  for (const details of findNodes(
    fragment,
    (node) => node.tagName === 'details',
  )) {
    const summary = details.childNodes?.find(
      (child) => child.tagName === 'summary',
    )
    const heading = createElement(
      'h4',
      summary?.childNodes?.length
        ? summary.childNodes
        : [createTextNode('詳細')],
    )
    const content =
      details.childNodes?.filter((child) => child !== summary) ?? []
    replaceNode(details, [heading, ...content])
    increment(normalizedSourceElementCounts, 'details-to-heading')
  }

  for (const select of findNodes(
    fragment,
    (node) => node.tagName === 'select',
  )) {
    const options = findNodes(select, (node) => node.tagName === 'option').map(
      (option) =>
        createElement('li', [createTextNode(textContent(option).trim())]),
    )
    assert(
      options.length > 0,
      `Encountered an empty HTML select in ${articleId}`,
    )
    replaceNode(select, [createElement('ul', options)])
    increment(normalizedSourceElementCounts, 'select-to-list')
  }

  for (const image of findNodes(fragment, (node) => node.tagName === 'img')) {
    const sourceUrl = getAttribute(image, 'src').trim()
    assert(sourceUrl, `Image src is missing in ${articleId}`)
    assertSafeAssetSource(sourceUrl, articleId)
    const alt = getAttribute(image, 'alt').trim()
    const label = alt || imageFileLabel(sourceUrl)
    assetReferences.push({
      context: 'body.img',
      sourceUrl,
      alt,
      disposition: 'inventory-only-not-copied',
    })
    replaceNode(image, [
      createElement('em', [createTextNode(`画像は移行保留です（${label}）`)]),
    ])
    increment(normalizedSourceElementCounts, 'image-to-deferred-note')
  }

  const rewriteHref = (href) =>
    rewriteInternalHref(href, {
      articleId,
      internalTargets,
    })

  for (const anchor of findNodes(fragment, (node) => node.tagName === 'a')) {
    const href = getAttribute(anchor, 'href')
    if (!href) continue
    setAttribute(anchor, 'href', rewriteHref(href))
  }

  const tableMarkdown = []
  for (const table of findNodes(fragment, (node) => node.tagName === 'table')) {
    const marker = `WIKIDRAFTTABLETOKEN${tableMarkdown.length}END`
    assert(
      !source.includes(marker),
      `Generated table marker collides with source text: ${articleId}`,
    )
    tableMarkdown.push(convertTable(table, rewriteHref))
    replaceNode(table, [createElement('p', [createTextNode(marker)])])
    increment(normalizedSourceElementCounts, 'table-to-markdown')
  }

  let markdown = turndown.turndown(serialize(fragment))
  tableMarkdown.forEach((table, index) => {
    markdown = replaceMarkdownTableMarker(
      markdown,
      `WIKIDRAFTTABLETOKEN${index}END`,
      table,
    )
  })
  const knownRepairs = normalizeKnownDraftMarkdown(markdown, originalSlug)
  markdown = knownRepairs.markdown
  for (const operation of knownRepairs.operations) {
    increment(normalizedSourceElementCounts, operation)
  }
  const headingMarkerRepairs = markdown.match(/^(#{2,6})[ \t]+-[ \t]+/gmu)
  if (headingMarkerRepairs) {
    normalizedSourceElementCounts.set(
      'heading-marker-repair',
      headingMarkerRepairs.length,
    )
  }
  markdown = markdown
    .replace(/^(#{2,6})[ \t]+-[ \t]+/gmu, '$1 ')
    .replace(/[ \t]+\n/gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()

  assertMarkdownBody(markdown, originalSlug)

  return {
    markdown,
    assetReferences,
    removedSourceElements: sortedCountEntries(removedSourceElementCounts),
    normalizedSourceElements: sortedCountEntries(normalizedSourceElementCounts),
  }
}

function normalizeKnownDraftMarkdown(markdown, originalSlug) {
  let normalized = markdown
  const operations = []

  if (originalSlug === 'SurvivalGuideFacility') {
    const repaired = unindentFromHeading(
      normalized,
      '### あすたん王国　X-200 Z-400',
    )
    if (repaired !== normalized) {
      normalized = repaired
      operations.push('list-indent-repair')
    }
  }

  if (originalSlug === 'world') {
    const repaired = normalized.replace(
      /倉庫、植林場、採掘場を用意してます。\*\*[ \t]*\r?\n[ \t]*主な施設\*\*/u,
      '倉庫、植林場、採掘場を用意してます。\n\n**主な施設**',
    )
    assert(
      repaired !== normalized,
      'The locked world strong-boundary repair target changed.',
    )
    normalized = repaired
    operations.push('strong-boundary-repair')
  }

  if (originalSlug === 'SurvivalRules') {
    const repaired = normalized.replace(
      '参加方法：https://aceserver-wiki.acecore.systems/article/in/',
      '参加方法：https://asv-wiki.acecore.net/article/in/',
    )
    if (repaired !== normalized) {
      normalized = repaired
      operations.push('legacy-url-rewrite')
    }
  }

  return { markdown: normalized, operations }
}

function unindentFromHeading(markdown, heading) {
  const start = markdown.indexOf(`    ${heading}`)
  if (start < 0) return markdown

  return (
    markdown.slice(0, start) + markdown.slice(start).replace(/^ {4}/gmu, '')
  )
}

export function assertMarkdownBody(markdown, id) {
  assert(
    !rawHtmlPattern.test(markdown),
    `Raw HTML remains after draft conversion: ${id}`,
  )
  assert(
    !dangerousUriPattern.test(normalizeUriText(markdown)),
    `Dangerous URI remains after draft conversion: ${id}`,
  )
  assert(
    !containsLevelOneHeading(markdown),
    `Level-one heading remains after draft conversion: ${id}`,
  )
  assert(
    !/!\[[^\]]*\]\([^)]*\)/u.test(markdown),
    `Draft images must remain inventory-only until assets are reviewed: ${id}`,
  )
}

function assertApiCollection(payload, expected) {
  assert(
    payload &&
      payload.skip === 0 &&
      payload.limit === 1000 &&
      payload.total === expected.total &&
      Array.isArray(payload.items) &&
      payload.items.length === expected.items,
    `Unexpected Newt API collection envelope: ${expected.fileName}`,
  )
  assert(
    new Set(payload.items.map(({ _id }) => _id)).size === expected.uniqueIds,
    `Unexpected unique ID count: ${expected.fileName}`,
  )
}

function isPublished(article) {
  return (
    typeof article?._sys?.raw?.publishedAt === 'string' &&
    article._sys.raw.publishedAt.length > 0
  )
}

function imageSource(value) {
  if (typeof value === 'string') return value.trim()
  if (value && typeof value.src === 'string') return value.src.trim()
  return ''
}

function assertSafeAssetSource(sourceUrl, articleId) {
  let url
  try {
    url = new URL(sourceUrl)
  } catch {
    throw new Error(`Draft asset URL is invalid in ${articleId}: ${sourceUrl}`)
  }
  assert(
    url.protocol === 'https:' && url.username === '' && url.password === '',
    `Draft asset URL must be credential-free HTTPS in ${articleId}: ${sourceUrl}`,
  )
}

function imageFileLabel(sourceUrl) {
  const url = new URL(sourceUrl)
  const encodedName = url.pathname.split('/').at(-1) || '画像'
  try {
    return decodeURIComponent(encodedName).split('/').at(-1) || '画像'
  } catch {
    return encodedName
  }
}

function rewriteInternalHref(href, { articleId, internalTargets }) {
  const trimmed = href.trim()
  if (!trimmed) return ''

  if (/^(?:mailto|tel):/iu.test(trimmed)) return trimmed

  let url
  try {
    url = new URL(trimmed, 'https://asv-wiki.acecore.net')
  } catch {
    throw new Error(`Invalid link in ${articleId}: ${href}`)
  }
  assert(
    url.protocol === 'http:' || url.protocol === 'https:',
    `Unsupported link scheme in ${articleId}: ${href}`,
  )
  if (!legacyOrigins.has(url.origin)) return trimmed

  let decodedPath
  try {
    decodedPath = decodeURIComponent(url.pathname).normalize('NFC')
  } catch {
    throw new Error(`Invalid encoded internal link in ${articleId}: ${href}`)
  }
  const match = /^\/article\/([^/]+)\/?$/u.exec(decodedPath)
  if (!match) return `${url.pathname}${url.search}${url.hash}`

  const targetSlug = internalTargets.get(match[1])
  assert(
    targetSlug,
    `Internal article link has no explicit migration target in ${articleId}: ${match[1]}`,
  )
  return `/article/${targetSlug}/${url.search}${url.hash}`
}

function convertTable(table, rewriteHref) {
  const rows = findNodes(table, (node) => {
    if (node.tagName !== 'tr') return false

    let ancestor = node.parentNode
    while (ancestor && ancestor !== table) {
      if (ancestor.tagName === 'table') return false
      ancestor = ancestor.parentNode
    }
    return ancestor === table
  })
  const grid = []
  const futureCells = new Map()
  const headerFlags = []
  const inheritedColumnsByRow = []

  rows.forEach((row, rowIndex) => {
    const cells = (row.childNodes ?? []).filter(
      (node) => node.tagName === 'td' || node.tagName === 'th',
    )
    const outputRow = []
    const scheduled = futureCells.get(rowIndex)

    if (scheduled) {
      for (const [column, content] of scheduled) outputRow[column] = content
    }

    let column = 0
    let containsHeader = false
    for (const cell of cells) {
      while (outputRow[column] !== undefined) column += 1
      const content = tableCellMarkdown(cell, rewriteHref)
      const rowSpan = positiveIntegerAttribute(cell, 'rowspan')
      const columnSpan = positiveIntegerAttribute(cell, 'colspan')
      containsHeader ||= cell.tagName === 'th'

      for (let offset = 0; offset < columnSpan; offset += 1) {
        outputRow[column + offset] = content
        for (let rowOffset = 1; rowOffset < rowSpan; rowOffset += 1) {
          const targetRow = rowIndex + rowOffset
          const target = futureCells.get(targetRow) ?? new Map()
          target.set(column + offset, content)
          futureCells.set(targetRow, target)
        }
      }
      column += columnSpan
    }

    if (outputRow.some((cell) => cell !== undefined)) {
      grid.push(outputRow)
      headerFlags.push(containsHeader)
      inheritedColumnsByRow.push(new Set(scheduled?.keys() ?? []))
    }
  })

  assert(grid.length > 0, 'Encountered an empty HTML table.')
  const columnCount = Math.max(...grid.map((row) => row.length))
  const normalized = collapseRowspanAliasRows(
    grid.map((row) =>
      Array.from({ length: columnCount }, (_, index) => row[index] ?? ''),
    ),
    inheritedColumnsByRow,
  )
  const header = normalized[0]
  const body = normalized.slice(1)
  if (!headerFlags[0] && body.length === 0) {
    body.push(Array.from({ length: columnCount }, () => ''))
  }

  return [
    markdownTableRow(header),
    markdownTableRow(Array.from({ length: columnCount }, () => '---')),
    ...body.map(markdownTableRow),
  ].join('\n')
}

function tableCellMarkdown(cell, rewriteHref) {
  const render = (node) => {
    if (node.nodeName === '#text') return node.value
    if (node.tagName === 'br') return ' ／ '
    if (node.tagName === 'a') {
      const label = renderChildren(node).trim()
      const href = getAttribute(node, 'href')
      return href ? `[${label}](${rewriteHref(href)})` : label
    }
    if (node.tagName === 'code') return `\`${renderChildren(node).trim()}\``
    if (node.tagName === 'b' || node.tagName === 'strong') {
      return `**${renderChildren(node).trim()}**`
    }
    if (node.tagName === 'li') return `${renderChildren(node).trim()} ／ `
    return renderChildren(node)
  }
  const renderChildren = (node) => (node.childNodes ?? []).map(render).join('')

  return renderChildren(cell)
    .replace(/\s+/gu, ' ')
    .replace(/(?:\s*／\s*){2,}/gu, ' ／ ')
    .replace(/\s*／\s*$/u, '')
    .replaceAll('|', '\\|')
    .trim()
}

function markdownTableRow(cells) {
  return `| ${cells.join(' | ')} |`
}

function serializeFrontmatter(article) {
  return [
    '---',
    `title: ${JSON.stringify(article.title)}`,
    ...(article.seoTitle
      ? [`seoTitle: ${JSON.stringify(article.seoTitle)}`]
      : []),
    `description: ${JSON.stringify(article.description)}`,
    `category: ${JSON.stringify(article.category)}`,
    `order: ${article.order}`,
    'draft: true',
    '---',
  ].join('\n')
}

function findNodes(rootNode, predicate) {
  const results = []
  const visit = (node) => {
    if (predicate(node)) results.push(node)
    for (const child of node.childNodes ?? []) visit(child)
  }
  visit(rootNode)
  return results
}

function replaceNode(node, replacements) {
  const parent = node.parentNode
  assert(parent?.childNodes, 'Cannot replace a detached HTML node.')
  const index = parent.childNodes.indexOf(node)
  assert(index >= 0, 'Cannot locate an HTML node in its parent.')
  for (const replacement of replacements) replacement.parentNode = parent
  parent.childNodes.splice(index, 1, ...replacements)
}

function createTextNode(value) {
  return { nodeName: '#text', value, parentNode: null }
}

function createElement(tagName, childNodes) {
  const element = {
    nodeName: tagName,
    tagName,
    attrs: [],
    namespaceURI: xhtmlNamespace,
    childNodes,
    parentNode: null,
  }
  for (const child of childNodes) child.parentNode = element
  return element
}

function getAttribute(node, name) {
  return node.attrs?.find((attribute) => attribute.name === name)?.value ?? ''
}

function setAttribute(node, name, value) {
  const attribute = node.attrs?.find((candidate) => candidate.name === name)
  if (attribute) {
    attribute.value = value
  } else {
    node.attrs = [...(node.attrs ?? []), { name, value }]
  }
}

function positiveIntegerAttribute(node, name) {
  const value = Number.parseInt(getAttribute(node, name), 10)
  return Number.isSafeInteger(value) && value > 0 ? value : 1
}

function textContent(node) {
  if (node.nodeName === '#text') return node.value
  return (node.childNodes ?? []).map(textContent).join('')
}

function containsLevelOneHeading(source) {
  const lines = source.replace(/\r\n?/gu, '\n').split('\n')
  let fence = null
  let previousLineCanBeHeading = false

  for (const line of lines) {
    const fenceMatch = /^(?: {0,3})(`{3,}|~{3,})/u.exec(line)
    if (fenceMatch) {
      const marker = fenceMatch[1][0]
      const length = fenceMatch[1].length
      if (!fence) {
        fence = { marker, length }
      } else if (fence.marker === marker && length >= fence.length) {
        fence = null
      }
      previousLineCanBeHeading = false
      continue
    }
    if (fence || /^(?: {4}|\t)/u.test(line)) {
      previousLineCanBeHeading = false
      continue
    }
    if (
      /^(?: {0,3})#(?:[ \t]+|$)/u.test(line) ||
      (previousLineCanBeHeading && /^(?: {0,3})=+[ \t]*$/u.test(line))
    ) {
      return true
    }
    previousLineCanBeHeading = line.trim().length > 0
  }
  return false
}

function normalizeUriText(value) {
  return value
    .replace(
      /&#(?:x([0-9a-f]{1,6})|([0-9]{1,7}));?/giu,
      (match, hexadecimal, decimal) => {
        const codePoint = Number.parseInt(
          hexadecimal || decimal || '',
          hexadecimal ? 16 : 10,
        )
        return Number.isSafeInteger(codePoint) && codePoint <= 0x10ffff
          ? String.fromCodePoint(codePoint)
          : match
      },
    )
    .replace(/&(?:colon|tab|newline);/giu, (entity) =>
      /^&colon;/iu.test(entity) ? ':' : '',
    )
    .split('')
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0
      return codePoint > 0x20 && codePoint !== 0x7f
    })
    .join('')
}

function increment(counts, key) {
  counts.set(key, (counts.get(key) ?? 0) + 1)
}

function sortedCountEntries(counts) {
  return [...counts.entries()]
    .toSorted(([left], [right]) => left.localeCompare(right, 'en'))
    .map(([element, count]) => ({ element, count }))
}

function stringValue(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function hasObjectPath(value, path) {
  let current = value
  for (const segment of path.split('.')) {
    if (!current || typeof current !== 'object' || !(segment in current)) {
      return false
    }
    current = current[segment]
  }
  return true
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString('utf8'))
  } catch {
    throw new Error(`Invalid JSON: ${label}`)
  }
}

function assertUnique(values, label) {
  assert(
    new Set(values).size === values.length &&
      values.every((value) => typeof value === 'string' && value.length > 0),
    `Expected unique non-empty ${label}.`,
  )
}

async function assertAbsentOrExact(fileUrl, expected, message) {
  try {
    await access(fileUrl)
  } catch {
    return
  }
  const current = await readFile(fileUrl, 'utf8')
  assert(current.replace(/\r\n?/gu, '\n') === expected, message)
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

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : ''
if (invokedPath && pathToFileURL(invokedPath).href === import.meta.url) {
  const commandArguments = process.argv.slice(2)
  const checkOnly = commandArguments.includes('--check')
  assert(
    commandArguments.every((argument) => argument === '--check') &&
      commandArguments.filter((argument) => argument === '--check').length <= 1,
    'Usage: node scripts/import-newt-drafts.mjs [--check]',
  )
  await runDraftMigrationImport({ checkOnly })
}
