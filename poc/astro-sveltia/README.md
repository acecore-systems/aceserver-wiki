# Astro + Sveltia Wiki

ASV WikiのAstro・Markdown実装です。公開記事はrepository内Markdownを正本とし、
Discordログイン、stock Sveltia CMS、Pages Functionsのcontent gatewayを経由して
GitHubへ保存します。Newtの公開記事・画像・URL・検索・SEO・広告実装は
移行済みです。広告は、誰でも直接編集できる公開面の審査・通報運用が整うまで
fail closedで無効です。
本番公開と復旧の手順は[OPERATIONS.md](./OPERATIONS.md)を参照してください。

## 構成

1. Astroが `src/content/wiki/*.md` を静的な記事ページへ変換する。
2. `/admin/` ではforkしていないSveltia CMS 0.172.4を起動する。
3. Wiki専用OIDC brokerがDiscord OAuth2をOIDCへ変換し、Cloudflare Accessが
   ログインを担当する。
4. Pages Functionsのcontent gatewayがAccess JWT内のDiscord属性を検証する。
5. gatewayだけがrepository限定のGitHub App installation tokenを保持し、
   許可されたMarkdownと画像だけをGitHubへ保存する。
6. GitHub連携のCloudflare Pagesが、Git pushを契機に再ビルドする。

SveltiaへGitHubアカウントやPATを渡しません。CMS commitにはメールアドレスや
raw Discord user IDを含めず、request IDだけを残します。Discord user IDとの
対応はD1監査だけに保存します。

## 認証と認可

Cloudflare Accessのメール許可ルールは広く設定できますが、gatewayはメールを
認可に使いません。本番は`guild`モードで、Access JWTの
`custom.discord_id`をDiscord user snowflake、
`custom.discord_guild_id`を所属確認済みguild snowflakeとして検証します。
エースサーバー公式Discord（`737538781024092170`）への参加手続きが完了した
メンバーだけを編集可能にします。

本番のguild認可では、OIDC brokerがDiscord membershipを確認し、次の
custom claimsだけをAccess JWTへ渡します。

- `custom.discord_id`
- `custom.discord_guild_id`

Discordの通常OAuth2はOIDC ID tokenとJWKSを提供しないため、Cloudflare Accessの
Generic OIDCへ直接接続しません。専用brokerがDiscordの
`identify email guilds.members.read` scopeで本人情報と対象guildへの所属を
確認し、OIDC ID tokenへ`discord_id`と`discord_guild_id`を発行します。Access側は
scopeを`openid email profile`、OIDC Claimsを
`discord_id,discord_guild_id`、email claimを`email`として設定し、Access JWTの
`custom`へ渡します。`profile`はCloudflare
Access互換目的で受理しますが、brokerは名前・username・avatarなどのprofile
claimを保存・発行しません。claimsが欠落・不正の場合、gatewayはfail closedで
拒否します。Access JWT自身のtop-level `sub`はCloudflare側のsubjectなので、
Discord IDとして使用しません。

`CMS_DISCORD_AUTHORIZATION_MODE=guild`では、brokerがguild membershipと
Membership Screening完了を確認したうえで発行した`discord_guild_id`が一致すれば、
そのguildのメンバーを編集可能にします。guildモードではrole claimを要求しません。
所属確認は新しいDiscordログイン時に行います。発行済みのCloudflare Access
sessionは設定された期限または明示的な失効まで有効です。退会やkickを即時反映
する場合は、対象Discord IDを`cms_bans`へ登録し、対象Access sessionを失効して
からDiscordから除外します。詳細は`OPERATIONS.md`を参照してください。
本番では使用しない`role`モードへ変更する場合は、追加の`discord_roles` claimと
`CMS_DISCORD_ALLOWED_ROLE_IDS` の交差を必須にできます。Discord APIのmember
rolesには暗黙の `@everyone` が含まれないため、`@everyone` role IDを
role配列へ入れる前提にはしません。

