import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const alphaGuideStylesSource = readFileSync(
  new URL('../src/styles/alpha-guide.css', import.meta.url),
  'utf8',
)

test('チャット入力欄をiPhoneの自動拡大が起きない16pxで表示する', () => {
  const inputStyles = alphaGuideStylesSource.match(
    /\.alpha-form textarea\s*\{(?<styles>[\s\S]*?)\}/u,
  )?.groups?.styles

  assert.match(inputStyles ?? '', /font-size:\s*16px;/u)
})
