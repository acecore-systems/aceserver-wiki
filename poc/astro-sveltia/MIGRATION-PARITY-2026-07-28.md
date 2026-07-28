# Nuxt/Newt → Astro/Markdown 完全移行監査

- 監査日: 2026-07-28
- 旧環境: `https://bba3fffa.aceserver-wiki.pages.dev`
- 現環境: `https://asv-wiki.acecore.net`

## 結論

旧Nuxtが公開していた15記事の本文は失われていません。旧rollback deploymentの
公開payloadを再取得し、15記事すべてで本文byte数とSHA-256が初回production
manifestに一致することを確認しました。初回production manifestは不変コピーとして
分離し、rollback deployment固有のpayload hashは別manifestとsnapshotへ保存して
います。旧Pages/Newtを将来停止した後も原文と両時点の証跡を検証できます。

監査で見つかったMarkdown変換上の表示崩れ、失われていたトップ導線、旧原文から
引き継いだ無効URLも本対応で修復しました。

## 原本証跡

- [`migration/newt-initial-production-manifest.json`](./migration/newt-initial-production-manifest.json)
  - `main`の`746f19be0a64bb580b289a9846fa3948b9561bf0`に存在した
    `newt-public-payload-manifest.json`の完全な不変コピー
  - Git blob: `6ad614a08f867c1f1def0d68fa43e06dae3f0781`
  - file SHA-256:
    `837e0102d9cec317b464bec0e1bba9fe7c2bf9c14371403274ce1b757583e923`
  - 初回production origin、payload hash、15記事の本文hash、初回生成Markdown
    hashを保持し、再取得では更新しない
- [`migration/newt-public-content-snapshot.json`](./migration/newt-public-content-snapshot.json)
  - root payloadと15記事の公開payload原文・正規化済み公開データ
  - 各記事の原文HTML、payload SHA-256、本文byte数、本文SHA-256
  - 6カテゴリ、3ヘッダーリンク、旧app/icon/cover情報
  - Newt token、Access情報、GitHub資格情報は使用・保存していない
- [`migration/newt-public-payload-manifest.json`](./migration/newt-public-payload-manifest.json)
  - 記録済みrollback deploymentから原文を再現するためのmanifest
  - snapshotと同じdeployment固有payload hash、15記事と11画像の移行先、
    redirect、破損画像の扱いを保持
  - 初回production manifestとは独立した再現用証跡
- 退役前に取得したsnapshotは不変証跡として保持する
- 旧deploymentへ依存するlive再取得のnpm入口は退役するが、取得・hash照合・
  決定的snapshot生成のscriptは由来証跡として保持する
- `npm run test:migration`
  - rollback snapshotとrollback再現用manifestを、現在の記事編集から独立して
    継続検証する
- `npm run test:migration:current`
  - snapshotと保存画像だけによるoffline再生成、build後の15記事、11画像、表・list・
    強調・参加導線を完全移行監査として検証する

原文本文の合計は53,234 bytesです。15/15記事で本文hashが一致し、11/11の保存画像
もbyte数・SHA-256・画像形式が一致しました。

## 内容・構造の突合結果

| 対象                    | 結果                                     |
| ----------------------- | ---------------------------------------- |
| 記事inventory・title    | 15/15一致                                |
| カテゴリ                | 6/6、順序を含め一致                      |
| ヘッダーリンク          | 3/3、順序を含め一致                      |
| 初回→rollback本文hash   | 15/15一致                                |
| non-table可視text       | exact allowlist適用後、15/15記事でexact  |
| semantic table          | 10/10表でexact                           |
| 旧HTML anchor           | exact 39、canonical rewrite 2、retired 6 |
| 現行記事anchor          | 旧由来41 + 正当な置換・追加3 = 44        |
| 旧記事内画像            | 8/9を保持・alt現行化、旧404画像1件を除外 |
| 保存画像                | 11/11 byte一致                           |
| 旧slug                  | 4件を301で正規化                         |
| 旧`SurvivalRules` alias | 301で`/article/rule/`へ維持              |
| 検索`Discord`           | 旧8記事、新9記事（復旧した参加導線で+1） |
| sitemap                 | トップと15記事を収録                     |

## 本文・表の全件監査

原文snapshotの各`article.body`と現行15記事を記事単位で照合しました。表の外は
HTML/Markdownの空白、list marker、見出しmarkerなど表示構造だけの差を正規化した
可視textとして比較し、下記のexact allowlist適用後に15/15記事で一致しました。
表は文字列の並びではなく、header、row、cell、`rowspan`が表す共有関係を
semantic tableとして比較し、次の10表すべてで一致しました。

検索結果の1件増加は本文欠落ではありません。旧版ではplaceholderだった
`ディスコード連携のやり方`の参加導線を、有効なDiscord inviteを持つCTAへ
置換したため、同記事も`Discord`検索に現れるようになりました。旧版の8記事は
新版でもすべて検索でき、そこへ同記事が追加されています。

- `ルール・BAN条件`: 1表
- `コマンドについて`: 6表
- `プラグイン一覧`: 1表
- `あすたん王国`: 2表

「旧可視本文を全文字・同一順序で保持」とは判定していません。Markdownで表現できる
構造への変換と、次の正当置換allowlistを適用したうえで、意味のある本文の欠落が
ないことを確認しています。

| 記事                       | 原文                                                                   | 現行・理由                                         |
| -------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------- |
| `ルール・BAN条件`          | `http://acecore.systems/acesv`                                         | `https://asv-wiki.acecore.net/article/in/`へ現行化 |
| `ルール・BAN条件`          | `https://discord.gg/dkrn6NtU5E`                                        | 有効な`https://discord.gg/acsv`へ現行化            |
| `ディスコード連携のやり方` | `ディスコードに参加するXXX（XXXのとこにディスコードリンクを埋め込み）` | `Discordに参加する`と有効なinvite linkへ置換       |
| `コマンドについて`         | table headerの`使用方法h`                                              | 誤記を`使用方法`へ修正                             |

