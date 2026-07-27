import { getCollection, type CollectionEntry } from 'astro:content'
import { HEADER_TITLE, SITE_ORIGIN, WIKI_CATEGORIES } from '../config/wiki'
import { assertMarkdownSource } from './markdown-policy'
import { markdownToSearchText, type WikiSearchItem } from './search'

export { HEADER_TITLE, SITE_ORIGIN }

export type WikiArticle = CollectionEntry<'wiki'>

export interface WikiCategoryGroup {
  id: string
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
  const categoryNames = new Set<string>(WIKI_CATEGORIES.map(({ name }) => name))
  const unknownCategory = articles.find(
    (article) => !categoryNames.has(article.data.category),
  )

  if (unknownCategory) {
    throw new Error(
      `Unknown wiki category "${unknownCategory.data.category}" in ${unknownCategory.id}.`,
    )
  }

  return WIKI_CATEGORIES.map(({ id, name }) => ({
    id,
    name,
    articles: articles.filter((article) => article.data.category === name),
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

export const getWikiSearchItems = async (): Promise<WikiSearchItem[]> => {
  const articles = await getWikiArticles()

  return articles.map((article) => ({
    title: article.data.title,
    url: articlePath(article.id),
    text: markdownToSearchText(
      (article as WikiArticle & { body?: string }).body ?? '',
    ),
  }))
}
