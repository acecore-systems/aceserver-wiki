import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { unflatten } from 'devalue'
import { parseFragment, serialize } from 'parse5'
import TurndownService from 'turndown'

import {
  collapseRowspanAliasRows,
  normalizeKnownMigratedMarkdown,
  replaceMarkdownTableMarker,
} from './newt-markdown-normalization.mjs'

const root = new URL('../', import.meta.url)
const CONTENT_DIRECTORY = new URL('src/content/wiki/', root)
const MEDIA_DIRECTORY = new URL('public/uploads/wiki/', root)
const MANIFEST_URL = new URL(
  'migration/newt-public-payload-manifest.json',
  root,
)
const SNAPSHOT_URL = new URL(
  'migration/newt-public-content-snapshot.json',
  root,
)
const commandArguments = process.argv.slice(2)
const CHECK_ONLY = commandArguments.includes('--check')

assert(
  commandArguments.every((argument) => argument === '--check') &&
    commandArguments.filter((argument) => argument === '--check').length <= 1,
  'Usage: node scripts/import-newt-public.mjs [--check]',
)

const immutableManifest = JSON.parse(await readFile(MANIFEST_URL, 'utf8'))
const snapshot = JSON.parse(await readFile(SNAPSHOT_URL, 'utf8'))
const SOURCE_ORIGIN = normalizeOrigin(immutableManifest.source.origin)
const LEGACY_SOURCE_ORIGINS = new Set([
  SOURCE_ORIGIN,
  'https://asv-wiki.acecore.net',
  'https://aceserver-wiki.pages.dev',
])
const XHTML_NAMESPACE = 'http://www.w3.org/1999/xhtml'

