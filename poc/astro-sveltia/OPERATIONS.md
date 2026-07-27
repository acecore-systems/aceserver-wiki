# ASV Wiki 運用手順

この文書は、Astro・Markdown・Sveltia CMS版のASV Wikiを
Cloudflare Pagesで運用するための手順です。公開コンテンツの正本は
`src/content/wiki/*.md` と `public/uploads/wiki/*`、変更履歴の正本はGitです。

## 本番構成

- GitHub repository: `acecore-systems/aceserver-wiki`
- Cloudflare Pages root: `poc/astro-sveltia`
- Build command: `npm ci && npm run build`
- Build output: `dist`
- Production branch: `main`
- CMS path: `/admin/*`
- CMS認証: Cloudflare Access経由のDiscordログイン
- CMS保存: repository限定GitHub Appによるcommit
- CMS状態: D1 binding `CMS_DATABASE`

Pagesは必ずGitHub連携で作成し、Direct Uploadを本番経路にしません。
rootのYarn projectと独立してnpm installするため、Wrangler varsの
`SKIP_DEPENDENCY_INSTALL=1`でPagesの自動installを止めます。
production以外では`CMS_PUBLICATION_MODE=disabled`とし、GitHub AppとAccessの
secretを登録しません。

## 初回公開ゲート

1. PRのroot CI、Astro CI、OIDC broker CI、依存監査、Pages previewを
   すべてgreenにする。
2. OIDC broker用D1へmigrationを適用する。
3. brokerのRS256 signing keyとAccess client secretを生成する。private keyと
   client secretはrepositoryへ保存せず、公開JWKだけを通常variableにする。
4. Discord applicationのcallbackを`https://wiki-auth.acecore.net/callback`へ
   変更してclient secretを発行し、brokerの3 secretを登録する。
5. brokerを`wiki-auth.acecore.net`へ配備し、discovery、JWKS、authorization
   error、token errorが期待どおりであることを確認する。
6. AccessへGeneric OIDC IdPを追加してProvider Testを通す。
7. production用とpreview用CMS D1へmigrationを適用し、両方でpendingが0件で
   あることを確認する。この作業はAccess設定から独立して先に完了できる。
8. `aceserver-wiki-astro.pages.dev`と`asv-wiki.acecore.net`の`/admin*`だけを
   broker IdP限定で保護し、Access application audienceを取得する。
9. productionへCMS D1 binding、Access設定、GitHub App設定を登録する。
   previewはpreview専用CMS D1 bindingだけを維持する。
10. GitHub連携Pages projectのsource repository、root、build、output、
    production branchを確認してPRをmergeし、`github:push` production
    deploymentを成功させる。
11. `aceserver-wiki-astro.pages.dev`で公開面とCMS保存のE2Eを完了する。
12. `asv-wiki.acecore.net`を切り替え、GitHub push由来のproduction deploymentと
    custom domain activeを確認する。

### D1 migration

repository rootのNode.js 24.18.0を使用します。

```bash
cd poc/discord-oidc-broker
npx wrangler d1 migrations apply OIDC_STATE_DB --remote
npx wrangler d1 migrations list OIDC_STATE_DB --remote

cd ../astro-sveltia
npx wrangler d1 migrations apply CMS_DATABASE --remote
npx wrangler d1 migrations apply CMS_DATABASE --env preview --remote
npx wrangler d1 migrations list CMS_DATABASE --remote
npx wrangler d1 migrations list CMS_DATABASE --env preview --remote
```

broker、CMS production、CMS previewの3つすべての`migrations list`でpendingが
0件になるまで公開しません。Worker/PagesのGit deploymentはD1 migrationを
自動適用しません。

## Cloudflare Access

Access applicationは、`aceserver-wiki-astro.pages.dev`と
`asv-wiki.acecore.net`の両方について`/admin*`をdestinationに指定します。
利用できるlogin methodはWiki専用のOIDC brokerだけに限定し、OTPを含めません。
1つのIdPだけを使うため、instant authenticationを有効にできます。

