import { describe, expect, it } from 'vitest'

import {
  isAllowedCmsDeletePath,
  isAllowedCmsWritePath,
  normalizeCmsPath,
} from '../functions/admin/api/_cms-policy.ts'
import { validateCmsAddition } from '../functions/admin/api/_content-validation.ts'
import {
  MAX_CMS_MARKDOWN_BYTES,
  MAX_CMS_MARKDOWN_KIB,
} from '../src/lib/cms-limits.ts'
import { assertMarkdownSource } from '../src/lib/markdown-policy.ts'
import { assertWikiMarkdownByteSize } from '../src/loaders/wiki-markdown-loader.ts'

const VALID_MARKDOWN = `---
title: Markdown編集PoC
description: 公開切替を伴わない編集経路の検証記事です。
category: その他
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
    expect(isAllowedCmsDeletePath(path)).toBe(false)
    expect(
      isAllowedCmsDeletePath(
        'poc/astro-sveltia/public/uploads/wiki/example.png',
      ),
    ).toBe(false)
  })

  it.each([
    'poc/astro-sveltia/src/content/wiki/../secrets.md',
    'poc/astro-sveltia/src/content/wiki/nested/page.md',
    'poc/astro-sveltia/src/content/wiki/.hidden.md',
    'poc/astro-sveltia/public/uploads/wiki/animated.gif',
    'poc/astro-sveltia/public/uploads/wiki/photo.avif',
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
  it('accepts Markdown at 448 KiB and rejects one byte over', () => {
    expect(MAX_CMS_MARKDOWN_KIB).toBe(448)
    expect(MAX_CMS_MARKDOWN_BYTES).toBe(448 * 1024)

    const baseBytes = new TextEncoder().encode(VALID_MARKDOWN).byteLength
    const atLimit = `${VALID_MARKDOWN}${'a'.repeat(
      MAX_CMS_MARKDOWN_BYTES - baseBytes,
    )}`
    const overLimit = `${atLimit}a`
    const path = 'poc/astro-sveltia/src/content/wiki/size-boundary.md'

    expect(new TextEncoder().encode(atLimit)).toHaveLength(
      MAX_CMS_MARKDOWN_BYTES,
    )
    expect(() =>
      assertWikiMarkdownByteSize(MAX_CMS_MARKDOWN_BYTES, 'at-limit.md'),
    ).not.toThrow()
    expect(() =>
      assertWikiMarkdownByteSize(MAX_CMS_MARKDOWN_BYTES + 1, 'over-limit.md'),
    ).toThrow('448 KiB')
    expect(validateCmsAddition(path, encodeUtf8(atLimit)).ok).toBe(true)

    const rejected = validateCmsAddition(path, encodeUtf8(overLimit))

    expect(rejected.ok).toBe(false)
    if (!rejected.ok) {
      expect(rejected.message).toContain('448 KiB')
    }
  })

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
      'numeric entity whitespace in dangerous URI',
      VALID_MARKDOWN.replace(
        '本文は **Markdown** で保存します。',
        '[開く](java&#x09;script:alert(1))\n[開く](java&#13;script:alert(1))',
      ),
    ],
    [
      'named entity whitespace in dangerous URI',
      VALID_MARKDOWN.replace(
        '本文は **Markdown** で保存します。',
        '[開く](java&Tab;script:alert(1))\n[開く](java&NewLine;script:alert(1))',
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

  it.each([
    '![追跡画像](https://tracker.example/pixel.png)',
    '![追跡画像](//tracker.example/pixel.png)',
    '![追跡画像][pixel]\n\n[pixel]: https://tracker.example/pixel.png',
    '![非対応画像](/uploads/wiki/animated.gif)',
    '![非対応画像](/uploads/wiki/photo.avif)',
    [
      '![追跡画像][pixel]',
      '',
      '[pixel]: https://tracker.example/pixel.png',
      '[pixel]: /uploads/wiki/allowed.png',
    ].join('\n'),
    [
      '![追跡画像][pixel]',
      '',
      '[pixel]: /uploads/wiki/allowed.png',
      '[pixel]: https://tracker.example/pixel.png',
      '',
      '![追跡画像][external]',
      '',
      '[external]: https://tracker.example/pixel.png',
    ].join('\n'),
    '![追跡画像](../pixel.png)',
  ])('rejects a non-local Markdown image: %s', (body) => {
    const markdown = VALID_MARKDOWN.replace(
      '本文は **Markdown** で保存します。',
      body,
    )
    const result = validateCmsAddition(
      'poc/astro-sveltia/src/content/wiki/rejected-image.md',
      encodeUtf8(markdown),
    )

    expect(result.ok).toBe(false)
    expect(() => assertMarkdownSource(body, 'test')).toThrow('/uploads/wiki')
  })

  it('allows uploaded wiki images and ordinary external links', () => {
    const body = [
      '![案内画像](/uploads/wiki/guide-image.webp)',
      '',
      '![参照画像][guide]',
      '',
      '[guide]: /uploads/wiki/guide-image.webp',
      '[guide]: https://tracker.example/ignored.png',
      '',
      '[公式サイト](https://example.com/)',
    ].join('\n')
    const markdown = VALID_MARKDOWN.replace(
      '本文は **Markdown** で保存します。',
      body,
    )
    const result = validateCmsAddition(
      'poc/astro-sveltia/src/content/wiki/local-image.md',
      encodeUtf8(markdown),
    )

    expect(result.ok).toBe(true)
    expect(() => assertMarkdownSource(body, 'test')).not.toThrow()
  })

  it.each([
    "import './side-effect.js'",
    'export async function run() {}',
    'export type Example = string',
  ])(
    'rejects module syntax before it can break the Astro build: %s',
    (body) => {
      const markdown = VALID_MARKDOWN.replace(
        '本文は **Markdown** で保存します。',
        body,
      )
      const result = validateCmsAddition(
        'poc/astro-sveltia/src/content/wiki/rejected-module.md',
        encodeUtf8(markdown),
      )

      expect(result.ok).toBe(false)
      expect(() => assertMarkdownSource(body, 'test')).toThrow(
        'MDX module syntax',
      )
    },
  )

  it('accepts a matching PNG signature and rejects an extension mismatch', () => {
    const png = createPng(2048, 2048)
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

  it('rejects oversized, animated, and unsupported image formats', () => {
    const oversizedPng = validateCmsAddition(
      'poc/astro-sveltia/public/uploads/wiki/oversized.png',
      encodeBytes(createPng(4097, 1)),
    )
    const animatedPng = validateCmsAddition(
      'poc/astro-sveltia/public/uploads/wiki/animated.png',
      encodeBytes(createPng(32, 32, true)),
    )
    const gif = validateCmsAddition(
      'poc/astro-sveltia/public/uploads/wiki/animated.gif',
      encodeBytes(
        new Uint8Array([
          0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x3b,
        ]),
      ),
    )

    expect(oversizedPng.ok).toBe(false)
    expect(animatedPng.ok).toBe(false)
    expect(gif.ok).toBe(false)
  })

  it('validates both simple and extended static WebP dimensions', () => {
    const simple = validateCmsAddition(
      'poc/astro-sveltia/public/uploads/wiki/simple.webp',
      encodeBytes(
        createWebp([createWebpChunk('VP8L', createVp8lPayload(2048, 1024))]),
      ),
    )
    const extended = validateCmsAddition(
      'poc/astro-sveltia/public/uploads/wiki/extended.webp',
      encodeBytes(
        createWebp([
          createWebpChunk('VP8X', createVp8xPayload(2048, 1024)),
          createWebpChunk('VP8L', createVp8lPayload(2048, 1024)),
        ]),
      ),
    )
    const oversized = validateCmsAddition(
      'poc/astro-sveltia/public/uploads/wiki/oversized.webp',
      encodeBytes(
        createWebp([createWebpChunk('VP8L', createVp8lPayload(4097, 1))]),
      ),
    )

    expect(simple.ok).toBe(true)
    expect(extended.ok).toBe(true)
    expect(oversized.ok).toBe(false)
  })

  it('does not trust forged VP8X canvas dimensions', () => {
    const webp = createWebp([
      createWebpChunk('VP8X', createVp8xPayload(1, 1)),
      createWebpChunk('VP8L', createVp8lPayload(4097, 1)),
    ])
    const result = validateCmsAddition(
      'poc/astro-sveltia/public/uploads/wiki/forged-canvas.webp',
      encodeBytes(webp),
    )

    expect(result.ok).toBe(false)
  })

  it.each(['ANIM', 'ANMF'])(
    'rejects a WebP %s chunk even when the VP8X animation flag is unset',
    (animationChunk) => {
      const webp = createWebp([
        createWebpChunk('VP8X', createVp8xPayload(32, 32)),
        createWebpChunk(animationChunk, new Uint8Array(6)),
        createWebpChunk('VP8L', createVp8lPayload(32, 32)),
      ])
      const result = validateCmsAddition(
        'poc/astro-sveltia/public/uploads/wiki/animated.webp',
        encodeBytes(webp),
      )

      expect(result.ok).toBe(false)
    },
  )

  it('rejects the VP8X animation feature flag', () => {
    const webp = createWebp([
      createWebpChunk('VP8X', createVp8xPayload(32, 32, 0x02)),
      createWebpChunk('VP8L', createVp8lPayload(32, 32)),
    ])
    const result = validateCmsAddition(
      'poc/astro-sveltia/public/uploads/wiki/animated-flag.webp',
      encodeBytes(webp),
    )

    expect(result.ok).toBe(false)
  })

  it.each([
    [
      'duplicate image chunks',
      () =>
        createWebp([
          createWebpChunk('VP8L', createVp8lPayload(32, 32)),
          createWebpChunk('VP8L', createVp8lPayload(32, 32)),
        ]),
    ],
    [
      'VP8X after image data',
      () =>
        createWebp([
          createWebpChunk('VP8L', createVp8lPayload(32, 32)),
          createWebpChunk('VP8X', createVp8xPayload(32, 32)),
        ]),
    ],
    [
      'a chunk before a simple image',
      () =>
        createWebp([
          createWebpChunk('JUNK', new Uint8Array(0)),
          createWebpChunk('VP8L', createVp8lPayload(32, 32)),
        ]),
    ],
    [
      'non-zero RIFF padding',
      () => {
        const webp = createWebp([
          createWebpChunk('VP8L', createVp8lPayload(32, 32)),
        ])
        webp[webp.length - 1] = 1
        return webp
      },
    ],
    [
      'a truncated chunk',
      () => {
        const complete = createWebp([
          createWebpChunk('VP8L', createVp8lPayload(32, 32)),
        ])
        const truncated = complete.slice(0, -2)
        writeUint32LittleEndian(truncated, 4, truncated.length - 8)
        return truncated
      },
    ],
    [
      'an overflowing chunk length',
      () => {
        const webp = createWebp([
          createWebpChunk('VP8L', createVp8lPayload(32, 32)),
        ])
        writeUint32LittleEndian(webp, 16, 0xffff_ffff)
        return webp
      },
    ],
  ])('rejects malformed WebP with %s', (_label, createBytes) => {
    const result = validateCmsAddition(
      'poc/astro-sveltia/public/uploads/wiki/malformed.webp',
      encodeBytes(createBytes()),
    )

    expect(result.ok).toBe(false)
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

function createPng(width: number, height: number, animated = false) {
  const bytes = [
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    0x00,
    0x00,
    0x00,
    0x0d,
    0x49,
    0x48,
    0x44,
    0x52,
    (width >>> 24) & 0xff,
    (width >>> 16) & 0xff,
    (width >>> 8) & 0xff,
    width & 0xff,
    (height >>> 24) & 0xff,
    (height >>> 16) & 0xff,
    (height >>> 8) & 0xff,
    height & 0xff,
    0x08,
    0x02,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
  ]

  if (animated) {
    bytes.push(
      0x00,
      0x00,
      0x00,
      0x08,
      0x61,
      0x63,
      0x54,
      0x4c,
      0x00,
      0x00,
      0x00,
      0x01,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
    )
  }

  bytes.push(
    0x00,
    0x00,
    0x00,
    0x00,
    0x49,
    0x45,
    0x4e,
    0x44,
    0x00,
    0x00,
    0x00,
    0x00,
  )

  return new Uint8Array(bytes)
}

type WebpChunk = {
  type: string
  payload: Uint8Array
}

function createWebpChunk(type: string, payload: Uint8Array): WebpChunk {
  return { type, payload }
}

function createWebp(chunks: WebpChunk[]) {
  const byteLength =
    12 +
    chunks.reduce(
      (total, { payload }) => total + 8 + payload.length + (payload.length % 2),
      0,
    )
  const bytes = new Uint8Array(byteLength)

  writeAscii(bytes, 0, 'RIFF')
  writeUint32LittleEndian(bytes, 4, byteLength - 8)
  writeAscii(bytes, 8, 'WEBP')

  let offset = 12

  for (const { payload, type } of chunks) {
    writeAscii(bytes, offset, type)
    writeUint32LittleEndian(bytes, offset + 4, payload.length)
    bytes.set(payload, offset + 8)
    offset += 8 + payload.length + (payload.length % 2)
  }

  return bytes
}

function createVp8xPayload(width: number, height: number, flags = 0) {
  const payload = new Uint8Array(10)

  payload[0] = flags
  writeUint24LittleEndian(payload, 4, width - 1)
  writeUint24LittleEndian(payload, 7, height - 1)

  return payload
}

function createVp8lPayload(width: number, height: number) {
  const payload = new Uint8Array(5)
  const bits = (width - 1) | ((height - 1) << 14)

  payload[0] = 0x2f
  writeUint32LittleEndian(payload, 1, bits)

  return payload
}

function writeAscii(bytes: Uint8Array, offset: number, value: string) {
  for (let index = 0; index < value.length; index += 1) {
    bytes[offset + index] = value.charCodeAt(index)
  }
}

function writeUint24LittleEndian(
  bytes: Uint8Array,
  offset: number,
  value: number,
) {
  bytes[offset] = value & 0xff
  bytes[offset + 1] = (value >>> 8) & 0xff
  bytes[offset + 2] = (value >>> 16) & 0xff
}

function writeUint32LittleEndian(
  bytes: Uint8Array,
  offset: number,
  value: number,
) {
  bytes[offset] = value & 0xff
  bytes[offset + 1] = (value >>> 8) & 0xff
  bytes[offset + 2] = (value >>> 16) & 0xff
  bytes[offset + 3] = (value >>> 24) & 0xff
}