const ARTICLES = [
  {
    id: '6a585343d2c46e306ca40722',
    sourceSlug: 'other-server',
    targetSlug: 'other-server',
    title: 'その他サーバーについて',
    category: '生活鯖について',
    order: 10,
    bodyBytes: 1747,
    description:
      'その他サーバーについて、シーズンサーバーの構成と遊び方を案内します。常時設置される2台のサーバーそれぞれの仕様や、参加前に確認したい違いをまとめています。',
  },
  {
    id: '6a578bb7d2c46e306ca21a78',
    sourceSlug: 'hub-intro',
    targetSlug: 'hub-intro',
    title: 'hub紹介',
    category: '生活鯖について',
    order: 20,
    bodyBytes: 1768,
    description:
      'Hubワールドの初期スポーン地点と、中心街「エースタウン」を紹介します。主要施設や人が集まる場所を把握し、サーバー参加後の移動や探索に役立てられます。',
  },
  {
    id: '67d56eb21c808a95b6824af7',
    sourceSlug: 'discord-rule',
    targetSlug: 'discord-rule',
    title: 'ルール',
    seoTitle: 'ディスコードのルール',
    category: 'ディスコードについて',
    order: 30,
    bodyBytes: 845,
    description:
      'エースサーバー公式Discordで守る基本ルールをまとめています。招待URLを投稿できる部屋や、コミュニティリーダーに認められる例外を確認できます。',
  },
  {
    id: '63453173d2720e3d2d563c0a',
    sourceSlug: 'rule',
    targetSlug: 'rule',
    title: 'ルール・BAN条件',
    seoTitle: 'ルール',
    category: '生活鯖について',
    order: 40,
    bodyBytes: 14930,
    description:
      'エースサーバー内で全員が楽しく遊ぶための基本ルールを案内します。禁止事項や守るべきマナーを参加前に確認し、安心できるコミュニティづくりにご協力ください。',
  },
  {
    id: '67d56f2d1c808a95b68259e1',
    sourceSlug: 'discord-roles',
    targetSlug: 'discord-roles',
    title: '各ロールの説明',
    seoTitle: 'ディスコードのロールについて',
    category: 'ディスコードについて',
    order: 50,
    bodyBytes: 2011,
    description:
      'エースサーバー公式Discordで使われる運営、サポーター、イベントサポーターなどのロールを紹介します。各役職の役割や活動範囲、参加者との関わり方を確認できます。',
  },
  {
    id: '6406fcb64279ec68fbbc4bf2',
    sourceSlug: 'how to discordsrv link',
    targetSlug: 'how-to-discordsrv-link',
    title: 'ディスコード連携のやり方',
    category: '生活鯖について',
    order: 60,
    bodyBytes: 1426,
    description:
      'エースサーバーで遊ぶために必要な、DiscordアカウントとMinecraftアカウントの連携手順を案内します。認証の流れを順番に確認し、参加前の設定を完了できます。',
  },
  {
    id: '61e93243616290001858fe14',
    sourceSlug: 'rinen',
    targetSlug: 'rinen',
    title: 'サーバー理念',
    category: 'イントロダクション',
    order: 70,
    bodyBytes: 1691,
    description:
      'エースサーバーが大切にする「みんなの居場所であること」という理念を説明します。参加者だけでなく、これから参加する人、運営やサポーターも含めた考え方です。',
    ogImage: '/uploads/wiki/server-philosophy-og.png',
  },
  {
    id: '635e74f0e069d0741c37c397',
    sourceSlug: 'SurvivalCommand',
    targetSlug: 'SurvivalCommand',
    title: 'コマンドについて',
    category: '生活鯖について',
    order: 80,
    bodyBytes: 7014,
    description:
      'エースサーバーで利用できるコマンドと使い方をまとめています。通常のMinecraftにあるコマンドと、導入プラグイン固有のコマンドを目的別に確認できます。',
  },
  {
    id: '634531c7d2720e3d2d56ef9c',
    sourceSlug: 'in',
    targetSlug: 'in',
    title: '参加方法',
    category: 'イントロダクション',
    order: 90,
    bodyBytes: 4292,
    description:
      'エースサーバーへの参加方法を順番に案内します。公式Discordへの参加、Minecraftアカウントとの連携など、初めて遊ぶ前に必要な準備を確認できます。',
  },
  {
    id: '635966e2f8dd31b69e7a6ccb',
    sourceSlug: 'SurvivalPluginsList',
    targetSlug: 'SurvivalPluginsList',
    title: 'プラグイン一覧',
    seoTitle: 'エース鯖(メイン鯖)のプラグイン一覧',
    category: '生活鯖について',
    order: 100,
    bodyBytes: 2258,
    description:
      'エースサーバーのメインサーバーに導入しているプラグインを一覧で紹介します。CoreProtectやGSitなど、各プラグインの役割と利用できる機能を確認できます。',
  },
  {
    id: '634530dfd2720e3d2d54e7ec',
    sourceSlug: 'howto',
    targetSlug: 'howto',
    title: '遊び方',
    category: 'イントロダクション',
    order: 110,
    bodyBytes: 4302,
    description:
      'エースサーバーでの基本的な遊び方を案内します。参加後にできることや、権限によって利用条件が異なる機能を確認し、自分に合った楽しみ方を見つけられます。',
  },
  {
    id: '641a68535297515063afd957',
    sourceSlug: 'About management team',
    targetSlug: 'about-management-team',
    title: '運営陣について',
    category: 'その他',
    order: 120,
    bodyBytes: 1675,
    description:
      'エースサーバーの運営陣について、参加者に理解してほしい考え方と注意点をまとめています。無料で提供するサービスを支える運営・サポーターへの配慮を確認できます。',
  },
  {
    id: '63628c7db48748bdc77e6f61',
    sourceSlug: 'Hoe Kingdom',
    targetSlug: 'hoe-kingdom',
    title: 'くわ王国',
    category: 'コミュニティ紹介',
    order: 130,
    bodyBytes: 402,
    description:
      'くわ王国は、中心地から離れた場所に巨大な王国を築くコミュニティです。住みやすさと街並み・城の景観を両立させる具体的な活動内容や目標を紹介します。',
  },
  {
    id: '63c6641ef6bd29a2e7b03c03',
    sourceSlug: 'Asutan　Kingdom',
    targetSlug: 'asutan-kingdom',
    title: 'あすたん王国',
    category: 'コミュニティ紹介',
    order: 140,
    bodyBytes: 5649,
    description:
      'あすたん王国は、あすたんが王女として治めるエースサーバー内のコミュニティです。設置された各種装置を活用し、資材を供給する王国の特徴を紹介します。',
  },
  {
    id: '634532c6d2720e3d2d5801f3',
    sourceSlug: 'promotion',
    targetSlug: 'promotion',
    title: '宣伝に利用させていただいているサービス',
    seoTitle: 'プロモーション',
    category: 'その他',
    order: 150,
    bodyBytes: 3224,
    description:
      'エースサーバーのプロモーション方針と活動内容を紹介します。参加者により楽しんでもらうため、複数のサービスで情報を発信し、コミュニティを盛り上げる取り組みをまとめています。',
  },
]

