# エースサーバー Wiki

## 概要

エースサーバーの公式 Wiki ページです。

## ビルド

Node.js 24.18.0 と Corepack を使用します。

```bash
corepack enable
yarn install --immutable
yarn lint
yarn typecheck
yarn test:seo
yarn build
```

静的サイトを生成する場合は、Newt の CDN API トークンをローカルでは
`.env`、Cloudflare Pages では暗号化されたビルド環境変数
`NEWT_CDN_API_TOKEN` として設定し、`yarn generate` を実行します。生成物は
既存の Pages 出力先に合わせて `dist/` に作成されます。トークンをリポジトリや
公開ランタイム設定に含めないでください。

このビルド手順はrollback用に保持している旧Nuxt/Newt実装向けです。
本番公開は2026-07-27にAstro・Markdown版へ切り替えました。旧Pages projectと
Newt設定はrollback window中は削除せず、旧projectからcustom domainを外して
自動deployを停止しています。

## Astro・Markdown版

移行先のWikiは
[`poc/astro-sveltia`](./poc/astro-sveltia/README.md)
にあります。Astro、repository内Markdown、stock Sveltia CMS、Discord OAuthを
受ける[Wiki専用OIDC broker](./poc/discord-oidc-broker/README.md)、
Cloudflare Access、Pages Functionsのcontent gatewayで構成しています。

Newtの公開データはMarkdownへ移行済みです。Astro版のE2E確認と
`asv-wiki.acecore.net`のcustom domain切替も完了しています。旧Nuxt/Newt実装は
rollback用に保持しています。
公開・認証・D1・復旧の手順は
[`poc/astro-sveltia/OPERATIONS.md`](./poc/astro-sveltia/OPERATIONS.md)
を、実施記録は
[`poc/astro-sveltia/CUTOVER-2026-07-27.md`](./poc/astro-sveltia/CUTOVER-2026-07-27.md)
を参照してください。
