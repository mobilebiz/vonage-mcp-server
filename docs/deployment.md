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
gcloud services enable run.googleapis.com secretmanager.googleapis.com
export PROJECT_ID="your-project-id"
export REGION="asia-northeast1"
export SERVICE_NAME="vonage-mcp-server"
```

### 1. 秘密鍵を Secret Manager に登録

```bash
gcloud secrets create vonage-private-key --data-file="./private.key" --project=$PROJECT_ID
```

### 方式A: Cloud Run IAM で認証する（推奨）

`--no-allow-unauthenticated` を指定し、認証をプラットフォームに任せます。

```bash
gcloud run deploy $SERVICE_NAME \
  --source . \
  --project $PROJECT_ID \
  --region $REGION \
  --no-allow-unauthenticated \
  --max-instances=1 \
  --set-env-vars="TRUST_UPSTREAM_AUTH=true" \
  --set-env-vars="ENABLE_SMS=true" \
  --set-env-vars="RATE_LIMIT_PER_HOUR=5" \
  --set-env-vars="VONAGE_APPLICATION_ID=YOUR_APPLICATION_ID" \
  --set-env-vars="VONAGE_PRIVATE_KEY_PATH=/secrets/private.key" \
  --set-secrets="/secrets/private.key=vonage-private-key:latest"
```

呼び出す側には `roles/run.invoker` を付与します。

```bash
gcloud run services add-iam-policy-binding $SERVICE_NAME \
  --region=$REGION \
  --member="serviceAccount:CALLER@$PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/run.invoker"
```

> [!WARNING]
> **`TRUST_UPSTREAM_AUTH=true` はサーバー自身の認証を無効にします。**
> `--allow-unauthenticated` と組み合わせると**誰でも SMS を送れる状態**になります。起動のたびに警告が出るのはこのためです。

### 方式B: Bearer トークンで認証する

Cloud Run IAM を使えない場合（外部の MCP クライアントが IAM トークンを付けられないなど）はこちらです。

```bash
# トークンを生成して Secret Manager に登録
openssl rand -hex 32 | gcloud secrets create mcp-auth-token --data-file=- --project=$PROJECT_ID

gcloud run deploy $SERVICE_NAME \
  --source . \
  --project $PROJECT_ID \
  --region $REGION \
  --allow-unauthenticated \
  --max-instances=1 \
  --set-env-vars="ENABLE_SMS=true" \
  --set-env-vars="RATE_LIMIT_PER_HOUR=5" \
  --set-env-vars="VONAGE_APPLICATION_ID=YOUR_APPLICATION_ID" \
  --set-env-vars="VONAGE_PRIVATE_KEY_PATH=/secrets/private.key" \
  --set-env-vars="ALLOWED_HOSTS=YOUR_SERVICE.a.run.app" \
  --set-secrets="/secrets/private.key=vonage-private-key:latest" \
  --set-secrets="MCP_AUTH_TOKEN=mcp-auth-token:latest"
```

`ALLOWED_HOSTS` にサービスのホスト名を設定しておくと、`Host` ヘッダーの検証が効きます（DNS rebinding 対策）。

### 3. 動作確認

```bash
# ヘルスチェック（認証不要）
curl https://YOUR_SERVICE_URL/health
# => {"status":"ok","connected":true,"version":"..."}

# ツール一覧（Accept ヘッダーが必要）
curl -X POST https://YOUR_SERVICE_URL/mcp \
  -H "Authorization: Bearer $MCP_AUTH_TOKEN" \
  -H "Accept: application/json, text/event-stream" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

`tools` が空の場合、**capability が有効になっていません。** 起動ログの警告を確認してください。

### 4. Webhook の登録

Vonage Dashboard の Application 設定で **Status URL** に次を登録します。

```
https://YOUR_SERVICE_URL/webhooks/message-status
```

`VONAGE_API_SIGNATURE_SECRET` が未設定だと、このエンドポイントは `503` を返して無効化されます（fail-closed）。

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
