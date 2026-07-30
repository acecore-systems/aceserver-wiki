import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const commit =
  process.env.CF_PAGES_COMMIT_SHA ||
  process.env.GITHUB_SHA ||
  process.env.COMMIT_SHA ||
  'local'
const corpus = JSON.parse(
  await readFile(resolve('dist/vector-corpus.json'), 'utf8'),
)

if (!/^[0-9a-f]{20}$/u.test(corpus?.version || '')) {
  throw new Error('Vector corpus must contain a 20-character version.')
}

const outputDirectory = resolve('dist/.well-known')
await mkdir(outputDirectory, { recursive: true })
await writeFile(
  resolve(outputDirectory, 'aceserver-wiki-build.json'),
  `${JSON.stringify({
    commit,
    searchCorpusVersion: corpus.version,
  })}\n`,
  'utf8',
)
