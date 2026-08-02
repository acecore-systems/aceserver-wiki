;(() => {
  const widget = document.querySelector('[data-alpha-widget]')
  if (!widget || widget.dataset.alphaBound === 'true') return

  const panel = widget.querySelector('[data-alpha-panel]')
  const toggle = widget.querySelector('[data-alpha-toggle]')
  const messagesContainer = widget.querySelector('[data-alpha-messages]')
  const form = widget.querySelector('[data-alpha-form]')
  const input = widget.querySelector('[data-alpha-input]')
  const sendButton = widget.querySelector('[data-alpha-send]')

  if (
    typeof HTMLDialogElement === 'undefined' ||
    !(panel instanceof HTMLDialogElement) ||
    !(toggle instanceof HTMLButtonElement) ||
    !(messagesContainer instanceof HTMLElement) ||
    !(form instanceof HTMLFormElement) ||
    !(input instanceof HTMLTextAreaElement) ||
    !(sendButton instanceof HTMLButtonElement) ||
    typeof panel.show !== 'function'
  ) {
    return
  }

  widget.dataset.alphaBound = 'true'

  const CLIENT_STORAGE_KEY = 'acecore-alpha-chat-client'
  const MAX_HISTORY_MESSAGES = 8
  const MAX_HISTORY_CHARACTERS = 2_800
  const REQUEST_TIMEOUT_MS = 25_000
  const UUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
  const history = []
  let sending = false
  let inputIsComposing = false
  let returnFocusAfterClose = true

  function appendHistory(role, content, loreRevisionId = '') {
    history.push({
      role,
      content,
      ...(role === 'assistant' && UUID_PATTERN.test(loreRevisionId)
        ? { loreRevisionId }
        : {}),
    })
    if (history.length > MAX_HISTORY_MESSAGES) {
      history.splice(0, history.length - MAX_HISTORY_MESSAGES)
    }
    while (
      history.length > 1 &&
      history.reduce(
        (total, message) => total + [...message.content].length,
        0,
      ) > MAX_HISTORY_CHARACTERS
    ) {
      history.shift()
    }
  }

  function appendInlineText(parent, value) {
    const text = String(value || '')
    const pattern = /\*\*([^*\n]{1,160})\*\*|`([^`\n]{1,160})`/gu
    let cursor = 0
    let match

    while ((match = pattern.exec(text))) {
      if (match.index > cursor) {
        parent.append(document.createTextNode(text.slice(cursor, match.index)))
      }

      const element = document.createElement(match[1] ? 'strong' : 'code')
      element.textContent = match[1] || match[2]
      parent.append(element)
      cursor = pattern.lastIndex
    }

    if (cursor < text.length) {
      parent.append(document.createTextNode(text.slice(cursor)))
    }
  }

  function appendAnswerText(container, value) {
    const lines = String(value || '')
      .replace(/\r\n?/gu, '\n')
      .trim()
      .split('\n')
    let paragraphLines = []
    let list = null

    const flushParagraph = () => {
      if (paragraphLines.length === 0) return
      const paragraph = document.createElement('p')
      appendInlineText(paragraph, paragraphLines.join('\n'))
      container.append(paragraph)
      paragraphLines = []
    }

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) {
        flushParagraph()
        list = null
        continue
      }

      const listMatch = trimmed.match(/^[-*+・]\s+(.+)$/u)
      if (listMatch) {
        flushParagraph()
        if (!list) {
          list = document.createElement('ul')
          container.append(list)
        }
        const item = document.createElement('li')
        appendInlineText(item, listMatch[1])
        list.append(item)
        continue
      }

      list = null
      paragraphLines.push(trimmed.replace(/^#{1,3}\s+/u, ''))
    }

    flushParagraph()
  }

  function normalizeSource(value) {
    if (!value || typeof value !== 'object') return null

    const title =
      typeof value.title === 'string'
        ? value.title
            .normalize('NFKC')
            .replace(/\s+/gu, ' ')
            .trim()
            .slice(0, 160)
        : ''
    const rawUrl = typeof value.url === 'string' ? value.url.trim() : ''
    if (
      !title ||
      !rawUrl.startsWith('/') ||
      rawUrl.startsWith('//') ||
      rawUrl.includes('\\')
    ) {
      return null
    }

    try {
      const url = new URL(rawUrl, window.location.href)
      if (
        url.origin !== window.location.origin ||
        !url.pathname.startsWith('/article/') ||
        url.search ||
        url.hash
      ) {
        return null
      }
      return { title, url: url.pathname }
    } catch {
      return null
    }
  }

  function appendSources(container, values) {
    if (!Array.isArray(values)) return

    const sources = []
    const seenUrls = new Set()
    for (const value of values) {
      const source = normalizeSource(value)
      if (!source || seenUrls.has(source.url)) continue
      seenUrls.add(source.url)
      sources.push(source)
      if (sources.length >= 2) break
    }
    if (sources.length === 0) return

    const sourceList = document.createElement('nav')
    sourceList.className = 'alpha-message__sources'
    sourceList.setAttribute('aria-label', '参照記事')

    const label = document.createElement('span')
    label.textContent = '参照'
    sourceList.append(label)

    for (const source of sources) {
      const link = document.createElement('a')
      link.href = source.url
      link.textContent = source.title
      sourceList.append(link)
    }
    container.append(sourceList)
  }

  function createMessage(role, content, sources = [], transient = false) {
    const message = document.createElement('div')
    message.className = `alpha-message alpha-message--${role}`
    if (transient) message.dataset.alphaTransient = 'true'

    const speaker = document.createElement('span')
    speaker.className = 'visually-hidden'
    speaker.textContent = role === 'assistant' ? 'アルファくん: ' : 'あなた: '
    message.append(speaker)

    if (role === 'assistant') {
      const avatar = document.createElement('img')
      avatar.src = widget.dataset.alphaAvatar || '/uploads/wiki/wiki-icon.png'
      avatar.alt = ''
      avatar.setAttribute('aria-hidden', 'true')
      avatar.width = 32
      avatar.height = 32
      message.append(avatar)
    }

    const bubble = document.createElement('div')
    bubble.className = 'alpha-message__bubble'
    if (role === 'assistant') {
      appendAnswerText(bubble, content)
      appendSources(bubble, sources)
    } else {
      bubble.textContent = content
    }
    message.append(bubble)
    messagesContainer.append(message)
    messagesContainer.scrollTop = messagesContainer.scrollHeight
    return message
  }

  function ensureGreeting() {
    if (history.length > 0) return
    const greeting =
      widget.dataset.alphaGreeting ||
      'やあ、アルファくんだよ。公開中のAceserver WIKIから案内するね。'
    appendHistory('assistant', greeting)
    createMessage('assistant', greeting)
  }

  function setSending(nextSending) {
    sending = nextSending
    widget.classList.toggle('is-sending', sending)
    messagesContainer.setAttribute('aria-busy', String(sending))
    input.readOnly = sending
    sendButton.disabled = sending
    widget.querySelectorAll('[data-alpha-prompt]').forEach((button) => {
      if (button instanceof HTMLButtonElement) button.disabled = sending
    })
  }

  function createClientId() {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()

    const bytes = crypto.getRandomValues(new Uint8Array(16))
    bytes[6] = (bytes[6] & 0x0f) | 0x40
    bytes[8] = (bytes[8] & 0x3f) | 0x80
    const hex = Array.from(bytes, (entry) =>
      entry.toString(16).padStart(2, '0'),
    ).join('')
    return [
      hex.slice(0, 8),
      hex.slice(8, 12),
      hex.slice(12, 16),
      hex.slice(16, 20),
      hex.slice(20),
    ].join('-')
  }

  function getClientId() {
    try {
      const current = window.localStorage.getItem(CLIENT_STORAGE_KEY)
      if (current && UUID_PATTERN.test(current)) return current

      const created = createClientId()
      window.localStorage.setItem(CLIENT_STORAGE_KEY, created)
      return created
    } catch {
      return createClientId()
    }
  }

  async function sendQuestion(rawQuestion) {
    const question = String(rawQuestion || '').trim()
    if (!question || sending) return

    input.value = ''
    appendHistory('user', question)
    createMessage('user', question)
    setSending(true)

    const loadingMessage = createMessage(
      'assistant',
      widget.dataset.alphaLoading || 'アルファくんがWIKIを調べているよ…',
      [],
      true,
    )
    const controller = new AbortController()
    const timeout = window.setTimeout(
      () => controller.abort(),
      REQUEST_TIMEOUT_MS,
    )

    try {
      const response = await fetch(
        widget.dataset.alphaEndpoint || '/api/alpha-chat',
        {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'X-Acecore-Chat-Client': getClientId(),
          },
          body: JSON.stringify({
            question,
            messages: history.slice(0, -1).slice(-(MAX_HISTORY_MESSAGES - 1)),
            locale: 'ja',
          }),
          signal: controller.signal,
        },
      )
      const payload = await response.json().catch(() => null)
      const fallback =
        widget.dataset.alphaError ||
        'いまはアルファくんの案内につながらなかったよ。少し時間をおいて試してね。'
      const answer =
        payload && typeof payload.answer === 'string' && payload.answer.trim()
          ? payload.answer.trim()
          : fallback
      const sources =
        payload && Array.isArray(payload.sources) ? payload.sources : []
      const loreRevisionId =
        payload && UUID_PATTERN.test(payload.loreRevisionId)
          ? payload.loreRevisionId
          : ''

      loadingMessage.remove()
      appendHistory('assistant', answer, loreRevisionId)
      createMessage('assistant', answer, sources)
    } catch {
      const fallback =
        widget.dataset.alphaError ||
        'いまはアルファくんの案内につながらなかったよ。少し時間をおいて試してね。'
      loadingMessage.remove()
      appendHistory('assistant', fallback)
      createMessage('assistant', fallback)
    } finally {
      window.clearTimeout(timeout)
      setSending(false)
      window.setTimeout(() => input.focus(), 0)
    }
  }

  function openPanel() {
    if (document.body.classList.contains('has-open-mobile-menu')) return
    if (!panel.open) panel.show()
    widget.classList.add('is-open')
    toggle.setAttribute('aria-expanded', 'true')
    ensureGreeting()
    window.setTimeout(() => input.focus(), 0)
  }

  function closePanel(shouldReturnFocus = true) {
    if (!panel.open) return
    returnFocusAfterClose = shouldReturnFocus
    panel.close()
  }

  panel.addEventListener('close', () => {
    widget.classList.remove('is-open')
    toggle.setAttribute('aria-expanded', 'false')
    if (
      returnFocusAfterClose &&
      !document.body.classList.contains('has-open-mobile-menu')
    ) {
      toggle.focus()
    }
    returnFocusAfterClose = true
  })

  panel.addEventListener('cancel', (event) => {
    event.preventDefault()
    closePanel()
  })

  toggle.addEventListener('click', () => {
    if (panel.open) closePanel()
    else openPanel()
  })

  widget.querySelectorAll('[data-alpha-close]').forEach((button) => {
    button.addEventListener('click', () => closePanel())
  })

  widget.querySelectorAll('[data-alpha-prompt]').forEach((button) => {
    button.addEventListener('click', () => {
      if (!(button instanceof HTMLButtonElement)) return
      openPanel()
      void sendQuestion(button.dataset.alphaPrompt || button.textContent || '')
    })
  })

  form.addEventListener('submit', (event) => {
    event.preventDefault()
    void sendQuestion(input.value)
  })

  input.addEventListener('compositionstart', () => {
    inputIsComposing = true
  })

  input.addEventListener('compositionend', () => {
    inputIsComposing = false
  })

  input.addEventListener('keydown', (event) => {
    if (event.isComposing || inputIsComposing) return
    if (event.key !== 'Enter' || event.shiftKey) return
    event.preventDefault()
    void sendQuestion(input.value)
  })

  document.addEventListener('keydown', (event) => {
    if (event.isComposing || inputIsComposing) return
    if (event.key === 'Escape' && panel.open) closePanel()
  })

  const mobileMenuObserver = new MutationObserver(() => {
    if (
      document.body.classList.contains('has-open-mobile-menu') &&
      panel.open
    ) {
      closePanel(false)
    }
  })
  mobileMenuObserver.observe(document.body, {
    attributes: true,
    attributeFilter: ['class'],
  })
})()