const CATEGORIES = [
  { id: '61e92e9f616290001858f8a4', name: 'イントロダクション' },
  { id: '635d007306cfd5386b36f752', name: '生活鯖について' },
  { id: '67c94e6c395b530d64ff9669', name: 'その他サーバーについて' },
  { id: '67c9514e33281c1d6502bd9e', name: 'ディスコードについて' },
  { id: '635cac9d06cfd5386b36b3dc', name: 'コミュニティ紹介' },
  { id: '61e936ac8b1cc500187ad308', name: 'その他' },
]

const LINKS = [
  {
    id: '641696afb836a015edcad52a',
    text: 'ワールドマップ',
    href: 'https://asv.acecore.net/world-map/',
  },
  {
    id: '6347cd906892c6a352914f05',
    text: 'Acecore',
    href: 'https://acecore.net',
  },
  {
    id: '6347cd5f6892c6a352914185',
    text: 'エースサーバーポータル',
    href: 'https://asv.acecore.net',
  },
]

const ASSETS = [
  {
    sourceUrl:
      'https://cdn.pixabay.com/photo/2018/03/07/08/13/shaking-hands-3205463_960_720.jpg',
    fileName: 'rule-handshake.jpg',
    mediaType: 'image/jpeg',
    bytes: 140587,
    width: 960,
    height: 640,
    sha256: '1a5fcfc9be301d1ca188e3825bb92b8eddf6945d22e55d73c73ce3e96382edbb',
  },
  {
    sourceUrl:
      'https://cdn.pixabay.com/photo/2014/09/20/13/52/board-453758_960_720.jpg',
    fileName: 'rule-circuit-board.jpg',
    mediaType: 'image/jpeg',
    bytes: 171335,
    width: 960,
    height: 652,
    sha256: '468f4ff041be113891747455cd4bf672de91aac4a362ca816e0127cfdcda361b',
  },
  {
    sourceUrl:
      'https://storage.googleapis.com/p_631ae0ff4b26e8e308048763/e1507a8e-4ed9-41fa-b5e7-2d8c53ef1f9c/image_2026-07-15_095728508.png',
    fileName: 'discord-link-step-a.png',
    mediaType: 'image/png',
    bytes: 21515,
    width: 475,
    height: 284,
    sha256: '04db4260eaac671e273d2e24f38d488e14c2772c4fe24b7deb544da1800197a0',
  },
  {
    sourceUrl:
      'https://storage.googleapis.com/p_631ae0ff4b26e8e308048763/89922600-767f-4d8d-9318-e92f2879511a/E3FA5126-3C9F-48A9-A08E-6DBFFC93E8BF.png',
    fileName: 'discord-link-server.png',
    mediaType: 'image/png',
    bytes: 1346932,
    width: 1920,
    height: 1080,
    sha256: 'd938207f74af8e1d759cb3e755e2fb3ebd74df8d4ad78866cc09d0b96ed7a129',
  },
  {
    sourceUrl:
      'https://storage.googleapis.com/p_631ae0ff4b26e8e308048763/48946ae8-4496-4e8f-8bcc-4349318ca026%2Ficon2.png',
    fileName: 'server-philosophy-icon.png',
    mediaType: 'image/png',
    bytes: 139548,
    width: 512,
    height: 512,
    sha256: 'c83056b983c1420ede6de165a6fd607cb90a1e3e3aa9d323a34fef571e501216',
  },
  {
    sourceUrl:
      'https://storage.googleapis.com/p_631ae0ff4b26e8e308048763/cf33b9fd-4dd0-4662-b4d2-db3194b2a7fa%2Facico.png',
    fileName: 'server-philosophy-og.png',
    mediaType: 'image/png',
    bytes: 136025,
    width: 512,
    height: 512,
    sha256: 'c060fc2ccb72a3d20df856f0468052cc813862c2a935c0c2d61430d7baf9305c',
  },
  {
    sourceUrl:
      'https://cdn.pixabay.com/photo/2018/02/07/18/30/people-3137672_960_720.jpg',
    fileName: 'join-header.jpg',
    mediaType: 'image/jpeg',
    bytes: 145805,
    width: 960,
    height: 640,
    sha256: '7a36b772ee876ccb68bca3dfebb35d1c0f72144e695f5fecfd9848e8ebb5fdb9',
  },
  {
    sourceUrl:
      'https://cdn.pixabay.com/photo/2020/10/05/20/03/boys-5630669_960_720.jpg',
    fileName: 'play-header.jpg',
    mediaType: 'image/jpeg',
    bytes: 195798,
    width: 960,
    height: 640,
    sha256: '99f1887163763747672c3a5efd77be72fee4603cdbfe190adfddfd1a73b595d5',
  },
  {
    sourceUrl:
      'https://cdn.pixabay.com/photo/2020/03/22/15/25/fetch-4957501_1280.jpg',
    fileName: 'promotion-header.jpg',
    mediaType: 'image/jpeg',
    bytes: 250829,
    width: 1280,
    height: 853,
    sha256: '7cf9c0f5cc716235079abf3ff03c515c1858a342756ba9c7e506b7295942005f',
  },
  {
    sourceUrl:
      'https://storage.googleapis.com/newt-images/631ae0ff4b26e8e308048763/1665754188707/icons/1665754188708/icon3.png',
    fileName: 'wiki-icon.png',
    mediaType: 'image/png',
    bytes: 155424,
    width: 500,
    height: 500,
    sha256: '651915783c3c94ce513e38ac971c0336173b4dff68cddd65f88fc3611f35fd6b',
  },
  {
    sourceUrl:
      'https://storage.googleapis.com/newt-images/631ae0ff4b26e8e308048763/6345278ad2720e3d2d4b2453/covers/1665478447427/SCC.png',
    fileName: 'wiki-cover.png',
    mediaType: 'image/png',
    bytes: 2968610,
    width: 1658,
    height: 843,
    sha256: 'fb6fac81285c1d12e1b8ef90bc4d51a4a4c33cde7fa0584f8ffb20c58459c1e4',
  },
]

