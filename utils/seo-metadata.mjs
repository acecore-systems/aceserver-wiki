export const SEO_LIMITS = Object.freeze({
  titleMin: 15,
  titleMax: 70,
  descriptionMin: 70,
  descriptionMax: 160,
})

const META_SITE_NAME = 'エースサーバー公式Wiki'

export const ROOT_META_TITLE =
  'エースサーバー公式Wiki｜ルール・参加方法・コマンド案内'

export const ROOT_DESCRIPTION =
  'エースサーバーの公式Wikiです。Minecraftサーバーへの参加方法、基本ルール、Discord連携、コマンドやプラグイン、Hubと各ワールドの遊び方、運営方針、コミュニティ情報をまとめています。初めて参加する方も、プレイ中に仕様や注意点を確認したい方も、必要な記事をカテゴリから探せます。'

export const CURATED_ARTICLE_DESCRIPTIONS = Object.freeze({
  その他サーバーについて:
    'その他サーバーについて、シーズンサーバーの構成と遊び方を案内します。常時設置される2台のサーバーそれぞれの仕様や、参加前に確認したい違いをまとめています。',
  hub紹介:
    'Hubワールドの初期スポーン地点と、中心街「エースタウン」を紹介します。主要施設や人が集まる場所を把握し、サーバー参加後の移動や探索に役立てられます。',
  ディスコードのルール:
    'エースサーバー公式Discordで守る基本ルールをまとめています。招待URLを投稿できる部屋や、コミュニティリーダーに認められる例外を確認できます。',
  ルール:
    'エースサーバー内で全員が楽しく遊ぶための基本ルールを案内します。禁止事項や守るべきマナーを参加前に確認し、安心できるコミュニティづくりにご協力ください。',
  ディスコードのロールについて:
    'エースサーバー公式Discordで使われる運営、サポーター、イベントサポーターなどのロールを紹介します。各役職の役割や活動範囲、参加者との関わり方を確認できます。',
  ディスコード連携のやり方:
    'エースサーバーで遊ぶために必要な、DiscordアカウントとMinecraftアカウントの連携手順を案内します。認証の流れを順番に確認し、参加前の設定を完了できます。',
  サーバー理念:
    'エースサーバーが大切にする「みんなの居場所であること」という理念を説明します。参加者だけでなく、これから参加する人、運営やサポーターも含めた考え方です。',
  コマンドについて:
    'エースサーバーで利用できるコマンドと使い方をまとめています。通常のMinecraftにあるコマンドと、導入プラグイン固有のコマンドを目的別に確認できます。',
  参加方法:
    'エースサーバーへの参加方法を順番に案内します。公式Discordへの参加、Minecraftアカウントとの連携など、初めて遊ぶ前に必要な準備を確認できます。',
  'エース鯖(メイン鯖)のプラグイン一覧':
    'エースサーバーのメインサーバーに導入しているプラグインを一覧で紹介します。CoreProtectやGSitなど、各プラグインの役割と利用できる機能を確認できます。',
  遊び方:
    'エースサーバーでの基本的な遊び方を案内します。参加後にできることや、権限によって利用条件が異なる機能を確認し、自分に合った楽しみ方を見つけられます。',
  運営陣について:
    'エースサーバーの運営陣について、参加者に理解してほしい考え方と注意点をまとめています。無料で提供するサービスを支える運営・サポーターへの配慮を確認できます。',
  くわ王国:
    'くわ王国は、中心地から離れた場所に巨大な王国を築くコミュニティです。住みやすさと街並み・城の景観を両立させる具体的な活動内容や目標を紹介します。',
  あすたん王国:
    'あすたん王国は、あすたんが王女として治めるエースサーバー内のコミュニティです。設置された各種装置を活用し、資材を供給する王国の特徴を紹介します。',
  プロモーション:
    'エースサーバーのプロモーション方針と活動内容を紹介します。参加者により楽しんでもらうため、複数のサービスで情報を発信し、コミュニティを盛り上げる取り組みをまとめています。',
})

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
  return /[。！？!?.](?:[）」』】])?$/.test(text) ? text : `${text}。`
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
  if (
    !duplicate &&
    parts.join('').length + next.length <= SEO_LIMITS.descriptionMax
  ) {
    parts.push(next)
  }
}

const semanticSentences = (value) =>
  (
    normalizeSeoText(value).match(/[^。！？!?]+[。！？!?]+|[^。！？!?]+$/g) ??
    []
  )
    .map(sentence)
    .filter(Boolean)

const appendSentences = (parts, value) => {
  for (const candidate of semanticSentences(value)) {
    appendDistinct(parts, candidate)
    if (parts.join('').length >= SEO_LIMITS.descriptionMin) break
  }
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
  const curated = CURATED_ARTICLE_DESCRIPTIONS[articleTitle]
  if (curated) return curated
  const parts = []
  appendSentences(parts, description)

  if (parts.join('').length < SEO_LIMITS.descriptionMin) {
    appendSentences(parts, body)
  }

  const fallbacks = [
    `「${articleTitle}」について、エースサーバーの参加者が確認したい手順、ルール、利用条件や注意点を分かりやすく案内します。`,
    'Minecraftを初めて遊ぶ方も、プレイ中に仕様を確認したい方も、本文を参加前・利用前のチェックに活用してください。',
    '関連する記事もあわせて確認できます。',
  ]
  for (const fallback of fallbacks) {
    if (parts.join('').length >= SEO_LIMITS.descriptionMin) break
    appendSentences(parts, fallback)
  }

  return parts.join('')
}

export const unnaturalDescriptionReasons = (description) => {
  const reasons = []
  if (!/[。！？!?.](?:[）」』】])?$/.test(description)) {
    reasons.push('incomplete ending')
  }
  if (
    /…$|スポンサーリンク|関連記事|前の記事|次の記事|この記事では|<[^>]+>|。。|。\.|└/.test(
      description
    )
  ) {
    reasons.push('UI noise or awkward punctuation')
  }
  if (
    /(?:として|ための|についての|による|からの|への|とは|では|には|の|を|が|に|へ|で|と|や|から|より|は)[。！？!?.](?:[）」』】])?$/.test(
      description
    )
  ) {
    reasons.push('trailing fragment')
  }
  if ((description.match(/[。！？!?](?:[）」』】])?/g) ?? []).length > 5) {
    reasons.push('too many short sentences')
  }
  return reasons
}
