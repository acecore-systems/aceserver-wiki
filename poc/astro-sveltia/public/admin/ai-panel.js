;(function initCmsAiPanel() {
  const apiRoot = '/admin/api/ai'
  const conversationsEndpoint = apiRoot + '/conversations'
  const sessionEndpoint = apiRoot + '/session'
  const savedConversationKey =
    'cms-ai-conversation-id:' + window.location.hostname
  const launcher = document.createElement('button')
  launcher.className = 'cms-ai-launcher'
  launcher.type = 'button'
  launcher.setAttribute('aria-controls', 'cms-ai-panel')
  launcher.setAttribute('aria-expanded', 'false')
  launcher.innerHTML = '<span aria-hidden="true">✦</span><span>AIと相談</span>'

  const panel = document.createElement('aside')
  panel.className = 'cms-ai-panel'
  panel.hidden = true
  panel.id = 'cms-ai-panel'
  panel.setAttribute('aria-label', 'CMS AIとの会話')
  panel.innerHTML = [
    '<header class="cms-ai-panel__header">',
    '  <div><div class="cms-ai-panel__title-row"><h2>CMS AI</h2><span class="cms-ai-role" hidden></span></div>',
    '  <p class="cms-ai-panel__description">質問とサイト修正を、同じ会話で続けられます。</p></div>',
    '  <button class="cms-ai-panel__close" type="button" aria-label="CMS AIパネルを閉じる">×</button>',
    '</header>',
    '<div class="cms-ai-auth" hidden><p class="cms-ai-auth__message">CMS AIを使うにはログインが必要です。</p><a class="cms-ai-auth__link" href="#">CMS AIにログイン</a></div>',
    '<div class="cms-ai-panel__body" hidden>',
    '  <div class="cms-ai-conversation-bar">',
    '    <label>会話履歴<select class="cms-ai-conversation-select"><option value="">新しい会話</option></select></label>',
    '    <button class="cms-ai-new-conversation" type="button">＋ 新規</button>',
    '  </div>',
    '  <ol class="cms-ai-messages" aria-live="polite"></ol>',
    '  <form class="cms-ai-form">',
    '    <label>メッセージ<textarea name="instruction" required maxlength="4000" placeholder="例: トップページの文章について相談したい"></textarea></label>',
    '    <div class="cms-ai-form__actions"><label>考える深さ<select name="reasoningEffort" required><option value="low">低</option><option value="medium" selected>標準</option><option value="high">高</option></select></label><button class="cms-ai-form__submit" type="submit">送信</button></div>',
    '    <p class="cms-ai-capability"></p>',
    '    <p class="cms-ai-form__hint">高いほど丁寧に考えますが、完了時間と利用量が増える場合があります。</p>',
    '    <p class="cms-ai-form__status" role="status"></p>',
    '  </form>',
    '</div>',
  ].join('')

  document.body.append(launcher, panel)

  const body = panel.querySelector('.cms-ai-panel__body')
  const auth = panel.querySelector('.cms-ai-auth')
  const authMessage = panel.querySelector('.cms-ai-auth__message')
  const authLink = panel.querySelector('.cms-ai-auth__link')
  const roleBadge = panel.querySelector('.cms-ai-role')
  const capability = panel.querySelector('.cms-ai-capability')
  const form = panel.querySelector('.cms-ai-form')
  const close = panel.querySelector('.cms-ai-panel__close')
  const submit = panel.querySelector('.cms-ai-form__submit')
  const instruction = form.elements.instruction
  const effort = form.elements.reasoningEffort
  const messages = panel.querySelector('.cms-ai-messages')
  const conversationSelect = panel.querySelector('.cms-ai-conversation-select')
  const newConversation = panel.querySelector('.cms-ai-new-conversation')
  const formStatus = panel.querySelector('.cms-ai-form__status')
  let conversation = null
  let conversationSummaries = []
  let session = null
  let initialized = false
  let timer = 0

  launcher.addEventListener('click', () => {
    panel.hidden = false
    launcher.setAttribute('aria-expanded', 'true')
    if (!initialized) {
      initialized = true
      initialize().catch(showAuthentication)
    } else if (session) {
      focusComposer()
    }
  })

  close.addEventListener('click', () => {
    panel.hidden = true
    launcher.setAttribute('aria-expanded', 'false')
  })
  newConversation.addEventListener('click', startNewConversation)
  conversationSelect.addEventListener('change', () => {
    const id = conversationSelect.value
    if (!id) return startNewConversation()
    clearTimer()
    loadConversation(id, { showLoading: true }).catch((error) => {
      renderStatus(readError(error, '会話を読み込めませんでした。'), true)
    })
  })

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    if (!session || (conversation && isPending(conversation.status))) return
    clearTimer()
    submit.disabled = true
    renderStatus(
      conversation ? 'メッセージを送信しています。' : '会話を開始しています。',
      false,
    )

    try {
      const endpoint = conversation
        ? `${conversationsEndpoint}/${encodeURIComponent(conversation.id)}/messages`
        : apiRoot + '/jobs'
      const payload = await requestJson(endpoint, {
        body: new FormData(form),
        method: 'POST',
      })
      instruction.value = ''
      if (payload.conversation) setConversation(payload.conversation)
      else if (payload.job?.conversationId)
        await loadConversation(payload.job.conversationId)
      else throw new Error('開始した会話を確認できません。')
      await loadConversationList()
      pollConversation(conversation.id)
    } catch (error) {
      renderStatus(readError(error, 'メッセージを送信できません。'), true)
    } finally {
      renderComposer({ preserveStatus: true })
    }
  })

  async function initialize() {
    session = await requestJson(sessionEndpoint)
    showConversationUi()
    await loadConversationList()
    const saved = readSavedConversation()
    const initial = conversationSummaries.some((item) => item.id === saved)
      ? saved
      : conversationSummaries[0]?.id || ''
    if (initial) await loadConversation(initial)
    else startNewConversation()
  }

  function showConversationUi() {
    auth.hidden = true
    body.hidden = false
    roleBadge.hidden = false
    roleBadge.textContent = session?.role || 'chat'
    capability.textContent = session?.capabilities?.edit
      ? 'サイト変更を依頼すると、確認用Pull Requestを作成します。自動マージはしません。'
      : 'この権限は相談専用です。ファイル変更やPull Request作成は行いません。'
  }

  function showAuthentication(error) {
    session = null
    body.hidden = true
    auth.hidden = false
    authMessage.textContent = readError(
      error,
      'CMS AIを使うにはCloudflare Accessへのログインと利用権限が必要です。',
    )
    const returnPath = window.location.pathname + window.location.search
    authLink.href =
      sessionEndpoint + '?redirect=' + encodeURIComponent(returnPath)
  }

  async function loadConversationList() {
    const payload = await requestJson(conversationsEndpoint)
    conversationSummaries = Array.isArray(payload.conversations)
      ? payload.conversations
      : []
    renderConversationList()
  }

  async function loadConversation(id, options = {}) {
    if (options.showLoading) renderStatus('会話を読み込んでいます。', false)
    try {
      const payload = await requestJson(
        `${conversationsEndpoint}/${encodeURIComponent(id)}`,
      )
      if (!payload.conversation) throw new Error('会話を読み込めません。')
      setConversation(payload.conversation)
      if (isPending(payload.conversation.status)) {
        if (options.schedulePolling !== false) pollConversation(id)
      } else clearTimer()
    } catch (error) {
      if (error?.status === 404) {
        forgetConversation()
        startNewConversation()
        return
      }
      throw error
    }
  }

  function pollConversation(id) {
    clearTimer()
    timer = window.setInterval(async () => {
      try {
        await loadConversation(id, { schedulePolling: false })
        if (conversation && !isPending(conversation.status))
          await loadConversationList().catch(() => {})
      } catch {}
    }, 3000)
  }

  function setConversation(next) {
    conversation = next
    rememberConversation(next.id)
    effort.value = next.reasoningEffort || 'medium'
    renderConversation()
    renderConversationList()
    renderComposer()
  }

  function startNewConversation() {
    clearTimer()
    conversation = null
    forgetConversation()
    instruction.value = ''
    effort.value = 'medium'
    renderConversation()
    renderConversationList()
    renderComposer()
    focusComposer()
  }

  function renderConversationList() {
    const selected = conversation?.id || ''
    conversationSelect.replaceChildren(new Option('新しい会話', ''))
    for (const item of conversationSummaries) {
      if (!item || typeof item.id !== 'string') continue
      conversationSelect.append(
        new Option(
          typeof item.title === 'string' ? item.title : 'CMS AIの会話',
          item.id,
        ),
      )
    }
    conversationSelect.value = selected
  }

  function renderConversation() {
    messages.replaceChildren()
    if (!conversation || !Array.isArray(conversation.jobs)) {
      const empty = document.createElement('li')
      empty.className = 'cms-ai-messages__empty'
      empty.textContent = session?.capabilities?.edit
        ? '質問も修正依頼も、そのままメッセージで送れます。'
        : 'サイトについて知りたいことを、そのままメッセージで送れます。'
      messages.append(empty)
      return
    }
    for (const job of conversation.jobs) messages.append(renderTurn(job))
    window.requestAnimationFrame(() => {
      messages.scrollTop = messages.scrollHeight
    })
  }

  function renderTurn(job) {
    const turn = document.createElement('li')
    turn.className = 'cms-ai-turn'
    turn.append(
      makeMessage(
        'user',
        `あなた · Turn ${job.turnNumber || ''} · ${effortLabel(job.reasoningEffort)}`,
        job.instruction || '',
      ),
      makeMessage(
        'assistant',
        'CMS AI · ' + statusLabel(job.status),
        (job.status === 'failed' ? job.errorMessage : '') ||
          job.assistantMessage ||
          job.clarification ||
          job.summary ||
          pendingMessage(job.status),
        job,
      ),
    )
    return turn
  }

  function makeMessage(kind, metaText, text, job) {
    const article = document.createElement('article')
    article.className = 'cms-ai-message cms-ai-message--' + kind
    const meta = document.createElement('p')
    meta.className = 'cms-ai-message__meta'
    meta.textContent = metaText
    const content = document.createElement('p')
    content.className = 'cms-ai-message__text'
    content.textContent = text
    article.append(meta, content)
    if (Array.isArray(job?.changedPaths) && job.changedPaths.length) {
      const paths = document.createElement('ul')
      paths.className = 'cms-ai-message__paths'
      for (const path of job.changedPaths) {
        const item = document.createElement('li')
        item.textContent = path
        paths.append(item)
      }
      article.append(paths)
    }
    if (typeof job?.prUrl === 'string' && job.prUrl) {
      const link = document.createElement('a')
      link.className = 'cms-ai-message__link'
      link.href = job.prUrl
      link.target = '_blank'
      link.rel = 'noreferrer'
      link.textContent = 'Pull Requestを開く'
      article.append(link)
    }
    return article
  }

  function renderComposer(options = {}) {
    const pending = Boolean(conversation && isPending(conversation.status))
    const merged = conversation?.status === 'merged'
    const atLimit = Number(conversation?.jobs?.length || 0) >= 30
    submit.disabled = pending || merged || atLimit
    instruction.disabled = pending || merged || atLimit
    effort.disabled = pending || merged || atLimit
    submit.textContent = pending ? '処理中…' : '送信'
    if (options.preserveStatus) return
    if (pending) renderStatus(statusLabel(conversation.status), false)
    else if (merged)
      renderStatus(
        'マージ済みです。続きは新しい会話で依頼してください。',
        false,
      )
    else if (atLimit)
      renderStatus(
        '会話の上限に達しました。新しい会話を開始してください。',
        false,
      )
    else renderStatus('', false)
  }

  async function requestJson(url, options = {}) {
    const response = await fetch(url, { credentials: 'include', ...options })
    const contentType = response.headers.get('Content-Type') || ''
    const payload = contentType.includes('application/json')
      ? await response.json().catch(() => ({}))
      : {}
    if (!response.ok || !contentType.includes('application/json')) {
      const error = new Error(
        typeof payload.message === 'string'
          ? payload.message
          : 'CMS AIへログインして利用権限を確認してください。',
      )
      error.status = response.status
      throw error
    }
    return payload
  }

  function renderStatus(text, error) {
    formStatus.textContent = text || ''
    formStatus.classList.toggle('cms-ai-form__status--error', Boolean(error))
  }
  function focusComposer() {
    window.setTimeout(() => instruction.focus(), 0)
  }
  function clearTimer() {
    if (timer) window.clearInterval(timer)
    timer = 0
  }
  function isPending(status) {
    return ['queued', 'running', 'validating'].includes(status)
  }
  function statusLabel(status) {
    return (
      {
        failed: '自動処理を停止しました',
        merged: 'マージ済み',
        pr_created: 'Pull Requestを更新しました',
        queued: 'GitHub Actionsを開始しています',
        responded: '返信しました',
        running: '回答・変更案を作成しています',
        validating: '変更を検証しています',
      }[status] || '状況を確認しています'
    )
  }
  function pendingMessage(status) {
    return isPending(status)
      ? '依頼を確認しています。完了するとここに返答が表示されます。'
      : '処理結果を確認できません。'
  }
  function effortLabel(value) {
    return { high: '高', low: '低', medium: '標準' }[value] || '標準'
  }
  function readError(error, fallback) {
    return error instanceof Error && error.message ? error.message : fallback
  }
  function rememberConversation(id) {
    try {
      window.localStorage.setItem(savedConversationKey, id)
    } catch {}
  }
  function readSavedConversation() {
    try {
      return window.localStorage.getItem(savedConversationKey) || ''
    } catch {
      return ''
    }
  }
  function forgetConversation() {
    try {
      window.localStorage.removeItem(savedConversationKey)
    } catch {}
  }

  renderConversation()
  renderConversationList()
  renderComposer()
})()