const REDIRECTS = ARTICLES.filter(
  ({ sourceSlug, targetSlug }) => sourceSlug !== targetSlug,
).map(({ sourceSlug, targetSlug }) => ({
  from: `/article/${encodeURIComponent(sourceSlug)}/`,
  to: `/article/${targetSlug}/`,
  status: 301,
}))

const imagePathBySource = new Map(
  ASSETS.map(({ sourceUrl, fileName }) => [
    sourceUrl,
    `/uploads/wiki/${fileName}`,
  ]),
)
const imageAltByLocalPath = new Map([
  ['/uploads/wiki/rule-handshake.jpg', '握手とルールを表すイメージ'],
  [
    '/uploads/wiki/rule-circuit-board.jpg',
    'レッドストーン回路を表す基板のイメージ',
  ],
  [
    '/uploads/wiki/discord-link-step-a.png',
    'Discordのルール認証で押すAリアクション',
  ],
  [
    '/uploads/wiki/discord-link-server.png',
    'Minecraftでエースサーバーを追加する手順',
  ],
  ['/uploads/wiki/server-philosophy-icon.png', 'エースサーバーのアイコン'],
  ['/uploads/wiki/join-header.jpg', 'エースサーバーへ参加するプレイヤー'],
  ['/uploads/wiki/play-header.jpg', 'エースサーバーで一緒に遊ぶイメージ'],
  ['/uploads/wiki/promotion-header.jpg', 'エースサーバーの宣伝イメージ'],
])
const slugByDecodedLegacyPath = new Map(
  REDIRECTS.flatMap(({ from, to }) => {
    const decoded = decodeURIComponent(from)
    return [
      [decoded, to],
      [decoded.replace(/\/$/u, ''), to],
    ]
  }),
)
const turndown = new TurndownService({
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
  emDelimiter: '*',
  headingStyle: 'atx',
  strongDelimiter: '**',
})

turndown.remove(['script', 'style'])

const archivedRootPayload = decodeArchivedPayload(snapshot.source.rawPayload)
const wikiData = archivedRootPayload.data?.['wiki-data']

assert(wikiData, 'Root payload does not contain data["wiki-data"].')
assertDeepEqual(
  wikiData,
  snapshot.wikiData,
  'Decoded root payload differs from the archived snapshot data.',
)
validateArchivedSourceEvidence()

assertDeepEqual(
  wikiData.categories.map(({ _id, name }) => ({ id: _id, name })),
  CATEGORIES,
  'Category order changed in the public payload.',
)
assertDeepEqual(
  wikiData.links.map(({ _id, text, href }) => ({ id: _id, text, href })),
  LINKS,
  'Header links changed in the public payload.',
)
assertDeepEqual(
  wikiData.articles.map(({ _id, slug, title }) => ({
    id: _id,
    sourceSlug: slug,
    title,
  })),
  ARTICLES.map(({ id, sourceSlug, title }) => ({ id, sourceSlug, title })),
  'Article order or identity changed in the public payload.',
)
assert(
  wikiData.app?.icon?.value === ASSETS.at(-2).sourceUrl,
  'Wiki icon URL changed in the public payload.',
)
assert(
  wikiData.app?.cover?.value === ASSETS.at(-1).sourceUrl,
  'Wiki cover URL changed in the public payload.',
)

