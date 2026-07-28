import { buildWikiVectorCorpus } from '../lib/vector-search'
import { articlePath, getWikiArticles, type WikiArticle } from '../lib/wiki'

export const prerender = true

export async function GET() {
  const articles = await getWikiArticles()
  const corpus = await buildWikiVectorCorpus(
    articles.map((article) => ({
      url: articlePath(article.id),
      title: article.data.title,
      description: article.data.description,
      category: article.data.category,
      body: (article as WikiArticle & { body?: string }).body ?? '',
    })),
  )

  return new Response(`${JSON.stringify(corpus, null, 2)}\n`, {
    headers: {
      'Cache-Control': 'public, max-age=0, must-revalidate',
      'Content-Type': 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