このほか、見出しへ露出していた`-`、本文へ露出していた`\*`、raw HTMLの
`details/summary`、不正なlist nestingは表示構造として修復しました。`rowspan`由来の
同義commandは1 cellへ併記し、共有説明は対応する各rowへ保持しています。

## リンク全件監査

旧HTMLのanchorは47件です。39件は同じdestinationをexactに保持しました。
内部リンク2件（`hub紹介`と`参加方法`）は
`/article/how-to-discordsrv-link/`へ正規化しました。残る6件はラベルを本文へ残し、
到達不能である次の理由を付けて非リンク化しました。

- FRESTU 3件（プロフィール、Discordフレンド募集、ゲーム友達募集）:
  2026-07-28時点で応答を確認できない
- ものくらふと 1件: 掲載先がHTTP 402で公開ページを確認できない
- Japan Minecraft Servers 1件: 掲載先がHTTP 404
- Discoparty 1件: 掲載先がHTTP 404

旧47 anchorの内訳とは別に、参加導線を3件置換・追加しました。

- `ルール・BAN条件`の旧参加URLを現行Wikiの`/article/in/`へ置換
- 同記事の無効なDiscord inviteを`https://discord.gg/acsv`へ置換
- `ディスコード連携のやり方`の`XXX` placeholderへ同じ有効inviteを追加

したがって現行15記事の描画anchorは、旧由来41件と上記3件の合計44件です。

## 今回修復した差分

- `hub紹介`
  - 見出し先頭へ混入した`-`を削除
  - 平文の`\*`になっていた利用条件2件をMarkdown listへ復元
- `遊び方`
  - `Discord`見出し先頭へ混入した`-`を削除
- `ルール・BAN条件`
  - `トラップ・回路`以降を前のlist itemから分離
  - 強調記号が文字として露出していた退出時警告を修復
  - 使用可能クライアントを正しい3列表として復元
  - 表の外にあった質問案内を4列目へ誤結合しないconverterへ修正
  - 参加URLを`https://asv-wiki.acecore.net/article/in/`へ更新
  - 無効なDiscord招待を`https://discord.gg/acsv`へ更新
- `ディスコード連携のやり方`
  - 原文の`XXX` placeholderを削除し、有効なDiscord招待を追加
- `コマンドについて`
  - HTML `rowspan`由来の同義command行を1行へまとめ、重複を削減
  - `使用方法h`を`使用方法`へ修正
- トップ
  - 旧Nuxtにあった`Wikiを読む`導線を`/article/rinen/`へ復元
- 検索index
  - runtimeで`X-Robots-Tag: noindex`を付与
- 画像
  - ファイル名や機械翻訳列挙だったaltを内容が分かる日本語へ更新
- プロモーション
  - 404のJapan Minecraft Servers、Discopartyリンクを停止
  - 応答不能のFRESTU、HTTP 402のものくらふとリンクを停止
  - サービス名と確認日を本文へ残し、原URLはsnapshotで保存

## 意図的な変換と例外

- `/img/リスト.png`は旧Nuxt上でも404で、検証可能な元画像がないため削除済み。
  manifestに記事、alt、理由を記録しています。
- 旧記事本文の画像9件は、有効な8件をrepositoryへ保存して内容を表すaltへ更新し、
  上記の旧404画像1件だけを除外しました。別途公開されていたWiki app/icon/cover
  3件も保存しているため、hash管理する保存画像は合計11件です。
- HTML `details/summary` 5件は、raw HTMLを許可しない公開編集ポリシーに合わせて
  Markdown見出しと常時表示本文へ変換しました。内容は保持されています。
- HTML `rowspan`はMarkdown表で表現できないため、同義commandを同じセルへまとめ、
  その他の共有説明は各行へ明示しました。
- 4つの空白・全角空白を含むslugは安全なslugへ正規化し、旧URLを301で保持します。
- Wiki cover画像は原本・hashを保存していますが、旧Nuxt公開画面でも描画されて
  いなかったため、現画面へ新たには表示していません。

## 外部リンク監査

現行化前の公開記事にある外部リンクをGET/HEADとDiscord公開invite APIで確認
しました。有効なDiscord招待は`acsv`、旧`dkrn6NtU5E`は無効です。
確定404の旧参加URL、Japan Minecraft Servers、Discopartyは置換またはリンクを
停止しました。ディス速はCloudflare 403のため自動判定不能ですが、404とは断定
せず維持しています。MCServers.JPとTwitchはHEAD 405でもGET 200のため維持して
います。

## 旧系退役

2026-07-28、本監査の結果を確認した利用者から旧系削除の明示承認を受けました。
これは当初2026-08-03 20:55 JSTまでとしていたrollback保持を置き換えます。
退役は本番15記事、検索、SEO、旧URL、Access、CMS、D1、GitHub push deploymentを
各段階で再確認し、次の順序で実施します。

1. rootの旧Nuxt build経路とrepository内Newt接続設定を削除するcleanup PRを作成し、
   reviewを完了する。この時点ではNewt tokenと旧Pages projectを保持する。
2. cleanup PRをmergeする。
3. merge後のGitHub接続Astro production deployment、custom domain、15記事、
   `/admin/`のAccessとCMS読込・保存を再確認する。
4. 再確認完了後にNewt tokenを失効する。
5. 記録済みrollback deploymentを持つ旧Pages projectを最後に削除する。

初回production manifest、rollback再現用manifest、原文snapshot、CUTOVER/D1監査記録
はcleanup後もrepositoryへ保持します。
