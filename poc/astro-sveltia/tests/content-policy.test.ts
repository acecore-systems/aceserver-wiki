import { describe, expect, it } from 'vitest'

import {
  isAllowedCmsWritePath,
  normalizeCmsPath,
} from '../functions/admin/api/_cms-policy.ts'
import { validateCmsAddition } from '../functions/admin/api/_content-validation.ts'
import { assertMarkdownSource } from '../src/lib/markdown-policy.ts'

const VALID_MARKDOWN = `---
title: Markdown編集PoC
description: 公開切替を伴わない編集経路の検証記事です。
category: PoC
order: 10
draft: false
---

## Markdown編集PoC

本文は **Markdown** で保存します。
`

describe('CMS path policy', () => {
  it('accepts a normalized Japanese Markdown filename', () => {
    const path = 'poc/astro-sveltia/src/content/wiki/編集ガイド-1.md'

    expect(normalizeCmsPath(path)).toBe(path)
    expect(isAllowedCmsWritePath(path)).toBe(true)
  })

  it.each([
    'poc/astro-sveltia/src/content/wiki/../secrets.md',
    'poc/astro-sveltia/src/content/wiki/nested/page.md',
    'poc/astro-sveltia/src/content/wiki/.hidden.md',
    'poc/astro-sveltia/public/uploads/wiki/icon.svg',
    'README.md',
  ])('rejects an out-of-scope path: %s', (path) => {
    const normalized = normalizeCmsPath(path)

    expect(normalized === null || !isAllowedCmsWritePath(normalized)).toBe(true)
  })

  it('rejects a non-NFC path', () => {
    const decomposed = 'poc/astro-sveltia/src/content/wiki/cafe\u0301.md'

    expect(normalizeCmsPath(decomposed)).toBeNull()
  })
})

describe('CMS content validation', () => {
  it('accepts strict UTF-8 Markdown and frontmatter', () => {
    const result = validateCmsAddition(
      'poc/astro-sveltia/src/content/wiki/markdown-editing-poc.md',
      encodeUtf8(VALID_MARKDOWN),
    )

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.addition.mediaType).toBe('text/markdown; charset=utf-8')
    }
  })

  it.each([
    [
      'raw HTML',
      VALID_MARKDOWN.replace(
        '本文は **Markdown** で保存します。',
        '<script>alert(1)</script>',
      ),
    ],
    [
      'unknown frontmatter',
      VALID_MARKDOWN.replace(
        'draft: false',
        'draft: false\nlayout: ../../secret',
      ),
    ],
    [
      'dangerous URI',
      VALID_MARKDOWN.replace(
        '本文は **Markdown** で保存します。',
        '[開く](java&#x73;cript:alert(1))',
      ),
    ],
    [
      'YAML alias',
      VALID_MARKDOWN.replace(
        'title: Markdown編集PoC',
        'title: &shared Markdown編集PoC',
      ),
    ],
    [
      'level-one heading',
      VALID_MARKDOWN.replace('## Markdown編集PoC', '# Markdown編集PoC'),
    ],
  ])('rejects %s', (_label, markdown) => {
    const result = validateCmsAddition(
      'poc/astro-sveltia/src/content/wiki/rejected.md',
      encodeUtf8(markdown),
    )

    expect(result.ok).toBe(false)
  })

  it('allows heading-like text inside fenced code blocks', () => {
    const markdown = VALID_MARKDOWN.replace(
      '本文は **Markdown** で保存します。',
      '```markdown\n# コード例\n```',
    )
    const result = validateCmsAddition(
      'poc/astro-sveltia/src/content/wiki/code-example.md',
      encodeUtf8(markdown),
    )

    expect(result.ok).toBe(true)
  })

  it('accepts a matching PNG signature and rejects an extension mismatch', () => {
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00,
      0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ])
    const encoded = encodeBytes(png)
    const pngResult = validateCmsAddition(
      'poc/astro-sveltia/public/uploads/wiki/preview.png',
      encoded,
    )
    const jpegResult = validateCmsAddition(
      'poc/astro-sveltia/public/uploads/wiki/preview.jpg',
      encoded,
    )

    expect(pngResult.ok).toBe(true)
    expect(jpegResult.ok).toBe(false)
  })
})

describe('Astro Markdown build policy', () => {
  it('reserves h1 for the frontmatter article title', () => {
    expect(() => assertMarkdownSource('# 本文h1', 'test')).toThrow(
      'Level-one headings',
    )
    expect(() =>
      assertMarkdownSource('```markdown\n# コード例\n```', 'test'),
    ).not.toThrow()
  })
})

function encodeUtf8(value: string) {
  return encodeBytes(new TextEncoder().encode(value))
}

function encodeBytes(bytes: Uint8Array) {
  let binary = ''

  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }

  return btoa(binary)
}
