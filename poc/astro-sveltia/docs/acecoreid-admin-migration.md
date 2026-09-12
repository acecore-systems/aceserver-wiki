# Wiki管理画面のAcecoreID移行

認証はAcecoreIDとCloudflare Accessに統一する。認可は既存のDiscord account / guild / roleモードを維持する。連携Discord IDだけでguild/role条件を満たしたとは扱わない。

## 変更と維持する境界

- Access JWTの署名・issuer・audience・exp・iat・sub・app種別を検証し、AcecoreIDのsubjectと連携Discord数値IDを必須にする。旧brokerの `discord_id` やメール、Access subによる代替はしない。
- guild/roleモードでは、対象guildの現在のmemberをサイト用Botで照会する。未所属、membership screening未完了、許可ロールなしは拒否。API障害・rate limit・設定欠落・応答異常は許可しない。結果はキャッシュしない。
- accountモードに新たな所属条件を追加しない。現在の本番設定がguildなのにaccountへ緩和することは禁止する。
- D1のDiscord IDによる停止・監査・idempotency、content制限、専用GitHub App、expected HEAD付き保存を維持する。

## 本番切替条件

1. AcecoreID PR #56反映と本人のDiscord連携を確認する。AccessのAcecoreID IdPで `https://acecore.net/claims/subject` と `https://acecore.net/claims/discord-id` をapp tokenの `custom` へ文字列として伝搬する。
2. 現行Access policy・guild ID・mode・role IDs・停止ユーザーの条件を読み取り照合する。ソースの設定はguildだが、稼働中の設定確認を省略しない。
3. 対象guildに所属するサイト用Botの `CMS_DISCORD_BOT_TOKEN` をPages productionのsecretに準備する。既存OAuth client secretや他サービスのBot tokenを流用しない。Bot作成・追加・secret設定は別途準備し、未設定のまま本番へ反映しない。Administrator権限は要求しない。
4. WikiのAccess appだけをAcecoreIDのみにする。既存guild条件を旧broker claimのまま残すと新ログインを拒否するため、新方式と同じ所属条件で照合してから切り替える。Pages Functionsの所属確認を省略しない。
5. GitHub連携deploy後、新規ログイン・session/read API・停止/未所属/ロール削除ユーザーの拒否を確認する。旧Accessセッションを再認証させ、他の利用元がないことを確認して旧brokerを廃止する。

コードの検証だけでは移行完了としない。利用者照合、Bot準備、Access設定と本番検証が残る間はdraftとする。本人のOAuth tokenは読み出さず、追加ログインは求めない。

参照: [Discord Get Guild Member](https://docs.discord.com/developers/resources/guild#get-guild-member)。
