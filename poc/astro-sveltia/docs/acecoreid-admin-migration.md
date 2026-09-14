# Wiki管理画面のAcecoreID移行

認証はAcecoreIDとCloudflare Accessに統一する。認可は既存のDiscord account / guild / roleモードを維持する。連携Discord IDだけでguild/role条件を満たしたとは扱わない。

## 変更と維持する境界

- Access JWTの署名・issuer・audience・exp・iat・sub・app種別を検証し、AcecoreIDのsubjectと連携Discord数値IDを必須にする。旧brokerの `discord_id` やメール、Access subによる代替はしない。署名済みJWTのcustomで片方または両方が欠ける場合だけ、同じAccess issuerのfull identityを参照し、JWT subとuser UUID、Acecore account、AcecoreID OIDC provider、両claimの一致を確認する。不正な直接claimや情報源間の不一致は補完しない。
- guild/roleモードでは、対象guildの現在のmemberをサイト用Botで照会する。未所属、membership screening未完了、許可ロールなしは拒否。API障害・rate limit・設定欠落・応答異常は許可しない。結果はキャッシュしない。
- accountモードに新たな所属条件を追加しない。現在の本番設定がguildなのにaccountへ緩和することは禁止する。
- D1のDiscord IDによる停止・監査・idempotency、content制限、専用GitHub App、expected HEAD付き保存を維持する。

## 本番切替条件

1. AcecoreIDのDiscord連携機能を反映する。AccessのAcecoreID IdPで `https://acecore.net/claims/subject` と `https://acecore.net/claims/discord-id` をapp tokenの `custom` へ文字列として伝搬する。全編集者の事前連携完了は切替待ちの条件にしない。未連携の編集者は次回利用時に本人がAcecoreIDでDiscordを連携し、Wikiの「ログイン情報を更新」からこのサイトの古いAccess cookieだけを破棄して再ログインする。
2. 現行Access policy・guild ID・mode・role IDs・停止ユーザーの条件を読み取り照合する。ソースの設定はguildだが、稼働中の設定確認を省略しない。
3. 専用Discord application「ASV Wiki」のBotを対象guildへ追加し、本人が取得したtokenをSecrets Storeの `aceserver-wiki-production-discord-bot-token`（scope: Workers）へ直接入力する。PagesのSecretには保存しない。`workers/discord-membership/wrangler.jsonc` の非公開Workerを先にdeployし、Pages productionの `CMS_DISCORD_MEMBERSHIP` Service Bindingから所属確認する。既存OAuth client secret、Alpha Bot、他サービスのBot token、本人のOAuth tokenは読み取り・流用しない。Botのguild追加・Store保存・Worker実機確認は本番切替gateであり、未完了のままPages/Accessを切り替えない。Administrator権限は要求しない。
4. WikiのAccess appだけをAcecoreIDのみにする。既存guild条件を旧broker claimのまま残すと新ログインを拒否するため、新方式と同じ所属条件で照合してから切り替える。Pages Functionsの所属確認を省略しない。
5. GitHub連携deploy後、新規ログイン・session/read API・停止/未所属/ロール削除ユーザーの拒否を確認する。旧Accessセッションを再認証させ、他の利用元がないことを確認して旧brokerを廃止する。

コードの検証だけでは移行完了としない。専用Botのguild追加とproduction secret入力、Access設定、本番検証が残る間はdraftとする。全編集者の事前連携を待たず、未連携者は次回本人利用時に案内する。本人のOAuth tokenやBot tokenをログ・PRへ記載しない。

参照: [Discord Get Guild Member](https://docs.discord.com/developers/resources/guild#get-guild-member)。

## Secrets Storeと所属確認Worker

- Secrets Storeを資格情報の正本とする。秘密値はGit・台帳・ログ・PR・Pages・レスポンスへ転記しない。
- Worker `aceserver-wiki-discord-membership` はworkers.dev・preview URL・routesを無効にし、production PagesのService Bindingだけから呼ぶ。preview Pagesにはbindingを設定しない。新しい共有APIキーは増やさない。
- Workerが固定guildのmemberだけを照会する。呼び出し元が任意URL・別guildを指定することはできない。渡すのは検証済みDiscord IDとguild ID、返すのは一致確認用IDとrolesのみ。JWT・cookie・メール・Bot tokenは渡さない。
- Store読取失敗・Discord障害・不正応答では503、未所属・screening未完了では403。Pagesは自身の既存role条件とD1停止条件を引き続き確認する。資格情報・所属結果はキャッシュしない。
- `npm run cf:typegen`、`npm run check`、`npm test`、`npm run membership:build` をCIでも実施する。Storeの値が未登録でもdry-runは通るため、本番稼働の証明とはしない。
- 本番作業順: Store保存 → Botのguild参加確認 → `npx wrangler whoami` → `npx wrangler deploy --config workers/discord-membership/wrangler.jsonc` → 公開URL無効・Store binding・内部所属確認検証 → PR merge → GitHub pushによるPages本番deploy → Access切替 →本人のログイン/read API確認。
- Bot token更新はStoreの同じ秘密名を更新する。参照Workerと所属判定を確認してから旧資格情報を廃止する。GitHub App秘密鍵等の既存Pages秘密情報は別途移行対象であり、この変更だけで全資格情報移行完了とはしない。
