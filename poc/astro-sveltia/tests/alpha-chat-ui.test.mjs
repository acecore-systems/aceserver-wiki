import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

const alphaGuideStylesSource = readFileSync(
  new URL('../src/styles/alpha-guide.css', import.meta.url),
  'utf8',
)
const alphaChatSource = readFileSync(
  new URL('../public/alpha-chat.js', import.meta.url),
  'utf8',
)

test('チャット入力欄をiPhoneの自動拡大が起きない16pxで表示する', () => {
  const inputStyles = alphaGuideStylesSource.match(
    /\.alpha-form textarea\s*\{(?<styles>[\s\S]*?)\}/u,
  )?.groups?.styles

  assert.match(inputStyles ?? '', /font-size:\s*16px;/u)
})

test('アルファ回答のMarkdownリンクを視認可能な下線付きで表示する', () => {
  const linkStyles = alphaGuideStylesSource.match(
    /\.alpha-message__bubble a\s*\{(?<styles>[\s\S]*?)\}/u,
  )?.groups?.styles

  assert.match(linkStyles ?? '', /color:\s*#ffe16a;/u)
  assert.match(linkStyles ?? '', /text-decoration-line:\s*underline;/u)
})

test('アルファ回答の安全なMarkdownをDOM要素として組み立てる', () => {
  const markdown = [
    '**Markdown表示**',
    '',
    '[公式Discord](https://discord.gg/acsv)と[WIKI内リンク](/article/rule/)を確認してね。',
    '[危険](javascript:alert)は文字のままにするよ。',
    '',
    '1. `/home`を確認',
    '2. ~~古い案内~~は更新済み',
  ].join('\n')
  const { bubble, render } = createAlphaAnswerRenderer()
  render(bubble, markdown)

  const links = findByTagName(bubble, 'a')
  assert.equal(links.length, 2)
  assert.deepEqual(
    links.map(({ href, rel, target, textContent }) => ({
      href,
      rel,
      target,
      textContent,
    })),
    [
      {
        href: 'https://discord.gg/acsv',
        rel: 'ugc nofollow noopener noreferrer',
        target: '_blank',
        textContent: '公式Discord',
      },
      {
        href: '/article/rule/',
        rel: undefined,
        target: undefined,
        textContent: 'WIKI内リンク',
      },
    ],
  )
  assert.match(bubble.textContent, /\[危険\]\(javascript:alert\)/u)
  assert.deepEqual(
    findByTagName(bubble, 'strong').map((node) => node.textContent),
    ['Markdown表示'],
  )
  assert.deepEqual(
    findByTagName(bubble, 'code').map((node) => node.textContent),
    ['/home'],
  )
  assert.deepEqual(
    findByTagName(bubble, 'del').map((node) => node.textContent),
    ['古い案内'],
  )
  assert.deepEqual(
    findByTagName(bubble, 'ol').flatMap((list) =>
      findByTagName(list, 'li').map((item) => item.textContent),
    ),
    ['/homeを確認', '古い案内は更新済み'],
  )
})

class FakeTextNode {
  constructor(value) {
    this.textContent = String(value)
  }
}

class FakeElement {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase()
    this.children = []
  }

  append(...nodes) {
    this.children.push(...nodes)
  }

  get textContent() {
    return this.children.map((child) => child.textContent).join('')
  }

  set textContent(value) {
    this.children = [new FakeTextNode(value)]
  }
}

function createAlphaAnswerRenderer() {
  const start = alphaChatSource.indexOf('  function normalizeAnswerLink')
  const end = alphaChatSource.indexOf('  function normalizeSource')
  assert.ok(start >= 0 && end > start, 'Alpha Markdown renderer source missing')

  const document = {
    createElement(tagName) {
      return new FakeElement(tagName)
    },
    createTextNode(value) {
      return new FakeTextNode(value)
    },
  }
  const window = {
    location: {
      href: 'https://asv-wiki.acecore.net/search/',
      origin: 'https://asv-wiki.acecore.net',
    },
  }
  const context = { URL, document, window }
  const rendererSource = alphaChatSource.slice(start, end)
  runInNewContext(
    `${rendererSource}\nwindow.renderAlphaAnswer = appendAnswerText`,
    context,
    { timeout: 1_000 },
  )
  const bubble = new FakeElement('div')

  return {
    bubble,
    render: window.renderAlphaAnswer,
  }
}

function findByTagName(root, tagName) {
  const expected = tagName.toUpperCase()
  return walkElements(root).filter((element) => element.tagName === expected)
}

function walkElements(root) {
  const elements = []
  for (const child of root.children ?? []) {
    if (!(child instanceof FakeElement)) continue
    elements.push(child, ...walkElements(child))
  }
  return elements
}
