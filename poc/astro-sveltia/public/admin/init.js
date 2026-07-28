const root = document.getElementById('nc-root') || document.body

class CmsStartupError extends Error {
  constructor(kind, message, detail = '') {
    super(message)
    this.name = 'CmsStartupError'
    this.kind = kind
    this.detail = detail
  }
}

showStatus({
  title: '編集画面を準備しています',
  message: 'Cloudflare Access とコンテンツゲートウェイを確認しています。',
})

async function initCms() {
  try {
    if (!window.CMS?.init) {
      throw new CmsStartupError(
        'loading',
        'Sveltia CMS を読み込めませんでした。',
        'ネットワーク接続を確認してから、再読み込みしてください。',
      )
    }

    await getGatewayJson('/admin/api/session', 'session')
    await getGatewayJson('/admin/api/github/user', 'github')

    window.location.hash = `#/signin/${btoa(
      JSON.stringify({ token: 'cloudflare-access' }),
    )}`
    window.CMS.init()
    showPublicationNotice()
  } catch (error) {
    const status = describeError(error)

    showStatus({
      ...status,
      isError: true,
      retry: true,
    })
  }
}

function showPublicationNotice() {
  if (document.querySelector('.cms-publish-notice')) return

  const notice = document.createElement('aside')
  const title = document.createElement('strong')
  const message = document.createElement('span')
  const close = document.createElement('button')

  notice.className = 'cms-publish-notice'
  notice.setAttribute('aria-label', 'Wikiの公開方法')
  title.textContent = '保存すると自動で公開されます'
  message.textContent =
    '通常は数分でサイトに反映されます。記事・画像の削除は参照確認を伴うPull Requestで行います。'
  close.className = 'cms-publish-notice__close'
  close.type = 'button'
  close.setAttribute('aria-label', '公開方法の案内を閉じる')
  close.textContent = '×'
  close.addEventListener('click', () => notice.remove())
  notice.append(title, message, close)
  document.body.append(notice)
}

async function getGatewayJson(path, stage) {
  let response

  try {
    response = await fetch(path, {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
      },
    })
  } catch {
    if (stage === 'session') {
      throw new CmsStartupError(
        'access',
        'Cloudflare Access の認証を確認できませんでした。',
        'ログインを完了してから、このページを再読み込みしてください。',
      )
    }

    throw new CmsStartupError(
      'network',
      'コンテンツゲートウェイに接続できませんでした。',
      '通信状態を確認してから、再読み込みしてください。',
    )
  }

  const contentType = response.headers.get('content-type') || ''
  const isJson = contentType.toLowerCase().includes('application/json')
  const data = isJson ? await response.json().catch(() => ({})) : {}
  const gatewayMessage = getGatewayMessage(data)

  if (response.redirected || (!isJson && response.ok)) {
    throw new CmsStartupError(
      'access',
      'Cloudflare Access のログインが必要です。',
      'ログインを完了してから、このページを再読み込みしてください。',
    )
  }

  if (response.ok) return data

  if (response.status === 401) {
    throw new CmsStartupError(
      'access',
      'Cloudflare Access のログインを確認できませんでした。',
      gatewayMessage ||
        'ログインを完了してから、このページを再読み込みしてください。',
    )
  }

  if (response.status === 403) {
    if (stage === 'github') {
      throw new CmsStartupError(
        'configuration',
        'GitHub App が Wiki リポジトリへアクセスできません。',
        gatewayMessage ||
          'GitHub App のインストール先とリポジトリ権限を管理者が確認してください。',
      )
    }

    throw new CmsStartupError(
      'permission',
      'このアカウントには Wiki の編集権限がありません。',
      gatewayMessage ||
        '対象の Discord サーバーと編集者ロールを確認してください。',
    )
  }

  if (
    response.status === 404 ||
    response.status === 500 ||
    response.status === 503
  ) {
    throw new CmsStartupError(
      'configuration',
      '編集ゲートウェイの設定が完了していません。',
      gatewayMessage ||
        (stage === 'github'
          ? 'GitHub App のインストール先と権限を管理者が確認してください。'
          : 'Cloudflare Access と Discord 認証の設定を管理者が確認してください。'),
    )
  }

  throw new CmsStartupError(
    'gateway',
    '編集ゲートウェイの確認に失敗しました。',
    gatewayMessage ||
      `しばらく待ってから再試行してください（HTTP ${response.status}）。`,
  )
}

function getGatewayMessage(data) {
  if (!data || typeof data !== 'object') return ''

  const value =
    typeof data.message === 'string'
      ? data.message
      : typeof data.error === 'string'
        ? data.error
        : ''

  return value.trim().slice(0, 300)
}

function describeError(error) {
  if (error instanceof CmsStartupError) {
    return {
      title: error.message,
      message: error.detail,
      kind: error.kind,
    }
  }

  return {
    title: '編集画面を開始できませんでした。',
    message:
      'ページを再読み込みしても直らない場合は、管理者に連絡してください。',
    kind: 'unknown',
  }
}

function showStatus({
  title,
  message,
  kind = 'loading',
  isError = false,
  retry = false,
}) {
  root.innerHTML = `
    <section class="cms-status${isError ? ' cms-status--error' : ''}">
      <div class="cms-status__card" data-status="${escapeHtml(kind)}">
        <p class="cms-status__eyebrow">ASV Wiki editor</p>
        <h1>${escapeHtml(title)}</h1>
        ${message ? `<p class="cms-status__message">${escapeHtml(message)}</p>` : ''}
        ${
          retry
            ? '<button class="cms-status__retry" type="button">再読み込み</button>'
            : '<span class="cms-status__progress" aria-hidden="true"></span>'
        }
      </div>
    </section>
  `

  root
    .querySelector('.cms-status__retry')
    ?.addEventListener('click', () => window.location.reload())
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => {
    return {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[char]
  })
}

initCms()
