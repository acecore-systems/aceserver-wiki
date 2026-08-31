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
  const MAX_CONVERSATION_CONTEXT_BYTES = 64 * 1024
  const REQUEST_TIMEOUT_MS = 25_000
  const UUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
  const history = []
  let conversationContext = null
  let latestLoreRevisionId = ''
  let sending = false
  let inputIsComposing = false
  let returnFocusAfterClose = true

  function appendHistory(role, content) {
    history.push({
      role,
      content,
    })
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
      'やあ、ぼくはアルファくんだよ。公開中のAceserver WIKIから案内するね。'
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

  function showStatusNotice(message, transient = false) {
    if (!message) return
    const notice = document.createElement('p')
    notice.className = 'alpha-context-notice'
    notice.setAttribute('role', 'status')
    notice.textContent = message
    messagesContainer.append(notice)
    messagesContainer.scrollTop = messagesContainer.scrollHeight
    if (transient) window.setTimeout(() => notice.remove(), 8_000)
  }

  function readConversationContext(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null
    }
    try {
      return new TextEncoder().encode(JSON.stringify(value)).byteLength <=
        MAX_CONVERSATION_CONTEXT_BYTES
        ? value
        : null
    } catch {
      return null
    }
  }

  function isResponsePayload(value) {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value))
  }

  function updateStreamingMessage(
    message,
    text,
    { complete = false, sources = [] } = {},
  ) {
    const bubble = message?.querySelector('.alpha-message__bubble')
    if (!(bubble instanceof HTMLElement)) return
    bubble.textContent = ''
    if (complete) {
      appendAnswerText(bubble, text)
      appendSources(bubble, sources)
    } else {
      bubble.textContent = text
    }
    messagesContainer.scrollTop = messagesContainer.scrollHeight
  }

  async function readResponsePayload(response, onDelta) {
    const contentType = String(response.headers.get('Content-Type') || '')
      .split(';', 1)[0]
      .trim()
      .toLowerCase()
    if (contentType !== 'text/event-stream') {
      return response.json().catch(() => null)
    }
    if (!response.body) throw new Error('AlphaChatStreamMissing')

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let finalPayload = null

    function consumeEvent(block) {
      let event = 'message'
      const data = []
      String(block)
        .split(/\r?\n/u)
        .forEach((line) => {
          if (line.startsWith('event:')) {
            event = line.slice(6).trim()
          } else if (line.startsWith('data:')) {
            data.push(line.slice(5).trimStart())
          }
        })
      if (data.length === 0) return

      let payload
      try {
        payload = JSON.parse(data.join('\n'))
      } catch {
        throw new Error('AlphaChatStreamPayloadError')
      }
      if (event === 'delta') {
        if (!isResponsePayload(payload) || typeof payload.text !== 'string') {
          throw new Error('AlphaChatStreamPayloadError')
        }
        onDelta(payload.text)
      } else if (event === 'complete' || event === 'error') {
        finalPayload = payload
      }
    }

    function consumeBufferedEvents(flush = false) {
      while (true) {
        const boundary = /\r?\n\r?\n/u.exec(buffer)
        if (!boundary) break
        consumeEvent(buffer.slice(0, boundary.index))
        buffer = buffer.slice(boundary.index + boundary[0].length)
      }
      if (flush && buffer.trim()) {
        consumeEvent(buffer)
        buffer = ''
      }
    }

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        consumeBufferedEvents()
      }
      buffer += decoder.decode()
      consumeBufferedEvents(true)
    } finally {
      reader.releaseLock()
    }

    if (!finalPayload) throw new Error('AlphaChatStreamIncomplete')
    return finalPayload
  }

  function isResettableConversationResponse(response, payload) {
    return (
      response.status === 400 ||
      response.status === 413 ||
      response.status === 422 ||
      (isResponsePayload(payload) && payload.conversationContextReset === true)
    )
  }

  async function requestAlphaResponse(
    question,
    signal,
    onDelta,
    allowContextResetRetry = true,
  ) {
    const response = await fetch(
      widget.dataset.alphaEndpoint || '/api/alpha-chat',
      {
        method: 'POST',
        headers: {
          Accept: 'text/event-stream',
          'Content-Type': 'application/json',
          'X-Acecore-Chat-Client': getClientId(),
        },
        body: JSON.stringify({
          question,
          locale: 'ja',
          ...(conversationContext ? { conversationContext } : {}),
          ...(latestLoreRevisionId
            ? { loreRevisionId: latestLoreRevisionId }
            : {}),
        }),
        signal,
      },
    )
    const payload = await readResponsePayload(response, onDelta)
    const answer =
      isResponsePayload(payload) && typeof payload.answer === 'string'
        ? payload.answer.trim()
        : ''

    if (
      response.ok &&
      isResponsePayload(payload) &&
      payload.ok === true &&
      answer
    ) {
      return { answer, payload }
    }

    if (
      allowContextResetRetry &&
      conversationContext &&
      isResettableConversationResponse(response, payload)
    ) {
      conversationContext = null
      showStatusNotice(
        '会話の継続情報を更新したよ。表示中のメッセージはそのままだよ。',
      )
      return requestAlphaResponse(question, signal, onDelta, false)
    }

    throw new Error('AlphaChatRequestFailed')
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
      widget.dataset.alphaLoading || 'いまWIKIを調べているよ…',
      [],
      true,
    )
    const controller = new AbortController()
    const timeout = window.setTimeout(
      () => controller.abort(),
      REQUEST_TIMEOUT_MS,
    )

    try {
      let streamedAnswer = ''
      const { answer, payload } = await requestAlphaResponse(
        question,
        controller.signal,
        (delta) => {
          streamedAnswer += delta
          updateStreamingMessage(loadingMessage, streamedAnswer)
        },
      )
      const sources = Array.isArray(payload.sources) ? payload.sources : []
      const loreRevisionId = UUID_PATTERN.test(payload.loreRevisionId)
        ? payload.loreRevisionId
        : ''
      latestLoreRevisionId = loreRevisionId

      const nextContext = readConversationContext(
        payload.nextConversationContext,
      )
      const contextReset =
        payload.conversationContextReset === true ||
        (conversationContext !== null && nextContext === null)
      conversationContext = nextContext
      if (contextReset) {
        showStatusNotice(
          '会話の継続情報を更新したよ。表示中のメッセージはそのままだよ。',
        )
      }

      appendHistory('assistant', answer)
      updateStreamingMessage(loadingMessage, answer, {
        complete: true,
        sources,
      })
    } catch {
      const errorNotice =
        widget.dataset.alphaError ||
        'いまはうまく答えを届けられなかったよ。少し時間をおいて、もう一度聞いてね。'
      loadingMessage.remove()
      showStatusNotice(errorNotice, true)
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