Cloudflare Access applicationは少なくとも `/admin/*` を保護し、管理画面と
APIを同じoriginに置いてください。`CMS_ACCESS_HOSTNAMES` も実際の管理画面host
だけに限定します。

## GitHub App

GitHub Appは `acecore-systems/aceserver-wiki` だけへインストールし、次の
repository permissionsだけを付与します。

- Contents: Read and write
- Metadata: Read（GitHubが必須化する既定権限）
- Pull requests: No access

必要なsecretとdeployment固有値は次のとおりです。

| 名前                             | 用途                                  |
| -------------------------------- | ------------------------------------- |
| `CMS_ACCESS_AUD`                 | Access application audience tag       |
| `CMS_ACCESS_TEAM_DOMAIN`         | `https://<team>.cloudflareaccess.com` |
| `CMS_ACCESS_HOSTNAMES`           | 管理画面hostのカンマ区切りallowlist   |
| `CMS_DISCORD_GUILD_ID`           | 許可guild `737538781024092170`        |
| `CMS_DISCORD_AUTHORIZATION_MODE` | 本番は`guild`、他に`account`/`role`   |
| `CMS_DISCORD_ALLOWED_ROLE_IDS`   | `role`時の許可role IDカンマ区切り     |
| `CMS_PUBLICATION_MODE`           | productionでは`direct`固定            |
| `CMS_GITHUB_APP_CLIENT_ID`       | GitHub App client ID                  |
| `CMS_GITHUB_APP_INSTALLATION_ID` | repository installation ID            |
| `CMS_GITHUB_APP_PRIVATE_KEY`     | GitHub AppのPKCS#1/PKCS#8 private key |

Cloudflare PagesのWrangler設定は`secrets.required`をサポートしないため、
上表のsecretはPages dashboardまたはAPIからproduction環境のencrypted
secretsへ登録します。認可・公開modeとrole IDはdeployment varsで上書き
できます。private keyやtokenをrepository、通常のPages vars、ブラウザへ
置かないでください。

## 保存モード

`CMS_PUBLICATION_MODE` は `direct` だけを許可します。expected HEADが一致するとき
だけ`main`へ直接commitし、それ以外の値は503で拒否します。gatewayはPull Requestを
作成せず、GitHub AppにもPull requests権限を付与しません。

編集者の保存がそのままGit pushとなり、
Pagesの再ビルド後に公開されます。D1によるrate limit、BAN、永続監査、
idempotency、応答消失時の再照合を行い、安全に完了を確定できない保存は
成功レスポンスを返しません。

direct publishの対象はgateway allowlist内のWiki Markdownと画像だけです。
source code、Astro schema、CMS設定、Pages Functions、workflowは作業branchから
PRを作り、CIを通して`main`へ反映します。

## gatewayの境界

- repository、branch、content/media rootをコードと環境設定の二重allowlistで固定
- GraphQL ASTを解析し、Sveltiaが必要とするqueryと
  `createCommitOnBranch`だけを許可
- state-changing GraphQLをsame-originかつ`application/json`に限定
- REST readを許可tree/blob SHAだけへ限定
- expected HEAD不一致を409で返す
- Markdown frontmatterをstrict schemaで検証
- raw HTML、MDX import/export、危険なURI、YAML alias/mergeを拒否
- 本文のh1を拒否し、frontmatter由来の記事タイトルだけをh1として表示
- Markdown画像を管理下の`/uploads/wiki/*`だけに限定し、外部画像による追跡を拒否
- 外部リンクへ`rel="ugc nofollow noopener noreferrer"`を付与
- 画像を8 MiB以下のJPEG/PNG/WebPに限定し、拡張子、magic bytes、
  4096 px以下の辺、16 MP以下の画素数を照合
- APNG、animated WebP、GIF、AVIF、SVGを拒否
- Markdown 1ファイルを448 KiB以下に限定し、保存時のgatewayと
  build時のloaderで同じ上限を適用
- 1回の保存を40変更・追加10 MiB以下に限定
- readを1 user 120回/10分、全体60回/10秒かつ240回/10分にD1で制限
- 10分あたり1 user 12 mutation/16 MiB、全体60 mutation/64 MiBをD1で制限
- CMS全体を1000 files、Markdown 64 MiB、画像512 MiB、
  合計512 MiB以下に限定
