import { htmlToText } from 'html-to-text'

export default defineEventHandler(async (event) => {
  const articles = await getSearchArticles(event)
  return articles.map((article) => ({
    _id: article._id,
    title: article.title,
    slug: article.slug,
    text: htmlToText(article.body || '', {
      selectors: [{ selector: 'img', format: 'skip' }],
    }),
  }))
})
