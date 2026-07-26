# Astro + Sveltia content gateway PoC

公開Wikiを、Git管理のMarkdown、Astro、stock Sveltia CMSへ移行できるかを
検証する並行PoCです。現行のNuxt/Newtサイト、公開設定、コンテンツ正本は
変更しません。このディレクトリを本番へ直接デプロイしないでください。

## 検証する構成

1. Astroが `src/content/wiki/*.md` を静的な記事ページへ変換する。
2. `/admin/` ではforkしていないSveltia CMS 0.172.4を起動する。
3. Cloudflare Accessがログインを担当する。
4. Pages Functionsのcontent gatewayがAccess JWT内のDiscord属性を検証する。
5. gatewayだけがrepository限定のGitHub App installation tokenを保持し、
   許可されたMarkdownと画像だけをGitHubへ保存する。
6. GitHub連携のCloudflare Pagesが、Git pushを契機に再ビルドする。

SveltiaへGitHubアカウントやPATを渡しません。コミットとPRにもメールアドレスを
含めず、監査用にはDiscord user IDだけを記録します。

## 認証と認可

Cloudflare Accessのメール許可ルールは広く設定できますが、gatewayはメールを
認可に使いません。次のcustom claimsをAccess JWTに含めるOIDC IdPが必要です。

- `custom.discord_id`
- `custom.discord_guild_id`
- `custom.discord_roles`（role IDの配列）

DiscordをOIDC IdPとして直接接続できない構成では、KeycloakやAuthentikなどの
OIDC brokerでDiscordログインとguild/role確認を行い、上記claimsをAccessへ
渡します。claimsが欠落・不正の場合、gatewayはfail closedで拒否します。

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
| `CMS_DISCORD_GUILD_ID`           | 許可するDiscord guild ID              |
| `CMS_DISCORD_AUTHORIZATION_MODE` | `guild`（全員）または`role`（限定）   |
| `CMS_DISCORD_ALLOWED_ROLE_IDS`   | `role`時の許可role IDカンマ区切り     |
| `CMS_PUBLICATION_MODE`           | `direct`または`review`                |
| `CMS_GITHUB_APP_CLIENT_ID`       | GitHub App client ID                  |
| `CMS_GITHUB_APP_INSTALLATION_ID` | repository installation ID            |
| `CMS_GITHUB_APP_PRIVATE_KEY`     | GitHub App PKCS#8 private key         |

`wrangler.jsonc` の `secrets.required` にある値、特にprivate keyはCloudflareの
encrypted secretsへ登録します。認可・公開modeとrole IDはdeployment varsで
上書きできます。private keyやtokenをrepository、Pages vars、ブラウザへ
置かないでください。

## 保存モード

`CMS_PUBLICATION_MODE` は次の2モードです。

- `direct`（PoC既定）: expected HEADが一致するときだけ`main`へ直接commitする。
- `review`: 短期branchへ1 commitを作り、PRを開く。

不明な値は503で拒否します。`direct`なら編集者の保存がそのままGit pushとなり、
Pagesの再ビルド後に公開されます。これは「Discord認証した利用者が直接編集する」
検証に合わせた既定値ですが、本番で有効化するのは、Newt移行、rate limit、
BAN、永続監査ログ、復旧手順を整えた後です。

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
- 画像を8 MiB以下のPNG/JPEG/GIF/WebP/AVIFに限定し、拡張子とmagic bytesを照合
- SVG、path traversal、nested content/media path、管理対象外ファイルを拒否
- PR作成に失敗したreview branchを削除

## ローカル検証

repository rootのNode.js 24.18.0を使用します。

```bash
cd poc/astro-sveltia
npm ci
npm run cf:typegen
npm run check
npm test
npm run build
npx wrangler pages functions build
```

ローカルでAccess/GitHub Appを接続する場合だけ、`.dev.vars.example` を
`.dev.vars` へコピーして実値を設定します。`.dev.vars` はcommitしません。

## Cloudflare PagesでのPoC公開

公開が必要になった場合もDirect Uploadは使いません。PRのmerge後に
Cloudflare PagesでGitHub repository `acecore-systems/aceserver-wiki` を接続し、
現行Wikiとは別のPoC専用projectを次の設定で作成します。

- Root directory: `poc/astro-sveltia`
- Build command: `npm run build`
- Build output: `dist`
- Production branch: `main`

Git Provider、source repository、GitHub push deployment、preview domainを
確認してから検証します。現行の `asv-wiki.acecore.net` custom domainは
PoCへ接続しません。PR merge前のbranch previewでは、CMSが保存する`main`と
表示元branchが一致しないため、gateway secretを登録せず表示確認だけを行います。

## このPoCに含まれないもの

- Newtの15記事・カテゴリ・画像のMarkdown移行
- 既存URL、検索、sitemap、広告の完全移植
- Discord OIDC brokerとCloudflare Access applicationの実環境構築
- GitHub Appの実環境作成・secret登録
- rate limit、BAN、D1等の永続監査ログ
- 公開Pages projectやcustom domainの変更

本採用時は、まずNewtを正確にexportして既存URLを保ったMarkdown変換を行い、
表示差分とリンクを検証してから公開ビルドを切り替えます。
