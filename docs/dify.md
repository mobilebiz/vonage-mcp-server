# Dify から使う

このサーバーを **Dify** のアプリから使うための手順です。

> [!WARNING]
> **この手順はまだ実機で通していません。** 公開ドキュメント（2026-08-30 時点）に基づく draft です。
> 実際に通したら、この警告を消して確認できた内容を「5. 実機で確認できたこと」に記録してください。
> **本プロジェクトでは「文書上は対応」と「実機で確認済み」を区別します**（README の対応表の 📄 と ✅）。

## Gemini Enterprise との違い

Gemini Enterprise のコネクタは認証が「なし」か OAuth 2.0 の2択で `MCP_AUTH_TOKEN` を渡せず、
ADK でエージェントを書く回り道が必要でした（`docs/gemini-enterprise-adk.md`）。

**Dify にはその制約がありません。** カスタムヘッダを設定できるので、
`Authorization: Bearer <MCP_AUTH_TOKEN>` をそのまま送れます。**追加のインフラは不要です。**

```
Dify の Workflow / Agent
      │  HTTP + Authorization: Bearer <MCP_AUTH_TOKEN>
      ▼
Vonage MCP Server on Cloud Run
```

## 1. 前提

| | |
|---|---|
| Dify | Cloud（Sandbox プランで可。カード不要）またはセルフホスト |
| このサーバー | **HTTP 版が公開 HTTPS で到達できること。** stdio 版は使えません |
| 認証 | `MCP_AUTH_TOKEN`（16文字以上）を設定しておくこと |

> [!IMPORTANT]
> **`MCP_AUTH_TOKEN` を設定せずに公開しないでください。** このサーバーは課金が発生する
> 操作を持ちます。未設定の場合、HTTP 版は `127.0.0.1` にしか bind しないため
> Dify からは到達できません（意図的な既定です）。

Cloud Run で動かす手順は `docs/deployment.md` を参照してください。

### 送信先を絞っておく

**Dify には、ツール実行前の承認 UI が既定ではありません。** ワークフローに Human Input
ノードを置けば承認を挟めますが（→ 4.）、置かなければ**エージェントの判断だけで送信されます**。

検証中は `ALLOWED_NUMBERS` に自分の番号だけを入れてください。

```sh
ALLOWED_NUMBERS=+819012345678
RATE_LIMIT_PER_HOUR=5
```

**これが実際に効く防御です。** ツール注釈（`destructiveHint`）は仕様上ヒントであって
強制ではなく、承認 UI を持たない基盤では何も起こりません。

## 2. MCP サーバーとして登録する

Dify の **Integrations → Tools** から追加します。

| 欄 | 入れる値 |
|---|---|
| **Server URL** | `https://<あなたのホスト>/mcp` |
| **Name** | `Vonage`（表示名。任意） |
| **Server identifier** | `vonage`（**あとから変えないこと**。アプリはこの ID でサーバーを参照するため、変更すると既存のツールが壊れます） |

### 認証（ここが要点）

**Dynamic Client Registration は既定で ON ですが、OFF にしてください。**
このサーバーは OAuth を喋りません。ON のままだと Dify が OAuth の自動登録を試みて失敗します。

そのうえで **Custom Headers** に次を設定します。

| ヘッダー名 | 値 |
|---|---|
| `Authorization` | `Bearer <MCP_AUTH_TOKEN>` |

Cloud Run で Secret Manager に入れている場合、値は次で取り出せます。

```sh
gcloud secrets versions access latest --secret=mcp-auth-token --project=<PROJECT_ID>
```

> Dify のヘッダー値は `{{request.headers.X-Custom-Auth}}` のようなプレースホルダも書けますが、
> **このサーバーでは固定値で構いません。** トークンは1デプロイに1つです。

### 登録できたことの確認

保存すると Dify が接続し、ツール一覧を取り込みます。**次の4つが出れば成功です。**

- `send_sms`
- `make_voice_call`
- `get_sms_status`
- `get_call_status`

> [!NOTE]
> **ツールが1つも出ない場合、ほぼ確実に `ENABLE_*` の設定漏れです。**
> このサーバーは既定でツールを1つも公開しません。サーバー側の環境変数に
> `ENABLE_SMS=true` / `ENABLE_VOICE=true`（**小文字**）が入っているか確認してください。
>
> サーバー側で直接確かめるなら:
>
> ```sh
> curl -s -X POST https://<ホスト>/mcp \
>   -H "Authorization: Bearer $TOKEN" \
>   -H 'Content-Type: application/json' \
>   -H 'Accept: application/json, text/event-stream' \
>   -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
> ```

