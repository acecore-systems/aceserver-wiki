import { getCollection, type CollectionEntry } from 'astro:content'
import { assertMarkdownSource } from './markdown-policy'

export const SITE_TITLE = 'エースサーバー Wiki'
export const SITE_ORIGIN = 'https://asv-wiki.acecore.net'
export const POC_DESCRIPTION =
  'Git上のMarkdownをAstroで表示する技術検証です。現在公開中のWikiコンテンツは移行していません。'

export type WikiArticle = CollectionEntry<'wiki'>

export interface WikiCategoryGroup {
  name: string
  articles: WikiArticle[]
}

const japaneseCollator = new Intl.Collator('ja-JP', {
  numeric: true,
  sensitivity: 'base',
})

export const assertMarkdownOnly = (article: WikiArticle): void => {
  const body = (article as WikiArticle & { body?: string }).body ?? ''

  assertMarkdownSource(body, article.id)
}

export const getWikiArticles = async (): Promise<WikiArticle[]> => {
  const articles = await getCollection('wiki', ({ data }) => !data.draft)

  articles.forEach(assertMarkdownOnly)

  return articles.toSorted(
    (left, right) =>
      left.data.order - right.data.order ||
      japaneseCollator.compare(left.data.title, right.data.title) ||
      japaneseCollator.compare(left.id, right.id),
  )
}

export const groupWikiArticles = (
  articles: WikiArticle[],
): WikiCategoryGroup[] => {
  const categories = new Map<string, WikiArticle[]>()

  for (const article of articles) {
    const category = categories.get(article.data.category) ?? []
    category.push(article)
    categories.set(article.data.category, category)
  }

  return Array.from(categories, ([name, categoryArticles]) => ({
    name,
    articles: categoryArticles,
  }))
}

export const articlePath = (id: string): string => {
  const encodedId = id
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/')

  return `/article/${encodedId}/`
}
