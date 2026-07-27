import { parseDocument } from 'yaml'

import {
  getCmsPathExtension,
  isCmsMarkdownPath,
  isCmsMediaPath,
} from './_cms-policy.ts'
import {
  assertMarkdownSource,
  mdxModulePattern,
  wikiImagePathPattern,
} from '../../../src/lib/markdown-policy.ts'

const MAX_MARKDOWN_BYTES = 512 * 1024
const MAX_MEDIA_BYTES = 8 * 1024 * 1024
const MAX_IMAGE_DIMENSION = 4096
const MAX_IMAGE_PIXELS = 16 * 1024 * 1024
const FRONTMATTER_KEYS = new Set([
  'title',
  'seoTitle',
  'description',
  'category',
  'order',
  'ogImage',
  'draft',
])
const WIKI_CATEGORIES = new Set([
  'イントロダクション',
  '生活鯖について',
  'その他サーバーについて',
  'ディスコードについて',
  'コミュニティ紹介',
  'その他',
])
const BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u
const RAW_HTML_PATTERN =
  /<(?!https?:\/\/|mailto:)(?:!--|!|\?|\/?[A-Za-z][A-Za-z0-9:-]*(?=[\s/>]|$))/iu
const ESM_PATTERN = mdxModulePattern
const DANGEROUS_URI_PATTERN = /\b(?:data|javascript|vbscript)\s*:/iu
const YAML_REFERENCE_PATTERN = /(?:^|\s)[&*][A-Za-z0-9_-]+|^\s*<<\s*:/mu
const LEVEL_ONE_ATX_HEADING_PATTERN = /^(?: {0,3})#(?:[ \t]+|$)/u
const LEVEL_ONE_SETEXT_HEADING_PATTERN = /^(?: {0,3})=+[ \t]*$/u

export type ValidatedCmsAddition = {
  path: string
  contents: string
  byteSize: number
  mediaType: string
}

type ValidationResult =
  { ok: true; addition: ValidatedCmsAddition } | { ok: false; message: string }

export function validateCmsAddition(
  path: string,
  contents: string,
): ValidationResult {
  if (!BASE64_PATTERN.test(contents)) {
    return { ok: false, message: 'ファイル内容が正しいbase64ではありません。' }
  }

  const byteSize = getBase64ByteSize(contents)

  if (isCmsMarkdownPath(path)) {
    if (byteSize === 0 || byteSize > MAX_MARKDOWN_BYTES) {
      return {
        ok: false,
        message: 'Markdownは1 byte以上512 KiB以下にしてください。',
      }
    }

    const bytes = decodeBase64(contents, byteSize)

    if (!bytes) {
      return {
        ok: false,
        message: 'Markdownのbase64を復号できません。',
      }
    }

    const markdownError = validateMarkdown(bytes)

    if (markdownError) return { ok: false, message: markdownError }

    return {
      ok: true,
      addition: {
        path,
        contents,
        byteSize,
        mediaType: 'text/markdown; charset=utf-8',
      },
    }
  }

  if (isCmsMediaPath(path)) {
    if (byteSize === 0 || byteSize > MAX_MEDIA_BYTES) {
      return {
        ok: false,
        message: '画像は1 byte以上8 MiB以下にしてください。',
      }
    }

    const bytes = decodeBase64(contents, byteSize)

    if (!bytes) {
      return { ok: false, message: '画像のbase64を復号できません。' }
    }

    const detectedImage = detectImageMetadata(bytes)
    const expectedMediaType = expectedMediaTypeForPath(path)

    if (!detectedImage || detectedImage.mediaType !== expectedMediaType) {
      return {
        ok: false,
        message:
          '画像は4096px・16777216画素以内のPNG、JPEG、WebPに限定し、拡張子と内容を一致させてください。',
      }
    }

    return {
      ok: true,
      addition: {
        path,
        contents,
        byteSize,
        mediaType: detectedImage.mediaType,
      },
    }
  }

  return { ok: false, message: 'CMS管理対象外のファイルです。' }
}