const articleEvidence = []
const generatedArticles = []

for (const expected of ARTICLES) {
  const payloadPath = `/article/${encodeURIComponent(expected.sourceSlug)}/_payload.json`
  const archived = snapshot.articles.find(
    ({ sourceSlug }) => sourceSlug === expected.sourceSlug,
  )
  const evidence = immutableManifest.articles.find(
    ({ sourceSlug }) => sourceSlug === expected.sourceSlug,
  )
  const article = archived?.article

  assert(article, `Article payload is missing: ${expected.sourceSlug}`)
  assert(evidence, `Article evidence is missing: ${expected.sourceSlug}`)
  assert(
    article._id === expected.id,
    `Article ID changed: ${expected.sourceSlug}`,
  )
  assert(
    article.title === expected.title,
    `Article title changed: ${expected.sourceSlug}`,
  )
  assert(
    article.category?.name === expected.category,
    `Article category changed: ${expected.sourceSlug}`,
  )

  const bodyBytes = Buffer.byteLength(article.body, 'utf8')
  assert(
    bodyBytes === expected.bodyBytes,
    `Article body byte count changed for ${expected.sourceSlug}: expected ${expected.bodyBytes}, received ${bodyBytes}`,
  )

  if (expected.sourceSlug === 'rinen') {
    assert(
      article.meta?.ogImage?.src === ASSETS[5].sourceUrl ||
        article.meta?.ogImage === ASSETS[5].sourceUrl,
      'The server philosophy OG image changed.',
    )
  }

  const markdownBody = convertHtmlToMarkdown(article.body, expected.sourceSlug)
  const frontmatter = serializeFrontmatter(expected)
  const markdown = `${frontmatter}\n${markdownBody}\n`
  const markdownFileUrl = new URL(
    `${expected.targetSlug}.md`,
    CONTENT_DIRECTORY,
  )

  assert(
    !/<(?:!--[\s\S]*?--|!doctype\b[^>]*|\/?[a-z][a-z0-9:-]*(?:\s[^<>]*?)?\s*\/?>)/iu.test(
      markdownBody,
    ),
    `Raw HTML remains after conversion: ${expected.sourceSlug}`,
  )
  assert(
    !/^(?: {0,3})#(?:[ \t]+|$)/mu.test(markdownBody),
    `Level-one heading remains after conversion: ${expected.sourceSlug}`,
  )
  assert(
    !/https:\/\/(?:cdn\.pixabay\.com|storage\.googleapis\.com)/u.test(
      markdownBody,
    ),
    `A remote image remains after conversion: ${expected.sourceSlug}`,
  )

  generatedArticles.push({
    fileUrl: markdownFileUrl,
    markdown,
    targetSlug: expected.targetSlug,
  })

  articleEvidence.push({
    id: expected.id,
    sourceSlug: expected.sourceSlug,
    targetSlug: expected.targetSlug,
    title: expected.title,
    category: expected.category,
    order: expected.order,
    sourceUrl: `${SOURCE_ORIGIN}/article/${encodeURIComponent(expected.sourceSlug)}/`,
    sourcePayloadUrl: `${SOURCE_ORIGIN}${payloadPath}`,
    sourcePayloadSha256: archived.payloadSha256,
    sourceBodyBytes: bodyBytes,
    sourceBodySha256: sha256(article.body),
    markdownPath: `src/content/wiki/${expected.targetSlug}.md`,
    markdownBytes: Buffer.byteLength(markdown, 'utf8'),
    markdownSha256: sha256(markdown),
  })
}

const assetEvidence = []

for (const asset of ASSETS) {
  const bytes = await readFile(new URL(asset.fileName, MEDIA_DIRECTORY))

  assert(
    bytes.byteLength === asset.bytes,
    `Asset byte count changed for ${asset.fileName}: expected ${asset.bytes}, received ${bytes.byteLength}`,
  )
  assert(
    sha256(bytes) === asset.sha256,
    `Asset SHA-256 changed for ${asset.fileName}.`,
  )
  assert(
    detectImageMediaType(bytes) === asset.mediaType,
    `Asset magic bytes do not match ${asset.mediaType}: ${asset.fileName}`,
  )

  assetEvidence.push({
    sourceUrl: asset.sourceUrl,
    localPath: `public/uploads/wiki/${asset.fileName}`,
    mediaType: asset.mediaType,
    bytes: asset.bytes,
    width: asset.width,
    height: asset.height,
    sha256: asset.sha256,
  })
}

