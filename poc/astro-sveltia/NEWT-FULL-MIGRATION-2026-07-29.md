# Newt全記事・下書き移行記録（2026-07-29）

## 結論

Newt APIから取得した全モデル原本をrepositoryへ保存し、記事32件を次の境界で
Markdownへ固定しました。

- 公開済み15件: 既存Markdownを1 byteも変更せず、そのまま公開を継続
- Newt未公開17件: `draft: true`のMarkdownとして追加し、公開面から除外
- 公開画像11件: 既存ファイルとSHA-256を維持
- 未公開記事の画像参照8件（固有7件）: 7画像すべてを公開path外のmigration
  archiveへ保存し、うち1画像は既存公開assetとの完全一致も記録
- Newtメディアライブラリ全体: 72ファイルを一括ZIPで取得し、ZIPと全ファイルの
  SHA-256を固定。ZIP本体はprivate GitHub Releaseへ保管
- 下書き画像を`public/uploads/wiki`へ追加せず、本文は公開前reviewまで画像非表示

移行manifestは
[`migration/newt-full-draft-migration-manifest.json`](./migration/newt-full-draft-migration-manifest.json)
です。Newt ID、元slug、移行先slug、元カテゴリ、移行先カテゴリ、元本文byte数・
SHA-256、生成Markdown byte数・SHA-256、除去・正規化したHTML要素、画像参照を
記事単位で保持しています。

未公開記事は存在を失わないための保存であり、公開承認ではありません。内容には
古いサーバー仕様、未完成の説明、空本文が含まれるため、公開する記事ごとに内容と
画像の確認が必要です。

機密情報・credentialのblock対象は検出されませんでしたが、変換後も次の2件は
追加の公開前reviewを必須としています。

- `survival-rules-legacy`: 現行`rule`の旧版なので原則非公開とし、本文中の
  Discord招待URLが現在も公開用かも確認する
- `member`: 掲載対象と役職の現行性、本人同意を確認する

このgateはmanifestの`publicationPolicy.additionalSecurityReview`へ固定し、
validatorで対象が変わっていないことを確認します。

## API原本

次の4ファイルを
[`migration/newt-full-export-2026-07-29/`](./migration/newt-full-export-2026-07-29/)
へ保存しています。

| ファイル        | 内容                       | 件数 |
| --------------- | -------------------------- | ---: |
| `article.json`  | articleモデル全レスポンス  |   32 |
| `category.json` | categoryモデル全レスポンス |    9 |
| `link.json`     | linkモデル全レスポンス     |    3 |
| `manifest.json` | 取得条件、byte数、SHA-256  |    - |

importerは原本manifest自体と3 APIファイルのbyte数・SHA-256をコード内の固定値と
照合します。API原本、manifest、件数またはIDが1つでも変わった場合は生成を停止
します。公開日時がある15件と公開日時がない17件も自動分類後に固定inventoryと
照合し、想定外の公開状態を受け入れません。

公開15件は、全件APIだけでなく退役前の
[`migration/newt-public-content-snapshot.json`](./migration/newt-public-content-snapshot.json)
とも本文、meta、category ID、category raw履歴を完全照合します。コミュニティ2記事
だけは、snapshot時のカテゴリ名`コミュニティ紹介`から全件API時の
`コミュニティについて`への名称変更を明示的な差分として固定しています。

未公開17件のうち16件には過去の`firstPublishedAt`があり、`Communication`だけが
未公開のまま空本文です。現在の`publishedAt: null`と過去の`firstPublishedAt`を
記事ごとにmanifestへ保存します。category 9件とlink 3件も件数だけでなく、
Newt ID、値、表示順、公開日時を保存しています。

全32件のNewt ID、元slug、NFC正規化＋大文字小文字を無視した元slug、本文SHA-256
には衝突がありません。表示タイトルは`ルール`の2件と`プラグイン一覧`の3件が
重複するため、IDとslugで区別する2群として`sourceCollisionAudit`へ固定しました。

## Newt管理画面で確認した構成

2026-07-29にNewt管理画面で次を確認しました。

- 現行プランではApp exportを利用できなかったため、本移行はモデルAPIの全件取得を
  原本とした
- articleモデル:
  `title`、`slug`、`meta.title`、`meta.description`、`meta.ogImage`、
  `body`、`category`、`sortOrder`
- categoryモデル: `name`、`sortOrder`
- linkモデル: `text`、`href`
- table view:
  - `投稿` / model `article` / uid `article`
  - `カテゴリ` / model `category` / uid `category`
  - `リンク` / model `link` / uid `link`

