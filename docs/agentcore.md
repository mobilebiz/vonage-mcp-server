# AWS Bedrock AgentCore Gateway から使う

このサーバーを **Amazon Bedrock AgentCore Gateway** のターゲットとして登録する手順です。

> **2026-08-31、`ap-northeast-1` で `dry_run` の実行まで確認しました。**
> 確認できた範囲は「6. 実機で確認できたこと」に書いてあります。

```
エージェント ──SigV4──▶ AgentCore Gateway ──Bearer──▶ Cloud Run の MCP サーバー
              (inbound: AWS_IAM)      (outbound: API キープロバイダ)
```

## 1. 先に知っておくべき2点

### IAM SigV4 では繋がりません

Gateway の outbound 認証には OAuth / IAM (SigV4) / API キー / 認証なし がありますが、
**このサーバーで使えるのは API キーだけです。**

[AWS のドキュメント](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-target-MCPservers.html)が明示しています。

> Gateway は SigV4 で署名するが、**ターゲット側が SigV4 署名を検証できなければならない。**
> 対応するのは AgentCore Gateway / AgentCore Runtime / API Gateway / Lambda Function URLs。

**Cloud Run はこの一覧にありません。** ALB や EC2 の直エンドポイントと同じく非対応です。
OAuth もこのサーバーは喋らないため、**残るのは API キープロバイダ**になります。

### ツール名が変わります

**Gateway はツール名に `<ターゲット名>___`（アンダースコア3つ）を前置します。**

| サーバー側 | エージェントから見える名前 |
|---|---|
| `send_sms` | `VonageCloudRun___send_sms` |
| `make_voice_call` | `VonageCloudRun___make_voice_call` |

**`docs/gemini_system_instruction.md` をそのまま使うと噛み合いません。** あの指示文は
`send_sms` や `dry_run` をツール名で名指ししています。**AgentCore で使うときは、
ターゲット名の接頭辞を付けて書き換えてください。**

## 2. 前提

| | |
|---|---|
| リージョン | Gateway に対応しているリージョン。**`ap-northeast-1`（東京）は対応**（Evaluations と Policy を除く全機能） |
| このサーバー | **HTTP 版が公開 HTTPS で到達できること。** stdio 版は使えません |
| 認証 | `MCP_AUTH_TOKEN`（16文字以上）を設定しておくこと |
| プロトコル版 | Gateway の対応は `2026-07-28` / `2025-11-25` / `2025-06-18` / `2025-03-26`。**このサーバーは `2025-11-25`** |
| 課金 | **AgentCore Gateway は無料枠ではありません。** |

> [!IMPORTANT]
> **`ALLOWED_NUMBERS` を先に設定してください。** Gateway は API であって UI ではないので、
> **ツール実行前の承認は一切ありません。** ツール注釈（`destructiveHint`）も効きません。

## 3. Gateway 用の IAM ロールを作る

信頼ポリシー。**`aws:SourceAccount` と `aws:SourceArn` で絞ってください** —
混乱した代理人（confused deputy）攻撃を防ぐためです。

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Service": "bedrock-agentcore.amazonaws.com" },
    "Action": "sts:AssumeRole",
    "Condition": {
      "StringEquals": { "aws:SourceAccount": "<ACCOUNT_ID>" },
      "ArnLike": { "aws:SourceArn": "arn:aws:bedrock-agentcore:<REGION>:<ACCOUNT_ID>:*" }
    }
  }]
}
```

権限ポリシー。Gateway が outbound の資格情報を取り出すためのものだけで足ります。

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "bedrock-agentcore:GetResourceApiKey",
        "bedrock-agentcore:GetResourceOauth2Token",
        "bedrock-agentcore:GetWorkloadAccessToken",
        "bedrock-agentcore:GetWorkloadAccessTokenForUserId"
      ],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": "secretsmanager:GetSecretValue",
      "Resource": "arn:aws:secretsmanager:<REGION>:<ACCOUNT_ID>:secret:bedrock-agentcore-identity*"
    }
  ]
}
```

> AWS の例は `secretsmanager:GetSecretValue` を `Resource: "*"` にしていますが、
> **それだとアカウント内の全シークレットが読めます。** AgentCore Identity が作る
> シークレットは `bedrock-agentcore-identity!default/apikey/<名前>-...` という名前なので、
> 上記の接頭辞で絞れます。**実際にこの範囲で動作しました。**

```sh
aws iam create-role --role-name VonageMcpGatewayRole \
  --assume-role-policy-document file://trust.json
aws iam put-role-policy --role-name VonageMcpGatewayRole \
  --policy-name VonageMcpGatewayOutbound --policy-document file://perms.json
```

## 4. Gateway を作る

```sh
aws bedrock-agentcore-control create-gateway \
  --region ap-northeast-1 \
  --name VonageMcpGateway \
  --role-arn arn:aws:iam::<ACCOUNT_ID>:role/VonageMcpGatewayRole \
  --protocol-type MCP \
  --authorizer-type AWS_IAM
```

**`--authorizer-type AWS_IAM` を選ぶと Cognito が不要です。** `CUSTOM_JWT` だと
ユーザープールと discovery URL の用意が要ります。IAM なら呼び出し側の IAM ID に
`bedrock-agentcore:InvokeGateway` を付けるだけです。

返る `gatewayUrl` がエージェントの接続先になります。`status` が `READY` になるまで待ちます。

## 5. トークンを登録してターゲットを追加する

### API キープロバイダ

