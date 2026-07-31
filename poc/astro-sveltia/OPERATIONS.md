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
build commandが`npm ci`を明示しているため、Wrangler varsの
`SKIP_DEPENDENCY_INSTALL=1`でPagesの重複した自動installを止めます。
production以外では`CMS_PUBLICATION_MODE=disabled`とし、GitHub AppとAccessの
secretを登録しません。

## 初回公開ゲート

1. PRのAstro CI、OIDC broker CI、依存監査、Pages previewを
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

本番は`guild`モードです。Access JWTの`custom.discord_id`をDiscord user
snowflake、`custom.discord_guild_id`をguild snowflakeとして検証し、後者が
エースサーバー公式Discordの`737538781024092170`と完全一致する場合だけ
編集を許可します。guildモードではrole claimを要求しません。
Discordの通常OAuth2はOIDC ID token/JWKSを提供しないため直接接続せず、
Wiki専用OIDC brokerを使用します。

brokerはDiscordへ`identify email guilds.members.read`を要求し、対象guildの
Current User Guild Member endpointが200、かつMembership Screeningが完了して
いる場合だけ`discord_guild_id`を発行します。Discord access tokenは成功・拒否の
どちらでも即時revokeします。

Access側はscopeを`openid email profile`、email claimを`email`、
OIDC Claimsを`discord_id,discord_guild_id`、PKCEを有効にします。
`profile`は現行Cloudflare AccessのGeneric OIDCが要求する
互換scopeであり、brokerは名前・username・avatarなどのprofile claimを
保存・発行しません。Provider Testと実ログインで
`custom.discord_id`がDiscord user snowflake、
`custom.discord_guild_id`が`737538781024092170`になることを確認します。
Access JWT自身のtop-level `sub`をDiscord IDとして使用しません。

membershipはOIDC brokerが新しいDiscordログインを処理する時点で確認します。
発行済みのCloudflare Access sessionは、設定された期限または明示的な失効まで
有効です。Discordから除外しただけでは既存sessionは即時失効しません。

認可切替後はapplicationの`Revoke existing tokens`だけでなく、Zero Trustの
team-domain sessionを失効するか、既存編集者全員のuser sessionを列挙して
失効し、全編集者に再ログインさせます。退会やkickを即時反映する手順は
「対象Discord IDを`cms_bans`へ登録
（gatewayで即時403）→ Zero Trust > Team & Resources > Usersのlast-seen
identityで`oidc_fields.discord_id`を照合して対象userをRevoke → Discordから
削除」です。userを特定できない場合はCMS applicationの全tokenをRevokeします。
再参加を確認するまでBANを解除しません。

### guild認可への切替順序

旧brokerまたは旧Access IdPのままPagesを`guild`モードへ切り替えると、
`discord_guild_id`がないため全編集者を403で拒否します。brokerとAccess IdPを
先に更新してProvider Testを通した後は、旧`account` gatewayでapplication tokenが
再発行される短い窓を残さないため、Pagesの`guild`反映を確認してから既存sessionを
直ちに失効します。旧claimのsessionは新gatewayでfail closedになります。

1. PRのbroker test、Astro test/build、Wrangler dry-runをgreenにする。
2. OIDC D1へ`0002_verified_discord_guild.sql`を適用し、pendingを0にする。
3. reviewed commitからbrokerをdeployし、guild非参加者とMembership Screening
   未完了者が`access_denied`、参加完了者が認証成功になることを確認する。
4. Access IdPのOIDC Claimsを`discord_id,discord_guild_id`の2つにし、
   Provider Testで両方のsnowflakeとguild IDを確認する。
5. PRをmergeし、GitHub push由来のPages production deploymentで`guild`モードを
   反映する。
6. 反映直後に旧認可で発行済みのapplication tokenを失効する。加えて
   team-domain sessionを失効するか、既存編集者全員のuser sessionを列挙して
   失効し、全編集者を新しいDiscordログインへ進ませる。
7. 失効の反映を確認してから、guild参加者の保存・D1 audit・GitHub commit・
   Pages再build、非参加者と
   Membership Screening未完了者の拒否、Access JWTの
   `custom.discord_id`と`custom.discord_guild_id`を本番E2Eで確認する。

切戻しで`account`モードへ戻すと認可を広げるため使用しません。障害時は
`CMS_PUBLICATION_MODE=disabled`で保存をfail closedに停止し、brokerまたは
Access設定を修復します。

## GitHub App

Wiki専用Appを`aceserver-wiki`だけへinstallし、権限を次に限定します。

