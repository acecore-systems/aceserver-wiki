# 共有Alpha Chatへの切替

Wikiの`/api/alpha-chat`は、same-origin検証と`CMS_DATABASE`のentry-point rate
limitを維持してから共有Workerへ転送します。ブラウザは共有Workerへ直接アクセスしません。

- `ALPHA_CHAT_SHARED_ENABLED=false`は既存のWIKI限定RAGを維持する移行状態です。
- `ALPHA_CHAT_SHARED_ENABLED=true`では`ALPHA_CHAT_SERVICE.fetch()`だけを呼びます。
  Service Binding不在・接続失敗・壊れた応答は`503`でfail closedし、ローカルOpenAIへは戻りません。
- Wikiのチャット履歴はブラウザ内だけに置き、直前の正史回答の`loreRevisionId`だけを
  続き質問のアンカーとして共有Workerへ渡します。
- 共有WorkerはD1正史、派生Vectorize、モデルsecret、人格、回答ポリシーを所有します。
  Wikiは公開記事、`vector-corpus.json`、Wiki検索indexの同期を所有します。

共有WorkerのPreviewを先にデプロイし、Service Bindingを追加してから、通常のWIKI質問、
正史初回生成、再利用、直後の続きをPreviewで検証します。productionは別D1・別Vectorize
indexを用意し、すべての結果を確認してから`ALPHA_CHAT_SHARED_ENABLED=true`にします。
