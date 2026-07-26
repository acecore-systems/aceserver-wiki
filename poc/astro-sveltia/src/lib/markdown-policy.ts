const rawHtmlPattern =
  /<(?:!--[\s\S]*?--|!doctype\b[^>]*|\/?[a-z][a-z0-9:-]*(?:\s[^<>]*?)?\s*\/?>)/i

const mdxModulePattern = /^(?:import|export)\s.+$/m
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

  if (containsLevelOneHeading(source)) {
    throw new Error(
      `Level-one headings are reserved for the article title: ${id}`,
    )
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