function validateMarkdown(bytes: Uint8Array) {
  let text: string

  try {
    text = new TextDecoder('utf-8', {
      fatal: true,
      ignoreBOM: false,
    }).decode(bytes)
  } catch {
    return 'Markdownは正しいUTF-8で保存してください。'
  }

  if (text.charCodeAt(0) === 0xfeff) {
    return 'MarkdownのUTF-8 BOMは使用できません。'
  }

  if (text.includes('\0')) {
    return 'MarkdownにNUL文字は使用できません。'
  }

  const normalized = text.replace(/\r\n/gu, '\n')

  if (normalized.includes('\r')) {
    return 'Markdownの改行コードが不正です。'
  }

  const parts = extractFrontmatter(normalized)

  if (!parts) {
    return 'MarkdownにはYAML frontmatterが必要です。'
  }

  if (YAML_REFERENCE_PATTERN.test(parts.frontmatter)) {
    return 'YAMLのanchor、alias、merge keyは使用できません。'
  }

  let frontmatter: unknown

  try {
    const document = parseDocument(parts.frontmatter, {
      strict: true,
      uniqueKeys: true,
    })

    if (document.errors.length > 0) {
      return 'YAML frontmatterの構文が不正です。'
    }

    frontmatter = document.toJS({ maxAliasCount: 0 })
  } catch {
    return 'YAML frontmatterを安全に解析できません。'
  }

  if (!isRecord(frontmatter)) {
    return 'YAML frontmatterはmappingで指定してください。'
  }

  const keys = Object.keys(frontmatter)

  if (keys.some((key) => !FRONTMATTER_KEYS.has(key))) {
    return 'YAML frontmatterに許可されていない項目があります。'
  }

  if (
    !isBoundedText(frontmatter.title, 1, 100) ||
    !isBoundedText(frontmatter.description, 1, 240) ||
    !isBoundedText(frontmatter.category, 1, 60)
  ) {
    return 'title、description、categoryを規定の長さで指定してください。'
  }

  if (!WIKI_CATEGORIES.has(frontmatter.category as string)) {
    return 'categoryは公開Wikiの6カテゴリから指定してください。'
  }

  if (
    frontmatter.seoTitle !== undefined &&
    !isBoundedText(frontmatter.seoTitle, 1, 100)
  ) {
    return 'seoTitleは1文字以上100文字以下で指定してください。'
  }

  if (
    frontmatter.ogImage !== undefined &&
    (typeof frontmatter.ogImage !== 'string' ||
      !wikiImagePathPattern.test(frontmatter.ogImage))
  ) {
    return 'ogImageはWiki画像フォルダ内の公開パスで指定してください。'
  }

  if (
    typeof frontmatter.order !== 'number' ||
    !Number.isInteger(frontmatter.order) ||
    frontmatter.order < 0 ||
    frontmatter.order > 9_999
  ) {
    return 'orderは0以上9999以下の整数で指定してください。'
  }

  if (
    frontmatter.draft !== undefined &&
    typeof frontmatter.draft !== 'boolean'
  ) {
    return 'draftはbooleanで指定してください。'
  }

  if (RAW_HTML_PATTERN.test(parts.body)) {
    return 'Markdown本文にraw HTMLは使用できません。'
  }

  if (ESM_PATTERN.test(parts.body)) {
    return 'Markdown本文にimportまたはexportは使用できません。'
  }

  if (DANGEROUS_URI_PATTERN.test(normalizeUriText(parts.body))) {
    return 'Markdown本文に危険なURI schemeは使用できません。'
  }

  if (containsLevelOneHeading(parts.body)) {
    return 'Markdown本文のh1は記事タイトル用に予約されています。見出しはh2から使用してください。'
  }

  try {
    assertMarkdownSource(parts.body, 'CMS submission')
  } catch {
    return 'Markdown本文が公開ビルドの安全規則に違反しています。'
  }

  return null
}

