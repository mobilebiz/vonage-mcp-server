# Gemini Enterprise の Agent Apps から使う（ADK 経由）

このサーバーを **Google Gemini Enterprise** のアプリから使うための手順です。
**2026-08-25 に実機で通しました**（`dry_run` → 承認ウィンドウ → 実送信 → `delivered` まで）。

## なぜコネクタではなく ADK なのか

Gemini Enterprise には「カスタム MCP サーバーコネクタ」がありますが、
**このサーバーには使えません。** コネクタが送れる認証は「認証なし」と OAuth 2.0 の
2つだけで、任意ヘッダの欄がないため `MCP_AUTH_TOKEN` を渡す手段がありません。
かつ公開 HTTPS 到達性を要求するので、「認証なし」は選択肢になりません
（課金できるサーバーを無認証で全世界に晒すことになります）。

[ADK](https://adk.dev/) の `McpToolset` は任意ヘッダを送れるので、この制約を回避できます。
作ったエージェントを **Agent Runtime**（旧 Agent Engine）にデプロイし、
Gemini Enterprise のアプリに登録すると、Apps の画面から使えます。

```
Gemini Enterprise の Apps
      │  （アプリに「Custom agent via Agent Runtime」として登録）
      ▼
ADK エージェント on Agent Runtime
      │  Streamable HTTP + Authorization: Bearer <MCP_AUTH_TOKEN>
      ▼
Vonage MCP Server on Cloud Run
```

## 1. 前提

| | |
|---|---|
| ロール | Gemini Enterprise Admin / Agent Platform User / Storage Admin |
| API | Agent Platform (aiplatform) / Discovery Engine / Cloud Storage |
| ライセンス | Gemini Enterprise アプリを作ると **30日間の無料トライアルライセンス**が同時に作られます。Apps にサインインするにはこれが要ります |

このサーバー側は、Streamable HTTP で公開し `MCP_AUTH_TOKEN` を設定しておきます
（[デプロイ手順](deployment.md)）。**トークンは Secret Manager に置いてください。**

## 2. エージェントを書く

`google-adk[mcp]` が要ります。**`google-cloud-aiplatform[agent_engines,adk]` だけでは
`mcp` パッケージが入らず、`McpToolset` の import が失敗します。** ADK は `mcp>=1.24,<2` を
要求するので、`pip install mcp` で最新を入れても `ImportError` になります。

```python
import os
from google.adk.agents import Agent
from google.adk.tools.mcp_tool import McpToolset
from google.adk.tools.mcp_tool.mcp_session_manager import StreamableHTTPConnectionParams

DESTRUCTIVE = ["send_sms", "bulk_sms_from_csv", "make_voice_call"]
READ_ONLY = ["get_sms_status", "get_call_status"]


def resolve_auth_token() -> str:
    """Secret Manager から MCP_AUTH_TOKEN を取る（環境変数に平文を置かない）。"""
    from google.cloud import secretmanager

    client = secretmanager.SecretManagerServiceClient()
    name = os.environ["MCP_AUTH_TOKEN_SECRET"]  # projects/<P>/secrets/<S>/versions/latest
    return client.access_secret_version(name=name).payload.data.decode().strip()


def confirm_unless_dry_run(**kwargs) -> bool:
    """dry_run: true 以外の呼び出しに承認を要求する。"""
    return kwargs.get("dry_run") is not True


class VonageMcpToolset(McpToolset):
    """pickle してもヘッダに秘密が残らない McpToolset（理由は 3. を参照）。"""

    def __init__(self, url, tool_filter=None, require_confirmation=False):
        self._url, self._names, self._confirm = url, tool_filter, require_confirmation
        super().__init__(
            connection_params=StreamableHTTPConnectionParams(
                url=url,
                headers={
                    "Authorization": f"Bearer {resolve_auth_token()}",
                    "Accept": "application/json, text/event-stream",
                },
            ),
            tool_filter=tool_filter,
            require_confirmation=confirm_unless_dry_run if require_confirmation else False,
        )

    def __reduce__(self):
        return (self.__class__, (self._url, self._names, self._confirm))


url = os.environ["VONAGE_MCP_URL"]  # https://<host>/mcp
root_agent = Agent(
    model="gemini-2.5-flash",
    name="vonage_sms_voice_agent",
    description="Vonage 経由で SMS を送信し、音声通話を発信し、配信状況を確認します。",
    instruction=open("system_instruction.md").read(),  # ← 下記参照
    tools=[
        VonageMcpToolset(url, tool_filter=DESTRUCTIVE, require_confirmation=True),
        VonageMcpToolset(url, tool_filter=READ_ONLY),
    ],
)
```

`instruction` には [`gemini_system_instruction.md`](gemini_system_instruction.md) の
「そのまま貼り付ける System Instruction」の本文を入れてください。

### なぜツールセットを2つに分けるのか

`require_confirmation` に渡す callable には、**ツール名が渡りません**（ツールの引数と
`tool_context` だけ）。そのため「破壊的なツールにだけ承認を要求する」を名前で書けません。
ツールセットを分けることで、名前で明示します。

そのうえで `confirm_unless_dry_run` により、**承認は `dry_run` でない実行にだけ**掛かります。
`dry_run` は Vonage API を叩かないので摩擦をゼロにでき、逆に**モデルが `dry_run` を省略した
呼び出しは実送信になるため、必ず承認を挟みます。**

## 3. デプロイ（Agent Runtime）

### トークンを `.pkl` に焼き込まないこと

`agent_engines.create()` は、**ローカルでエージェントを cloudpickle して Cloud Storage に
アップロードします。** ヘッダに直接トークンを書くと、それが staging バケットの `.pkl` に
残ります。上の `__reduce__` は「URL・ツール名・承認の要否」だけを pickle に載せ、
トークンはデプロイ先のコンテナで解決させるためのものです。

確認方法:

```sh
MCP_AUTH_TOKEN=CANARY python -c "
import cloudpickle; from agent import root_agent
print(b'CANARY' in cloudpickle.dumps(root_agent))"   # False であること
```

### サービスアカウントは先に作る

`identity_type=AGENT_IDENTITY` を使うと、サービスアカウントはデプロイ時に作られます。
ところがこのエージェントは**起動時に Secret Manager を読む**ため、権限が無いまま起動して
失敗します。**起動に失敗したリソースは消えるので、権限を付ける相手が残りません**（鶏と卵）。

```sh
SA=vonage-adk-agent@PROJECT.iam.gserviceaccount.com
gcloud iam service-accounts create vonage-adk-agent --project PROJECT
gcloud secrets add-iam-policy-binding mcp-auth-token --project PROJECT \
  --member "serviceAccount:$SA" --role roles/secretmanager.secretAccessor
gcloud projects add-iam-policy-binding PROJECT \
  --member "serviceAccount:$SA" --role roles/aiplatform.user --condition=None
gcloud storage buckets add-iam-policy-binding gs://STAGING_BUCKET \
  --member "serviceAccount:$SA" --role roles/storage.objectViewer
```

```python
import vertexai
from vertexai import agent_engines

client = vertexai.Client(project=PROJECT, location="us-central1")
remote = client.agent_engines.create(
    agent=agent_engines.AdkApp(agent=root_agent),
    config={
        "display_name": "Vonage SMS / Voice Agent",
        "description": "Vonage 経由で SMS を送信し、音声通話を発信し、配信状況を確認します。",
        "requirements": [
            "google-cloud-aiplatform[agent_engines,adk]",
            "google-adk[mcp]",              # ← 忘れるとデプロイ先で import に失敗する
            "google-cloud-secret-manager",
            "cloudpickle==3.1.2",           # ← ローカルと版を揃える
            "pydantic==2.13.4",
        ],
        "extra_packages": ["vonage_agent"],
        "staging_bucket": "gs://STAGING_BUCKET",
        "env_vars": {
            "VONAGE_MCP_URL": "https://<host>/mcp",
            "MCP_AUTH_TOKEN_SECRET": "projects/<P>/secrets/mcp-auth-token/versions/latest",
        },
        "service_account": SA,
    },
)
print(remote.api_resource.name)
```

デプロイに失敗したときは、原因がログにしか出ないことがあります。

```sh
gcloud logging read 'resource.type="aiplatform.googleapis.com/ReasoningEngine"' \
  --project PROJECT --limit 30 --freshness=1h --format="value(textPayload)"
```

> [!TIP]
> **モデル名は実際に引けるか確かめてください。** Quickstart の例にある `gemini-3.5-flash` は
> 引けないことがあります（404）。`gemini-3-flash-preview` は `location=global` でのみ
> 引ける、といった差もあります。

## 4. Gemini Enterprise に登録する

1. コンソールの **Gemini Enterprise** → **アプリ** → アプリを作成
   （**location は `global` を推奨**。`us` / `eu` を選ぶと Agent Runtime のリージョンが縛られます）
2. 作ったアプリ → **エージェント** → **エージェントを追加** →
   **Agent Runtime によるカスタム エージェント**
3. **Authorizations はスキップ**（ユーザーの代理で Google Cloud を叩く場合のみ必要）
4. 表示名・説明・リソースパス `projects/<P>/locations/<L>/reasoningEngines/<ID>` を入力

**説明は LLM がこのエージェントを呼ぶかどうかの判断に使われます。** 何ができるかを具体的に書いてください。

登録後、アプリの **プレビューを開く** から Apps の画面に入れます。

## 5. 実機で確認できたこと（2026-08-25）

| 確認項目 | 結果 |
|---|---|
| `dry_run` の検証 | ✅ セグメント数・エンコーディング・送信元まで提示される |
| 実送信 | ✅ **承認ウィンドウが表示され、承認後に送信された** |
| `get_sms_status` | ✅ `delivered`（Status Webhook 経由の DLR まで到達） |
| 読み取り専用ツール | ✅ 承認なしで即実行（312ms） |

**ツール呼び出しの引数が Apps の画面にそのまま表示されます。**
`send_sms(to='+81...', text='...', dry_run=True)` のように見えるため、
利用者は「AI が意図した宛先」と「実際に送られる宛先」を目視できます。

### 既知の引っかかり

承認して送信されたあと、**応答の描画が終わらず「処理しています」のままになることがあります。**
送信そのものは1回だけで、二重送信は起きていません（Cloud Run 側のリクエスト数で確認）。
気になる場合は入力欄の停止ボタンで打ち切り、次のメッセージで `get_sms_status` を尋ねれば
配信結果を確認できます。

## 6. それでもサーバー側の設定を省かないこと

承認ウィンドウが出ることは確認できましたが、**これはエージェント側の仕組みです。**
System Instruction はプロンプトインジェクションで破られる前提で読んでください。

**`ALLOWED_NUMBERS` と `RATE_LIMIT_PER_HOUR` を必ず設定してください。**
実効的な防御はサーバー側の設定だけです。
