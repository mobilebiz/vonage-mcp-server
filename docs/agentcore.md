# AWS Bedrock AgentCore Gateway から使う

このサーバーを **Amazon Bedrock AgentCore Gateway** のターゲットとして登録する手順です。

> **2026-08-31、`ap-northeast-1` で、エージェント経由の SMS 実送信と音声実発信まで確認しました。**
> 確認できた範囲は「7. 実機で確認できたこと」に書いてあります。

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

## 6. エージェントから使う（Strands Agents）

Gateway は MCP サーバーを仲介するだけなので、**エージェント本体は別に用意します。**
ここでは [Strands Agents](https://strandsagents.com/) をローカルで動かし、
モデルに Bedrock を使う構成を示します。AgentCore Runtime にデプロイする場合も
エージェント側のコードは同じです。

```sh
python3 -m venv venv && ./venv/bin/pip install strands-agents mcp boto3
```

### SigV4 は静的ヘッダーでは渡せません

**ここが唯一の難所です。** inbound を `AWS_IAM` にすると、リクエストごとに署名が変わるため
`headers={"Authorization": ...}` のような固定値では通りません。**`httpx.Auth` を実装して
MCP クライアントに差し込みます。**

```python
import boto3, httpx
from botocore.auth import SigV4Auth as BotoSigV4
from botocore.awsrequest import AWSRequest
from mcp.client.streamable_http import streamablehttp_client
from strands import Agent
from strands.models import BedrockModel
from strands.tools.mcp import MCPClient

GATEWAY_URL = "https://<GATEWAY_ID>.gateway.bedrock-agentcore.<REGION>.amazonaws.com/mcp"
REGION = "ap-northeast-1"
session = boto3.Session(region_name=REGION)


class SigV4(httpx.Auth):
    requires_request_body = True

    def auth_flow(self, request):
        creds = session.get_credentials().get_frozen_credentials()
        signable = AWSRequest(
            method=request.method,
            url=str(request.url),
            data=request.content or b"",
            headers={k: v for k, v in request.headers.items()
                     if k.lower() in ("content-type", "accept")},
        )
        BotoSigV4(creds, "bedrock-agentcore", REGION).add_auth(signable)
        for k, v in signable.headers.items():
            request.headers[k] = v
        yield request


mcp_client = MCPClient(lambda: streamablehttp_client(GATEWAY_URL, auth=SigV4()))

with mcp_client:
    agent = Agent(
        model=BedrockModel(model_id="jp.anthropic.claude-sonnet-4-5-20250929-v1:0",
                           boto_session=session),
        tools=mcp_client.list_tools_sync(),
        system_prompt=SYSTEM,
    )
    agent("+819045327751 に「テストです」と SMS を送りたいです。まず dry_run で確認してください。")
```

**署名するヘッダーは `content-type` と `accept` に絞っています。** httpx が後から付ける
`content-length` や `user-agent` まで署名対象にすると、実際に送られるヘッダーと
食い違って `SignatureDoesNotMatch` になります。署名対象外のヘッダーが増えるのは問題ありません。

**呼び出し側の IAM ID に `bedrock-agentcore:InvokeGateway` が必要です**（→ 4.）。

### システムプロンプトからツール名を消す

1. で書いたとおり、Gateway はツール名に接頭辞を付けます。**指示文がツール名を名指ししていると
空振りします。** 対処は「名前ではなく説明で選ばせる」ことです。

```text
あなたは Vonage の SMS / 音声通話ツールを扱うアシスタントです。

- 送信・発信を行うツールは、必ず先に dry_run: true で検証すること。
- dry_run の結果（宛先・送信元・セグメント数）をユーザーに提示し、承認を得てから実行すること。
- ユーザーが明示的に承認するまで dry_run: false で呼び出さないこと。
- 「送信成功」は Vonage が受理しただけで、配信を保証しない。
- ツールが返したエラーや注記は、要約せずそのまま伝えること。

**ツール名は基盤側で接頭辞が付く場合があります。名前ではなく説明を読んで選んでください。**
```

**この書き方で、エージェントは接頭辞つきの `VonageCloudRun___send_sms` を正しく選びました。**
`docs/gemini_system_instruction.md` をこの基盤で使う場合も同じ読み替えが要ります。

> [!IMPORTANT]
> **承認を強制しているのはこの指示文だけです。** Gateway にも Strands にも承認 UI はなく、
> 指示文はプロンプトインジェクションで破れます。**`ALLOWED_NUMBERS` が実効的な防御です。**

## 7. 実機で確認できたこと

**2026-08-31 / `ap-northeast-1` / サーバー v3.0.0 on Cloud Run /
エージェントは Strands + Bedrock (`jp.anthropic.claude-sonnet-4-5-20250929-v1:0`)。**

| 確認項目 | 結果 |
|---|---|
| API キープロバイダでの Bearer 認証 | ✅ 401 は1件も出ず |
| ターゲット作成時の自動同期（`tools/list`） | ✅ `READY` + `lastSynchronizedAt` |
| 絞った `secretsmanager` 権限で動作するか | ✅ `bedrock-agentcore-identity*` で足りた |
| SigV4 でツール一覧を取得 | ✅ 4ツール（接頭辞つき） |
| **エージェントが自分でツールを選ぶ** | ✅ 名前を伏せても説明から選んだ |
| `dry_run` | ✅ セグメント数・推定通話時間まで |
| **実送信（SMS が実機に届く）** | ✅ `delivered` |
| **実発信（電話が鳴る）** | ✅ `completed` / 8秒 / `sip_code: 200` / `detail: ok` |
| ツール実行前の承認 UI | ❌ **無い。Gateway にも Strands にも存在しない** |

### 実測の記録

```
tools/list  → VonageCloudRun___send_sms / ___make_voice_call
              ___get_sms_status / ___get_call_status

SMS   dry_run  25文字 UCS-2 segments=1 → Ready to send
      送信     Message ID 68cf2927-…
      確認     get_sms_status → delivered

音声  dry_run  estimated=10秒 max_duration=40秒 cap=300秒
      発信     Call ID b5d50869-…
      確認     get_call_status → completed / 8秒 / price 0.01863067
                                 sip_code 200 / detail ok
```

**`detail: ok` と `sip_code: 200` が返っています。** Voice API の `GET /v1/calls/{uuid}` は
この2つを返さず、届く経路は Event Webhook だけです。**Gateway を挟んでも、
サーバーが重ねた失敗理由がそのままエージェントまで届くことが確認できました。**

**レスポンスの `tool` フィールドは `send_sms` のまま**で、接頭辞が付くのは Gateway が
公開する名前だけです。

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

## 8. それでもサーバー側の設定を省かないこと

| 設定 | なぜ必要か |
|---|---|
| `ALLOWED_NUMBERS` | **承認 UI が無いので、これだけが誤送信とプロンプトインジェクションを止めます** |
| `RATE_LIMIT_PER_HOUR` | 1時間あたりの送信・架電件数の上限。**SMS と通話の合計**です |
| `MCP_AUTH_TOKEN` | 未設定だと HTTP 版はループバックにしか bind しません |
| `ALLOWED_COUNTRY_CODES` | 既定は日本のみ |

**トークンは AWS 側にも保管されます**（AgentCore Identity → Secrets Manager）。
ローテーションするときは **Cloud Run と AgentCore の両方**を更新してください。
AgentCore 側は `update-api-key-credential-provider` で差し替えられます。

## 9. 後片付け

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

> **本文中の Gateway ID・ターゲット ID は、検証時に作成して削除済みのものです。**
> 手順の再現には自分の環境で作成した値を使ってください。
