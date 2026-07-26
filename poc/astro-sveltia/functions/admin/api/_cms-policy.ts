export const CMS_REPOSITORY = {
  owner: 'acecore-systems',
  name: 'aceserver-wiki',
  branch: 'main',
} as const

export const CMS_CONTENT_PREFIX = 'poc/astro-sveltia/src/content/wiki/' as const
export const CMS_MEDIA_PREFIX =
  'poc/astro-sveltia/public/uploads/wiki/' as const

export type CmsRuntimeEnv = Omit<
  Env,
  | 'CMS_DISCORD_ALLOWED_ROLE_IDS'
  | 'CMS_DISCORD_AUTHORIZATION_MODE'
  | 'CMS_PUBLICATION_MODE'
> & {
  CMS_DISCORD_ALLOWED_ROLE_IDS: string
  CMS_DISCORD_AUTHORIZATION_MODE: string
  CMS_PUBLICATION_MODE: string
}

const MAX_CMS_PATH_LENGTH = 240
const MARKDOWN_EXTENSION = '.md'
const MEDIA_EXTENSIONS = new Set([
  '.avif',
  '.gif',
  '.jpeg',
  '.jpg',
  '.png',
  '.webp',
])
const CMS_DIRECTORY_ROOTS = [
  CMS_CONTENT_PREFIX.slice(0, -1),
  CMS_MEDIA_PREFIX.slice(0, -1),
]

export function normalizeCmsPath(path: string | null) {
  if (
    path === null ||
    path !== path.normalize('NFC') ||
    path.includes('\0') ||
    containsForbiddenPathCharacter(path)
  ) {
    return null
  }

  const normalized = path.replace(/\\/gu, '/').replace(/^\/+/u, '')

  if (normalized === '') return ''
  if (normalized.length > MAX_CMS_PATH_LENGTH) return null

  const segments = normalized.split('/')

  if (
    segments.some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    return null
  }

  return segments.join('/')
}

export function hasExpectedCmsRepositoryConfig(env: CmsRuntimeEnv) {
  return (
    env.CMS_REPOSITORY_OWNER === CMS_REPOSITORY.owner &&
    env.CMS_REPOSITORY_NAME === CMS_REPOSITORY.name &&
    env.CMS_REPOSITORY_BRANCH === CMS_REPOSITORY.branch &&
    env.CMS_CONTENT_ROOT === CMS_CONTENT_PREFIX.slice(0, -1) &&
    env.CMS_MEDIA_ROOT === CMS_MEDIA_PREFIX.slice(0, -1)
  )
}

export function isAllowedCmsWritePath(path: string) {
  if (
    path.startsWith(CMS_CONTENT_PREFIX) &&
    path.endsWith(MARKDOWN_EXTENSION)
  ) {
    return isSafeMarkdownFileName(path)
  }

  if (!path.startsWith(CMS_MEDIA_PREFIX)) return false

  return MEDIA_EXTENSIONS.has(getExtension(path)) && isSafeMediaFileName(path)
}

export function isAllowedCmsDirectoryPath(path: string) {
  if (path === '') return true

  return CMS_DIRECTORY_ROOTS.some((root) => {
    return path === root || root.startsWith(`${path}/`)
  })
}

export function isCmsMarkdownPath(path: string) {
  return (
    path.startsWith(CMS_CONTENT_PREFIX) &&
    path.endsWith(MARKDOWN_EXTENSION) &&
    isSafeMarkdownFileName(path)
  )
}

export function isCmsMediaPath(path: string) {
  return (
    path.startsWith(CMS_MEDIA_PREFIX) &&
    MEDIA_EXTENSIONS.has(getExtension(path)) &&
    isSafeMediaFileName(path)
  )
}

export function getCmsPathExtension(path: string) {
  return getExtension(path)
}

export function sanitizeCmsBranchPart(path: string) {
  const base = path
    .replace(/\.[^.]+$/u, '')
    .replace(/[^A-Za-z0-9_-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 48)

  return base || 'content'
}

export function encodePathSegments(path: string) {
  return path.split('/').map(encodeURIComponent).join('/')
}

function isSafeMarkdownFileName(path: string) {
  const relativePath = path.slice(CMS_CONTENT_PREFIX.length)

  if (!relativePath || relativePath.includes('/')) return false

  const slug = relativePath.slice(0, -MARKDOWN_EXTENSION.length)

  return slug.length <= 100 && /^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u.test(slug)
}

function isSafeMediaFileName(path: string) {
  const relativePath = path.slice(CMS_MEDIA_PREFIX.length)

  if (!relativePath || relativePath.includes('/')) return false

  const extension = getExtension(relativePath)
  const stem = relativePath.slice(0, -extension.length)

  return stem.length <= 100 && /^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u.test(stem)
}

function getExtension(path: string) {
  const fileName = path.split('/').pop() || ''
  const dot = fileName.lastIndexOf('.')

  return dot === -1 ? '' : fileName.slice(dot).toLowerCase()
}

function containsForbiddenPathCharacter(value: string) {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0

    return codePoint <= 0x1f || codePoint === 0x7f || character === '`'
  })
}