const totalSourceBodyBytes = articleEvidence.reduce(
  (total, article) => total + article.sourceBodyBytes,
  0,
)
assert(
  totalSourceBodyBytes === 53234,
  `Total source body size changed: ${totalSourceBodyBytes}`,
)

const generatedManifest = {
  schemaVersion: 1,
  source: {
    origin: SOURCE_ORIGIN,
    rootPayloadUrl: `${SOURCE_ORIGIN}/_payload.json`,
    rootPayloadSha256: snapshot.source.rootPayloadSha256,
    prerenderedAt: snapshot.source.prerenderedAt,
    articleCount: articleEvidence.length,
    categoryCount: CATEGORIES.length,
    headerLinkCount: LINKS.length,
    totalSourceBodyBytes,
  },
  categories: CATEGORIES,
  links: LINKS,
  articles: articleEvidence,
  assets: assetEvidence,
  removedAssets: [
    {
      articleId: '634531c7d2720e3d2d56ef9c',
      articleSlug: 'in',
      source: '/img/リスト.png',
      alt: '手順リスト',
      reason:
        'The public URL returns 404 and no verified source asset exists; the reference is removed without replacement.',
    },
  ],
  redirects: REDIRECTS,
}

assertDeepEqual(
  generatedManifest,
  immutableManifest,
  'Generated migration evidence differs from the rollback reproduction manifest.',
)

if (CHECK_ONLY) {
  for (const generated of generatedArticles) {
    const current = (await readFile(generated.fileUrl, 'utf8')).replace(
      /\r\n?/gu,
      '\n',
    )
    assert(
      current === generated.markdown,
      `Generated Markdown differs from the working tree: ${generated.targetSlug}`,
    )
  }

  console.log(
    `Verified offline regeneration for ${articleEvidence.length} Markdown articles, ${assetEvidence.length} local assets, and the rollback reproduction manifest without writing files.`,
  )
} else {
  await mkdir(CONTENT_DIRECTORY, { recursive: true })
  await Promise.all(
    generatedArticles.map(({ fileUrl, markdown }) =>
      writeFile(fileUrl, markdown, 'utf8'),
    ),
  )

  console.log(
    `Regenerated ${articleEvidence.length} Markdown articles offline from the archived snapshot and ${assetEvidence.length} verified local assets (${totalSourceBodyBytes} source body bytes).`,
  )
  console.log(`Evidence: ${fileURLToPath(MANIFEST_URL)}`)
}

