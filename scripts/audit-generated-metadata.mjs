import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  SEO_LIMITS,
  normalizeSeoText,
  unnaturalDescriptionReasons,
} from '../utils/seo-metadata.mjs'
import { inspectImageAlts } from '../utils/image-alt.mjs'

const distDirectory = path.resolve('dist')
const sitemap = await fs.readFile(
  path.join(distDirectory, 'sitemap.xml'),
  'utf8'
)
const urls = [
  ...sitemap.matchAll(/<loc>(https:\/\/asv-wiki\.acecore\.net[^<]*)<\/loc>/g),
].map((match) => new URL(match[1]))
const failures = []
const titles = new Map()
const descriptions = new Map()
const summary = {
  urls: urls.length,
  titleShort: 0,
  titleLong: 0,
  descriptionShort: 0,
  descriptionLong: 0,
  duplicateTitles: 0,
  duplicateDescriptions: 0,
  unnaturalDescriptions: 0,
  canonicalErrors: 0,
  robotsErrors: 0,
  images: 0,
  imageAltMissing: 0,
  imageAltEmpty: 0,
  notFoundNoindex: false,
}

const metaContent = (html, key) => {
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0]
    const name = tag.match(/\b(?:name|property)=(['"])(.*?)\1/i)?.[2]
    if (name?.toLowerCase() !== key.toLowerCase()) continue
    return normalizeSeoText(tag.match(/\bcontent=(['"])(.*?)\1/i)?.[2] ?? '')
  }
  return ''
}

for (const url of urls) {
  const pathname = decodeURIComponent(url.pathname)
  const file =
    pathname === '/'
      ? path.join(distDirectory, 'index.html')
      : path.join(distDirectory, pathname.replace(/^\//, ''), 'index.html')
  const html = await fs.readFile(file, 'utf8')
  const title = normalizeSeoText(
    html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? ''
  )
  const description = metaContent(html, 'description')
  const robots = metaContent(html, 'robots')
  const canonical = html.match(
    /<link\b(?=[^>]*\brel=(['"])canonical\1)[^>]*\bhref=(['"])(.*?)\2[^>]*>/i
  )?.[3]
  const imageAudit = inspectImageAlts(html)

  summary.images += imageAudit.images
  summary.imageAltMissing += imageAudit.missing
  summary.imageAltEmpty += imageAudit.empty
  for (const issue of imageAudit.issues) {
    failures.push(
      url.toString() +
        ': ' +
        issue.state +
        ' image alt (' +
        (issue.source || 'src missing') +
        ')'
    )
  }

  titles.set(title, [...(titles.get(title) ?? []), url.toString()])
  descriptions.set(description, [
    ...(descriptions.get(description) ?? []),
    url.toString(),
  ])
  if (title.length < SEO_LIMITS.titleMin) summary.titleShort += 1
  if (title.length > SEO_LIMITS.titleMax) summary.titleLong += 1
  if (description.length < SEO_LIMITS.descriptionMin) {
    summary.descriptionShort += 1
  }
  if (description.length > SEO_LIMITS.descriptionMax) {
    summary.descriptionLong += 1
  }
  const unnaturalReasons = unnaturalDescriptionReasons(description)
  if (unnaturalReasons.length > 0) {
    summary.unnaturalDescriptions += 1
    failures.push(
      `${url.toString()}: description is unnatural (${unnaturalReasons.join(
        ', '
      )})`
    )
  }
  if (canonical !== url.toString()) summary.canonicalErrors += 1
  if (/noindex/i.test(robots)) summary.robotsErrors += 1
}

for (const [title, matchingUrls] of titles) {
  if (title && matchingUrls.length > 1) {
    summary.duplicateTitles += matchingUrls.length
  }
}
for (const [description, matchingUrls] of descriptions) {
  if (description && matchingUrls.length > 1) {
    summary.duplicateDescriptions += matchingUrls.length
  }
}

const notFoundHtml = await fs.readFile(
  path.join(distDirectory, '404.html'),
  'utf8'
)
summary.notFoundNoindex =
  /<meta\b(?=[^>]*\bname=(['"])robots\1)[^>]*\bcontent=(['"])[^'"]*noindex[^'"]*\2/i.test(
    notFoundHtml
  )

for (const [key, value] of Object.entries(summary)) {
  if (
    key === 'urls' ||
    key === 'images' ||
    key === 'imageAltMissing' ||
    key === 'imageAltEmpty' ||
    key === 'notFoundNoindex'
  )
    continue
  if (value > 0) failures.push(`${key}: ${value}`)
}
if (summary.imageAltMissing > 0)
  failures.push('imageAltMissing: ' + summary.imageAltMissing)
if (summary.imageAltEmpty > 0)
  failures.push('imageAltEmpty: ' + summary.imageAltEmpty)
if (!summary.notFoundNoindex)
  failures.push('404.html is missing noindex robots metadata')

console.log(JSON.stringify(summary))
if (failures.length > 0) {
  console.error(failures.join('\n'))
  process.exit(1)
}