function containsLevelOneHeading(source: string) {
  const lines = source.replace(/\r\n/gu, '\n').split('\n')
  let fence: { marker: '`' | '~'; length: number } | null = null
  let previousLineCanBeHeading = false

  for (const line of lines) {
    const fenceMatch = /^(?: {0,3})(`{3,}|~{3,})/u.exec(line)

    if (fenceMatch) {
      const marker = fenceMatch[1][0] as '`' | '~'
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
      LEVEL_ONE_ATX_HEADING_PATTERN.test(line) ||
      (previousLineCanBeHeading && LEVEL_ONE_SETEXT_HEADING_PATTERN.test(line))
    ) {
      return true
    }

    previousLineCanBeHeading = line.trim().length > 0
  }

  return false
}

function normalizeUriText(value: string) {
  return value
    .replace(
      /&#(?:x([0-9a-f]{1,6})|([0-9]{1,7}));?/giu,
      (match, hexadecimal: string | undefined, decimal: string | undefined) => {
        const codePoint = Number.parseInt(
          hexadecimal || decimal || '',
          hexadecimal ? 16 : 10,
        )

        return Number.isSafeInteger(codePoint) && codePoint <= 0x10ffff
          ? String.fromCodePoint(codePoint)
          : match
      },
    )
    .replace(/&(?:colon|tab|newline);/giu, (entity) => {
      if (/^&colon;/iu.test(entity)) return ':'
      return ''
    })
    .split('')
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0

      return codePoint > 0x20 && codePoint !== 0x7f
    })
    .join('')
}

function extractFrontmatter(text: string) {
  const lines = text.split('\n')

  if (lines[0] !== '---') return null

  const closingIndex = lines.indexOf('---', 1)

  if (closingIndex < 2) return null

  return {
    frontmatter: lines.slice(1, closingIndex).join('\n'),
    body: lines.slice(closingIndex + 1).join('\n'),
  }
}

function decodeBase64(value: string, expectedByteSize: number) {
  try {
    const binary = atob(value)

    if (binary.length !== expectedByteSize) return null

    const bytes = new Uint8Array(binary.length)

    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index)
    }

    return bytes
  } catch {
    return null
  }
}

type ImageMetadata = {
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp'
  width: number
  height: number
}

function detectImageMetadata(bytes: Uint8Array): ImageMetadata | null {
  const png = readPngDimensions(bytes)
  if (png && hasAllowedImageDimensions(png)) {
    return { mediaType: 'image/png', ...png }
  }

  const jpeg = readJpegDimensions(bytes)
  if (jpeg && hasAllowedImageDimensions(jpeg)) {
    return { mediaType: 'image/jpeg', ...jpeg }
  }

  const webp = readWebpDimensions(bytes)
  if (webp && hasAllowedImageDimensions(webp)) {
    return { mediaType: 'image/webp', ...webp }
  }

  return null
}

function readPngDimensions(bytes: Uint8Array) {
  if (
    bytes.length < 45 ||
    !hasBytes(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  ) {
    return null
  }

  let offset = 8
  let dimensions: { width: number; height: number } | null = null

  while (offset + 12 <= bytes.length) {
    const length = readUint32(bytes, offset)
    const type = readAscii(bytes, offset + 4, 4)
    const chunkEnd = offset + 12 + length

    if (chunkEnd > bytes.length) return null

    if (!dimensions) {
      if (type !== 'IHDR' || length !== 13) return null
      dimensions = {
        width: readUint32(bytes, offset + 8),
        height: readUint32(bytes, offset + 12),
      }
    } else if (type === 'IHDR') {
      return null
    }

    // APNG can contain an unbounded number of decoded frames. CMS images are
    // intentionally static, so reject its animation control chunk.
    if (type === 'acTL') return null

    if (type === 'IEND') {
      return length === 0 && chunkEnd === bytes.length ? dimensions : null
    }

    offset = chunkEnd
  }

  return null
}

function readJpegDimensions(bytes: Uint8Array) {
  if (
    bytes.length < 13 ||
    !hasBytes(bytes, 0, [0xff, 0xd8, 0xff]) ||
    !hasBytes(bytes, bytes.length - 2, [0xff, 0xd9])
  ) {
    return null
  }

  let offset = 2

  while (offset + 1 < bytes.length) {
    if (bytes[offset] !== 0xff) return null

    while (bytes[offset] === 0xff) offset += 1

    const marker = bytes[offset]
    offset += 1

    if (marker === undefined || marker === 0x00 || marker === 0xd9) return null
    if (marker === 0xda) return null

    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue
    }

    const segmentLength = readUint16(bytes, offset)

    if (segmentLength < 2 || offset + segmentLength > bytes.length) {
      return null
    }

    if (isJpegStartOfFrame(marker)) {
      if (segmentLength < 7) return null

      return {
        width: readUint16(bytes, offset + 5),
        height: readUint16(bytes, offset + 3),
      }
    }

    offset += segmentLength
  }

  return null
}

