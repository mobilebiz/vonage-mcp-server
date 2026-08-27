# デプロイ手順 / Deployment Guide

Vonage MCP Server (Streamable HTTP 版) を各プラットフォームにデプロイする手順です。

> [!WARNING]
> **このサーバーは、あなたの Vonage アカウントで課金が発生する操作を外部に開放します。**
> 認証を設定せずに外部公開しないでください。認証が未設定の場合、サーバーは `127.0.0.1` でのみ待ち受け、認証なしで `BIND_HOST` に外部アドレスを指定すると**起動時にエラーで停止**します。

> [!IMPORTANT]
> **必ず単一インスタンスで動かしてください。**
> レートリミット・配信ステータス・Webhook のリプレイ検出はすべてプロセス内のメモリに保持されます。複数インスタンスでは、
> - **レートリミットが実効的にインスタンス数倍に緩みます**
> - Webhook が別インスタンスに届くと `get_sms_status` が機能しません
>
> Cloud Run なら `--max-instances=1` を指定してください。

---

## 共通: 最低限の環境変数

```sh
# 使う機能を有効にする（既定ではツールが1つも公開されない）
ENABLE_SMS=true

# 資格情報
VONAGE_APPLICATION_ID=...
VONAGE_PRIVATE_KEY_PATH=/secrets/private.key

# 被害額の上限
RATE_LIMIT_PER_HOUR=5

# Webhook の署名検証（配信ステータスを使う場合は必須）
VONAGE_API_SIGNATURE_SECRET=...
```

認証は次のどちらかを選びます。

| 方式 | 設定 | 向いている場面 |
| --- | --- | --- |
| プラットフォーム IAM | `TRUST_UPSTREAM_AUTH=true` | Cloud Run / API Gateway の手前で認証できる場合（**推奨**） |
| Bearer トークン | `MCP_AUTH_TOKEN=...` | IAM を挟めない場合、または MCP クライアントが Bearer しか話せない場合 |

---

## Google Cloud Run

### 前提

```bash
gcloud services enable run.googleapis.com secretmanager.googleapis.com cloudbuild.googleapis.com
export PROJECT_ID="your-project-id"
export REGION="asia-northeast1"
export SERVICE_NAME="vonage-mcp-server"
```

### 1. 秘密鍵を Secret Manager に登録する

```bash
gcloud secrets create vonage-private-key --data-file="./private.key" --project=$PROJECT_ID
```

### 2. 認証方式を決める

**先に決めてください。後から変えると URL の再登録が必要になります。**

| | 方式A: Cloud Run IAM | 方式B: Bearer トークン |
| --- | --- | --- |
| デプロイ | `--no-allow-unauthenticated` | `--allow-unauthenticated` |
| 認証を担うもの | Google の IAM | このサーバー（`MCP_AUTH_TOKEN`） |
| **配信ステータス (DLR)** | **受け取れません** | 受け取れます |
| 使える MCP クライアント | **IAM トークンを付けられるものだけ** | ほぼすべて |

> [!IMPORTANT]
> **方式A では Vonage からの Webhook が届きません。**
>
> Cloud Run の IAM は**サービス全体**に掛かり、パスごとに外せません。Vonage は Google の IAM トークンを付けられないので、`--no-allow-unauthenticated` にすると **Status Webhook が 403 で弾かれます。** その結果 `get_sms_status` は永久に `submitted` のままになります。
>
> また **Claude / Gemini Enterprise / Dify / n8n はいずれも IAM トークンを付けられません。** 方式A が使えるのは、自作のクライアントやサービスアカウント経由で呼ぶ場合に限られます。
>
> **迷ったら方式B を選んでください。**

### 3. デプロイする

#### 方式B: Bearer トークン（通常はこちら）