function validateArchivedSourceEvidence() {
  assert(
    immutableManifest.schemaVersion === 1,
    'Unexpected immutable manifest schema.',
  )
  assert(snapshot.schemaVersion === 1, 'Unexpected source snapshot schema.')
  assert(
    snapshot.source.origin === SOURCE_ORIGIN,
    'Snapshot origin differs from the immutable manifest.',
  )
  assert(
    snapshot.source.rootPayloadUrl === immutableManifest.source.rootPayloadUrl,
    'Snapshot root payload URL differs from the immutable manifest.',
  )
  assert(
    typeof snapshot.source.rawPayload === 'string' &&
      sha256(snapshot.source.rawPayload) ===
        immutableManifest.source.rootPayloadSha256 &&
      snapshot.source.rootPayloadSha256 ===
        immutableManifest.source.rootPayloadSha256,
    'Snapshot root payload SHA-256 differs from the immutable manifest.',
  )
  assert(
    snapshot.source.prerenderedAt === immutableManifest.source.prerenderedAt,
    'Snapshot prerender timestamp differs from the immutable manifest.',
  )
  assert(
    archivedRootPayload.prerenderedAt === snapshot.source.prerenderedAt,
    'Decoded root payload prerender timestamp differs from the snapshot.',
  )
  assert(
    snapshot.source.capturedAt ===
      deterministicCaptureTime(snapshot.source.prerenderedAt),
    'Snapshot capture timestamp is not deterministic.',
  )
  assert(
    snapshot.source.articleCount === immutableManifest.source.articleCount &&
      snapshot.articles.length === immutableManifest.source.articleCount,
    'Snapshot article count differs from the immutable manifest.',
  )
  assert(
    snapshot.source.categoryCount === immutableManifest.source.categoryCount,
    'Snapshot category count differs from the immutable manifest.',
  )
  assert(
    snapshot.source.headerLinkCount ===
      immutableManifest.source.headerLinkCount,
    'Snapshot header-link count differs from the immutable manifest.',
  )
  assert(
    snapshot.source.totalSourceBodyBytes ===
      immutableManifest.source.totalSourceBodyBytes,
    'Snapshot source-body size differs from the immutable manifest.',
  )
  assertDeepEqual(
    immutableManifest.categories,
    CATEGORIES,
    'Hard-coded categories differ from the immutable manifest.',
  )
  assertDeepEqual(
    immutableManifest.links,
    LINKS,
    'Hard-coded header links differ from the immutable manifest.',
  )
  assertDeepEqual(
    snapshot.wikiData.categories.map(({ _id, name }) => ({ id: _id, name })),
    immutableManifest.categories,
    'Snapshot categories differ from the immutable manifest.',
  )
  assertDeepEqual(
    snapshot.wikiData.links.map(({ _id, text, href }) => ({
      id: _id,
      text,
      href,
    })),
    immutableManifest.links,
    'Snapshot header links differ from the immutable manifest.',
  )
  assertDeepEqual(
    snapshot.wikiData.articles.map(({ _id, slug, title }) => ({
      id: _id,
      sourceSlug: slug,
      title,
    })),
    immutableManifest.articles.map(({ id, sourceSlug, title }) => ({
      id,
      sourceSlug,
      title,
    })),
    'Snapshot article order or identity differs from the immutable manifest.',
  )

  const archivedSourceSlugs = snapshot.articles.map(
    ({ sourceSlug }) => sourceSlug,
  )
  assert(
    new Set(archivedSourceSlugs).size === archivedSourceSlugs.length,
    'Snapshot contains duplicate article slugs.',
  )

  for (const evidence of immutableManifest.articles) {
    const archived = snapshot.articles.find(
      ({ sourceSlug }) => sourceSlug === evidence.sourceSlug,
    )

    assert(archived, `Snapshot article is missing: ${evidence.sourceSlug}`)
    assert(
      archived.id === evidence.id &&
        archived.article?._id === evidence.id &&
        archived.article?.slug === evidence.sourceSlug,
      `Snapshot article identity differs: ${evidence.sourceSlug}`,
    )
    assert(
      archived.sourceUrl === evidence.sourceUrl &&
        archived.payloadUrl === evidence.sourcePayloadUrl,
      `Snapshot article URL differs: ${evidence.sourceSlug}`,
    )
    assert(
      typeof archived.rawPayload === 'string' &&
        sha256(archived.rawPayload) === evidence.sourcePayloadSha256 &&
        archived.payloadSha256 === evidence.sourcePayloadSha256,
      `Snapshot article payload SHA-256 differs: ${evidence.sourceSlug}`,
    )
    const decodedPayload = decodeArchivedPayload(archived.rawPayload)
    assertDeepEqual(
      decodedPayload.data?.[`article:${evidence.sourceSlug}`],
      archived.article,
      `Decoded article payload differs from the snapshot: ${evidence.sourceSlug}`,
    )
    assert(
      typeof archived.article?.body === 'string' &&
        Buffer.byteLength(archived.article.body, 'utf8') ===
          evidence.sourceBodyBytes &&
        archived.bodyBytes === evidence.sourceBodyBytes,
      `Snapshot article body byte count differs: ${evidence.sourceSlug}`,
    )
    assert(
      sha256(archived.article.body) === evidence.sourceBodySha256 &&
        archived.bodySha256 === evidence.sourceBodySha256,
      `Snapshot article body SHA-256 differs: ${evidence.sourceSlug}`,
    )
  }
}