function isJpegStartOfFrame(marker: number) {
  return (
    marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)
  )
}

function readWebpDimensions(bytes: Uint8Array) {
  if (
    bytes.length < 26 ||
    readAscii(bytes, 0, 4) !== 'RIFF' ||
    readUint32LittleEndian(bytes, 4) !== bytes.length - 8 ||
    readAscii(bytes, 8, 4) !== 'WEBP'
  ) {
    return null
  }

  let offset = 12
  let firstChunkType: string | null = null
  let canvas: { width: number; height: number } | null = null
  let image: { width: number; height: number } | null = null
  let imageChunkType: 'VP8 ' | 'VP8L' | null = null
  let hasAlphaChunk = false
  let hasIccProfile = false
  const metadataChunks = new Set<string>()

  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) return null

    const chunkType = readAscii(bytes, offset, 4)
    const chunkLength = readUint32LittleEndian(bytes, offset + 4)
    const payloadOffset = offset + 8
    const payloadEnd = payloadOffset + chunkLength
    const paddedEnd = payloadEnd + (chunkLength % 2)

    if (
      payloadEnd > bytes.length ||
      paddedEnd > bytes.length ||
      paddedEnd <= offset ||
      (chunkLength % 2 === 1 && bytes[payloadEnd] !== 0)
    ) {
      return null
    }

    firstChunkType ??= chunkType

    if (chunkType === 'ANIM' || chunkType === 'ANMF') return null

    if (chunkType === 'VP8X') {
      if (offset !== 12 || canvas || image || chunkLength !== 10) return null
      if ((bytes[payloadOffset] & 0x02) !== 0) return null

      canvas = {
        width: readUint24LittleEndian(bytes, payloadOffset + 4) + 1,
        height: readUint24LittleEndian(bytes, payloadOffset + 7) + 1,
      }
    } else if (chunkType === 'ICCP') {
      if (!canvas || hasIccProfile || hasAlphaChunk || image) return null
      hasIccProfile = true
    } else if (chunkType === 'ALPH') {
      if (!canvas || hasAlphaChunk || image || chunkLength === 0) return null
      hasAlphaChunk = true
    } else if (chunkType === 'VP8 ' || chunkType === 'VP8L') {
      if (image || (!canvas && offset !== 12)) return null
      if (chunkType === 'VP8L' && hasAlphaChunk) return null

      image =
        chunkType === 'VP8 '
          ? readVp8Dimensions(bytes, payloadOffset, chunkLength)
          : readVp8lDimensions(bytes, payloadOffset, chunkLength)

      if (!image) return null
      imageChunkType = chunkType
    } else if (chunkType === 'EXIF' || chunkType === 'XMP ') {
      if (!canvas || metadataChunks.has(chunkType)) return null
      metadataChunks.add(chunkType)
    }

    offset = paddedEnd
  }

  if (
    offset !== bytes.length ||
    !image ||
    !imageChunkType ||
    (hasAlphaChunk && imageChunkType !== 'VP8 ')
  ) {
    return null
  }

  if (!canvas) {
    return firstChunkType === imageChunkType ? image : null
  }

  return canvas.width === image.width && canvas.height === image.height
    ? image
    : null
}

