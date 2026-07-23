const IMAGE_ALT_BY_SOURCE = {
  'https://cdn.pixabay.com/photo/2020/03/22/15/25/fetch-4957501_1280.jpg':
    'エースサーバーの宣伝イメージ',
}

const matchAttribute = (tag, name) =>
  tag.match(
    new RegExp(
      '\\b' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))',
      'i',
    ),
  )

const attributeValue = (match) =>
  match ? match.slice(1).find((value) => value !== undefined) || '' : ''

const hasText = (value) =>
  value.replace(/&(?:nbsp|#160|#x0*a0);/gi, ' ').trim().length > 0

const escapeAttribute = (value) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

export const inspectImageAlts = (html = '') => {
  const issues = []
  let images = 0

  for (const match of html.matchAll(/<img\b[^>]*>/gi)) {
    images += 1
    const tag = match[0]
    const altAttribute = matchAttribute(tag, 'alt')
    if (!altAttribute) {
      issues.push({
        state: 'missing',
        source: attributeValue(matchAttribute(tag, 'src')),
      })
    } else if (!hasText(attributeValue(altAttribute))) {
      issues.push({
        state: 'empty',
        source: attributeValue(matchAttribute(tag, 'src')),
      })
    }
  }

  return {
    images,
    missing: issues.filter((issue) => issue.state === 'missing').length,
    empty: issues.filter((issue) => issue.state === 'empty').length,
    issues,
  }
}

export const ensureImageAlts = (html = '', context = 'エースサーバー Wiki') => {
  const imageTotal = (html.match(/<img\b[^>]*>/gi) || []).length
  let imageIndex = 0

  return html.replace(/<img\b[^>]*>/gi, (tag) => {
    imageIndex += 1
    const altAttribute = matchAttribute(tag, 'alt')
    if (altAttribute && hasText(attributeValue(altAttribute))) return tag

    const source = attributeValue(matchAttribute(tag, 'src'))
    const fallbackContext =
      String(context || '').trim() || 'エースサーバー Wiki'
    const sequence = imageTotal > 1 ? ' ' + imageIndex : ''
    const alt =
      IMAGE_ALT_BY_SOURCE[source] || fallbackContext + 'の説明画像' + sequence
    const replacement = 'alt="' + escapeAttribute(alt) + '"'

    if (altAttribute) return tag.replace(altAttribute[0], replacement)
    return tag.replace(/<img\b/i, '<img ' + replacement)
  })
}