function convertHtmlToMarkdown(source, sourceSlug) {
  const fragment = parseFragment(source)
  const tableMarkdown = []

  for (const table of findNodes(fragment, (node) => node.tagName === 'table')) {
    const marker = `WIKITABLETOKEN${tableMarkdown.length}END`
    tableMarkdown.push(convertTable(table))
    replaceNode(table, [createTextNode(marker)])
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
  }

  for (const node of findNodes(
    fragment,
    (candidate) =>
      candidate.tagName === 'style' || candidate.tagName === 'script',
  )) {
    replaceNode(node, [])
  }

  for (const image of findNodes(fragment, (node) => node.tagName === 'img')) {
    const sourceUrl = getAttribute(image, 'src')

    if (sourceUrl === '/img/リスト.png') {
      replaceNode(image, [])
      continue
    }

    const localPath = imagePathBySource.get(sourceUrl)
    assert(
      localPath,
      `Unverified image in article ${sourceSlug}: ${sourceUrl || '(missing src)'}`,
    )
    setAttribute(image, 'src', localPath)

    const improvedAlt = imageAltByLocalPath.get(localPath)
    if (improvedAlt) setAttribute(image, 'alt', improvedAlt)
  }

  for (const anchor of findNodes(fragment, (node) => node.tagName === 'a')) {
    const href = getAttribute(anchor, 'href')
    const rewritten = rewriteInternalHref(href)

    if (rewritten) setAttribute(anchor, 'href', rewritten)
  }

  let markdown = turndown.turndown(serialize(fragment))

  tableMarkdown.forEach((table, index) => {
    markdown = replaceMarkdownTableMarker(
      markdown,
      `WIKITABLETOKEN${index}END`,
      table,
    )
  })

  return normalizeKnownMigratedMarkdown(markdown, sourceSlug)
    .replace(/[ \t]+\n/gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
}

function convertTable(table) {
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

      const content = tableCellMarkdown(cell)
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

function tableCellMarkdown(cell) {
  const render = (node) => {
    if (node.nodeName === '#text') return node.value
    if (node.tagName === 'br') return ' ／ '
    if (node.tagName === 'a') {
      const label = renderChildren(node).trim()
      const href = rewriteInternalHref(getAttribute(node, 'href'))
      return href ? `[${label}](${href})` : label
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
    .replace(/^使用方法h$/u, '使用方法')
    .replaceAll('|', '\\|')
    .trim()
}

function markdownTableRow(cells) {
  return `| ${cells.join(' | ')} |`
}

function rewriteInternalHref(href) {
  if (!href) return ''

  let url
  try {
    url = new URL(href, SOURCE_ORIGIN)
  } catch {
    return href
  }

  if (!LEGACY_SOURCE_ORIGINS.has(url.origin)) return href

  let decodedPath
  try {
    decodedPath = decodeURIComponent(url.pathname).normalize('NFC')
  } catch {
    return href
  }

  const redirectTarget = slugByDecodedLegacyPath.get(decodedPath)

  if (redirectTarget) return `${redirectTarget}${url.search}${url.hash}`
  return [...LEGACY_SOURCE_ORIGINS].some((origin) => href.startsWith(origin))
    ? `${url.pathname}${url.search}${url.hash}`
    : href
}

function serializeFrontmatter(article) {
  const lines = [
    '---',
    `title: ${JSON.stringify(article.title)}`,
    ...(article.seoTitle
      ? [`seoTitle: ${JSON.stringify(article.seoTitle)}`]
      : []),
    `description: ${JSON.stringify(article.description)}`,
    `category: ${JSON.stringify(article.category)}`,
    `order: ${article.order}`,
    ...(article.ogImage ? [`ogImage: ${JSON.stringify(article.ogImage)}`] : []),
    'draft: false',
    '---',
  ]

  return lines.join('\n')
}

function decodeArchivedPayload(rawPayload) {
  assert(
    typeof rawPayload === 'string',
    'Archived payload must be stored as a raw JSON string.',
  )
  return unflatten(JSON.parse(rawPayload), {
    ShallowReactive: (payload) => payload,
  })
}

function findNodes(root, predicate) {
  const results = []
  const visit = (node) => {
    if (predicate(node)) results.push(node)
    for (const child of node.childNodes ?? []) visit(child)
  }
  visit(root)
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
    namespaceURI: XHTML_NAMESPACE,
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

function detectImageMediaType(bytes) {
  if (
    bytes.length >= 20 &&
    bytes
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) &&
    bytes.subarray(-8, -4).toString('ascii') === 'IEND'
  ) {
    return 'image/png'
  }

  if (
    bytes.length >= 4 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff &&
    bytes.at(-2) === 0xff &&
    bytes.at(-1) === 0xd9
  ) {
    return 'image/jpeg'
  }

  return null
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function deterministicCaptureTime(prerenderedAt) {
  const capturedAt = new Date(prerenderedAt)
  assert(
    Number.isFinite(capturedAt.valueOf()),
    'The snapshot prerender timestamp is invalid.',
  )
  return capturedAt.toISOString()
}

function normalizeOrigin(value) {
  const url = new URL(value)
  assert(
    url.protocol === 'https:',
    'The immutable migration source origin must use HTTPS.',
  )
  assert(
    url.username === '' &&
      url.password === '' &&
      url.pathname === '/' &&
      url.search === '' &&
      url.hash === '',
    'The immutable migration source must be an origin without credentials, path, query, or fragment.',
  )
  return url.origin
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function assertDeepEqual(actual, expected, message) {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${message}\nExpected: ${JSON.stringify(expected)}\nReceived: ${JSON.stringify(actual)}`,
  )
}
