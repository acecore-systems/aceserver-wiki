# 共有Alpha Chatへの切替

Wikiの`/api/alpha-chat`は、same-origin検証と`CMS_DATABASE`のentry-point rate
limitを維持してから共有Workerへ転送します。ブラウザは共有Workerへ直接アクセスしません。

- chat APIは`ALPHA_CHAT_SERVICE.fetch()`だけを呼びます。Service Binding不在・接続失敗・
  壊れた応答は`503`でfail closedし、WIKI内のローカル生成へは戻りません。
- Wikiの表示履歴はブラウザ内だけに置き、共有Workerが返した不透明な会話コンテキストと
  `personaVersion`を続き質問へ渡します。質問・回答本文をWIKI側で永続化しません。
- 共有WorkerはD1正史、派生Vectorize、モデルsecret、人格、回答ポリシーを所有します。
  Wikiは公開記事、`vector-corpus.json`、Wiki検索indexの同期を所有します。

共有WorkerのPreviewを先にデプロイし、Service Bindingを追加してから、通常のWIKI質問、
正史初回生成、再利用、直後の続きをPreviewで検証します。productionは別D1・別Vectorize
indexを用意し、すべての結果を確認してから共有Worker、WIKIの順に反映します。確認には
個人的な過去や未知の正史質問を使わず、新しい正史をD1へ書き込みません。