- path traversal、nested content/media path、管理対象外ファイルを拒否
- 参照切れを防ぐためCMSからのMarkdown・画像削除を拒否
- 削除が必要な場合は、保守担当者がGitHub Appとは別の通常の作業branchから
  参照確認を伴うPull Requestを作成

## ローカル検証

Node.js 24.18.0を使用します。

```bash
cd poc/astro-sveltia
npm ci
npm run cf:typegen
npm run check
npm test
npm run test:migration
npm run test:migration:archive
npm run build
npx wrangler pages functions build
```

`npm run test:migration:acceptance`と、build後の
`npm run test:migration:legacy-acceptance`は移行受入れ時だけ実行します。旧Newtの
対象記事・画像を現在のWikiと突合するため、CMSの通常保存gateには含めません。

旧Nuxt/Newtの公開payloadは、退役前に復元可能なJSONとしてrepositoryへ保全
しました。rootと各記事の公開payload原文を含むため、旧Pages停止後もpayload
SHA-256を保存文字列から再計算できます。旧deploymentへ依存するlive snapshotの
npm入口は取得元の退役に合わせて削除していますが、取得元固定・payload照合・
決定的snapshot生成の実装は`./scripts/snapshot-newt-public.mjs`へ由来証跡として
保持します。旧deployment削除後の通常運用では実行しません。

移行証跡は用途を分けて保存します。

- `migration/newt-initial-production-manifest.json`
  - `main`の`746f19be0a64bb580b289a9846fa3948b9561bf0`に存在した
    `newt-public-payload-manifest.json`の完全な不変コピー
  - custom domainが旧Nuxtを指していた初回移行時のorigin、payload hash、
    15記事の本文hash、初回生成Markdown hashを保持
  - rollback snapshotの再取得や現在の記事編集では更新しない
- `migration/newt-public-payload-manifest.json`
  - 記録済みrollback deploymentから原文を再現するためのmanifest
  - `migration/newt-public-content-snapshot.json`と同じdeployment固有の
    payload hashを保持し、初回production manifestとは独立して扱う

`test:migration`は、保全済みrollback payloadの本文byte数・SHA-256を
rollback再現用manifestと照合します。現在の記事inventoryには依存しないため、
CMSで記事を追加・編集しても原本証跡の継続CIを妨げません。記事・画像の削除は
CMSから行わず、保守担当者が通常の作業branchから参照確認を伴うPull Requestを
作成します。初回production
manifestとの全件突合結果は`MIGRATION-PARITY-2026-07-28.md`へ記録します。

`test:migration:legacy-acceptance`は旧公開15件の受入れ監査用です。
`npm run build`の後に実行し、
保存snapshotとrepository内画像だけによるoffline再生成が現在の15 Markdownへ
一致すること、11画像・redirect・修復済みMarkdownと描画HTML・参加導線を確認
します。通常のCMS保存ゲートには使用せず、将来の記事更新を旧Nuxtの内容へ固定
しません。`npm run build`は現在のMarkdown inventory、schema、SEO、検索、sitemap
などを動的に検証します。

2026-07-29にはNewtモデルAPIから記事32件、カテゴリ9件、リンク3件の全件原本を
追加保存しました。従来の公開15 MarkdownはSHA-256一致を維持し、未公開17件だけを
`draft: true`として決定的に変換しています。下書き本文にあった画像8参照は
manifestへ保存し、7固有画像すべてを公開path外のmigration archiveへ保存し、
うち1件は既存公開assetとの完全一致もhash固定しました。本文へは公開前の
個別確認まで画像を追加しません。Newtメディアライブラリ全72ファイルも一括ZIPで
取得し、ローカルZIPと展開済み72ファイルを検証しました。ZIPと各ファイルの
SHA-256はrepositoryへ保存しています。検証済み原本は維持したまま、完全重複3件を
まとめた69固有画像を`Aceserver-Newt画像整理-2026-07-29`の直下へコピーし、
元UUID・SHA-256・記事用途・現Wiki保全先の対応表もローカルへ保存しました。
GitHub Releaseは作成せず、画像はローカルで内容・現行性・権利を確認してから
必要なものだけ記事単位で新Wikiへ反映します。
公開15件は退役前snapshotとの本文・meta・category履歴照合も固定し、全32件の
ID/slug/本文hash衝突0と表示タイトル重複2群を監査しています。詳細、明示
slug/category mapping、Newt管理画面のモデル・view証跡は
[`NEWT-FULL-MIGRATION-2026-07-29.md`](./NEWT-FULL-MIGRATION-2026-07-29.md)
を参照してください。

