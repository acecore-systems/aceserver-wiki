import { markdownToSearchText } from './search'

export const SEARCH_CORPUS_SCHEMA_VERSION = 1
export const SEARCH_EMBEDDING_MODEL = '@cf/baai/bge-m3'
export const SEARCH_EMBEDDING_DIMENSIONS = 1024
export const SEARCH_DISTANCE_METRIC = 'cosine'
export const SEARCH_VECTOR_LIMIT = 500
export const SEARCH_NAMESPACE = 'ja'

export const SEARCH_TARGET_CHUNK_CHARACTERS = 850
export const SEARCH_MAXIMUM_CHUNK_CHARACTERS = 1200
export const SEARCH_OVERLAP_CHARACTERS = 120

const EXCERPT_MAXIMUM_CHARACTERS = 220
const SECTION_MAXIMUM_CHARACTERS = 240

export interface WikiVectorSource {
  url: string
  title: string
  description: string
  category: string
  body: string
}

export interface WikiVectorMetadata {
  url: string
  title: string
  section: string
  excerpt: string
  category: string
  locale: typeof SEARCH_NAMESPACE
}

export interface WikiVectorChunk {
  id: string
  namespace: typeof SEARCH_NAMESPACE
  text: string
  metadata: WikiVectorMetadata
}

export interface WikiVectorCorpus {
  schemaVersion: typeof SEARCH_CORPUS_SCHEMA_VERSION
  version: string
  embedding: {
    model: typeof SEARCH_EMBEDDING_MODEL
    dimensions: typeof SEARCH_EMBEDDING_DIMENSIONS
    metric: typeof SEARCH_DISTANCE_METRIC
  }
  chunking: {
    targetCharacters: typeof SEARCH_TARGET_CHUNK_CHARACTERS
    maximumCharacters: typeof SEARCH_MAXIMUM_CHUNK_CHARACTERS
    overlapCharacters: typeof SEARCH_OVERLAP_CHARACTERS
  }
  sourceCount: number
  vectorCount: number
  localeCounts: Record<typeof SEARCH_NAMESPACE, number>
  chunks: WikiVectorChunk[]
}

interface WikiVectorBlock {
  heading: string
  text: string
}

type PendingChunkBlock = WikiVectorBlock

export const buildWikiVectorCorpus = async (
  inputSources: readonly WikiVectorSource[],
): Promise<WikiVectorCorpus> => {
  const sources = inputSources.map(normalizeSource).toSorted(compareSources)
  assertUniqueSourceUrls(sources)

  const chunks: WikiVectorChunk[] = []

  for (const source of sources) {
    chunks.push(...(await chunkWikiVectorSource(source)))
  }

  if (chunks.length > SEARCH_VECTOR_LIMIT) {
    throw new Error(
      `Wiki vector corpus has ${chunks.length} vectors; the configured limit is ${SEARCH_VECTOR_LIMIT}.`,
    )
  }

  const version = (
    await sha256Hex(
      chunks
        .map(({ id }) => id)
        .toSorted()
        .join('\n'),
    )
  ).slice(0, 20)

  return {
    schemaVersion: SEARCH_CORPUS_SCHEMA_VERSION,
    version,
    embedding: {
      model: SEARCH_EMBEDDING_MODEL,
      dimensions: SEARCH_EMBEDDING_DIMENSIONS,
      metric: SEARCH_DISTANCE_METRIC,
    },
    chunking: {
      targetCharacters: SEARCH_TARGET_CHUNK_CHARACTERS,
      maximumCharacters: SEARCH_MAXIMUM_CHUNK_CHARACTERS,
      overlapCharacters: SEARCH_OVERLAP_CHARACTERS,
    },
    sourceCount: sources.length,
    vectorCount: chunks.length,
    localeCounts: {
      [SEARCH_NAMESPACE]: chunks.length,
    },
    chunks,
  }
}