```bash
# トークンを生成して Secret Manager に登録する
openssl rand -hex 32 | gcloud secrets create mcp-auth-token --data-file=- --project=$PROJECT_ID

gcloud run deploy $SERVICE_NAME \
  --source . \
  --project $PROJECT_ID \
  --region $REGION \
  --allow-unauthenticated \
  --max-instances=1 \
  --min-instances=1 \
  --set-env-vars="ENABLE_SMS=true" \
  --set-env-vars="RATE_LIMIT_PER_HOUR=5" \
  --set-env-vars="ALLOWED_NUMBERS=+819012345678" \
  --set-env-vars="VONAGE_APPLICATION_ID=YOUR_APPLICATION_ID" \
  --set-env-vars="VONAGE_PRIVATE_KEY_PATH=/secrets/private.key" \
  --set-secrets="/secrets/private.key=vonage-private-key:latest" \
  --set-secrets="MCP_AUTH_TOKEN=mcp-auth-token:latest"
```

デプロイ後、**サービスのホスト名を `ALLOWED_HOSTS` に設定して再デプロイ**してください（DNS rebinding 対策）。URL はデプロイしないと確定しないため、2段階になります。

```bash
HOST=$(gcloud run services describe $SERVICE_NAME --region=$REGION \
  --format='value(status.url)' | sed 's|https://||')

gcloud run services update $SERVICE_NAME --region=$REGION \
  --update-env-vars="ALLOWED_HOSTS=$HOST"
```

#### 方式A: Cloud Run IAM

**Webhook を使わず、呼び出し側が IAM トークンを付けられる場合のみ**です。

```bash
gcloud run deploy $SERVICE_NAME \
  --source . \
  --project $PROJECT_ID \
  --region $REGION \
  --no-allow-unauthenticated \
  --max-instances=1 \
  --min-instances=1 \
  --set-env-vars="TRUST_UPSTREAM_AUTH=true" \
  --set-env-vars="ENABLE_SMS=true" \
  --set-env-vars="RATE_LIMIT_PER_HOUR=5" \
  --set-env-vars="VONAGE_APPLICATION_ID=YOUR_APPLICATION_ID" \
  --set-env-vars="VONAGE_PRIVATE_KEY_PATH=/secrets/private.key" \
  --set-secrets="/secrets/private.key=vonage-private-key:latest"

gcloud run services add-iam-policy-binding $SERVICE_NAME \
  --region=$REGION \
  --member="serviceAccount:CALLER@$PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/run.invoker"
```

> [!WARNING]
> **`TRUST_UPSTREAM_AUTH=true` はサーバー自身の認証を無効にします。**
> `--allow-unauthenticated` と組み合わせると**誰でも SMS を送れる状態**になります。起動のたびに警告が出るのはこのためです。

### 4. インスタンス数の指定について

**`--max-instances=1` と `--min-instances=1` を両方指定してください。** 理由が別々にあります。

| 設定 | 理由 |
| --- | --- |
| `--max-instances=1` | レートリミットはプロセス内メモリなので、**インスタンスが増えると上限がその数だけ緩みます**（毎時5件を3インスタンスで動かせば15件） |
| `--min-instances=1` | **インスタンスがゼロに落ちるとメモリが消えます** |

**`--min-instances` を省くとレートリミットが実質無効になります。** Cloud Run は既定でアイドル時にインスタンスを停止するため、次のことが起きます。

- **レートリミットの計数がリセットされます。** 5件送って停止し、再起動後にまた5件送れます
- **送信記録が消えます。** その後に届いた DLR は「知らない `message_id`」として隔離バッファに回され、`get_sms_status` で取得できなくなります

> [!NOTE]
> `--min-instances=1` は**インスタンスが常時起動する**ため課金が発生します。それが許容できない場合は、レートリミットが上限として機能しないことを前提に、**Vonage アカウント側の利用額上限を主たる防御としてください。**

#### アイドル時にいつ停止するのか

