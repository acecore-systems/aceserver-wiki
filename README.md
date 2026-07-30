# エースサーバー Wiki

## 概要

エースサーバー公式Wikiのsource repositoryです。公開サイトはAstroで生成し、
記事の正本はrepository内のMarkdownです。編集画面はSveltia CMS、ログインは
Discord OAuthを受けるOIDC brokerとCloudflare Access、保存はPages Functionsの
content gatewayを使用します。編集者はDiscord OAuthでエースサーバー公式Discord
への参加を確認し、確認から20分を超えたsessionは再ログインまで拒否します。
参加手続きが完了したメンバーだけを編集者として受け入れます。

本番はCloudflare Pages project `aceserver-wiki-astro`にGitHub repositoryを接続し、
`https://asv-wiki.acecore.net`で公開しています。Direct Uploadは使用しません。

## Repository構成

- [`poc/astro-sveltia`](./poc/astro-sveltia/README.md):
  Astro、Markdown、Sveltia CMS、Pages Functions
- [`poc/discord-oidc-broker`](./poc/discord-oidc-broker/README.md):
  Discord OAuthをCloudflare Access用OIDCへ変換するWorker
- [`tests/workflows.test.mjs`](./tests/workflows.test.mjs):
  CMS rollback workflowの安全条件

repository内の旧Nuxt/Newt実装は2026-07-28の完全移行監査と削除承認を受けて
退役しました。
旧公開payload、15記事、11画像、変換結果のhashは
[`poc/astro-sveltia/migration`](./poc/astro-sveltia/migration)に保全し、CIで
offline検証します。

## ローカル検証

Node.js 24.18.0を使用します。

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

OIDC brokerは別projectです。検証手順は
[`poc/discord-oidc-broker/README.md`](./poc/discord-oidc-broker/README.md)
を参照してください。公開・認証・D1・復旧の運用は
[`poc/astro-sveltia/OPERATIONS.md`](./poc/astro-sveltia/OPERATIONS.md)
に、切替と旧系退役の実施記録は
[`poc/astro-sveltia/CUTOVER-2026-07-27.md`](./poc/astro-sveltia/CUTOVER-2026-07-27.md)
と
[`poc/astro-sveltia/MIGRATION-PARITY-2026-07-28.md`](./poc/astro-sveltia/MIGRATION-PARITY-2026-07-28.md)
にあります。
