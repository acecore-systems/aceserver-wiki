import rehypeStringify from 'rehype-stringify'
import remarkParse from 'remark-parse'
import remarkRehype from 'remark-rehype'
import { unified } from 'unified'
import { describe, expect, it, vi } from 'vitest'

import { onRequest } from '../functions/_middleware'
import {
  ADSENSE_CLIENT,
  ARTICLE_REDIRECTS,
  BING_SITE_VERIFICATION,
  ROOT_DESCRIPTION,
  ROOT_META_TITLE,
  SEARCH_META_TITLE,
  WIKI_CATEGORIES,
  WIKI_HEADER_LINKS,
} from '../src/config/wiki'
import {
  isExternalHttpUrl,
  rehypeUgcExternalLinks,
} from '../src/lib/external-link-policy'
import { markdownToSearchText, matchesWikiSearch } from '../src/lib/search'

const SITE = 'https://asv-wiki.acecore.net'

describe('migrated public site configuration', () => {
  it('preserves six ordered categories including the empty source category', () => {
    expect(WIKI_CATEGORIES.map(({ name }) => name)).toEqual([
      'イントロダクション',
      '生活鯖について',
      'その他サーバーについて',
      'ディスコードについて',
      'コミュニティ紹介',
      'その他',
    ])
  })

  it('preserves the curated header links', () => {
    expect(WIKI_HEADER_LINKS).toEqual([
      {
        text: 'ワールドマップ',
        href: 'https://asv.acecore.net/world-map/',
      },
      { text: 'Acecore', href: 'https://acecore.net' },
      {
        text: 'エースサーバーポータル',
        href: 'https://asv.acecore.net',
      },
      {
        text: 'Aceserverグッズ',
        href: 'https://shop.acecore.net/collections/aceserver/',
      },
    ])
  })

  it('keeps the curated production SEO and advertising identifiers', () => {
    expect(ROOT_META_TITLE).toBe(
      'エースサーバー公式Wiki｜ルール・参加方法・コマンド案内',
    )
    expect(ROOT_DESCRIPTION.length).toBeGreaterThan(100)
    expect(SEARCH_META_TITLE).toBe('サイト内検索 | エースサーバー公式Wiki')
    expect(BING_SITE_VERIFICATION).toBe('B670753BF4A50FA5437E5694CB04BAFD')
    expect(ADSENSE_CLIENT).toBe('ca-pub-3935803464310919')
  })
})

describe('wiki search normalization', () => {
  it('keeps link labels but excludes image alt text and destinations', () => {
    const text = markdownToSearchText(`
## 参加方法

[Discord連携](/article/how-to-discordsrv-link/)

![検索対象にしない画像説明](/uploads/wiki/join-header.jpg)

[角括弧を含むリンク\\]](https://example.test/link)
`)

    expect(text).toContain('参加方法')
    expect(text).toContain('Discord連携')
    expect(text).not.toContain('検索対象にしない画像説明')
    expect(text).not.toContain('/uploads/wiki/')
    expect(text).toContain('角括弧を含むリンク]')
    expect(text).not.toContain('https://example.test/link')
  })

  it('matches title and body case-insensitively', () => {
    const item = {
      title: 'Discord連携',
      url: '/article/how-to-discordsrv-link/',
      text: 'Minecraftアカウントを認証します。',
    }

    expect(matchesWikiSearch(item, 'discord')).toBe(true)
    expect(matchesWikiSearch(item, 'minecraft')).toBe(true)
    expect(matchesWikiSearch(item, '存在しない語')).toBe(false)
  })
})

describe('user-generated external link policy', () => {
  it.each([
    ['inline link', '[外部](https://external.example/path)'],
    [
      'reference link',
      '[外部][target]\n\n[target]: https://external.example/path',
    ],
    [
      'protocol-relative reference link',
      '[外部][target]\n\n[target]: //external.example/path',
    ],
    [
      'case-insensitive HTTP scheme',
      '[外部][target]\n\n[target]: HTTPS://external.example/path',
    ],
  ])('adds UGC rel tokens to an external %s', async (_label, markdown) => {
    const result = await renderMarkdownWithExternalLinkPolicy(markdown)

    expect(result).toContain('rel="ugc nofollow noopener noreferrer"')
  })

  it.each([
    '[同一サイト](https://asv-wiki.acecore.net/article/rule/)',
    '[相対リンク](/article/rule/)',
    '[メール](mailto:wiki@example.test)',
  ])('does not mark a non-external HTTP link as UGC: %s', async (markdown) => {
    const result = await renderMarkdownWithExternalLinkPolicy(markdown)

    expect(result).not.toContain(' rel=')
  })

  it('uses the same URL semantics for build validation', () => {
    expect(isExternalHttpUrl('//external.example/path', SITE)).toBe(true)
    expect(isExternalHttpUrl('HTTPS://external.example/path', SITE)).toBe(true)
    expect(
      isExternalHttpUrl('https://asv-wiki.acecore.net/article/rule/', SITE),
    ).toBe(false)
  })
})

async function renderMarkdownWithExternalLinkPolicy(markdown: string) {
  const result = await unified()
    .use(remarkParse)
    .use(remarkRehype)
    .use(rehypeUgcExternalLinks, { site: SITE })
    .use(rehypeStringify)
    .process(markdown)

  return String(result)
}