function readVp8Dimensions(
  bytes: Uint8Array,
  offset: number,
  chunkLength: number,
) {
  if (
    chunkLength < 10 ||
    (bytes[offset] & 0x01) !== 0 ||
    !hasBytes(bytes, offset + 3, [0x9d, 0x01, 0x2a])
  ) {
    return null
  }

  return {
    width: readUint16LittleEndian(bytes, offset + 6) & 0x3fff,
    height: readUint16LittleEndian(bytes, offset + 8) & 0x3fff,
  }
}

function readVp8lDimensions(
  bytes: Uint8Array,
  offset: number,
  chunkLength: number,
) {
  if (chunkLength < 5 || bytes[offset] !== 0x2f) return null

  const bits = readUint32LittleEndian(bytes, offset + 1)

  if (bits >>> 29 !== 0) return null

  return {
    width: (bits & 0x3fff) + 1,
    height: ((bits >>> 14) & 0x3fff) + 1,
  }
}

function hasAllowedImageDimensions({
  height,
  width,
}: {
  height: number
  width: number
}) {
  return (
    Number.isSafeInteger(width) &&
    Number.isSafeInteger(height) &&
    width > 0 &&
    height > 0 &&
    width <= MAX_IMAGE_DIMENSION &&
    height <= MAX_IMAGE_DIMENSION &&
    width * height <= MAX_IMAGE_PIXELS
  )
}

function expectedMediaTypeForPath(path: string) {
  const extension = getCmsPathExtension(path)

  if (extension === '.png') return 'image/png'
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg'
  if (extension === '.webp') return 'image/webp'

  return null
}

function getBase64ByteSize(value: string) {
  if (!value) return 0

  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0

  return (value.length * 3) / 4 - padding
}

function hasBytes(bytes: Uint8Array, offset: number, expected: number[]) {
  if (offset < 0 || offset + expected.length > bytes.length) return false

  return expected.every((value, index) => bytes[offset + index] === value)
}

function readAscii(bytes: Uint8Array, offset: number, length: number) {
  if (offset < 0 || offset + length > bytes.length) return ''

  let result = ''

  for (let index = offset; index < offset + length; index += 1) {
    result += String.fromCharCode(bytes[index])
  }

  return result
}

function readUint32(bytes: Uint8Array, offset: number) {
  if (offset < 0 || offset + 4 > bytes.length) return 0

  return (
    bytes[offset] * 0x1000000 +
    bytes[offset + 1] * 0x10000 +
    bytes[offset + 2] * 0x100 +
    bytes[offset + 3]
  )
}

function readUint16(bytes: Uint8Array, offset: number) {
  if (offset < 0 || offset + 2 > bytes.length) return 0

  return bytes[offset] * 0x100 + bytes[offset + 1]
}

function readUint16LittleEndian(bytes: Uint8Array, offset: number) {
  if (offset < 0 || offset + 2 > bytes.length) return 0

  return bytes[offset] + bytes[offset + 1] * 0x100
}

function readUint24LittleEndian(bytes: Uint8Array, offset: number) {
  if (offset < 0 || offset + 3 > bytes.length) return 0

  return bytes[offset] + bytes[offset + 1] * 0x100 + bytes[offset + 2] * 0x10000
}

function readUint32LittleEndian(bytes: Uint8Array, offset: number) {
  if (offset < 0 || offset + 4 > bytes.length) return 0

  return (
    bytes[offset] +
    bytes[offset + 1] * 0x100 +
    bytes[offset + 2] * 0x10000 +
    bytes[offset + 3] * 0x1000000
  )
}

function isBoundedText(
  value: unknown,
  minimumLength: number,
  maximumLength: number,
) {
  return (
    typeof value === 'string' &&
    value === value.trim() &&
    value.length >= minimumLength &&
    value.length <= maximumLength &&
    !containsAsciiControlCharacter(value)
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function containsAsciiControlCharacter(value: string) {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0

    return codePoint <= 0x1f || codePoint === 0x7f
  })
}