export const chunkWikiVectorSource = async (
  inputSource: WikiVectorSource,
): Promise<WikiVectorChunk[]> => {
  const source = normalizeSource(inputSource)
  const blocks = collectMarkdownBlocks(source)
  const groups: PendingChunkBlock[][] = []
  let current: PendingChunkBlock[] = []
  let currentLength = 0

  for (const block of blocks) {
    const blockLimit = Math.max(
      200,
      SEARCH_MAXIMUM_CHUNK_CHARACTERS -
        source.title.length -
        block.heading.length -
        2,
    )

    for (const part of splitLongText(block.text, blockLimit)) {
      const next = { heading: block.heading, text: part }
      let separatorLength = current.length > 0 ? 1 : 0
      const wouldExceed =
        current.length > 0 &&
        (currentLength + separatorLength + part.length >
          SEARCH_TARGET_CHUNK_CHARACTERS ||
          composeChunkText(source, [...current, next]).length >
            SEARCH_MAXIMUM_CHUNK_CHARACTERS)

      if (wouldExceed) {
        groups.push(current)
        current = buildOverlap(current)

        if (
          composeChunkText(source, [...current, next]).length >
          SEARCH_MAXIMUM_CHUNK_CHARACTERS
        ) {
          current = []
        }

        currentLength = current.reduce(
          (total, item, index) =>
            total + item.text.length + (index > 0 ? 1 : 0),
          0,
        )
        separatorLength = current.length > 0 ? 1 : 0
      }

      current.push(next)
      currentLength += separatorLength + part.length
    }
  }

  if (current.length > 0) groups.push(current)

  return Promise.all(
    groups.map(async (group, index) => {
      const section = getChunkSection(source, group)
      const body = group.map(({ text }) => text).join('\n')
      const text = composeChunkText(source, group)

      if (text.length > SEARCH_MAXIMUM_CHUNK_CHARACTERS) {
        throw new Error(
          `Wiki search chunk exceeds ${SEARCH_MAXIMUM_CHUNK_CHARACTERS} characters: ${source.url}`,
        )
      }

      const metadata: WikiVectorMetadata = {
        url: source.url,
        title: source.title,
        section,
        excerpt: createExcerpt(body || source.description),
        category: source.category,
        locale: SEARCH_NAMESPACE,
      }
      const digestInput = [
        `v${SEARCH_CORPUS_SCHEMA_VERSION}`,
        SEARCH_NAMESPACE,
        source.url,
        source.title,
        source.category,
        section,
        String(index),
        text,
      ].join('\n')
      const digest = await sha256Hex(digestInput)

      return {
        id: `v${SEARCH_CORPUS_SCHEMA_VERSION}-${digest.slice(0, 48)}`,
        namespace: SEARCH_NAMESPACE,
        text,
        metadata,
      }
    }),
  )
}

const collectMarkdownBlocks = (source: WikiVectorSource): WikiVectorBlock[] => {
  const blocks: WikiVectorBlock[] = []
  let heading = source.title
  let paragraph: string[] = []
  let fence: { character: '`' | '~'; length: number } | null = null

  const flushParagraph = () => {
    const text = normalizeText(markdownToSearchText(paragraph.join('\n')))
    paragraph = []

    if (text) blocks.push({ heading, text })
  }

  for (const line of source.body.replace(/\r\n?/gu, '\n').split('\n')) {
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/u.exec(line)

    if (fence) {
      paragraph.push(line)

      if (
        fenceMatch &&
        fenceMatch[1][0] === fence.character &&
        fenceMatch[1].length >= fence.length
      ) {
        fence = null
      }
      continue
    }

    if (fenceMatch) {
      fence = {
        character: fenceMatch[1][0] as '`' | '~',
        length: fenceMatch[1].length,
      }
      paragraph.push(line)
      continue
    }

    const headingMatch = /^ {0,3}#{2,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/u.exec(line)
    if (headingMatch) {
      flushParagraph()
      heading =
        truncateText(
          normalizeText(markdownToSearchText(headingMatch[1])),
          SECTION_MAXIMUM_CHARACTERS,
        ) || source.title
      blocks.push({ heading, text: heading })
      continue
    }

    if (!line.trim()) {
      flushParagraph()
      continue
    }

    paragraph.push(line)
  }

  flushParagraph()

  if (blocks.length === 0) {
    blocks.push({
      heading: source.title,
      text: source.description || source.title,
    })
  }

  return blocks
}