- Contents: Read and write
- Pull requests: No access
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
| `CMS_DISCORD_AUTHORIZATION_MODE` | `guild`                       |
| `CMS_DISCORD_GUILD_ID`           | `737538781024092170`          |

previewはpreview専用D1だけをbindingし、publication modeを`disabled`にします。
PagesのWrangler設定は`secrets.required`をサポートしないため、上表のsecretは
Pages dashboardまたはAPIからproduction環境だけへ登録します。初回公開時と
secret更新後は、productionのsecret名一覧とpreviewにsecretがないことを確認します。
publication modeを`disabled`にするだけでは、preview branch内の任意コードによる
secret読取を防げません。`CMS_GITHUB_APP_PRIVATE_KEY`がPreview environmentに
存在しないことをCloudflare APIまたはdashboardで必ず別途確認します。

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

## Vectorize検索

通常の`/search-index.json`による文字列検索を常に残し、その結果を先に表示します。
Vectorizeは同じ検索画面へ意味の近い記事を補う用途に限定し、OpenAI API、
Vectorize、D1のいずれかが失敗・timeout・rate limitになった場合は、文字列検索
だけで応答します。

- embedding model: OpenAI `text-embedding-3-large`
- index: 1536 dimensions / cosine
- production index: `aceserver-wiki-search-openai-1536-production`
- namespace: `ja`
- corpus: 公開対象Markdown 15記事からbuild時に生成する
  `dist/vector-corpus.json`
- API: same-originの`POST /api/search`
- minimum score: `0.40`
- rate limit: `CMS_DATABASE`の`semantic_search_rate_limits`を使用し、
  client 20回/分、全体300回/分
- kill switch: `SEARCH_ENABLED`

corpusのchunk IDは本文・記事URL・見出しから決定的に生成します。同期scriptは
現行indexとの差分だけをupsertし、削除はupsert後に行います。管理外ID、index名の
allowlist外、1536/cosine以外、20%を超える削除を既定で拒否します。
Vectorizeのdimensionsは作成後に変更できないため、旧1024次元indexは再利用しません。
1536次元Production indexはGitHub Actions run `30599607992`で
`current=26`、`expected=26`、`upsert=0`、`delete=0`の収束を確認済みです。
Productionは`SEARCH_ENABLED=true`と`ALPHA_CHAT_ENABLED=true`を維持します。
Pages PreviewはVectorize bindingを持たず、両flagを`false`に固定します。
旧indexはproductionの実API確認とrollback期間が終わるまで残します。

### 初回導入

repository rootのNode.js 24.18.0を使用し、次の順序で進めます。

```bash
cd poc/astro-sveltia
npm ci
npm run build
npm run search:sync:dry-run

npx wrangler vectorize create aceserver-wiki-search-openai-1536-production \
  --dimensions 1536 --metric cosine \
  --description "Ace Server Wiki production semantic search (OpenAI text-embedding-3-large, 1536 dimensions)"

npx wrangler d1 migrations apply CMS_DATABASE --env preview --remote
npx wrangler d1 migrations apply CMS_DATABASE --remote
npx wrangler d1 migrations list CMS_DATABASE --env preview --remote
npx wrangler d1 migrations list CMS_DATABASE --remote
```

Production同期workflowは次のGitHub Environmentだけを参照し、deployment
branchを`main`だけに制限します。

| Environment                         | Secrets                                                         |
| ----------------------------------- | --------------------------------------------------------------- |
| `cloudflare-wiki-search-production` | `CLOUDFLARE_WIKI_SEARCH_PRODUCTION_API_TOKEN`, `OPENAI_API_KEY` |

Cloudflare tokenは対象accountのVectorize Writeに必要な最小権限だけを付与します。
OpenAI keyはこの用途専用projectへ限定し、project側の
rate limitと予算上限を設定します。workflowは任意PRのcodeへsecretを渡さず、
protected `main`の同期scriptだけを実行します。
既存のPreview用Environment、token、index、Pages secretはこの変更では削除しませんが、
workflow、binding、移行gateからは参照しません。ProductionのPages runtime secret
`OPENAI_API_KEY`の値は`wrangler.jsonc`、`.dev.vars.example`、workflow logへ書きません。

1. Productionの`SEARCH_ENABLED=true`と`ALPHA_CHAT_ENABLED=true`、
   Previewの両flagが`false`でVectorize bindingがないことを確認する。
2. PRをmergeし、GitHub repository連携によるPages production deploymentと
   `/.well-known/aceserver-wiki-build.json`のcommit/corpus version一致を確認する。
