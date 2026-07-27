const REQUIRED_EXTERNAL_LINK_REL = [
  'ugc',
  'nofollow',
  'noopener',
  'noreferrer',
] as const

type HtmlNode = {
  type?: unknown
  tagName?: unknown
  properties?: Record<string, unknown>
  children?: unknown
}

type ExternalLinkPluginOptions = {
  site: string | URL
}

export function rehypeUgcExternalLinks({ site }: ExternalLinkPluginOptions) {
  const siteUrl = new URL(site)

  return (tree: HtmlNode): void => {
    visitHtmlNodes(tree, (node) => {
      if (
        node.type !== 'element' ||
        node.tagName !== 'a' ||
        !isExternalHttpUrl(node.properties?.href, siteUrl)
      ) {
        return
      }

      const rel = new Set([
        ...readRelTokens(node.properties?.rel),
        ...REQUIRED_EXTERNAL_LINK_REL,
      ])

      node.properties = {
        ...node.properties,
        rel: [...rel],
      }
    })
  }
}

export function isExternalHttpUrl(value: unknown, site: string | URL): boolean {
  if (typeof value !== 'string') return false

  try {
    const siteUrl = new URL(site)
    const url = new URL(value, siteUrl)

    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.origin !== siteUrl.origin
    )
  } catch {
    return false
  }
}

function visitHtmlNodes(
  node: HtmlNode,
  visitor: (node: HtmlNode) => void,
): void {
  visitor(node)

  if (!Array.isArray(node.children)) return

  for (const child of node.children) {
    if (child && typeof child === 'object') {
      visitHtmlNodes(child as HtmlNode, visitor)
    }
  }
}

function readRelTokens(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value]

  return values.flatMap((token) =>
    typeof token === 'string' ? token.split(/\s+/u).filter(Boolean) : [],
  )
}
