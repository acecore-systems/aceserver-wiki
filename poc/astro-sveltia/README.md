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

SveltiaへGitHubアカウントやPATを渡しません。コミットとPRにはメールアドレスや
raw Discord user IDを含めず、request IDだけを残します。Discord user IDとの
対応はD1監査だけに保存します。

## 認証と認可

Cloudflare Accessのメール許可ルールは広く設定できますが、gatewayはメールを
認可に使いません。本番既定の`account`モードは、Access JWTの
`custom.discord_id`をDiscord snowflakeとして検証し、
メール検証済みの全Discordアカウントをドメイン制限なしで編集可能にします。

guildまたはroleで制限する場合は、OIDC brokerがDiscord membershipを確認し、
次のcustom claimsをAccess JWTへ渡す必要があります。

- `custom.discord_id`
- `custom.discord_guild_id`
- `custom.discord_roles`（role IDの配列）

Discordの通常OAuth2はOIDC ID tokenとJWKSを提供しないため、Cloudflare Accessの
Generic OIDCへ直接接続しません。専用brokerがDiscordの`identify email` scopeで
本人情報を取得し、OIDC ID tokenへ`discord_id`を発行します。Access側はscopeを
`openid email profile`、OIDC Claimsを`discord_id`、email claimを`email`として
設定し、Access JWTの`custom.discord_id`へ渡します。`profile`はCloudflare
Access互換目的で受理しますが、brokerは名前・username・avatarなどのprofile
claimを保存・発行しません。claimsが欠落・不正の場合、gatewayはfail closedで
拒否します。Access JWT自身のtop-level `sub`はCloudflare側のsubjectなので、
Discord IDとして使用しません。

`CMS_DISCORD_AUTHORIZATION_MODE=guild` では、brokerがguild membershipを
確認したうえで発行した `discord_guild_id` が一致すれば、そのguildの全員を
編集可能にします。`role` では `discord_roles` と
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
- Pull requests: Read and write

必要なsecretとdeployment固有値は次のとおりです。

| 名前                             | 用途                                  |
| -------------------------------- | ------------------------------------- |
| `CMS_ACCESS_AUD`                 | Access application audience tag       |
| `CMS_ACCESS_TEAM_DOMAIN`         | `https://<team>.cloudflareaccess.com` |
| `CMS_ACCESS_HOSTNAMES`           | 管理画面hostのカンマ区切りallowlist   |
| `CMS_DISCORD_GUILD_ID`           | `guild`/`role`時だけ許可するguild ID  |
| `CMS_DISCORD_AUTHORIZATION_MODE` | `account`（既定）、`guild`、`role`    |
| `CMS_DISCORD_ALLOWED_ROLE_IDS`   | `role`時の許可role IDカンマ区切り     |
| `CMS_PUBLICATION_MODE`           | `direct`または`review`                |
| `CMS_GITHUB_APP_CLIENT_ID`       | GitHub App client ID                  |
| `CMS_GITHUB_APP_INSTALLATION_ID` | repository installation ID            |
| `CMS_GITHUB_APP_PRIVATE_KEY`     | GitHub AppのPKCS#1/PKCS#8 private key |

Cloudflare PagesのWrangler設定は`secrets.required`をサポートしないため、
上表のsecretはPages dashboardまたはAPIからproduction環境のencrypted
secretsへ登録します。認可・公開modeとrole IDはdeployment varsで上書き
できます。private keyやtokenをrepository、通常のPages vars、ブラウザへ
置かないでください。

## 保存モード

`CMS_PUBLICATION_MODE` は次の2モードです。

- `direct`（本番既定）: expected HEADが一致するときだけ`main`へ直接commitする。
- `review`: 短期branchへ1 commitを作り、PRを開く。

不明な値は503で拒否します。`direct`なら編集者の保存がそのままGit pushとなり、
Pagesの再ビルド後に公開されます。D1によるrate limit、BAN、永続監査、
idempotency、応答消失時の再照合を行い、安全に完了を確定できない保存は
成功レスポンスを返しません。

