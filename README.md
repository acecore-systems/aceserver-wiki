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

現行の公開コンテンツはビルド時に Newt から取得しています。Newt を廃止する際は、
記事・カテゴリ・リンクをリポジトリ管理のコンテンツへ移行してから
`server/utils/newt.ts` と `NEWT_CDN_API_TOKEN` を削除します。
