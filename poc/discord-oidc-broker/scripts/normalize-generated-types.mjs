import { readFile, writeFile } from 'node:fs/promises'

const generatedTypesUrl = new URL(
  '../worker-configuration.d.ts',
  import.meta.url,
)
const source = await readFile(generatedTypesUrl, 'utf8')
const normalized = source.replace(/[ \t]+$/gmu, '')

if (normalized !== source) {
  await writeFile(generatedTypesUrl, normalized, 'utf8')
}
