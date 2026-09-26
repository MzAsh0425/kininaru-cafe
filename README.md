# きになるカフェ ☕️

気になったカフェのリンクを貼るだけで、公式HP・食べログ・SNSなどの関連リンク、写真、地図、営業時間などをまとめて身内で共有できる iPhone 向け Web アプリです。

- **フロント**: GitHub Pages（ビルド不要の静的サイト / ホーム画面に追加すればアプリのように使えます）
- **データ・処理**: [Supabase](https://supabase.com)（無料枠で十分）
  - Postgres … 部屋・メンバー・カフェ情報
  - Storage … 収集した写真・アップロードした写真
  - Edge Function `process-cafe` … リンク先の情報収集
- **AI補完（任意）**: Anthropic API キーを設定すると、Claude が Web 検索で公式HP・食べログ・Instagram・営業時間などを探して補完します

## 使い方

1. 合言葉と自分の名前を入れて入室（同じ合言葉を入れた人と同じ部屋になります）
2. 右下の「カフェを追加」からリンクを貼る → 「情報を収集中…」のカードが出る
3. 数十秒〜2分ほどで写真・基本情報付きのカードになります
4. カードをタップすると、写真・リンク・営業時間・地図・メモなど全情報を表示。「編集」から全項目を修正できます

投稿者ごとに色分けされ（色は右上の名前から変更可）、「自分」「相手」「まだ行ってない」「行った」で絞り込めます。

## 情報収集のしくみ

1. 貼られたページを取得し、JSON-LD（構造化データ）・OGP・店舗情報の表（住所/営業時間/定休日…）・SNSリンクを抽出
2. `ANTHROPIC_API_KEY` があれば、Claude が Web 検索で店舗を特定し関連リンクと基本情報を補完
3. 見つかった食べログ・公式HPも取得して、写真と情報を追加
4. 写真は Supabase Storage にコピーして保存（リンク切れ防止）

> 食べログや公式HPのリンクは API キーなしでもかなりの情報が取れます。Instagram のリンクだけだと店名程度しか取れないため、AI補完の設定をおすすめします（1件あたり数十円程度）。

---

## セットアップ

### 1. Supabase プロジェクトを作る

1. https://supabase.com でアカウント作成 → **New project**（リージョンは Tokyo 推奨）。DB パスワードは控えておく
2. **SQL Editor** を開き、[`supabase/migrations/20260926000000_init.sql`](supabase/migrations/20260926000000_init.sql) の中身を貼り付けて **Run**
3. **Project Settings → API** から以下を控える
   - Project URL（`https://xxxx.supabase.co`）
   - `publishable` キー（または `anon` キー）
   - Project ref（URL の `xxxx` 部分）

### 2. Edge Function をデプロイする（GitHub Actions 経由・PC にツール不要）

1. https://supabase.com/dashboard/account/tokens で **Access token** を発行
2. GitHub リポジトリの **Settings → Secrets and variables → Actions** に以下を登録

   | Name | 値 |
   |---|---|
   | `SUPABASE_ACCESS_TOKEN` | 1 で発行したトークン |
   | `SUPABASE_PROJECT_REF` | Project ref |
   | `SUPABASE_DB_PASSWORD` | DB パスワード |
   | `ANTHROPIC_API_KEY` | （任意）https://console.anthropic.com で発行した API キー |

3. **Actions → Deploy Supabase → Run workflow** を実行

> ローカルに Supabase CLI がある場合は `supabase link` → `supabase functions deploy process-cafe --no-verify-jwt` でも可。
> 使用モデルは既定で `claude-opus-5`。費用を抑えたい場合は関数のシークレットに `CLAUDE_MODEL=claude-sonnet-5` などを設定してください。

### 3. フロントの設定

[`js/config.js`](js/config.js) の `SUPABASE_URL` と `SUPABASE_ANON_KEY` を書き換えて push すると、GitHub Pages に反映されます。
（publishable / anon キーはブラウザに公開される前提のキーです。データは合言葉のハッシュを知っている人しか読み書きできません）

### 4. iPhone で使う

1. Safari で GitHub Pages の URL を開く
2. 共有ボタン → **ホーム画面に追加**
3. 相手にも URL と合言葉を伝える

#### （おまけ）共有シートから直接追加するショートカット

「ショートカット」アプリで以下を作ると、Instagram や Safari の共有ボタンから一発で追加画面を開けます。

1. 新規ショートカット → 設定で「共有シートに表示」をオン、入力を「URL」「テキスト」に
2. アクション「URL」に `https://<ユーザー名>.github.io/<リポジトリ名>/?add=` と入力し、末尾に「ショートカットの入力」を追加（「URLエンコード」アクションを挟む）
3. アクション「URLを開く」

## セキュリティについて

- 合言葉は端末上で SHA-256 ハッシュ化され、平文はサーバーに送られません
- テーブルは RLS で直接アクセス禁止にしており、合言葉ハッシュを検証する関数経由でのみ読み書きできます
- 身内向けの簡易な仕組みなので、推測されにくい合言葉を使ってください

## ファイル構成

```
index.html / css/ / js/          フロントエンド（GitHub Pages で配信）
supabase/migrations/             DB スキーマと RPC 関数
supabase/functions/process-cafe/ 情報収集の Edge Function（index.ts: 全体処理と Claude 連携, scrape.ts: ページ解析）
.github/workflows/               Supabase への自動デプロイ
```
