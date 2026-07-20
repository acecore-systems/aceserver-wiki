export const SEO_LIMITS = Object.freeze({
  titleMin: 15,
  titleMax: 70,
  descriptionMin: 150,
  descriptionMax: 160,
})

const META_SITE_NAME = 'エースサーバー公式Wiki'

export const ROOT_META_TITLE =
  'エースサーバー公式Wiki｜ルール・参加方法・コマンド案内'

export const ROOT_DESCRIPTION =
  'エースサーバーの公式Wikiです。Minecraftサーバーへの参加方法、ルール・BAN条件、Discord連携、利用できるコマンドやプラグイン、Hubや各ワールドの遊び方、運営方針、コミュニティ情報をまとめています。初めて参加する方はもちろん、プレイ中に仕様や注意点を確認したい方も、必要な記事をカテゴリから探せます。'

const decodeEntities = (value) =>
  value
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code) =>
      String.fromCodePoint(Number.parseInt(code, 16))
    )
    .replace(
      /&(nbsp|amp|quot|apos|lt|gt);/gi,
      (_, entity) =>
        ({
          nbsp: ' ',
          amp: '&',
          quot: '"',
          apos: "'",
          lt: '<',
          gt: '>',
        }[entity.toLowerCase()])
    )

export const normalizeSeoText = (value = '') =>
  decodeEntities(
    value
      .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
      .replace(/<img\b[^>]*>/gi, ' ')
      .replace(/<br\s*\/?\s*>/gi, '。')
      .replace(/<\/(?:p|div|h[1-6]|li|tr|td|th|blockquote)>/gi, '。')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/[\u00a0\s]+/g, ' ')
    .replace(
      /([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])\s+(?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])/gu,
      '$1'
    )
    .replace(/\s+([、。！？!?])/g, '$1')
    .replace(/。{2,}/g, '。')
    .trim()

const sentence = (value) => {
  const text = normalizeSeoText(value).replace(/^[|｜:：・\s]+/, '')
  if (!text) return ''
  return /[。！？!?.]$/.test(text) ? text : `${text}。`
}

const appendDistinct = (parts, value) => {
  const next = sentence(value)
  if (!next) return
  const comparable = next
    .toLocaleLowerCase('ja-JP')
    .replace(/[\s、。！？!?.]/g, '')
  if (!comparable) return
  const duplicate = parts.some((part) => {
    const current = part
      .toLocaleLowerCase('ja-JP')
      .replace(/[\s、。！？!?.]/g, '')
    return current.includes(comparable) || comparable.includes(current)
  })
  if (!duplicate) parts.push(next)
}

const fitDescription = (value) => {
  if (value.length <= SEO_LIMITS.descriptionMax) return value
  const window = value.slice(0, SEO_LIMITS.descriptionMax)
  for (
    let index = window.length - 1;
    index >= SEO_LIMITS.descriptionMin - 1;
    index -= 1
  ) {
    if (/[。！？!?]/.test(window[index])) return window.slice(0, index + 1)
  }
  return `${value.slice(0, SEO_LIMITS.descriptionMax - 1).trimEnd()}…`
}

export const buildArticleMetaTitle = (title) => {
  const articleTitle = normalizeSeoText(title) || '記事ガイド'
  const suffix = `｜${META_SITE_NAME}`
  const candidate = `${articleTitle}${suffix}`
  if (candidate.length <= SEO_LIMITS.titleMax) return candidate
  const available = SEO_LIMITS.titleMax - suffix.length - 1
  return `${articleTitle.slice(0, available).trimEnd()}…${suffix}`
}

export const buildArticleMetaDescription = ({
  title,
  description = '',
  body = '',
}) => {
  const articleTitle = normalizeSeoText(title) || 'この記事'
  const parts = []
  appendDistinct(parts, description)

  const bodyText = normalizeSeoText(body)
  for (const segment of bodyText.split(/(?<=[。！？!?])\s*/u)) {
    appendDistinct(parts, segment)
    if (parts.join('').length >= SEO_LIMITS.descriptionMin) break
  }

  const fallbacks = [
    `この記事では「${articleTitle}」について、エースサーバーの参加者が確認したい手順、ルール、利用条件や注意点を分かりやすく案内します。`,
    'Minecraftを初めて遊ぶ方も、プレイ中に仕様を確認したい方も、本文を参加前・利用前のチェックに活用してください。',
    '関連する記事もあわせて確認できます。',
  ]
  for (const fallback of fallbacks) {
    if (parts.join('').length >= SEO_LIMITS.descriptionMin) break
    appendDistinct(parts, fallback)
  }

  return fitDescription(parts.join(''))
}