gatewayは次をすべて検証します。

- Access JWTの署名、issuer、audience、有効期限、application token
  (`type=app`)であること
- 実際のrequest hostname
- OIDC claimから得たDiscord snowflake
- repository、branch、content root、media rootの固定allowlist

`CMS_ACCESS_HOSTNAMES`には実際にAccessで保護したproduction hostnameだけを
カンマ区切りで設定します。初回切替時は
`aceserver-wiki-astro.pages.dev,asv-wiki.acecore.net`です。

`account`モードではAccess JWTの`custom.discord_id`だけをDiscord snowflake
として検証します。Discordの通常OAuth2はOIDC ID token/JWKSを提供しないため
直接接続せず、Wiki専用OIDC brokerを使用します。

Access側はscopeを`openid email`、email claimを`email`、OIDC Claimsを
`discord_id`、PKCEを有効にします。Provider Testと実ログインで
`custom.discord_id`がDiscord snowflakeになることを確認します。Access JWT自身の
top-level `sub`をDiscord IDとして使用しません。

## GitHub App

Wiki専用Appを`aceserver-wiki`だけへinstallし、権限を次に限定します。

- Contents: Read and write
- Pull requests: Read and write
- Metadata: Read（GitHubが必須化する既定権限）

Webhook、GitHub OAuth callback、他repositoryへのinstallは不要です。
private keyはCloudflareのencrypted secretへ直接登録し、repository、通常の
Pages variable、ブラウザ向けbundleへ置きません。

productionで必要な設定は次のとおりです。

| 名前                             | 種別                          |
| -------------------------------- | ----------------------------- |
| `CMS_DATABASE`                   | production D1 binding         |
| `CMS_ACCESS_AUD`                 | Access application audience   |
| `CMS_ACCESS_TEAM_DOMAIN`         | Access team URL               |
| `CMS_ACCESS_HOSTNAMES`           | production hostname allowlist |
| `CMS_GITHUB_APP_CLIENT_ID`       | GitHub App client ID          |
| `CMS_GITHUB_APP_INSTALLATION_ID` | repository installation ID    |
| `CMS_GITHUB_APP_PRIVATE_KEY`     | encrypted secret              |
| `CMS_PUBLICATION_MODE`           | `direct`                      |
| `CMS_DISCORD_AUTHORIZATION_MODE` | `account`                     |

previewはpreview専用D1だけをbindingし、publication modeを`disabled`にします。
PagesのWrangler設定は`secrets.required`をサポートしないため、上表のsecretは
Pages dashboardまたはAPIからproduction環境だけへ登録します。初回公開時と
secret更新後は、productionのsecret名一覧とpreviewにsecretがないことを確認します。

## CSPとFunctions経路

公開HTMLはPages Functionsでレスポンスごとのnonceを生成し、repository内の
信頼済みplaceholderが付いたscriptだけへ注入します。adminは別の最小CSPを
使用します。
HTMLはnonceと本文の不整合を防ぐため`no-store`とし、条件付きrequest headerと
asset側のETagを除去します。CSS、画像、JSON等の静的assetはこの対象外です。

`public/_routes.json`はsecurity headersとnonce処理のため`/*`をFunctionsへ
通します。公開前にPages Functionsのrequest数・上限・課金条件を確認し、
上限到達時に公開面がどう応答するかも検証します。広告実装は保持しますが、
誰でも直接編集できる全公開ページを未審査UGCとして扱い、審査済み判定、
通報窓口、監視・対応時間の運用が整うまでAdSenseを読み込みません。

## 保存と監査

1回の保存は同じidempotency keyを持つ一時branchへcommitした後、非forceの
fast-forwardで`main`へ反映します。GitHubのresponseが失われても、一時branch、
commit marker、唯一の親commit、`main`の包含関係を照合して復旧します。
D1監査を成功へ確定できない場合、gatewayは成功レスポンスを返しません。

- readは1 Discord userあたり10分間に120回、全体で10秒間に60回かつ
  10分間に240回