const normalizeSource = (source: WikiVectorSource): WikiVectorSource => {
  const url = normalizeSourceUrl(source.url)
  const title = normalizeRequiredText(source.title, 'title', url)
  const category = normalizeRequiredText(source.category, 'category', url)

  return {
    url,
    title,
    description: normalizeText(source.description),
    category,
    body: String(source.body ?? '').normalize('NFC'),
  }
}

const normalizeSourceUrl = (value: string): string => {
  const url = String(value ?? '')
    .normalize('NFC')
    .trim()

  if (
    !url.startsWith('/article/') ||
    url.startsWith('//') ||
    !url.endsWith('/')
  ) {
    throw new Error(`Invalid Wiki vector source URL: ${url || '(empty)'}`)
  }

  return url
}

const normalizeRequiredText = (
  value: string,
  field: string,
  url: string,
): string => {
  const normalized = normalizeText(value)

  if (!normalized) {
    throw new Error(`Wiki vector source ${field} is empty: ${url}`)
  }

  return normalized
}

const assertUniqueSourceUrls = (sources: readonly WikiVectorSource[]): void => {
  const urls = new Set<string>()

  for (const source of sources) {
    if (urls.has(source.url)) {
      throw new Error(`Duplicate Wiki vector source URL: ${source.url}`)
    }
    urls.add(source.url)
  }
}

const compareSources = (
  left: WikiVectorSource,
  right: WikiVectorSource,
): number => {
  if (left.url < right.url) return -1
  if (left.url > right.url) return 1
  return 0
}

const composeChunkText = (
  source: WikiVectorSource,
  group: readonly PendingChunkBlock[],
): string => {
  const body: string[] = []
  let previousHeading = source.title

  for (const block of group) {
    if (
      block.heading !== source.title &&
      block.heading !== previousHeading &&
      block.text !== block.heading
    ) {
      body.push(block.heading)
    }

    body.push(block.text)
    previousHeading = block.heading
  }

  return normalizeText([source.title, ...body].join('\n'))
}

const getChunkSection = (
  source: WikiVectorSource,
  group: readonly PendingChunkBlock[],
): string =>
  [...group].reverse().find(({ heading }) => heading)?.heading || source.title

const splitLongText = (text: string, limit: number): string[] => {
  if (text.length <= limit) return [text]

  const sentences = text.split(/(?<=[。！？.!?])\s*/u).filter(Boolean)
  const parts: string[] = []
  let current = ''

  for (const sentence of sentences) {
    if (sentence.length > limit) {
      if (current) {
        parts.push(current)
        current = ''
      }

      for (let index = 0; index < sentence.length; index += limit) {
        parts.push(sentence.slice(index, index + limit))
      }
      continue
    }

    const candidate = current ? `${current} ${sentence}` : sentence
    if (candidate.length > limit) {
      parts.push(current)
      current = sentence
    } else {
      current = candidate
    }
  }

  if (current) parts.push(current)
  return parts
}

const buildOverlap = (
  blocks: readonly PendingChunkBlock[],
): PendingChunkBlock[] => {
  const overlap: PendingChunkBlock[] = []
  let length = 0

  for (const block of [...blocks].reverse()) {
    if (
      overlap.length > 0 &&
      length + block.text.length > SEARCH_OVERLAP_CHARACTERS
    ) {
      break
    }

    overlap.unshift(block)
    length += block.text.length
    if (length >= SEARCH_OVERLAP_CHARACTERS) break
  }

  return overlap
}

const createExcerpt = (text: string): string =>
  truncateText(normalizeText(text), EXCERPT_MAXIMUM_CHARACTERS)

const truncateText = (text: string, maximumCharacters: number): string => {
  if (text.length <= maximumCharacters) return text
  return `${text.slice(0, maximumCharacters - 1).trimEnd()}…`
}

const normalizeText = (value: string): string =>
  String(value ?? '')
    .normalize('NFKC')
    .replace(/\s+/gu, ' ')
    .trim()

const sha256Hex = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  )

  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
}
