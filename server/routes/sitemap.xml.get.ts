import { articlePath, canonicalUrl } from '#shared/lib/seo'

export default defineEventHandler(async (event) => {
  const { articles } = await getWikiData(event)
  const locations = [
    canonicalUrl('/'),
    ...articles.map((article) => canonicalUrl(articlePath(article.slug))),
  ]
  const urls = [...new Set(locations)]
    .map((location) => `  <url><loc>${location}</loc></url>`)
    .join('\n')

  setResponseHeader(event, 'content-type', 'application/xml; charset=utf-8')
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`
})
