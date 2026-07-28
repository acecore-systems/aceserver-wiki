import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'

import { unflatten } from 'devalue'

const root = new URL('../', import.meta.url)
const manifest = JSON.parse(
  await readFile(
    new URL('migration/newt-public-payload-manifest.json', root),
    'utf8',
  ),
)
const outputUrl = new URL('migration/newt-public-content-snapshot.json', root)
const sourceOrigin = normalizeOrigin(
  process.env.NEWT_MIGRATION_SOURCE_ORIGIN ??
    'https://bba3fffa.aceserver-wiki.pages.dev',
)

assert(
  sourceOrigin === manifest.source.origin,
  'Snapshot origin differs from the rollback reproduction manifest.',
)

const rootPayload = await fetchPayload('/_payload.json')
const wikiData = rootPayload.value?.data?.['wiki-data']
const rootPayloadSha256 = sha256(rootPayload.raw)
const prerenderedAt = rootPayload.value?.prerenderedAt

assert(wikiData, 'Root payload does not contain data["wiki-data"].')
assert(
  `${sourceOrigin}/_payload.json` === manifest.source.rootPayloadUrl,
  'Root payload URL differs from the migration manifest.',
)
assert(
  rootPayloadSha256 === manifest.source.rootPayloadSha256,
  'Root payload SHA-256 differs from the migration manifest.',
)
assert(
  prerenderedAt === manifest.source.prerenderedAt,
  'Root payload prerender timestamp differs from the migration manifest.',
)
assertDeepEqual(
  wikiData.categories.map(({ _id, name }) => ({ id: _id, name })),
  manifest.categories,
  'Category inventory differs from the migration manifest.',
)
assertDeepEqual(
  wikiData.links.map(({ _id, text, href }) => ({ id: _id, text, href })),
  manifest.links,
  'Header-link inventory differs from the migration manifest.',
)
assertDeepEqual(
  wikiData.articles.map(({ _id, slug, title }) => ({
    id: _id,
    sourceSlug: slug,
    title,
  })),
  manifest.articles.map(({ id, sourceSlug, title }) => ({
    id,
    sourceSlug,
    title,
  })),
  'Article order or identity differs from the migration manifest.',
)

const articles = []

for (const expected of manifest.articles) {
  const payloadPath = `/article/${encodeURIComponent(expected.sourceSlug)}/_payload.json`
  const payload = await fetchPayload(payloadPath)
  const article = payload.value?.data?.[`article:${expected.sourceSlug}`]

  assert(article, `Article payload is missing: ${expected.sourceSlug}`)
  assert(
    article._id === expected.id,
    `Article ID differs: ${expected.sourceSlug}`,
  )
  assert(
    article.slug === expected.sourceSlug,
    `Article slug differs: ${expected.sourceSlug}`,
  )
  assert(
    article.title === expected.title,
    `Article title differs: ${expected.sourceSlug}`,
  )
  assert(
    article.category?.name === expected.category,
    `Article category differs: ${expected.sourceSlug}`,
  )

  const bodyBytes = Buffer.byteLength(article.body, 'utf8')
  const bodySha256 = sha256(article.body)
  const payloadSha256 = sha256(payload.raw)

  assert(
    payloadSha256 === expected.sourcePayloadSha256,
    `Article payload SHA-256 differs: ${expected.sourceSlug}`,
  )
  assert(
    bodyBytes === expected.sourceBodyBytes,
    `Article body byte count differs: ${expected.sourceSlug}`,
  )
  assert(
    bodySha256 === expected.sourceBodySha256,
    `Article body SHA-256 differs: ${expected.sourceSlug}`,
  )

  articles.push({
    id: expected.id,
    sourceSlug: expected.sourceSlug,
    sourceUrl: `${sourceOrigin}/article/${encodeURIComponent(expected.sourceSlug)}/`,
    payloadUrl: `${sourceOrigin}${payloadPath}`,
    payloadSha256,
    rawPayload: payload.raw,
    bodyBytes,
    bodySha256,
    article,
  })
}

const totalSourceBodyBytes = articles.reduce(
  (total, article) => total + article.bodyBytes,
  0,
)
assert(
  totalSourceBodyBytes === manifest.source.totalSourceBodyBytes,
  'Total source body byte count differs from the migration manifest.',
)

const snapshot = {
  schemaVersion: 1,
  source: {
    origin: sourceOrigin,
    capturedAt: deterministicCaptureTime(prerenderedAt),
    rootPayloadUrl: `${sourceOrigin}/_payload.json`,
    rootPayloadSha256,
    rawPayload: rootPayload.raw,
    prerenderedAt,
    articleCount: articles.length,
    categoryCount: wikiData.categories.length,
    headerLinkCount: wikiData.links.length,
    totalSourceBodyBytes,
  },
  wikiData,
  articles,
}

await writeFile(outputUrl, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')

console.log(
  `Archived ${articles.length} public Nuxt/Newt article payloads from ${sourceOrigin}.`,
)
console.log(
  'The snapshot contains only data already exposed by the public Nuxt payloads; no Newt token is used or stored.',
)

async function fetchPayload(path) {
  const url = `${sourceOrigin}${path}`
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'Acecore-Wiki-Migration-Snapshot/1.0',
    },
  })

  assert(response.ok, `Payload request failed (${response.status}): ${url}`)

  const raw = await response.text()
  const value = unflatten(JSON.parse(raw), {
    ShallowReactive: (payload) => payload,
  })

  return { raw, value }
}

function normalizeOrigin(value) {
  const url = new URL(value)
  assert(
    url.protocol === 'https:',
    'NEWT_MIGRATION_SOURCE_ORIGIN must use HTTPS.',
  )
  assert(
    url.username === '' &&
      url.password === '' &&
      url.pathname === '/' &&
      url.search === '' &&
      url.hash === '',
    'NEWT_MIGRATION_SOURCE_ORIGIN must be an origin without credentials, path, query, or fragment.',
  )
  return url.origin
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function deterministicCaptureTime(value) {
  const capturedAt = new Date(value)
  assert(
    Number.isFinite(capturedAt.valueOf()),
    'The root payload prerender timestamp is invalid.',
  )
  return capturedAt.toISOString()
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