[公式ドキュメント](https://docs.cloud.google.com/run/docs/about-instance-autoscaling)は **「最大15分」**としていますが、`might` / `up to` という書き方で**保証ではありません**。デプロイ時やインフラのメンテナンス時にも停止します。

**問題になるのは「何分後に照会するか」ではなく、「送信から DLR 到着までの間に再起動が挟まるか」です。**

1. 送信 → `recordSubmitted()` がメモリに記録する
2. **ここで停止すると記録が消える**
3. Vonage が DLR を POST → **新しいインスタンスが起動する**（Webhook 自体が起動トリガーになります）
4. その DLR は「知らない `message_id`」として**隔離バッファ**に入る
5. `get_sms_status` では取り出せない

隔離バッファから本ストアへ移るのは `recordSubmitted()` が呼ばれたときだけです。**再起動後にその送信の `recordSubmitted()` が呼ばれることはもう無い**ため、そのメッセージのステータスは**永久に取得できません**。

日本宛の DLR は通常数秒〜数十秒で届くので、**連続して操作している限り実用上は問題になりません。** 検証目的なら `--min-instances=0`（既定）で十分です。**本番運用で配信ステータスを当てにする場合にだけ `1` を検討してください。**

### 5. 動作確認

```bash
URL=$(gcloud run services describe $SERVICE_NAME --region=$REGION --format='value(status.url)')

# ヘルスチェック（認証不要）
curl "$URL/health"
# => {"status":"ok","connected":true,"version":"2.0.0"}

# ツール一覧（Accept ヘッダーが必要）
TOKEN=$(gcloud secrets versions access latest --secret=mcp-auth-token)
curl -X POST "$URL/mcp" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/json, text/event-stream" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

**`version` が期待どおりか確認してください。** 古いリビジョンが動いていることに気づかず調査を続けるのは、よくある時間の浪費です。

`tools` が空の場合、**capability が有効になっていません。** 起動ログを確認してください。

```bash
gcloud run services logs read $SERVICE_NAME --region=$REGION --limit=50
```

### 6. Webhook を登録する（方式B のみ）

Vonage Dashboard の Application 設定で、次の3つを登録します。

| 設定項目 | URL | メソッド |
| --- | --- | --- |
| Status URL（SMSの配信結果） | `https://YOUR_SERVICE_URL/webhooks/message-status` | POST |
| Answer URL（音声の着信） | `https://YOUR_SERVICE_URL/webhooks/voice/answer` | **POST** |
| Event URL（通話イベント） | `https://YOUR_SERVICE_URL/webhooks/voice/event` | POST |

> [!IMPORTANT]
> **Answer URL のメソッドは POST に変更してください。** 既定の GET では `405` になります（署名検証にリクエストボディが必要なため）。
>
> **Event URL は、通話が失敗した理由が届く唯一の経路です。** 登録しないと `get_call_status` は `detail` も `sip_code` も返せず、`busy` が「相手が通話中」なのか「その宛先への経路が無い」のか切り分けられません。

**`VONAGE_API_SIGNATURE_SECRET` を設定してください。** 未設定だと上記3つのエンドポイントはすべて `503` を返して無効化されます（fail-closed）。**着信は無応答のまま切断され、通話イベントも一切記録されません。**

あわせて、**アプリケーションの署名付き Webhook が有効か確認してください。** 古いアプリケーションでは既定で無効になっており、その場合は `401` が返り続けます。

```bash
echo -n "YOUR_SIGNATURE_SECRET" | gcloud secrets create vonage-signature-secret --data-file=-
gcloud run services update $SERVICE_NAME --region=$REGION \
  --set-secrets="VONAGE_API_SIGNATURE_SECRET=vonage-signature-secret:latest"
```

### Cloud Run 固有のつまずき

| 症状 | 原因 |
| --- | --- |
| Webhook が届かない | **`--no-allow-unauthenticated` になっていませんか。** 方式A では届きません |
| `403 Forbidden` | `ALLOWED_HOSTS` にサービスのホスト名が入っていません |
| `406 Not Acceptable` | POST に `Accept: application/json, text/event-stream` が必要です |
| 起動直後にコンテナが落ちる | 設定値の検証エラーです。ログに理由がまとめて出ています |
| レートリミットが効いていないように見える | `--min-instances=1` が無く、インスタンスが再起動しています |

---

## Docker Compose

ローカルや自前サーバーで動かす場合の最小構成です。

```yaml
services:
  vonage-mcp:
    build: .
    # 認証を設定しない場合、コンテナ内で 127.0.0.1 にのみ bind される。
    # ホストから使うには MCP_AUTH_TOKEN を設定して BIND_HOST を開ける必要がある。
    ports:
      - "127.0.0.1:3000:3000"
    environment:
      ENABLE_SMS: "true"
      RATE_LIMIT_PER_HOUR: "5"
      VONAGE_APPLICATION_ID: "${VONAGE_APPLICATION_ID}"
      VONAGE_PRIVATE_KEY_PATH: "/secrets/private.key"
      MCP_AUTH_TOKEN: "${MCP_AUTH_TOKEN}"
      BIND_HOST: "0.0.0.0"
      VONAGE_API_SIGNATURE_SECRET: "${VONAGE_API_SIGNATURE_SECRET}"
    volumes:
      - ./private.key:/secrets/private.key:ro
    # 単一インスタンス前提。replicas を増やさないこと
    deploy:
      replicas: 1
    command: ["node", "dist/http-server.js"]
```

> [!NOTE]
> ポート公開を `127.0.0.1:3000:3000` にしているのは、うっかり LAN に露出させないためです。外部から使う場合は認証を設定したうえで変更してください。

---

## AWS

### App Runner

1. ECR にイメージを push する
2. サービス作成時に **Auto scaling を最小1・最大1**に設定する（単一インスタンス前提のため）
3. 環境変数を設定し、秘密鍵は **Secrets Manager** から参照する
4. 手前に API Gateway を置ける場合は `TRUST_UPSTREAM_AUTH=true`、置けない場合は `MCP_AUTH_TOKEN` を設定する

App Runner はヘルスチェックに `/health` を使えます（認証不要）。

### ECS Fargate

- **タスク数は 1 に固定してください。** Service の desired count を増やすとレートリミットが緩みます
- 秘密鍵は Secrets Manager / Parameter Store から環境変数またはファイルとして渡します
- ALB を前段に置く場合は `ALLOWED_HOSTS` に ALB のホスト名を設定してください

---

## stdio で使う場合（Claude Desktop など）

HTTP サーバーは不要です。認証・CORS・Host 検証はいずれも HTTP トランスポート専用で、stdio には関係しません。

```json
{
  "mcpServers": {
    "vonage": {
      "command": "node",
      "args": ["--env-file=/path/to/.env", "/path/to/dist/index.js"]
    }
  }
}
```

stdio では Webhook を受け取れないため、**`get_sms_status` は常に `submitted` のまま**になります（レスポンスの `note` で明示されます）。配信結果を追跡したい場合は HTTP 版を使ってください。

---

## トラブルシューティング

| 症状 | 原因 |
| --- | --- |
| 起動直後に `[FATAL]` で停止する | 環境変数の値が解釈できない。メッセージに問題が列挙される |
| `tools/list` が空 | capability がすべて OFF。`ENABLE_SMS` などを設定する |
| `tools/list` が `Method not found` | 同上（capability が全 OFF の古いバージョン） |
| `/mcp` が `406` | POST に `Accept: application/json, text/event-stream` が無い |
| `/mcp` が `403` | `Host` ヘッダーが `ALLOWED_HOSTS` に無い |
| `/mcp` が `401` | `MCP_AUTH_TOKEN` が不一致、または未送信 |
| Webhook が `503` | `VONAGE_API_SIGNATURE_SECRET` も `VONAGE_WEBHOOK_SECRET` も未設定 |
| Webhook が `401` | 署名・`payload_hash`・`iat`・`jti` のいずれかが不正または欠落 |
| 外部から接続できない | 認証未設定のためループバックに bind されている |
