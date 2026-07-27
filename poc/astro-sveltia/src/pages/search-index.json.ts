import { getWikiSearchItems } from '../lib/wiki'

export const prerender = true

export async function GET() {
  return new Response(JSON.stringify(await getWikiSearchItems()), {
    headers: {
      'Cache-Control': 'public, max-age=0, must-revalidate',
      'Content-Type': 'application/json; charset=utf-8',
    },
  })
}