3. Production同期workflowを実行し、全件収束後に再実行してno-opを確認する。
   workflowはlive同期時だけ
   `--confirm-production aceserver-wiki-search-openai-1536-production`を渡し、
   `--allow-large-delete`は渡さない。
4. custom domainで文字列検索、意味検索、API障害時fallbackを再確認する。

Previewは有効化PR後も`SEARCH_ENABLED=false`と`ALPHA_CHAT_ENABLED=false`のままです。
`SEARCH_ENABLED=false`の間も文字列検索は動作します。緊急停止はProductionの値を
`false`へ戻してGitHubへpushし、Pagesの`github:push` deploymentを通します。
Direct Uploadや手動uploadを復旧経路にしません。

## アルファくん WIKI案内チャット

アルファくんは全公開ページからsame-originの`POST /api/alpha-chat`を呼び出します。
このWikiの`SEARCH_INDEX`と`/vector-corpus.json`だけをRAGの情報源とし、
Pages FunctionからOpenAIへ直接接続します。回答モデルはResponses APIの
`OPENAI_RESPONSE_MODEL=gpt-5.6-luna`、
`OPENAI_REASONING_EFFORT=medium`、`store=false`です。Cloudflare AI Gatewayや
Workers AIは経由しません。ルール、コマンド、
参加条件などをポータルやモデルの固定知識から補いません。取得したWiki根拠で
確認できない質問は「確認できない」と明示し、一般論から可否を推測しません。

応答の`answer`と`sources`は分離し、`sources`には根拠へ採用した同一originの
`/article/` URLと記事タイトルだけを最大2件入れます。モデルには
Responses APIのstrictな`text.format` JSON Schemaで根拠番号とWiki本文からの
完全一致引用だけを選ばせ、
サーバーが取得済みchunkに対して番号・引用・文字数を検証します。モデル生成文は
公開せず、検証済み引用から
サーバーが固定文を組み立てます。検証できない選択は`502`、回答根拠がない選択は
固定の「確認できない」回答へ戻します。
`/vector-corpus.json`はPagesの`ASSETS` bindingを優先してdeployment固有assetから
読みます。ブラウザ側は
`innerHTML`を使わず本文とリンクをDOM APIで構築します。入力上限は500文字です。

AI呼び出し前に`CMS_DATABASE`の`semantic_search_rate_limits`を使用し、
60秒窓でclient 5回、全体60回に制限します。clientは
`CF-Connecting-IP`を優先し、取得できない場合は
`X-Acecore-Chat-Client`のUUIDからSHA-256 keyを作ります。不正・欠落したUUIDは
`anonymous`枠を共有します。超過は`429`と`Retry-After: 60`で拒否し、
D1障害時はAIを呼ばず`503`でfail closedにします。

`ALPHA_CHAT_ENABLED=false`はchat APIのkill switchです。緊急停止時は
`wrangler.jsonc`のrootとpreviewを意図した値へ揃え、review済みcommitを
GitHubへpushし、GitHub連携Pages deploymentから反映します。Direct Uploadや
dashboardだけの恒久的な上書きを正本にしません。

### Preview非VectorizeゲートとProduction実AIゲート

unit testやWrangler bundle成功だけではOpenAI APIとVectorizeの実接続を証明
できません。一方、通常のPages PreviewへProduction相当の書込み可能bindingは
渡しません。次の順序で確認します。

1. Node.js 24.18.0で次のローカルgateを通す。

   ```bash
   cd poc/astro-sveltia
   npm ci
   npm run cf:typegen
   npm run check
   npm run test:unit -- tests/alpha-chat.test.ts
   npm test
   npm run build
   npx wrangler pages functions build
   ```

2. Previewに`SEARCH_INDEX`がなく、preview専用`CMS_DATABASE`だけがbinding
   されていることを確認する。varsは
   `SEARCH_ENABLED=false`、`ALPHA_CHAT_ENABLED=false`、
   `OPENAI_RESPONSE_MODEL=gpt-5.6-luna`、
   `OPENAI_REASONING_EFFORT=medium`、
   `OPENAI_EMBEDDING_MODEL=text-embedding-3-large`、
   `OPENAI_EMBEDDING_DIMENSIONS=1536`、
   `CMS_PUBLICATION_MODE=disabled`とし、GitHub App secretは置かない。
3. Previewの`/.well-known/aceserver-wiki-build.json`のcommit・corpus versionが
   review対象と一致し、`/search-index.json`の文字列検索が動作することを確認する。
   `/api/search`と`/api/alpha-chat`は`503`でfail closedすることを確認する。
