import { parseDocument } from 'yaml'

import {
  getCmsPathExtension,
  isCmsMarkdownPath,
  isCmsMediaPath,
} from './_cms-policy.ts'

const MAX_MARKDOWN_BYTES = 512 * 1024
const MAX_MEDIA_BYTES = 8 * 1024 * 1024
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
const WIKI_IMAGE_PATH_PATTERN =
  /^\/uploads\/wiki\/[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*\.(?:avif|gif|jpe?g|png|webp)$/u
const BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u
const RAW_HTML_PATTERN =
  /<(?!https?:\/\/|mailto:)(?:!--|!|\?|\/?[A-Za-z][A-Za-z0-9:-]*(?=[\s/>]|$))/iu
const ESM_PATTERN =
  /^\s*(?:import\s+.+\s+from\s+|export\s+(?:default|const|let|var|function|class|\{))/mu
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

    const detectedMediaType = detectImageMediaType(bytes)
    const expectedMediaType = expectedMediaTypeForPath(path)

    if (!detectedMediaType || detectedMediaType !== expectedMediaType) {
      return {
        ok: false,
        message: '画像の拡張子、MIME type、ファイルシグネチャが一致しません。',
      }
    }

    return {
      ok: true,
      addition: {
        path,
        contents,
        byteSize,
        mediaType: detectedMediaType,
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
      !WIKI_IMAGE_PATH_PATTERN.test(frontmatter.ogImage))
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

function detectImageMediaType(bytes: Uint8Array) {
  if (
    bytes.length >= 20 &&
    hasBytes(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) &&
    hasBytes(bytes, bytes.length - 12, [0x00, 0x00, 0x00, 0x00]) &&
    readAscii(bytes, bytes.length - 8, 4) === 'IEND'
  ) {
    return 'image/png'
  }

  if (
    bytes.length >= 4 &&
    hasBytes(bytes, 0, [0xff, 0xd8, 0xff]) &&
    hasBytes(bytes, bytes.length - 2, [0xff, 0xd9])
  ) {
    return 'image/jpeg'
  }

  if (
    bytes.length >= 14 &&
    (readAscii(bytes, 0, 6) === 'GIF87a' ||
      readAscii(bytes, 0, 6) === 'GIF89a') &&
    bytes[bytes.length - 1] === 0x3b
  ) {
    return 'image/gif'
  }

  if (
    bytes.length >= 16 &&
    readAscii(bytes, 0, 4) === 'RIFF' &&
    readUint32LittleEndian(bytes, 4) === bytes.length - 8 &&
    readAscii(bytes, 8, 4) === 'WEBP' &&
    ['VP8 ', 'VP8L', 'VP8X'].includes(readAscii(bytes, 12, 4))
  ) {
    return 'image/webp'
  }

  if (isAvif(bytes)) return 'image/avif'

  return null
}

function isAvif(bytes: Uint8Array) {
  if (bytes.length < 16 || readAscii(bytes, 4, 4) !== 'ftyp') return false

  const boxSize = readUint32(bytes, 0)

  if (boxSize < 16 || boxSize > bytes.length || boxSize % 4 !== 0) {
    return false
  }

  for (let offset = 8; offset + 4 <= boxSize; offset += 4) {
    const brand = readAscii(bytes, offset, 4)

    if (brand === 'avif' || brand === 'avis') return true
  }

  return false
}

function expectedMediaTypeForPath(path: string) {
  const extension = getCmsPathExtension(path)

  if (extension === '.png') return 'image/png'
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg'
  if (extension === '.gif') return 'image/gif'
  if (extension === '.webp') return 'image/webp'
  if (extension === '.avif') return 'image/avif'

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
