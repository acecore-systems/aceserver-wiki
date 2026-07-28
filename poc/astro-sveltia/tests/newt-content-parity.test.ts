import { describe, expect, it } from 'vitest'

import { semanticTableModelsFromFragment } from '../scripts/validate-newt-content-parity.mjs'

describe('Nuxt/Newt semantic table parity', () => {
  it('treats rowspan command aliases as one Markdown alias row', () => {
    const source = `
      <table>
        <tr><th>コマンド</th><th>説明</th><th>使用方法</th></tr>
        <tr>
          <td>/co i</td>
          <td rowspan="2">切り替え</td>
          <td rowspan="2"><ol><li>有効にする</li><li>確認する</li></ol></td>
        </tr>
        <tr><td>/co inspect</td></tr>
      </table>
    `
    const migrated = `
      <table>
        <thead>
          <tr><th>コマンド</th><th>説明</th><th>使用方法</th></tr>
        </thead>
        <tbody>
          <tr>
            <td>/co i ／ /co inspect</td>
            <td>切り替え</td>
            <td>有効にする ／ 確認する</td>
          </tr>
        </tbody>
      </table>
    `

    expect(
      semanticTableModelsFromFragment(migrated, 'SurvivalCommand'),
    ).toEqual(semanticTableModelsFromFragment(source, 'SurvivalCommand'))
  })

  it('expands shared rowspan usage without collapsing different commands', () => {
    const source = `
      <table>
        <tr><th>コマンド</th><th>説明</th><th>使用方法h</th></tr>
        <tr>
          <td>/cdonation</td>
          <td>預け入れのみ</td>
          <td rowspan="2">対象をクリックする</td>
        </tr>
        <tr>
          <td>/cpublic</td>
          <td>出し入れを許可</td>
        </tr>
      </table>
    `
    const migrated = `
      <table>
        <tr><th>コマンド</th><th>説明</th><th>使用方法</th></tr>
        <tr>
          <td>/cdonation</td>
          <td>預け入れのみ</td>
          <td>対象をクリックする</td>
        </tr>
        <tr>
          <td>/cpublic</td>
          <td>出し入れを許可</td>
          <td>対象をクリックする</td>
        </tr>
      </table>
    `

    expect(
      semanticTableModelsFromFragment(migrated, 'SurvivalCommand'),
    ).toEqual(semanticTableModelsFromFragment(source, 'SurvivalCommand'))
  })

  it('compares legacy list and line-break cells with Markdown separators', () => {
    const source = `
      <table>
        <tr><th>許可</th><th>グレー</th><th>禁止</th></tr>
        <tr>
          <td><li>Forge<br></li><li>Fabric<br></li></td>
          <td><li>Feather<br></li></td>
          <td><li>WURST<br></li><li>SIGMA<br></li></td>
        </tr>
      </table>
    `
    const migrated = `
      <table>
        <tr><th>許可</th><th>グレー</th><th>禁止</th></tr>
        <tr>
          <td>Forge ／ Fabric</td>
          <td>Feather</td>
          <td>WURST ／ SIGMA</td>
        </tr>
      </table>
    `

    expect(semanticTableModelsFromFragment(migrated, 'rule')).toEqual(
      semanticTableModelsFromFragment(source, 'rule'),
    )
  })
})
