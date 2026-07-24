import type { H3Event } from 'h3'
import { createClient } from 'newt-client-js'
import type {
  WikiArticle,
  WikiArticleSummary,
  WikiCategory,
  WikiLink,
  WikiSearchSource,
} from '#shared/types/wiki'

const newtConfig = {
  spaceUid: 'aceserver',
  appUid: 'wiki',
  apiType: 'cdn' as const,
  articleModelUid: 'article',
  categoryModelUid: 'category',
  linkModelUid: 'link',
}

const getClient = (event: H3Event) => {
  const token = useRuntimeConfig(event).newtCdnApiToken
  if (!token) {
    throw createError({
      statusCode: 500,
      statusMessage: 'NEWT_CDN_API_TOKEN is required.',
    })
  }

  return createClient({
    spaceUid: newtConfig.spaceUid,
    token,
    apiType: newtConfig.apiType,
  })
}

export const getWikiData = async (event: H3Event) => {
  const client = getClient(event)
  const [app, links, categories, articles] = await Promise.all([
    client.getApp({ appUid: newtConfig.appUid }),
    client.getContents<WikiLink>({
      appUid: newtConfig.appUid,
      modelUid: newtConfig.linkModelUid,
      query: {
        depth: 1,
        select: ['_id', 'text', 'href'],
        limit: 5,
      },
    }),
    client.getContents<WikiCategory>({
      appUid: newtConfig.appUid,
      modelUid: newtConfig.categoryModelUid,
      query: {
        depth: 1,
        order: ['sortOrder'],
        select: ['_id', 'name'],
        limit: 1000,
      },
    }),
    client.getContents<WikiArticleSummary>({
      appUid: newtConfig.appUid,
      modelUid: newtConfig.articleModelUid,
      query: {
        depth: 2,
        order: ['sortOrder'],
        select: ['_id', 'title', 'category', 'slug'],
        limit: 1000,
      },
    }),
  ])

  return {
    app,
    links: links.items,
    categories: categories.items,
    articles: articles.items,
  }
}

export const getArticle = async (event: H3Event, slug: string) => {
  const client = getClient(event)
  const { items } = await client.getContents<WikiArticle>({
    appUid: newtConfig.appUid,
    modelUid: newtConfig.articleModelUid,
    query: {
      depth: 2,
      slug,
      select: ['_id', 'title', 'slug', 'body', 'category', 'meta'],
      limit: 1,
    },
  })
  const article = items[0]

  if (!article) {
    throw createError({
      statusCode: 404,
      statusMessage: 'Article not found.',
    })
  }

  return article
}

export const getSearchArticles = async (event: H3Event) => {
  const client = getClient(event)
  const { items } = await client.getContents<WikiSearchSource>({
    appUid: newtConfig.appUid,
    modelUid: newtConfig.articleModelUid,
    query: {
      depth: 2,
      order: ['sortOrder'],
      select: ['_id', 'title', 'slug', 'body'],
      limit: 1000,
    },
  })
  return items
}
