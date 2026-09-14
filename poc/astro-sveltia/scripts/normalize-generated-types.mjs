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

// Keep the second Worker's declarations module-scoped; do not merge its
// Secrets Store binding into the Pages environment's global declarations.
const membershipTypesUrl = new URL(
  '../workers/discord-membership/worker-configuration.d.ts',
  import.meta.url,
)
const membershipSource = await readFile(membershipTypesUrl, 'utf8')
const membershipNormalized =
  membershipSource
    .replace(/[ \t]+$/gmu, '')
    .replace(/\nexport type \{ MembershipEnv \}\n?$/u, '')
    .trimEnd() + '\n\nexport type { MembershipEnv }\n'
await writeFile(membershipTypesUrl, membershipNormalized, 'utf8')