stock Sveltiaはgateway独自のPR URLや未マージ状態を表示しません。そのため
`review` は管理者向けの補助モードであり、一般編集者向けの既定にはしません。
保存後の再読込では未マージ内容がmainから再取得され、同じ内容のPRを重ねて
作成できるため、公開利用にはidempotencyと未処理PR上限が別途必要です。

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
- 1回の保存を40変更・追加10 MiB以下に限定
- readを1 user 120回/10分、全体60回/10秒かつ240回/10分にD1で制限
- 10分あたり1 user 12 mutation/16 MiB、全体60 mutation/64 MiBをD1で制限
- CMS全体を1000 files、Markdown 64 MiB、画像512 MiB、
  合計512 MiB以下に限定
- path traversal、nested content/media path、管理対象外ファイルを拒否
- PR作成に失敗したreview branchを削除

## ローカル検証

repository rootのNode.js 24.18.0を使用します。

```bash
cd poc/astro-sveltia
npm ci
npm run cf:typegen
npm run check
npm test
npm run test:migration
npm run build
npm run test:migration:current
npx wrangler pages functions build
```

`snapshot:newt-public`は、記録済みrollback deploymentで公開されているNuxt/Newt
payloadを取得し、15記事の本文を復元可能なJSONとして保存する保全コマンドです。
rootと各記事の公開payload原文も保存するため、旧Pages停止後もpayload SHA-256を
文字列から再計算できます。同じdeploymentから再取得した場合は同一file hashに
なるよう、取得時刻にはpayloadの`prerenderedAt`を使用します。
既定では`https://bba3fffa.aceserver-wiki.pages.dev`だけを読み、Newt tokenは
使用・保存しません。取得元を変える場合だけ、HTTPS originを
`NEWT_MIGRATION_SOURCE_ORIGIN`で指定します。

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
CMSで記事を追加・編集・削除しても原本証跡の継続CIを妨げません。初回production
manifestとの全件突合結果は`MIGRATION-PARITY-2026-07-28.md`へ記録します。

`test:migration:current`は完全移行監査用です。`npm run build`の後に実行し、
保存snapshotとrepository内画像だけによるoffline再生成が現在の15 Markdownへ
一致すること、11画像・redirect・修復済みMarkdownと描画HTML・参加導線を確認
します。通常のCMS保存ゲートには使用せず、将来の記事更新を旧Nuxtの内容へ固定
しません。`npm run build`は現在のMarkdown inventory、schema、SEO、検索、sitemap
などを動的に検証します。

ローカルでAccess/GitHub Appを接続する場合だけ、`.dev.vars.example` を
`.dev.vars` へコピーして実値を設定します。exampleはfail closedのため
`CMS_PUBLICATION_MODE=disabled`です。実際の保存E2Eを意図して行う間だけ
`direct`へ変更し、`.dev.vars` はcommitしません。

## Cloudflare Pagesでの公開

Direct Uploadは使いません。現行Wikiとは別の移行先Pages project
`aceserver-wiki-astro`へGitHub repository
`acecore-systems/aceserver-wiki`を接続します。

- Root directory: `poc/astro-sveltia`
- Build command: `npm ci && npm run build`
- Build output: `dist`
- Production branch: `main`

rootのYarn projectと独立したnpm projectとしてbuildするため、Wrangler varsの
`SKIP_DEPENDENCY_INSTALL=1`でPagesの自動installを止めます。

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
  接続し、Markdown下書きの保存・公開除外・削除を本番E2E確認済み
- 2026-07-27に`asv-wiki.acecore.net`を`aceserver-wiki-astro`へ切替済み
- 旧Pages project `aceserver-wiki`はcustom domainを外して自動deployを停止し、
  rollback用deploymentとNewt設定を保持中

deployment ID、commit SHA、監査結果、復旧点は
[`CUTOVER-2026-07-27.md`](./CUTOVER-2026-07-27.md)に記録しています。
Nuxt公開本文の全件hash、復元用snapshot、構造・リンク・画像の突合結果は
[`MIGRATION-PARITY-2026-07-28.md`](./MIGRATION-PARITY-2026-07-28.md)に記録
しています。