## 3. アプリから呼ぶ

取り込んだ MCP ツールは、Dify の他のツールと同じように使えます。

- **Workflow / Chatflow** — Tool ノード、または Agent ノードの中から
- **Agent アプリ** — 直接

### まず dry_run で試す

**いきなり送信させないでください。** すべての送信系ツールには `dry_run` があります。
`true` にすると Vonage API を呼ばずに検証だけを行い、宛先・送信元・セグメント数を返します。

```json
{
  "status": "dry_run_success",
  "message": "Ready to send",
  "tool": "send_sms",
  "to": "+819012345678",
  "from": "VonageMCP",
  "characters": 33,
  "encoding": "UCS-2",
  "segments": 1
}
```

日本の国内形式（`09012345678`）が E.164 形式へ自動変換されること、**セグメント数**が
返ることを確認してください。SMS の課金は文字数ではなくセグメント単位です。

### エージェントへの指示文

`docs/gemini_system_instruction.md` の「そのまま貼り付ける System Instruction」が
そのまま使えます。**基盤に依存しない内容**です。とくに次の2点は Dify でも重要です。

- 送信前に必ず `dry_run: true` で検証し、宛先と本文をユーザーに提示して承認を得ること
- 「送信成功」は Vonage が受理しただけで、配信の保証ではないこと

## 4. 承認を挟む（Human Input ノード）

Dify v1.13.0 以降の **Human Input ノード**を使うと、ワークフローを止めて人間の判断を
挟めます。**送信系ツールの手前に置いてください。**

| 設定 | 内容 |
|---|---|
| 配信方法 | Webapp または Email（Cloud では プラン次第） |
| フォーム | LLM の出力（宛先・本文）を変数として渡し、**送信前に編集させられます** |
| ボタン | 「承認」「却下」などを定義し、後続の分岐を変えられます |
| タイムアウト | 既定 3日。応答が無ければタイムアウト分岐へ |

**`dry_run` の結果を Human Input のフォームに渡すのが素直な設計です。** セグメント数と
正規化後の宛先を人間に見せてから、承認されたら実送信に進みます。

> [!IMPORTANT]
> **Human Input ノードを置かない構成では、承認は一切ありません。**
> その場合、実効的な防御は `ALLOWED_NUMBERS` とレートリミットだけになります。

## 5. 実機で確認できたこと

> このセクションは実機検証後に記入してください。テンプレートを置いておきます。

| 確認項目 | 結果 |
|---|---|
| Custom Headers での Bearer 認証 | ⬜ |
| `tools/list` に4ツールが出る | ⬜ |
| capability が OFF のツールが**一覧に出ない** | ⬜ |
| `dry_run` のレスポンスがエージェントに渡る | ⬜ |
| 実送信（SMS が実機に届く） | ⬜ |
| `get_sms_status` で `delivered` まで確認できる | ⬜ |
| Human Input ノードで承認を挟める | ⬜ |

### 確認したい未確定事項

- **Streamable HTTP の扱い。** 公式ドキュメントは「HTTP transport のみ対応」とだけ書いており、
  Streamable HTTP という語がありません。このサーバーは `enableJsonResponse` で
  **SSE ではなく通常の JSON を返す**構成なので通ると見ていますが、**未確認です**
- **Agent ノードのツール呼び出しに対する自動の承認 UI があるか。** 公式ドキュメントに記載がなく、
  Human Input ノードを自分で置く以外の方法があるかは分かっていません

## 6. それでもサーバー側の設定を省かないこと

Dify 側でどう組んでも、**サーバー側のガードレールが最後の砦です。**

| 設定 | なぜ必要か |
|---|---|
| `ALLOWED_NUMBERS` | 承認 UI が無い構成では、これだけが誤送信とプロンプトインジェクションを止めます |
| `RATE_LIMIT_PER_HOUR` | 1時間あたりの送信・架電件数の上限。**SMS と通話の合計**です |
| `MCP_AUTH_TOKEN` | 未設定だと HTTP 版はループバックにしか bind しません |
| `ALLOWED_COUNTRY_CODES` | 既定は日本のみ。海外宛を使うときだけ広げてください |

詳しくは README の「環境変数」と「ガードレール」を参照してください。