UIで確認したexample JSONとview設定は
[`migration/newt-full-export-2026-07-29/model-view-schema.json`](./migration/newt-full-export-2026-07-29/model-view-schema.json)
へ原文保存しました。byte数とSHA-256を移行manifestの`uiEvidence`へ保存し、
importer/validatorが内容とhashを照合します。

## 未公開17件の対応

slugは元値から推測生成せず、衝突しないASCII kebab-caseを全件明示しています。
表示順は公開15件の`10`〜`150`を維持し、下書きを`160`〜`320`へ割り当てました。

| Newt元slug               | Markdown slug               | 移行先カテゴリ         |
| ------------------------ | --------------------------- | ---------------------- |
| `Communication`          | `communication`             | コミュニティ紹介       |
| `Reset`                  | `reset`                     | その他サーバーについて |
| `Azkaban`                | `azkaban`                   | その他サーバーについて |
| `LoginPassword`          | `login-password`            | 生活鯖について         |
| `Application method`     | `application-method`        | イントロダクション     |
| `Q&A`                    | `faq`                       | イントロダクション     |
| `Lobby`                  | `lobby`                     | その他サーバーについて |
| `ResetOverview`          | `reset-overview`            | その他サーバーについて |
| `SurvivalGuideFacility`  | `survival-guide-facility`   | 生活鯖について         |
| `SurvivalRules`          | `survival-rules-legacy`     | 生活鯖について         |
| `AzkabanOverview`        | `azkaban-overview`          | その他サーバーについて |
| `AzkabanPluginsList`     | `azkaban-plugins-list`      | その他サーバーについて |
| `ResetServerPluginsList` | `reset-server-plugins-list` | その他サーバーについて |
| `community`              | `community`                 | コミュニティ紹介       |
| `member`                 | `member`                    | その他                 |
| `event`                  | `event`                     | その他                 |
| `world`                  | `world`                     | イントロダクション     |

カテゴリはNewt category IDと名前の両方を照合します。
`コミュニティについて`は現行の`コミュニティ紹介`へ、
`資源サーバー`と`アズカバンサーバー`は
`その他サーバーについて`へ明示変換します。未定義ID、名前変更、移行先カテゴリ外の
値はfail closedです。

`Application method`、`Q&A`、`community`の空descriptionには記事ごとの説明を
明示しました。それ以外の空descriptionは受け入れません。`LobbyOverview`という
実在しない旧記事slugへの内部リンクだけは、内容上対応する`lobby`へのaliasを
明示しています。その他の未知の内部記事リンクは変換を停止します。

`Azkaban`本文には`AzkabanPluginsList`の元本文全体が含まれています。これは
移行時の重複ではなくNewt原本の包含関係であるため、両記事を保持し、
`knownDuplicateContent`へ本文hashと関係を記録しています。

`SurvivalRules`は既存redirect
`/article/SurvivalRules/` → `/article/rule/`が示す現行ルールの旧版です。
誤って新規記事として公開しないよう移行先slugへ`-legacy`を付け、
`knownSupersededContent`へ現行記事との関係と`do-not-publish`既定を記録しています。

## HTMLから安全なMarkdownへの変換

Newt rich textのHTMLは次の規則で決定的に正規化します。

- `style`と`script`を除去し、記事ごとの除去数をmanifestへ記録
- `h1`を`h2`へ下げ、ページタイトル専用のh1と衝突させない
- `details` / `summary`をh4見出しと常時表示本文へ変換
- `select` / `option`をMarkdown listへ変換
- HTML tableをrowspan/colspanを展開したMarkdown tableへ変換
- 旧Wiki内部リンクを公開・下書き双方の明示slug mappingへ変換
- 見出しへ漏れたlist marker、list内へ誤って残った見出しindent、改行を跨いで
  壊れたstrong markerを既知原本ごとの規則で修復
- `SurvivalRules`の退役済み`aceserver-wiki.acecore.systems`参加URLを現行originへ
  正規化
- `javascript:`、`data:`、`vbscript:`、未知の内部記事、危険な埋め込み要素を拒否
- raw HTML、MDX相当構文、h1、外部Markdown画像が残った場合は拒否

本文内の画像は安全な「画像は移行保留です」という注記へ置き換えました。
元URLとaltはmanifestに残るため、公開前に権利・内容・必要性を確認し、採用する
画像だけを`/uploads/wiki/`へ保存できます。

## 下書き画像の原本保全

2026-07-29に8参照・7固有URLがすべてHTTP 200で取得できることを確認しました。
7ファイルすべてを
[`migration/newt-draft-assets-2026-07-29/`](./migration/newt-draft-assets-2026-07-29/)
へ保存し、byte数とSHA-256を固定しています。

