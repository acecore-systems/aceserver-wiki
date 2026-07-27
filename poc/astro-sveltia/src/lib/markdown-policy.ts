import remarkParse from 'remark-parse'
import { unified } from 'unified'

const rawHtmlPattern =
  /<(?:!--[\s\S]*?--|!doctype\b[^>]*|\/?[a-z][a-z0-9:-]*(?:\s[^<>]*?)?\s*\/?>)/i

export const mdxModulePattern = /^(?:import|export)\s.+$/m
export const wikiImagePathPattern =
  /^\/uploads\/wiki\/[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*\.(?:jpe?g|png|webp)$/u
const dangerousUriPattern = /\b(?:data|javascript|vbscript)\s*:/iu
const levelOneAtxHeadingPattern = /^(?: {0,3})#(?:[ \t]+|$)/u
const levelOneSetextHeadingPattern = /^(?: {0,3})=+[ \t]*$/u

export const assertMarkdownSource = (source: string, id: string): void => {
  if (rawHtmlPattern.test(source)) {
    throw new Error(`Raw HTML is not allowed in Markdown wiki content: ${id}`)
  }

  if (mdxModulePattern.test(source)) {
    throw new Error(
      `MDX module syntax is not allowed in Markdown wiki content: ${id}`,
    )
  }

  if (dangerousUriPattern.test(normalizeUriText(source))) {
    throw new Error(
      `Dangerous URI schemes are not allowed in Markdown wiki content: ${id}`,
    )
  }

  assertLocalWikiImages(source, id)

  if (containsLevelOneHeading(source)) {
    throw new Error(
      `Level-one headings are reserved for the article title: ${id}`,
    )
  }
}

type MarkdownNode = {
  type?: unknown
  url?: unknown
  identifier?: unknown
  children?: unknown
}

const assertLocalWikiImages = (source: string, id: string): void => {
  const tree = unified().use(remarkParse).parse(source) as MarkdownNode
  const imageUrls: string[] = []
  const imageReferences: string[] = []
  const definitions = new Map<string, string>()

  visitMarkdownNodes(tree, (node) => {
    if (node.type === 'image' && typeof node.url === 'string') {
      imageUrls.push(node.url)
    }

    if (node.type === 'imageReference' && typeof node.identifier === 'string') {
      imageReferences.push(node.identifier)
    }

    if (
      node.type === 'definition' &&
      typeof node.identifier === 'string' &&
      typeof node.url === 'string' &&
      !definitions.has(node.identifier)
    ) {
      definitions.set(node.identifier, node.url)
    }
  })

  for (const identifier of imageReferences) {
    const url = definitions.get(identifier)
    if (url) imageUrls.push(url)
  }

  if (imageUrls.some((url) => !wikiImagePathPattern.test(url))) {
    throw new Error(`Markdown images must use /uploads/wiki paths: ${id}`)
  }
}

const visitMarkdownNodes = (
  node: MarkdownNode,
  visitor: (node: MarkdownNode) => void,
): void => {
  visitor(node)

  if (!Array.isArray(node.children)) return

  for (const child of node.children) {
    if (child && typeof child === 'object') {
      visitMarkdownNodes(child as MarkdownNode, visitor)
    }
  }
}

const containsLevelOneHeading = (source: string): boolean => {
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
      levelOneAtxHeadingPattern.test(line) ||
      (previousLineCanBeHeading && levelOneSetextHeadingPattern.test(line))
    ) {
      return true
    }

    previousLineCanBeHeading = line.trim().length > 0
  }

  return false
}

const normalizeUriText = (value: string): string => {
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
      return /^&colon;/iu.test(entity) ? ':' : ''
    })
    .split('')
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0

      return codePoint > 0x20 && codePoint !== 0x7f
    })
    .join('')
}