describe('legacy article redirects', () => {
  it('defines four Newt slug normalizations and the older SurvivalRules alias', () => {
    expect(ARTICLE_REDIRECTS.get('/article/how to discordsrv link/')).toBe(
      '/article/how-to-discordsrv-link/',
    )
    expect(ARTICLE_REDIRECTS.get('/article/About management team/')).toBe(
      '/article/about-management-team/',
    )
    expect(ARTICLE_REDIRECTS.get('/article/Hoe Kingdom/')).toBe(
      '/article/hoe-kingdom/',
    )
    expect(ARTICLE_REDIRECTS.get('/article/Asutan　Kingdom/')).toBe(
      '/article/asutan-kingdom/',
    )
    expect(ARTICLE_REDIRECTS.get('/article/SurvivalRules')).toBe(
      '/article/rule/',
    )
  })

  it.each([
    ['how to discordsrv link', '/article/how-to-discordsrv-link/'],
    ['About management team', '/article/about-management-team/'],
    ['Hoe Kingdom', '/article/hoe-kingdom/'],
    ['Asutan　Kingdom', '/article/asutan-kingdom/'],
  ])('returns 301 for the old public slug %s', async (source, target) => {
    const next = vi.fn(async () => new Response('next'))
    const response = await onRequest({
      request: new Request(
        `https://asv-wiki.acecore.net/article/${encodeURIComponent(source)}/?ref=test`,
      ),
      next,
    } as unknown as Parameters<typeof onRequest>[0])

    expect(response.status).toBe(301)
    expect(response.headers.get('Location')).toBe(
      `https://asv-wiki.acecore.net${target}?ref=test`,
    )
    expect(next).not.toHaveBeenCalled()
  })

  it('preserves the existing MediaWiki and SurvivalRules aliases', async () => {
    const next = vi.fn(async () => new Response('next'))
    const root = await onRequest({
      request: new Request(
        'https://asv-wiki.acecore.net/index.php?title=メインページ',
      ),
      next,
    } as unknown as Parameters<typeof onRequest>[0])
    const rules = await onRequest({
      request: new Request(
        'https://asv-wiki.acecore.net/article/SurvivalRules/',
      ),
      next,
    } as unknown as Parameters<typeof onRequest>[0])

    expect(root.status).toBe(301)
    expect(root.headers.get('Location')).toBe('https://asv-wiki.acecore.net/')
    expect(rules.status).toBe(301)
    expect(rules.headers.get('Location')).toBe(
      'https://asv-wiki.acecore.net/article/rule/',
    )
  })
})

describe('public security headers', () => {
  it('uses a per-response strict CSP nonce only for trusted script markers', async () => {
    const next = vi.fn(async () => {
      return new Response(
        [
          '<!doctype html>',
          '<script nonce="__CSP_NONCE__" src="/search.js"></script>',
          '<script src="/untrusted.js"></script>',
        ].join(''),
        { headers: { 'Content-Type': 'text/html; charset=utf-8' } },
      )
    })
    const response = await onRequest({
      request: new Request('https://asv-wiki.acecore.net/search/'),
      next,
    } as unknown as Parameters<typeof onRequest>[0])

    const policy = response.headers.get('Content-Security-Policy')
    const nonce = policy?.match(/script-src 'nonce-([a-f0-9]{32})'/u)?.[1]
    const html = await response.text()

    expect(nonce).toBeTruthy()
    expect(policy).toContain("'strict-dynamic'")
    expect(policy).toContain("frame-src 'none'")
    expect(policy).not.toContain("'unsafe-eval'")
    expect(html).toContain(`nonce="${nonce}" src="/search.js"`)
    expect(html).toContain('<script src="/untrusted.js"></script>')
    expect(html).not.toContain('__CSP_NONCE__')
  })

  it('prevents a cached HTML body from being paired with a new nonce', async () => {
    const next = vi.fn(async (request: Request) => {
      expect(request.headers.get('If-None-Match')).toBeNull()
      expect(request.headers.get('If-Modified-Since')).toBeNull()

      return new Response(
        '<script nonce="__CSP_NONCE__" src="/search.js"></script>',
        {
          headers: {
            'Content-Type': 'text/html',
            ETag: '"cached-html"',
            'Last-Modified': 'Sun, 26 Jul 2026 00:00:00 GMT',
          },
        },
      )
    })
    const response = await onRequest({
      request: new Request('https://asv-wiki.acecore.net/search/?q=Discord', {
        headers: {
          'If-Modified-Since': 'Sun, 26 Jul 2026 00:00:00 GMT',
          'If-None-Match': '"cached-html"',
        },
      }),
      next,
    } as unknown as Parameters<typeof onRequest>[0])

    expect(next).toHaveBeenCalledOnce()
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(response.headers.get('ETag')).toBeNull()
    expect(response.headers.get('Last-Modified')).toBeNull()
    expect(await response.text()).not.toContain('__CSP_NONCE__')
  })

  it('also strips HTML validators and disables caching for HEAD responses', async () => {
    const next = vi.fn(async (request: Request) => {
      expect(request.method).toBe('HEAD')
      expect(request.headers.get('If-None-Match')).toBeNull()
      expect(request.headers.get('If-Modified-Since')).toBeNull()

      return new Response(null, {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          ETag: '"cached-html"',
          'Last-Modified': 'Sun, 26 Jul 2026 00:00:00 GMT',
        },
      })
    })
    const response = await onRequest({
      request: new Request('https://asv-wiki.acecore.net/search/', {
        method: 'HEAD',
        headers: {
          'If-Modified-Since': 'Sun, 26 Jul 2026 00:00:00 GMT',
          'If-None-Match': '"cached-html"',
        },
      }),
      next,
    } as unknown as Parameters<typeof onRequest>[0])

    expect(next).toHaveBeenCalledOnce()
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(response.headers.get('ETag')).toBeNull()
    expect(response.headers.get('Last-Modified')).toBeNull()
    expect(response.body).toBeNull()
  })
})