```sh
aws bedrock-agentcore-control create-api-key-credential-provider \
  --region ap-northeast-1 \
  --name VonageMcpAuthToken \
  --api-key "$(gcloud secrets versions access latest \
      --secret=mcp-auth-token --project=<PROJECT_ID>)"
```

**トークンを端末に表示させないよう、コマンド置換で直接渡しています。**

### ターゲット

`target.json`:

```json
{
  "mcp": {
    "mcpServer": {
      "endpoint": "https://<あなたのホスト>/mcp",
      "listingMode": "DEFAULT"
    }
  }
}
```

`cred.json` — **ここが要点です。** `credentialPrefix` に `Bearer` を指定することで
`Authorization: Bearer <MCP_AUTH_TOKEN>` が組み立てられます。

```json
[{
  "credentialProviderType": "API_KEY",
  "credentialProvider": {
    "apiKeyCredentialProvider": {
      "providerArn": "arn:aws:bedrock-agentcore:<REGION>:<ACCOUNT_ID>:token-vault/default/apikeycredentialprovider/VonageMcpAuthToken",
      "credentialParameterName": "Authorization",
      "credentialPrefix": "Bearer",
      "credentialLocation": "HEADER"
    }
  }
}]
```

```sh
aws bedrock-agentcore-control create-gateway-target \
  --region ap-northeast-1 \
  --gateway-identifier <GATEWAY_ID> \
  --name VonageCloudRun \
  --target-configuration file://target.json \
  --credential-provider-configurations file://cred.json
```

**`listingMode: DEFAULT` にすると、作成時に Gateway が自動で `tools/list` を叩きます。**
`status` が `READY` になり `lastSynchronizedAt` が入れば同期成功です。

> [!NOTE]
> **ツールを増減したら `SynchronizeGatewayTargets` を呼んでください。** DEFAULT モードは
> カタログをキャッシュするため、`ENABLE_SMS` などを変えても自動では追随しません。

## 6. 実機で確認できたこと

**2026-08-31 / `ap-northeast-1` / サーバー v3.0.0 on Cloud Run。**

| 確認項目 | 結果 |
|---|---|
| API キープロバイダでの Bearer 認証 | ✅ 401 は1件も出ず |
| ターゲット作成時の自動同期（`tools/list`） | ✅ `READY` + `lastSynchronizedAt` |
| 絞った `secretsmanager` 権限で動作するか | ✅ `bedrock-agentcore-identity*` で足りた |
| SigV4 でエージェントから `tools/list` | ✅ 4ツール（接頭辞つき） |
| `tools/call` で `dry_run` | ✅ セグメント数まで正しく返った |
| 実送信 | ⬜ 未確認（Dify 経由では確認済み） |
| ツール実行前の承認 UI | ❌ **無い。Gateway は API であって UI ではない** |

### AgentCore も SSE を開かない

Cloud Run 側で観測したアクセスは**すべて POST** でした。

```
POST 200   Apache-HttpAsyncClient/5.6.1 (Java/21.0.12)   ← initialize
POST 202   Apache-HttpAsyncClient/5.6.1 (Java/21.0.12)   ← notifications/initialized
POST 200   Apache-HttpAsyncClient/5.6.1 (Java/21.0.12)   ← tools/list
```

**`GET /mcp` が1件もありません。** Dify（`python-httpx`）と同じ挙動で、
**`enableJsonResponse`（SSE ではなく JSON を返す設定）は2基盤とも問題になりませんでした。**

なお AWS のドキュメントは、AgentCore Runtime 上の MCP サーバーについて
`Mcp-Session-Id` を許可するとレイテンシが下がると案内していますが、
**このサーバーはステートレス設計なので該当しません。**

### 実測の記録

```
tools/list  → VonageCloudRun___send_sms / ___make_voice_call
              ___get_sms_status / ___get_call_status
tools/call  → {"status":"dry_run_success","tool":"send_sms","to":"+8190…",
               "from":"VonageMCP","characters":20,"encoding":"UCS-2","segments":1}
```

**レスポンスの `tool` は `send_sms` のまま**です。接頭辞が付くのは Gateway が公開する
名前だけで、サーバーが返す中身は変わりません。

## 7. それでもサーバー側の設定を省かないこと

| 設定 | なぜ必要か |
|---|---|
| `ALLOWED_NUMBERS` | **承認 UI が無いので、これだけが誤送信とプロンプトインジェクションを止めます** |
| `RATE_LIMIT_PER_HOUR` | 1時間あたりの送信・架電件数の上限。**SMS と通話の合計**です |
| `MCP_AUTH_TOKEN` | 未設定だと HTTP 版はループバックにしか bind しません |
| `ALLOWED_COUNTRY_CODES` | 既定は日本のみ |

**トークンは AWS 側にも保管されます**（AgentCore Identity → Secrets Manager）。
ローテーションするときは **Cloud Run と AgentCore の両方**を更新してください。
AgentCore 側は `update-api-key-credential-provider` で差し替えられます。

## 8. 後片付け

検証だけで終える場合、課金を止めるには次の順で削除します。

```sh
aws bedrock-agentcore-control delete-gateway-target \
  --region <REGION> --gateway-identifier <GATEWAY_ID> --target-id <TARGET_ID>
aws bedrock-agentcore-control delete-gateway \
  --region <REGION> --gateway-identifier <GATEWAY_ID>
aws bedrock-agentcore-control delete-api-key-credential-provider \
  --region <REGION> --name VonageMcpAuthToken
aws iam delete-role-policy --role-name VonageMcpGatewayRole --policy-name VonageMcpGatewayOutbound
aws iam delete-role --role-name VonageMcpGatewayRole
```

**ターゲットを先に消さないと Gateway は削除できません。**
