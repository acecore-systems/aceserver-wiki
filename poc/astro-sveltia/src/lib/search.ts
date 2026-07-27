export interface WikiSearchItem {
  title: string
  url: string
  text: string
}

export const markdownToSearchText = (markdown: string): string => {
  return markdown
    .replace(/```[\s\S]*?```/gu, ' ')
    .replace(/!\[(?:\\.|[^\]\\])*\]\((?:\\.|[^)])*\)/gu, ' ')
    .replace(
      /\[((?:\\.|[^\]\\])*)\]\((?:\\.|[^)])*\)/gu,
      (_match, label: string) =>
        label.replace(/\\([\\`*_[\]{}()#+\-.!>])/gu, '$1'),
    )
    .replace(/`([^`]+)`/gu, '$1')
    .replace(/^ {0,3}#{2,6}[ \t]+/gmu, '')
    .replace(/^ {0,3}(?:[-+*]|\d+[.)])[ \t]+/gmu, '')
    .replace(/[|*_~>#\\]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
}

export const matchesWikiSearch = (
  item: WikiSearchItem,
  query: string,
): boolean => {
  const normalizedQuery = query.trim().toLocaleLowerCase('ja-JP')

  if (!normalizedQuery) return false

  return `${item.title}\n${item.text}`
    .toLocaleLowerCase('ja-JP')
    .includes(normalizedQuery)
}