4. Production indexの同期を2回通し、2回目がno-opであることを確認する。
   現行の収束証跡はGitHub Actions run `30599607992`で、
   `current=26`、`expected=26`、`upsert=0`、`delete=0`。
   Productionの`SEARCH_ENABLED`と`ALPHA_CHAT_ENABLED`は`true`を維持する。
5. UUIDをclient headerへ付け、Productionへ根拠が存在する質問を実送信する。

   ```bash
   curl -sS -X POST "https://asv-wiki.acecore.net/api/alpha-chat" \
     -H "Content-Type: application/json" \
     -H "Origin: https://asv-wiki.acecore.net" \
     -H "X-Acecore-Chat-Client: 11111111-1111-4111-8111-111111111111" \
     --data '{"question":"サバイバルサーバーで使えるコマンドを教えて"}'
   ```

6. `200`、`ok: true`、空でない`answer`、1件以上のstructured `sources`を確認し、
   各URLが実在する同一originの`/article/`で、回答内容がその記事の記載範囲内
   であることを目視する。
7. Wikiに記載がない可否質問も送信し、根拠のない断定をせず「確認できない」と
   明示することを確認する。rate-limit境界は同一固定60秒窓の通算6回目が
   `429`かつ`Retry-After: 60`になることを記録する。Pagesでは
   `CF-Connecting-IP`をclient keyへ優先するため、同じ送信元からUUIDだけを
   変えても枠は分離されない。
8. Production URL、deployment commit、corpus version、モデル名、質問、status、
   出典URLを関連PRへ記録する。timeout時はrequest契約を再確認してから一度再試験し、
   1回のtimeoutだけで実装不良または成功と判定しない。

## 保存と監査

1回の保存は同じidempotency keyを持つ一時branchへcommitした後、非forceの
fast-forwardで`main`へ反映します。GitHubのresponseが失われても、一時branch、
commit marker、唯一の親commit、`main`の包含関係を照合して復旧します。
D1監査を成功へ確定できない場合、gatewayは成功レスポンスを返しません。

このdirect publishはCMS管理対象のMarkdownと画像だけに限定します。source code、
Astro schema、CMS設定、Pages Functions、workflowは作業branchのPRとCIで
`main`へ反映します。
参照中の記事・画像を誤って消さないよう、CMSからの削除は拒否します。削除が
必要な場合は、保守担当者がGitHub Appとは別の通常の作業branchから参照確認を
含むPull Requestを作成します。

- readは1 Discord userあたり10分間に120回、全体で10秒間に60回かつ
  10分間に240回
- mutationは1 Discord userあたり10分間に12回、全体で60回
- mutationの追加量は1 Discord userあたり10分間に16 MiB、全体で64 MiB
- Markdown 1ファイルは448 KiB以下。保存時のgatewayとbuild時のloaderで
  同じ上限を適用
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
- 全公開ページにWikiアイコンのアルファくんdialogと外部`/alpha-chat.js`があり、
  keyboard操作、500文字上限、message log、CSP nonceが有効
- Production有効化後の実AI質問がWiki根拠とstructured sourcesを返し、根拠なし質問を
  「確認できない」と扱い、client 6回目/分を429で拒否する
- `/admin/*`はDiscord Access loginなしでは到達できない
- guild参加・Membership Screening完了済みのDiscord userだけがログインし、
  Markdownと画像を保存できる
- guild非参加者、Membership Screening未完了者、別guild claimを拒否する
- 保存でGitHub commit、D1 succeeded audit、GitHub push deploymentが作られる
- 同一requestの再送で重複commitされない
- BAN userを403、13回目のuser mutationと全体61回目のmutationを429で拒否する
- read、追加量、CMS全体容量の各上限を429または413でfail closedに拒否する
- rollback workflowで対象commitだけを戻せる

### 旧Pages退役後の復旧境界

2026-07-28の完全移行監査と明示承認後、repositoryの旧build経路、Newt tokenと
旧Wiki用deploy hook、旧Pages project `aceserver-wiki`を退役しました。
旧projectと記録済みrollback deploymentは削除済みのため、旧Nuxtへcustom domainを
戻す手順は使用できません。

記事の誤更新はCMS rollback workflowで対象commitだけを戻し、`main`へのGitHub push
から`aceserver-wiki-astro`を再deployします。Pages project自体の再作成が必要な
場合もDirect Uploadは使用せず、このrepositoryをGitHub連携し、production成功後に
`asv-wiki.acecore.net`を再接続します。

退役の実施状態、保持した証跡、復旧境界は
[`CUTOVER-2026-07-27.md`](./CUTOVER-2026-07-27.md)と
[Issue #35](https://github.com/acecore-systems/aceserver-wiki/issues/35)へ記録します。
