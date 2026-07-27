import { SITE_ORIGIN } from '../config/wiki'
import { articlePath, getWikiArticles } from '../lib/wiki'

export const prerender = true

export async function GET({ site }: { site?: URL }) {
  const origin = site ?? new URL(SITE_ORIGIN)
  const paths = [
    '/',
    ...(await getWikiArticles()).map(({ id }) => articlePath(id)),
  ]
  const urls = paths
    .map(
      (path) => `  <url><loc>${new URL(path, origin).toString()}</loc></url>`,
    )
    .join('\n')
  const sitemap = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    urls,
    '</urlset>',
    '',
  ].join('\n')

  return new Response(sitemap, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
    },
  })
}
