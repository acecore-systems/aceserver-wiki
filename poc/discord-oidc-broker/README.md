# Discord OIDC broker

Cloudflare Access の Generic OIDC と Discord OAuth2 Authorization Code Grant
の間だけを接続する、Wiki 編集画面専用の最小 Worker です。

Discord は OpenID Connect provider ではありません。この Worker が Discord
で本人を確認し、Cloudflare Access が検証できる RS256 ID token を発行します。
Cloudflare Access は唯一の OIDC client として client ID・client secret・
redirect URI の完全一致で固定します。

## セキュリティ境界

- Access → broker は `state`、任意の `nonce`、S256 PKCE を検証します。
- broker → Discord は別の暗号学的乱数 `state` を使います。
- 2 種類の state と短命認可 code は D1 に保存し、条件付き `DELETE ...
RETURNING` で一度だけ消費します。Discord state と broker code はハッシュ
  だけを保存します。期限切れ行は 5 分ごとの Cron で物理削除します。
- Discord には `identify email guilds.members.read` だけを要求します。
  `/users/@me` の verified emailとsnowflake IDに加え、
  `/users/@me/guilds/737538781024092170/member` でエースサーバー公式Discordへの
  所属を毎回確認します。Membership Screeningが`pending`の間は許可しません。
- Discord access token は本人情報取得後に即時 revoke します。revoke 失敗時も
  ID token を発行しません。
- ID token の `sub` と `discord_id` はDiscord user snowflake、
  `discord_guild_id`は所属確認済みguild snowflakeです。Cloudflare Accessでは
  custom claims `discord_id`、`discord_guild_id`、
  `discord_membership_verified_at`を登録し、Wiki gatewayはAccess JWTの
  3 claimを正規の編集者属性として使います。確認時刻はmembership API成功直後の
  Unix秒を文字列で発行します。
- `/authorize`、`/callback`、`/token` は D1 ベースの IP rate limit を
  fail-closed で適用します。bucketはAccess client secretを鍵にした
  HMAC-SHA-256で、raw IPやsaltなしhashを保存しません。
- CORS は有効化しません。ログには code、token、state、nonce、email、
  Authorization header、query string を出しません。自動 invocation log と
  trace も無効にし、固定イベント名だけを構造化ログへ出します。
- discovery と JWKS は公開 endpoint です。この broker 自体を同じ Access
  application で保護すると認証が再帰するため、保護対象に含めません。
- `workers.dev` endpoint は無効です。全 request の origin を固定
  `OIDC_ISSUER` と完全一致で検証し、preview URL や別 Host で同じ issuer の
  応答を返しません。

## Endpoint

| Endpoint                            | Method          | 用途                        |
| ----------------------------------- | --------------- | --------------------------- |
| `/.well-known/openid-configuration` | GET             | OIDC discovery              |
| `/jwks.json`                        | GET             | 公開 RS256 JWK              |
| `/authorize`                        | GET / POST form | Access からの認可要求       |
| `/callback`                         | GET             | Discord からの callback     |
| `/token`                            | POST form       | Access からの code exchange |

`/token` の client authentication は `client_secret_basic` と
`client_secret_post` の両方に対応します。同時指定、重複 parameter、未知の
grant type は拒否します。`userinfo` endpoint は実装も広告もしません。

## 外部設定

### 1. D1

認証専用 DB を作成し、返された ID を `wrangler.jsonc` の
`database_id` に追加します。

```powershell
npx wrangler d1 create aceserver-wiki-oidc
npx wrangler d1 migrations apply aceserver-wiki-oidc --remote
```

認証 state と email は短命です。DB を Wiki CMS 用 D1 と共有しません。

### 2. 非秘密変数

`wrangler.jsonc` の空欄を実値に置き換えます。

- `OIDC_ISSUER`: broker の HTTPS origin。path・query・末尾 slash なし
- `OIDC_ACCESS_CLIENT_ID`: broker 専用のランダムな client ID
- `OIDC_ACCESS_REDIRECT_URIS`:
  `https://<team>.cloudflareaccess.com/cdn-cgi/access/callback`
  （複数ならカンマ区切り）
- `OIDC_SIGNING_PUBLIC_JWK_JSON`: private key に対応する公開 RSA JWK。
  `alg=RS256`、`use=sig`、一意の `kid`、`key_ops=["verify"]`
- `OIDC_SIGNING_PREVIOUS_PUBLIC_JWKS_JSON`: rotation 中だけ残す旧公開 JWK
  の JSON 配列。通常は `[]`
- `DISCORD_CLIENT_ID`: Discord application ID
- `DISCORD_GUILD_ID`: 編集を許可するDiscord guild ID。
  本番は`737538781024092170`に固定

