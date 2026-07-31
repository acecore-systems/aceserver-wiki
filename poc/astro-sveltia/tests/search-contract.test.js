import { describe, expect, it } from 'vitest'

import {
  getSafePublicPathname,
  normalizeNetworkSearchResults,
} from '../public/search-contract.js'

const REQUEST_ID = '018f7e5a-7b4d-7c6a-8e9f-0123456789ab'

function networkPayload(results, requestId = REQUEST_ID) {
  return { ok: true, requestId, results }
}

function result(overrides = {}) {
  return {
    excerpt: '公開ページの抜粋です。',
    rank: 1,
    section: '案内',
    source: 'portal',
    sourceLabel: 'Aceserver Portal',
    title: 'Portalの記事',
    url: 'https://asv.acecore.net/stories/aceserver-hijacked/',
    ...overrides,
  }
}

describe('related-site search response contract', () => {
  it('keeps valid allowlisted results and excludes WIKI itself', () => {
    const results = normalizeNetworkSearchResults(
      networkPayload([
        result({ rank: 2 }),
        result({
          source: 'wiki',
          sourceLabel: 'Aceserver WIKI',
          url: 'https://asv-wiki.acecore.net/article/rule/',
        }),
        result({
          rank: 1,
          source: 'acecore',
          sourceLabel: 'Acecore',
          url: 'https://acecore.net/services/',
        }),
      ]),
      'wiki',
    )

    expect(
      results.map(({ rank, sourceLabel, url }) => ({ rank, sourceLabel, url })),
    ).toEqual([
      {
        rank: 1,
        sourceLabel: 'Acecore',
        url: 'https://acecore.net/services/',
      },
      {
        rank: 2,
        sourceLabel: 'Aceserver Portal',
        url: 'https://asv.acecore.net/stories/aceserver-hijacked/',
      },
    ])
  })

  it('rejects source-specific non-document related-site paths', () => {
    const unsafeResults = [
      result({
        source: 'wiki',
        sourceLabel: 'Aceserver WIKI',
        url: 'https://asv.acecore.net/stories/aceserver-hijacked/',
      }),
      result({
        source: 'wiki',
        sourceLabel: 'Aceserver WIKI',
        url: 'https://asv-wiki.acecore.net/search/',
      }),
      result({ url: 'https://asv.acecore.net/vector-corpus.json' }),
      result({ url: 'https://asv.acecore.net/404' }),
      result({ url: 'https://asv.acecore.net/404/' }),
      result({ url: 'https://asv.acecore.net/404.html' }),
      result({ url: 'https://asv.acecore.net/404.html/' }),
    ]

    expect(
      normalizeNetworkSearchResults(networkPayload(unsafeResults), 'systems'),
    ).toEqual([])
  })

  it('rejects unsafe raw paths before URL parsing and returns canonical paths', () => {
    const unsafePaths = [
      ' /services/',
      '\t/services/',
      '/safe/../services/',
      '/safe\\private/',
      '/safe/' + String.fromCharCode(0) + 'private/',
      '/safe/\tprivate/',
      '/safe%2fprivate/',
      '/safe%252fprivate/',
      '/safe/%252e%252e/services/',
      '/safe/%2509private/',
      '/safe/%3Fprivate/',
      '/safe/%EF%BC%8E%EF%BC%8E/services/',
      '/safe/%EF%BC%BCprivate/',
      '/%EF%BC%85%36%31dmin/',
    ]

    for (const path of unsafePaths) {
      expect(getSafePublicPathname(path), path).toBeNull()
    }
    expect(getSafePublicPathname('/services/')).toBe('/services/')
  })

  it('rejects response IDs and ranks outside the central contract', () => {
    expect(
      normalizeNetworkSearchResults(
        networkPayload([result()], '018f7e5a-7b4d-0c6a-8e9f-0123456789ab'),
        'wiki',
      ),
    ).toEqual([])
    expect(
      normalizeNetworkSearchResults(
        networkPayload([result()], '018f7e5a-7b4d-7c6a-7e9f-0123456789ab'),
        'wiki',
      ),
    ).toEqual([])
    expect(
      normalizeNetworkSearchResults(
        networkPayload([result()], '\t' + REQUEST_ID + '\n'),
        'wiki',
      ),
    ).toEqual([])
    expect(
      normalizeNetworkSearchResults(
        networkPayload([result({ rank: 4 })]),
        'wiki',
      ),
    ).toEqual([])
  })

  it('rejects malformed response IDs and URLs with query, fragment, or private paths', () => {
    expect(
      normalizeNetworkSearchResults(
        networkPayload([result()], 'not-a-uuid'),
        'wiki',
      ),
    ).toEqual([])
    expect(
      normalizeNetworkSearchResults(
        networkPayload([
          result({ url: 'https://asv.acecore.net/stories/?next=admin' }),
          result({ url: 'https://asv.acecore.net/stories/#private' }),
          result({ url: 'https://asv.acecore.net/admin/' }),
          result({ url: 'https://asv.acecore.net/%61dmin/' }),
          result({ url: 'https://asv.acecore.net/%61pi/search' }),
          result({ url: 'https://asv.acecore.net/%2561dmin/' }),
          result({ url: 'https://asv.acecore.net/%2561pi/search' }),
          result({ url: 'https://asv.acecore.net/%252e%252e/admin/' }),
          result({ url: 'https://asv.acecore.net//admin/' }),
          result({ url: 'https://asv.acecore.net/%2fadmin/' }),
          result({ url: 'https://asv.acecore.net/%252fadmin/' }),
          result({ url: 'https://asv.acecore.net/%5cadmin/' }),
          result({ url: 'https://asv.acecore.net/%255cadmin/' }),
          result({ url: 'https://asv.acecore.net/%255capi/search' }),
          result({ url: 'https://asv.acecore.net/%2500admin/' }),
          result({ url: 'https://asv.acecore.net/%EF%BC%8Fadmin/' }),
          result({ url: 'https://asv.acecore.net/%EF%BC%85%36%31dmin/' }),
          result({ url: 'https://asv.acecore.net/\\admin/' }),
          result({ url: 'https://asv.acecore.net/safe/../services/' }),
          result({ url: 'https://asv.acecore.net/safe\\private/' }),
          result({ url: 'https://asv.acecore.net/\tservices/' }),
          result({
            url: 'https://asv.acecore.net/safe/%252e%252e/services/',
          }),
          result({ url: 'https://asv.acecore.net/safe%252fprivate/' }),
          result({ url: 'https://asv.acecore.net/%ZZ/' }),
        ]),
        'wiki',
      ),
    ).toEqual([])
  })
})