ローカルでAccess/GitHub Appを接続する場合だけ、`.dev.vars.example` を
`.dev.vars` へコピーして実値を設定します。exampleはfail closedのため
`CMS_PUBLICATION_MODE=disabled`です。実際の保存E2Eを意図して行う間だけ
`direct`へ変更し、`.dev.vars` はcommitしません。

## Cloudflare Pagesでの公開

Direct Uploadは使いません。現行Pages project
`aceserver-wiki-astro`へGitHub repository
`acecore-systems/aceserver-wiki`を接続します。

- Root directory: `poc/astro-sveltia`
- Build command: `npm ci && npm run build`
- Build output: `dist`
- Production branch: `main`

build commandが`npm ci`を明示しているため、Wrangler varsの
`SKIP_DEPENDENCY_INSTALL=1`でPagesの重複した自動installを止めます。

Git Provider、source repository、GitHub push deployment、preview domainを
確認してから検証します。mainへAstro実装が入る前の初回deployment失敗は
production成功とは扱いません。`asv-wiki.acecore.net` は、
`aceserver-wiki-astro.pages.dev`上でDiscordログイン・保存・再ビルド・rollback
までE2E確認した後にだけ接続します。
branch previewは`CMS_PUBLICATION_MODE=disabled`とし、GitHub App secretを
登録しません。

## 移行状態

- Newtの15記事、6カテゴリ、3ヘッダーリンク、11画像をMarkdownへ移行済み
- 既存URL redirect、検索、sitemap、robots、404、SEO、OGP、広告実装を移行済み
- AdSenseは未審査UGCへ配信しないため全公開ページで無効化済み
- D1監査、rate limit、BAN、idempotency、rollback workflowを実装済み
- Discord OAuth→OIDC broker、Cloudflare Access、GitHub App、Pages productionを
  接続し、Markdown下書きの保存・公開除外を本番E2E確認済み
- 2026-07-27に`asv-wiki.acecore.net`を`aceserver-wiki-astro`へ切替済み
- 2026-07-28の完全移行監査で15記事・11画像・URL・検索・SEOの移行を確認済み
- 同日に旧系削除が承認され、PR #37でrootの旧Nuxt/Newt build経路を削除済み
- merge後のproduction再確認を通し、旧Newt token、旧Wiki用deploy hook、
  旧Pages project `aceserver-wiki`を退役済み
- Newt全32記事のAPI原本を保存し、未公開17件を`draft: true` Markdownへ移行済み
- 下書き画像8参照・7固有原本は自己完結archiveへ保存し、既存asset一致1件も記録済み
- Newtメディアライブラリ全72ファイルはローカルZIPと展開済みフォルダを検証し、
  ZIPと各ファイルのhashをrepositoryへ記録済み。69固有画像のflat整理用コピーも
  ローカルで検証済み。GitHub Releaseは作成せず、Newt削除はローカル選別後に判断

deployment ID、commit SHA、監査結果、復旧点は
[`CUTOVER-2026-07-27.md`](./CUTOVER-2026-07-27.md)に記録しています。
Nuxt公開本文の全件hash、復元用snapshot、構造・リンク・画像の突合結果は
[`MIGRATION-PARITY-2026-07-28.md`](./MIGRATION-PARITY-2026-07-28.md)に記録
しています。