- mutationは1 Discord userあたり10分間に12回、全体で60回
- mutationの追加量は1 Discord userあたり10分間に16 MiB、全体で64 MiB
- 1回の保存は40変更・追加10 MiB以下
- CMS全体は1000 files、Markdown 64 MiB、画像512 MiB、
  Markdownと画像の合計512 MiB以下
- 画像は8 MiB以下のJPEG/PNG/WebP、4096 px以下の辺、16 MP以下に限定し、
  animationを拒否
- Markdown画像は管理下の`/uploads/wiki/*`だけ、外部リンクは
  `ugc nofollow`として公開
- 成功・失敗replay stateは7日保持
- 不確定stateは30日保持
- cleanupは各requestで最大100件
- audit eventはcleanupせず保持

Git commitやPRにはraw Discord IDを残しません。raw IDとrequest IDの対応は
D1 auditだけに保存します。

### BAN

永久BANの例:

```sql
INSERT INTO cms_bans (
  discord_id, reason, expires_at, created_at, created_by
) VALUES (
  'DISCORD_USER_ID',
  'REASON',
  NULL,
  unixepoch(),
  'OPERATOR'
)
ON CONFLICT(discord_id) DO UPDATE SET
  reason = excluded.reason,
  expires_at = excluded.expires_at,
  created_at = excluded.created_at,
  created_by = excluded.created_by;
```

一時BANは`expires_at`にUnix timeを指定します。解除:

```sql
DELETE FROM cms_bans WHERE discord_id = 'DISCORD_USER_ID';
```

### 監査確認

```sql
SELECT
  occurred_at,
  actor_discord_id,
  request_id,
  status,
  paths_json,
  branch,
  commit_oid,
  http_status,
  detail
FROM cms_audit_events
ORDER BY occurred_at DESC
LIMIT 100;
```

## Rollback

通常のCMS rollbackはGitHub Actionsの`CMS rollback` workflowを手動実行します。

- 対象はfull 40-character SHA
- 理由は1行、1〜300文字
- 対象commitは`main`のancestorかつmerge commitでないこと
- 変更pathはWiki MarkdownまたはWiki画像だけであること

workflowは`git revert`を`main`へpushし、対象SHA、理由、GitHub actorをcommitに
記録します。workflowは必ず`main`をcheckoutし、revert後のAstro buildと公開面
検証が成功した場合だけpushします。CMS mutationの監査正本はD1、rollbackの
監査正本はGit履歴とGitHub Actions runです。revert後はGitHub push由来のPages
deployment成功まで確認します。

## E2E確認

- トップ、15記事、検索、404、sitemap、robotsが期待どおり
- 旧4 URLとMediaWiki互換URLが301
- 検索ページが`noindex, follow`
- 公開ページにSEO、OGP、Bing verificationがある
- 全公開ページがAdSense loaderを持たず、記事の外部リンクが`ugc nofollow`
- 公開面はレスポンスごとに異なるnonceのstrict CSP、admin面は専用CSPが有効
- `/admin/*`はDiscord Access loginなしでは到達できない
- Discord login後にMarkdownと画像を保存できる
- 保存でGitHub commit、D1 succeeded audit、GitHub push deploymentが作られる
- 同一requestの再送で重複commitされない
- BAN userを403、13回目のuser mutationと全体61回目のmutationを429で拒否する
- read、追加量、CMS全体容量の各上限を429または413でfail closedに拒否する
- rollback workflowで対象commitだけを戻せる

### custom domain rollback

切替前に、旧Pages project `aceserver-wiki`のactive deployment ID、commit SHA、
custom domain状態と確認時刻を運用記録へ残します。重大な障害が起きた場合は、
`asv-wiki.acecore.net`を新projectから外して旧projectへ戻し、custom domainが
activeになってからトップ、代表記事、旧URL redirectを再確認します。

切替後も旧Pages projectとNewt設定はrollback window中は削除しません。
Astro版の安定確認後にだけ旧project、Newt token、旧build経路を整理します。
