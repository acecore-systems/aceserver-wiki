# Wiki認証キーのSecrets Store移行

## 移行後の旧コピー整理（2026-09-12）

Storeへの同値移行は完了しています。Store参照に対応する旧Worker Secretは再配信時に要求せず、削除後の復旧にはStore対応版を使用します。Store本体・接続先側のキー・移行対象外の署名鍵やIDは保持します。以下の旧キー保持・移行前への切り戻しは移行当時の記録であり、整理後には適用しません。

Worker `aceserver-wiki-discord-oidc-broker` の2つのクライアント認証キーを、
既存値のままAcecoreアカウントのStore `f59c889c0fcc405794a34401fb09240c`へ移す。

| 元Worker Secret | 移行先secret名 | binding |
| --- | --- | --- |
| DISCORD_CLIENT_SECRET | aceserver-wiki-discord-oidc-broker-discord-client-secret | DISCORD_CLIENT_SECRET_STORE |
| OIDC_ACCESS_CLIENT_SECRET | aceserver-wiki-discord-oidc-broker-oidc-access-client-secret | OIDC_ACCESS_CLIENT_SECRET_STORE |

HTTP要求ごとに2項目を並行取得し、クライアント認証・Discord OAuth・IPのHMACバケットで
同じ要求内の値を使う。Store取得エラーや不正な長さは固定エラーとして503で拒否し、
旧値への自動fallbackはしない。providerのエラー詳細やキーをログに出さず、長寿命cacheも設けない。
bindingがない開発環境は従来のWorker Secretを使用する。期限切れ状態を掃除するcronはStoreを読まない。

## 切替手順

1. 対象と宛先への承認を確認する。2026-09-12 JSTの保護previewでは2項目とも存在し、1024 bytes以内だった。
2. 一時公開鍵を使う保護preview内の暗号化転送で同じ値を上表の名前へ登録する。値・暗号文・hashをファイルやログへ残さず、既存名には上書きしない。不確定な登録結果を盲目的に再試行しない。
3. 保護preview内でStore値と旧Worker Secretの一致を真偽だけで確認する。
4. CI成功と一致確認後、merge済みソースから`npx wrangler deploy --keep-vars`を実行する。旧Worker Secretは復旧用に残す。
5. 本番versionと2つのStore binding、公開discovery/JWKS、正しいクライアントキーでの認証通過と不正キーでの401を確認する。認証通過の検証は非対応grantで400に停止し、認証コードやユーザーのログインを作らない。Discordのキーは旧値一致とローカルのOAuth送信先検証で確認し、実ユーザーの認証やDiscord投稿を試験として行わない。
6. 異常時は直前のversionへ戻す。事前確認の復旧先は`7bcd987b-6d2f-4311-9007-5cc1d7e10ac0`。実行直前に新しいdeployがないことを再確認する。

## 署名用秘密鍵

`OIDC_SIGNING_PRIVATE_KEY_PEM` は現在のStore上限1024 bytesを超える。
これを収めるための鍵交換や分割は、既存トークン検証や鍵更新の整合性に影響するため行わない。
この移行では署名鍵と公開JWKSを従来の管理方法のまま維持する。

## 検証・現在の状態

型生成・型検査、Worker 56テスト、署名キー生成helper 3テスト、deploy dry-runが成功。
ローカルStoreは`adminSecretsStore`に合成キーを登録し、既存の認証フロー全体を検証する。
追加ケースでは、Storeキーによる認証とIPバケットの一致、次回の更新、Discord OAuthへの使用、
Store障害時のDB未更新・ログ非漏洩・復旧、不正な値から旧値に戻らないことを確認した。

Store登録・本番切替は未実施。

仕様: [Secrets Store Workers integration](https://developers.cloudflare.com/secrets-store/integrations/workers/)。