`SurvivalRules`の`shaking-hands.jpg`は既存の
`public/uploads/wiki/rule-handshake.jpg`とbyte数140587・SHA-256
`1a5fcfc9be301d1ca188e3825bb92b8eddf6945d22e55d73c73ce3e96382edbb`
が完全一致します。将来その公開assetが正当に更新されても原本監査を壊さないよう、
同一binaryをarchiveにも自己完結して保存しました。archive 7件と既存一致1件の
対応はmanifestの`draftAssetArchive`、8つの記事別参照は`deferredDraftAssets`へ
記録しています。

archiveは証跡保全用であり、Astroの公開静的ファイルではありません。記事を公開
するときにだけ、必要な画像を権利・内容確認後に公開assetへ明示的に移してください。

## Newtメディアライブラリの全件保全

記事本文が現在参照している画像だけでなく、Newtのメディアライブラリに残っていた
全72ファイルも管理画面の一括ダウンロードから保全しました。

- ZIP: `aceserver-newt-assets-2026-07-29.zip`
- byte数: `56092455`
- ZIP SHA-256:
  `28c12ec7a436c672a0fc562cad4d3f114f9e8ad1967050743078cefc51f5b4e1`
- ZIP entry: 144（ファイル72、ディレクトリ72）
- 展開後合計: `57115787` bytes
- 危険な絶対path・`..` entry: 0
- 保存先: private repository
  `acecore-systems/aceserver-wiki`のGitHub Release
  `newt-export-2026-07-29`

ZIP本体を通常のGit履歴へ入れずcloneとCloudflare Pages buildを肥大化させないため、
Release assetとして保持します。ファイル名、byte数、各SHA-256、ZIPの保持先は
[`migration/newt-full-assets-2026-07-29-manifest.json`](./migration/newt-full-assets-2026-07-29-manifest.json)
へ保存しています。manifestは恒久CIで、Newt管理画像と本文参照画像の既知対応も
検証します。

一括ZIPからmanifestを再生成するときはWindows PowerShellで次を実行します。

```powershell
.\scripts\inventory-newt-assets.ps1 `
  -ArchivePath .\aceserver-newt-assets-2026-07-29.zip `
  -OutputPath .\migration\newt-full-assets-2026-07-29-manifest.json
```

## 監査の分離

CMSによる正当な記事編集・新規記事・画像追加を恒久CIが妨げないよう、監査を
次の3層へ分けています。

- `test:migration:archive`: 恒久CI。API原本32/9/3、旧snapshot、UI証跡、
  参照画像archive 7件、全メディア72件のmanifest、公開履歴、source衝突、
  変換再現性を検証する。
  `src/content/wiki`と`public/uploads/wiki`の現行inventoryは読みません。
- `test:migration:unit`: 恒久CI。HTML変換、危険URL、未知カテゴリ、空説明の
  fail-closed規則をfixtureだけで検証します。
- `test:migration:acceptance`: 今回の移行受入れ時だけ手動実行。公開15件のhash、
  下書き17件の生成結果、公開画像11件、公開pathへの下書き画像混入0、表示順、
  独立Markdown規則を現行repositoryと突合します。CMS運用開始後の通常gateには
  使用しません。

通常の`npm run build` validatorは、その時点のcurrent collectionから公開記事だけを
検索、sitemap、記事route、Vectorize corpusへ含め、`draft: true`を除外することを
動的に確認します。

```bash
npm run test:migration:archive
npm run test:migration:unit
npm run check
npm test
npm run build
```

初回の決定的生成と受入れ確認だけは次を使用します。既存の生成対象に手編集が
ある場合は上書きせず停止します。

```bash
npm run migrate:newt-drafts
npm run test:migration:acceptance
```

## Newt削除前の境界

記事本文・カテゴリ・リンクのAPI原本とMarkdown移行はrepository内で復元できます。
下書き画像も7固有原本をarchiveでhash固定し、うち1件は既存assetとの完全一致も
記録しました。さらにメディアライブラリ全72ファイルの一括ZIPもprivate GitHub
Releaseへ保存し、ZIPと全ファイルのhashをrepositoryで固定しました。
したがってWikiのarticle/category/link、参照画像、未参照を含むNewtメディアについて、
Newtだけに残る原本はありません。公開15件は退役前snapshotとのmeta/category履歴
照合も完了しています。
ただし、下書き17件の内容確認と2件の追加security reviewは公開可否の判断として
別に残ります。