Discord Developer Portal の OAuth2 redirect には
`<OIDC_ISSUER>/callback` だけを登録します。Access callback を Discord 側へ
登録してはいけません。

### 3. 秘密値

実値をファイル、command history、PR、ログへ書かず、対話入力で登録します。

```powershell
npx wrangler secret put OIDC_ACCESS_CLIENT_SECRET
npx wrangler secret put OIDC_SIGNING_PRIVATE_KEY_PEM
npx wrangler secret put DISCORD_CLIENT_SECRET
```

secret binding 名は `wrangler.jsonc` の `secrets.required` を唯一の定義元にし、
実値なしで型生成できます。`.dev.vars.example` はローカル実行用のダミー
template です。本番値をこのファイルへ書いたり commit したりしないでください。
ローカル実行が必要な場合だけ、gitignore 対象の `.dev.vars` に実値を入れます。

署名鍵は最低 2048-bit RSA の PKCS#8 PEM を使います。リポジトリ外へ秘密鍵を
安全に生成し、公開 JWK だけを別ファイルへ出す helper を用意しています。

```powershell
node scripts/generate-signing-key.mjs `
  --private-key C:\secure\aceserver-wiki-oidc-private.pem `
  --public-jwk .\signing-public.jwk.json
```

既存ファイルは上書きせず、秘密鍵を標準出力へ出しません。公開 JWK が private
key と一致しなければ、Worker は自己検証に失敗して token を返しません。

鍵 rotation は次の 3 段階で行います。

1. 旧鍵で署名を続けたまま、新公開 JWK を
   `OIDC_SIGNING_PREVIOUS_PUBLIC_JWKS_JSON` に追加して deploy し、JWKS cache
   へ先行配布する。
2. cache TTL 後、新秘密鍵と新公開 JWK を current に切り替え、旧公開 JWK だけ
   を previous に残して deploy する。
3. 旧鍵で発行済みの ID token、有効な認可要求、JWKS cache がすべて期限切れに
   なった後、旧公開 JWK を previous から削除する。

各段階で current と previous に同じ `kid` を重複させてはいけません。

### 4. Cloudflare Access Generic OIDC

- Auth URL: `<OIDC_ISSUER>/authorize`
- Token URL: `<OIDC_ISSUER>/token`
- Certificate URL: `<OIDC_ISSUER>/jwks.json`
- Client ID / secret: broker 専用値
- PKCE: enabled
- Scopes: `openid`, `email`, `profile`
  - 現行 Cloudflare Access の Generic OIDC が `profile` まで要求するため互換
    目的で受理します。Discordへ要求するscopeは
    `identify email guilds.members.read`で、名前・username・avatarなどの
    profile claimは保存・発行しません。
- Email claim: `email`
- OIDC Claims: `discord_id`, `discord_guild_id`,
  `discord_membership_verified_at`

Identity providerのTestで`oidc_fields.discord_id`と
`oidc_fields.discord_guild_id=737538781024092170`に加え、
`oidc_fields.discord_membership_verified_at`がJSON stringの10桁Unix秒になる
ことを
確認します。Wiki
admin application の policy は `Include > Login Methods > この broker` とし、
メールdomainや個別アドレスでは絞りません。所属確認はbrokerとWiki gatewayの
両方でfail closedに適用します。

### 5. route

broker は Wiki の Access 保護対象 hostname/path と分けます。
discovery/JWKS/authorize/callback/token の全 endpoint を公開できる dedicated
custom domain または route が必須です。`workers_dev` は無効なので、route を
追加しない限り公開されません。Worker route を追加後、以下を実機確認します。

1. discovery の `issuer` と各 endpoint が実 URL と完全一致する。
2. JWKS に `d`, `p`, `q`, `dp`, `dq`, `qi` がない。
3. Access IdP Testが成功し、`oidc_fields.discord_id`と
   `oidc_fields.discord_guild_id`が期待するsnowflake、
   `oidc_fields.discord_membership_verified_at`がJSON stringの10桁Unix秒になる。
4. `/admin/`ログイン後のAccess JWTに`custom.discord_id`と
   `custom.discord_guild_id=737538781024092170`、
   `custom.discord_membership_verified_at`がある。
5. guild参加者はログインでき、非参加者とMembership Screening未完了者は
   `access_denied`になる。
6. 同じbroker codeの再交換と、誤ったPKCE verifierが拒否される。
7. broker hostnameがWiki Access applicationに含まれていない。

## ローカル検証

```powershell
npm ci
npm run cf:typegen
npm run check
npm test
```

テスト用 RSA 鍵は Vitest 起動時にメモリ上で生成し、リポジトリには保存しません。

## 一次資料

- [Cloudflare Access Generic OIDC](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/generic-oidc/)
- [Discord OAuth2](https://docs.discord.com/developers/topics/oauth2)
- [Cloudflare Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
