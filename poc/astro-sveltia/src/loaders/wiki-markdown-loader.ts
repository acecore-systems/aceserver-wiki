import { readdir, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Loader } from 'astro/loaders'
import { assertMarkdownSource } from '../lib/markdown-policy'

const require = createRequire(import.meta.url)
const { parse: parseYaml } = require('yaml') as typeof import('yaml')

const contentDirectoryUrl = new URL('../content/wiki/', import.meta.url)
const contentDirectoryPath = fileURLToPath(contentDirectoryUrl)
const markdownFilePattern = /^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*\.md$/u
const frontmatterPattern = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/u
const yamlReferencePattern = /(?:^|\s)[&*][A-Za-z0-9_-]+|^\s*<<\s*:/mu
const maxMarkdownBytes = 512 * 1024
const maxSlugLength = 100

interface ParsedMarkdown {
  data: Record<string, unknown>
  body: string
}

const parseMarkdownFile = (
  source: string,
  fileName: string,
): ParsedMarkdown => {
  if (Buffer.byteLength(source, 'utf8') > maxMarkdownBytes) {
    throw new Error(`Markdown file exceeds 512 KiB: ${fileName}`)
  }

  const match = frontmatterPattern.exec(source)

  if (!match) {
    throw new Error(`Markdown file requires YAML frontmatter: ${fileName}`)
  }

  if (yamlReferencePattern.test(match[1])) {
    throw new Error(
      `YAML anchors, aliases, and merge keys are not allowed: ${fileName}`,
    )
  }

  const parsed = parseYaml(match[1], {
    schema: 'core',
    strict: true,
    uniqueKeys: true,
  }) as unknown

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Markdown frontmatter must be an object: ${fileName}`)
  }

  return {
    data: parsed as Record<string, unknown>,
    body: match[2],
  }
}

export const wikiMarkdownLoader = (): Loader => ({
  name: 'wiki-markdown-loader',
  async load({ config, generateDigest, parseData, renderMarkdown, store }) {
    const directoryEntries = await readdir(contentDirectoryPath, {
      withFileTypes: true,
    })

    store.clear()

    for (const directoryEntry of directoryEntries) {
      const fileName = directoryEntry.name
      const slug = fileName.slice(0, -'.md'.length)

      if (
        !directoryEntry.isFile() ||
        fileName !== fileName.normalize('NFC') ||
        !markdownFilePattern.test(fileName) ||
        slug.length > maxSlugLength
      ) {
        throw new Error(
          `Only flat NFC letter/number kebab-case .md files are allowed: ${fileName}`,
        )
      }

      const id = slug
      const fileUrl = new URL(fileName, contentDirectoryUrl)
      const absoluteFilePath = fileURLToPath(fileUrl)
      const relativeFilePath = relative(
        fileURLToPath(config.root),
        absoluteFilePath,
      ).replaceAll('\\', '/')
      const bytes = await readFile(fileUrl)

      if (bytes.byteLength > maxMarkdownBytes) {
        throw new Error(`Markdown file exceeds 512 KiB: ${fileName}`)
      }

      const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes)

      if (source.charCodeAt(0) === 0xfeff || source.includes('\0')) {
        throw new Error(
          `Markdown must be BOM-free UTF-8 without NUL bytes: ${fileName}`,
        )
      }

      const { data: rawData, body } = parseMarkdownFile(source, fileName)

      assertMarkdownSource(body, id)

      const data = await parseData({
        id,
        data: rawData,
        filePath: absoluteFilePath,
      })

      store.set({
        id,
        data,
        body,
        digest: generateDigest(source),
        filePath: relativeFilePath,
        rendered: await renderMarkdown(body, {
          fileURL: fileUrl,
        }),
      })
    }
  },
})
