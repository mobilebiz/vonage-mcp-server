# Vonage MCP Server

[English](README.en.md) | 日本語

VonageのSMS送信、CSV一括送信、音声通話を **AIエージェントから安全に使う**ための MCP (Model Context Protocol) サーバーです。

利用者が自分の環境にコンテナを立て、自分の Vonage 資格情報を設定して使う **OSS のリファレンス実装**です。このプロジェクトがあなたの資格情報を預かることはありません。

## このプロジェクトの前提

### 脅威モデル — エージェントを信頼できる主体として扱わない

**攻撃者はプロンプトインジェクションによって AI エージェントを操れるものとします。**

SMS 送信と音声通話は**取り消せず、課金が発生し、相手にも迷惑がかかりうる**操作です。「エージェントが正しく使えば安全」という前提は置けません。このサーバーのガードレールは、エージェントが敵対的に振る舞っても被害が上限内に収まることを目指しています。

そのため、**既定ではツールが1つも公開されません。** 使う機能を環境変数で明示的に有効にしてください。

### 対象範囲

| 項目 | 範囲 |
| --- | --- |
| 規制上の案内 | **日本国内での利用を対象**とします |
| 発信先 | 海外番号も許容しますが、**既定では日本（国番号 81）のみ**有効です |
| 提供形態 | 利用者が自環境にデプロイします。1デプロイ = 1 Vonage アプリケーション |
| 対応クライアント | MCP 仕様準拠。stdio と Streamable HTTP の2形態 |

> [!IMPORTANT]
> **規制に関する記載は法的助言ではありません。**
> このプロジェクトが案内するのは日本国内での利用を対象とした事項に限られます。**他地域で利用する場合は、その地域の規制・キャリア仕様・Vonage の利用規約をご自身で確認する責任を負います。**
> 日本国内での利用についても、[日本向け SMS の利用条件](#日本向け-sms-の利用条件)に挙げた事項はサーバー側で判定できないため、遵守は利用者の責任です。

> [!WARNING]
> **単一インスタンスで動かしてください。**
> レートリミット・配信ステータス・Webhook のリプレイ検出はすべてプロセス内のメモリに保持されます。複数インスタンスで動かすと、
> - **レートリミットが実効的にインスタンス数倍に緩みます**（`RATE_LIMIT_PER_HOUR=5` を3インスタンスで動かせば毎時15件）
> - Webhook がインスタンス A に届いて `get_sms_status` が B で処理されると、**配信ステータスを取得できません**
> - Webhook のリプレイ検出がインスタンスをまたげません
>
> Cloud Run なら `--max-instances=1` を指定してください。外部ストア対応は現時点のスコープ外です。

## 対応プラットフォーム

本サーバーは MCP 仕様に準拠した **stdio** と **Streamable HTTP** の2形態を実装しており、プラットフォーム固有の分岐は持ちません。以下は各基盤の**公開ドキュメントに基づく**対応状況です。

凡例: ✅ 実機で確認済み / 📄 ドキュメント上は対応（未検証）/ ⚠️ 制約あり

| プラットフォーム | 接続方法 | 送れる認証 | ツール実行前の承認 | 状態 |
| --- | --- | --- | --- | --- |
| [Claude Desktop（ローカル）](#claude-desktopでの利用) | stdio / MCPB | 不要 | **あり（読み取り系にも出ます）** | ✅ |
| [Claude Code](https://code.claude.com/docs/en/mcp) | stdio / HTTP | `--header` で Bearer | あり | 📄 |
| **Streamable HTTP 全般**（Cloud Run 等） | Streamable HTTP | Bearer / 上流 IAM | クライアント次第 | ✅ |
| [Claude.ai / Desktop（リモート）](https://claude.com/docs/connectors/building/authentication) | Streamable HTTP | OAuth、または静的ヘッダ（beta・組織管理者が設定） | あり | 📄 |
| [Gemini Enterprise（コネクタ）](https://docs.cloud.google.com/gemini/enterprise/docs/connectors/custom-mcp-server/set-up-custom-mcp-server) | Streamable HTTP | **OAuth 2.0 か「認証なし」のみ** | あり（既定で必ず出る） | ⚠️ |
| [Gemini Enterprise（ADK で自作）](https://google.github.io/adk-docs/tools-custom/mcp-tools/) | Streamable HTTP | 任意ヘッダで Bearer | 自前実装 | 📄 |
| [AWS Bedrock AgentCore Gateway](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-target-MCPservers.html) | Streamable HTTP | OAuth / IAM SigV4 / API キー | ゲートウェイには無い | 📄 |
| [Dify](https://docs.dify.ai/en/cloud/use-dify/build/mcp) | HTTP | 任意ヘッダで Bearer、または OAuth | Human Input ノードを置けば可 | 📄 |
| [n8n（MCP Client Tool）](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.toolmcp/) | HTTP Streamable / stdio | Bearer / 任意ヘッダ / OAuth2 | AI Agent ノードで有効化すれば可 | 📄 |

> [!NOTE]
> 「📄」は**まだ実機で確認していない**という意味です。各基盤のドキュメント上は接続できるはずですが、動作報告をいただけると助かります。
>
> **Claude Desktop は 2026-08-24 に v1.34493 で確認しました。** MCPB のインストール、capability トグル、`ALLOWED_NUMBERS` によるブロック、**SMS の実配信と音声通話の実発信**、通話ステータスの取得、実行前の承認プロンプトまで動作しています。
> ただし **`readOnlyHint` は尊重されず、`get_sms_status` や `get_call_status` のような読み取り専用ツールでも承認プロンプトが出ます**（安全側の挙動なので実害はありません）。
>
> **Streamable HTTP（Cloud Run）も同日に確認しました。** Bearer 認証（未認証は 401）、`ALLOWED_NUMBERS` によるブロック、SMS と音声通話の実行に加えて、
> **`get_sms_status` が `delivered` を返すこと**（Status Webhook 経由）と、`get_call_status` が通話時間・料金を返すことを確認しています。
> **配信ステータスは stdio では取得できません。** 受け取るには HTTP で待ち受け、Vonage に Status URL を登録する必要があります。

### ツール実行前の承認について

`send_sms` / `make_voice_call` / `bulk_sms_from_csv` には、MCP のツール注釈で `destructiveHint: true` を付けています。これを解釈する基盤（Gemini Enterprise など）では、実行前に確認が表示されます。`get_sms_status` / `get_call_status` は `readOnlyHint: true` なので確認は省かれます。

> [!WARNING]
> **注釈は仕様上ヒントであり、強制ではありません。** 無視する基盤もあり、「常に許可」を選べる基盤もあります。**実測でも、Claude Desktop は `readOnlyHint` を尊重せず、読み取り専用ツールにも承認プロンプトを出しました。**
> 上の表で承認が「無い」基盤を使う場合は、[`ALLOWED_NUMBERS` と `RATE_LIMIT_PER_HOUR`](#安全機能guardrailsの環境変数) を必ず設定してください。**承認UIもプロンプトも、実効的な防御にはなりません。**

## インストール方法

### 方法1: MCPB Bundle（推奨 - ワンクリックインストール）

Claude Desktopで簡単にインストールできます：

1. **MCPBファイルのダウンロード**
   - [vonage-mcp-server.mcpb](https://github.com/mobilebiz/vonage-mcp-server/releases/latest) をダウンロード

2. **Claude Desktopで開く**
   - `.mcpb`ファイルをダブルクリック、またはClaude Desktopにドラッグ&ドロップ

3. **環境変数の設定**
   - Claude Desktopのインストールダイアログで以下を入力：
     - `VONAGE_APPLICATION_ID`: Vonage Application ID
     - `VONAGE_PRIVATE_KEY_PATH`: 秘密鍵ファイルのパス（例: `/Users/your-name/vonage/private.key`）
     - `VONAGE_VOICE_FROM`: 音声通話用の電話番号（E.164形式、例: `81345438093`）

4. **インストール完了**
   - Claude Desktopを再起動すると、Vonage MCPサーバーが利用可能になります

### 方法2: 手動セットアップ

## セットアップ

### 依存関係のインストール

```bash
npm install
```

### Vonage設定

1. **Vonageアカウントの作成**
   - 日本国内でご利用の場合は [日本語での申し込みページ](https://kwcplus.kddi-web.com/application/vonage) から作成できます（[詳細](#vonage-アカウントについて)）
   - 海外の場合は [Vonage Developer Portal](https://developer.vonage.com/sign-up) から作成します
   - アプリケーションを作成し、Application IDを取得

2. **秘密鍵の準備**
   - Vonage Developer Portalで秘密鍵（private.key）をダウンロード
   - プロジェクトルートに `private.key` として保存

3. **環境変数の設定**

   ```bash
   cp .env.example .env
   ```

   `.env` ファイルを編集して以下を設定：

   ```sh
   VONAGE_APPLICATION_ID=your_application_id_here
   VONAGE_PRIVATE_KEY_PATH=./private.key
   VONAGE_VOICE_FROM=14155550100  # Voice通話用のFROM番号
   ```

### 機能の有効化（capability トグル）

**このサーバーは、既定ではツールを1つも公開しません。** 使う機能だけを環境変数で明示的に有効にしてください。電話とSMSは実際に課金が発生し、相手にも迷惑がかかりうる操作なので、「気づかないうちに使える状態になっていた」を避けるための設計です。

| 環境変数 | 有効になるツール | 既定 |
| --- | --- | --- |
| `ENABLE_SMS` | `send_sms` / `get_sms_status` | OFF |
| `ENABLE_BULK_SMS` | `bulk_sms_from_csv` | OFF |
| `ENABLE_VOICE` | `make_voice_call` / `get_call_status` | OFF |

```sh
# SMSの単発送信だけを使う場合
ENABLE_SMS=true
```

無効なツールは `tools/list` の結果に含まれません。エージェントが存在しないツールを呼ぼうとして迷走せず、使わないツールの定義がコンテキストを消費することもありません。

> [!IMPORTANT]
> **`ENABLE_BULK_SMS` を `ENABLE_SMS` から分けているのは、爆発半径が違うためです。**
> 単発の `send_sms` が1件なのに対し、`bulk_sms_from_csv` は1回の呼び出しで数百件を送信できます。

> [!WARNING]
> **v1.3.0 の破壊的変更: `generate_jwt` ツールを削除しました。**
> Vonage API を直接叩ける署名済みクレデンシャルを呼び出し側に渡すツールで、**受け取った相手にはこのサーバーのガードレール（宛先制限・レートリミット・capability トグル）が一切効きません**。既定 OFF にしても、一度有効化した後にプロンプトインジェクションで長寿命のトークンを生成させられる余地が残ります。
> AIエージェントから Vonage を使いやすくするという本サーバーの目的に対して汎用の JWT 発行は主要な用途ではないため、迂回路を残さない判断をしました。JWT が必要な場合は [Vonage 公式のサーバーSDK](https://developer.vonage.com/en/getting-started/concepts/authentication) を直接お使いください。

> [!IMPORTANT]
> 有効な値は `true` / `false` のみで、**大文字小文字を区別**します。`ENABLE_SMS=True` や `ENABLE_SMS=1` は起動エラーになります。無効にしたつもりの `false` が truthy と判定されて機能が公開される事故を防ぐため、曖昧な値は推測せずに落とす方針です。

> [!NOTE]
> capability を有効にした場合、`VONAGE_APPLICATION_ID` は必須になります。`ENABLE_VOICE=true` の場合はさらに `VONAGE_VOICE_FROM` が必要で、いずれも未設定なら起動時にエラーになります（実行して初めて失敗するより、起動時に気づけるほうが安全なため）。

### 安全機能（Guardrails）の環境変数

AIエージェント（Gemini Enterprise / Claude 等）から利用する際の、意図しない課金・スパム送信を防ぐための設定です。すべて任意で、未設定でも動作します。

| 環境変数 | デフォルト | 説明 |
| --- | --- | --- |
| `ALLOWED_COUNTRY_CODES` | `81`（日本のみ） | 送信・架電を許可する**国番号**（カンマ区切り、`+` の有無は問わない）。海外宛を使う場合は明示的に追加する。`*` を指定すると制限を外す（非推奨）。実在しない国番号を書くと起動エラーになる。 |
| `ALLOW_PREMIUM_NUMBERS` | `false` | `true` にすると、`0990`（情報料代理徴収）・`0570`（ナビダイヤル）・`0180`（テレドーム）への送信・架電を許可する。 |
| `ALLOWED_NUMBERS` | （未設定＝制限なし） | 送信・架電を許可する宛先番号のホワイトリスト（カンマ区切り）。設定すると、これ以外の番号へのリクエストはエラーになる。表記ゆれ（`090-1234-5678` 等）は正規化して比較される。 |
| `RATE_LIMIT_PER_HOUR` | `5` | 1時間あたりの**送信・架電件数**の上限（`0`〜`10000` の整数）。`send_sms` / `bulk_sms_from_csv` / `make_voice_call` に**ツールごと独立して**適用される。**`0` は「すべて拒否」**（緊急停止）。`dry_run: true` の呼び出しは消費しない。 |
| `BULK_MAX_ROWS` | `100` | `bulk_sms_from_csv` が一度に受け付けるCSVの最大行数（`0`〜`10000` の整数）。**`0` は「すべて拒否」**（bulk の停止）。 |
| `SMS_RATE_LIMIT_PER_HOUR` | （未設定＝`RATE_LIMIT_PER_HOUR` に委ねる） | SMS だけをさらに絞りたい場合の上限。`send_sms` と `bulk_sms_from_csv` の合計に対して効く。 |
| `SMS_SEGMENT_LIMIT_PER_HOUR` | （未設定＝制限なし） | 1時間あたりの**セグメント数**の上限。**課金と直結する唯一の設定**。 |
| `SMS_MAX_SEGMENTS` | `3` | 1通のSMSに許すセグメント数（`1`〜`10`）。 |
| `VOICE_RATE_LIMIT_PER_HOUR` | （未設定＝`RATE_LIMIT_PER_HOUR` に委ねる） | 架電だけをさらに絞りたい場合の上限。 |
| `DISABLE_RATE_LIMIT` | `false` | `true` にするとレートリミットを完全に無効化する。**危険な設定**であり、起動のたびに警告が出る。本番環境では使わないこと。 |
| `VONAGE_API_SIGNATURE_SECRET` | （未設定） | Status Webhook の署名検証に使う Vonage の Signature Secret。**推奨**。Vonage Dashboard の Settings → API settings で取得できる。 |
| `VONAGE_WEBHOOK_SECRET` | （未設定） | 署名検証が使えない環境向けの代替。設定すると `x-webhook-secret` ヘッダーの一致を要求する。`VONAGE_API_SIGNATURE_SECRET` が設定されている場合は使われない。 |
| `WEBHOOK_MAX_AGE_SECONDS` | `300` | 署名付き Webhook の `iat` / `exp` に許す時刻のずれ（秒、`1`〜`3600`）。短いほどリプレイ可能な時間窓が縮む。 |

```sh
# 検証中は自分の番号だけに送信を許可する例
ALLOWED_NUMBERS=+819012345678,+819087654321
RATE_LIMIT_PER_HOUR=3
BULK_MAX_ROWS=10
VONAGE_API_SIGNATURE_SECRET=your_signature_secret_here
```

### 日本向け SMS の利用条件

> [!NOTE]
> ここに書いているのは**法的助言ではありません**。Vonage の利用規約およびキャリアの仕様として公開されている事項を、利用者が確認すべき論点として整理したものです。最新の条件は Vonage のサポート記事と契約書をご確認ください。
> このプロジェクトの規制案内は**日本国内での利用を対象**としています。他地域の利用者はご自身で確認する責任を負います。

#### 守るべき利用条件

| 項目 | 内容 |
| --- | --- |
| マーケティング目的の送信 | **受信者からのオプトイン同意が必須** |
| P2P（個人間）トラフィック | **禁止** |
| 禁止コンテンツ | 政治 / 宗教 / 未承諾プロモーション / ギャンブル |

**これらはサーバー側では判定できません。** 本文の内容や同意取得の有無はサーバーからは分からないため、利用者の責任で遵守してください。

#### 配信の不確実性 — もっとも注意が必要な点

> [!WARNING]
> **日本のネットワークでは、URL を含むメッセージがフィッシング SMS 対策として配信されないことがあります。拒否基準は非公開です。**
> 問題は、**API が成功を返すのに実際には届かない**ことです。AIエージェントは失敗を検知できないため、放っておくと「送信できました」とユーザーに報告してしまいます。

このサーバーはこう扱います。

- **ブロックはしません。** 正当な用途がありますし、拒否基準が非公開である以上こちらで判定しきれません
- 日本宛で URL を含む本文の場合、`dry_run` と成功レスポンスに **`delivery_warning`** を添えます
- `send_sms` の description に「成功レスポンスは配信保証ではない」と明記しています

**重要な連絡に SMS を使う場合は、`get_sms_status` で配信結果を確認し、別の手段も併用してください。**

#### 文字数

Unicode 連結メッセージの上限は Docomo / KDDI / Softbank が 670文字、Rakuten が 660文字です。このサーバーは安全側の **660文字**を絶対上限とし、実際の制限は[セグメント数](#sms-の課金単位--セグメント)で掛けています。

#### `content_id` / `entity_id` について

Vonage Messages API には「特定国の規制要件を満たすためのパラメータ」として `content_id` / `entity_id` がありますが、**これらはインドの DLT（Distributed Ledger Technology）登録制度のためのものです**。`entity_id` が DLT に登録した Principal Entity ID、`content_id` が承認済みテンプレート ID にあたります。

**日本宛の送信では不要**なため、このサーバーでは使用していません。

#### 送信者ID（sender ID）のルール

SMS の `from` には Vonage 公式ルールが適用されます。**英数字1〜11文字（A-Z a-z 0-9）**で、先頭文字と最小長の制限はありません。`2FA` や `AB` も有効です。

日本宛には、これに加えて日本の携帯キャリア固有の制限がかかります。

| 種別 | 日本宛 | 挙動 |
| --- | --- | --- |
| 英数字（例: `VonageMCP`） | ✅ 使用可 | そのまま表示される |
| 電話番号（例: `+819012345678`） | ❌ 使用不可 | **拒否します** |
| 汎用語（`INFO` / `SMS` / `NOTICE` など） | ❌ 使用不可 | **拒否します** |

> [!IMPORTANT]
> **日本宛で電話番号を送信元に指定しても、Vonage 側で別の送信者IDに上書きされます。**
> このサーバーは、これを「送れる」と応答せずに拒否します。通してしまうと、`dry_run` が「この番号から送ります」と答えてユーザーが承認したのに、**実際にはまったく別の送信者IDで届く**からです。承認した内容と届く内容が食い違うのが、いちばん避けたい失敗の形です。

日本以外が宛先の場合、これら2つの制限は適用されません（自社の発信元電話番号を送信元に使えます）。

#### 宛先のガードレール

宛先には、緩められるものと緩められないものの2種類の制限がかかります。

| 対象 | 挙動 | 緩められるか |
| --- | --- | --- |
| 緊急通報番号（`110` / `119` / `118`） | 常にブロック | **不可** |
| 高額課金番号（`0990` / `0570` / `0180`） | 既定でブロック | `ALLOW_PREMIUM_NUMBERS=true` |
| 国番号 | 既定で日本（`81`）のみ | `ALLOWED_COUNTRY_CODES` |
| 個別の番号 | 未設定なら制限なし | `ALLOWED_NUMBERS` |

これらは AND で効きます。`ALLOWED_NUMBERS` に載せた番号でも、国番号が許可されていなければブロックされます。判定はすべて `dry_run: true` の時点で行われるので、「dry_run は通ったのに本番で弾かれた」は起きません。

> [!WARNING]
> **`ALLOWED_COUNTRY_CODES` は IRSF（国際収益分配詐欺）に対する主防御にはなりません。**
> 国番号と国は一対一ではありません。`+1` は米国・カナダに加えてカリブ海の多数の国が共有しているため、「米国宛だけ許可」というポリシーはこの仕組みでは表現できません。米国宛のつもりで `1` を追加すると、同じ `+1` 配下の高リスク地域も同時に開きます。
> 実効的な防御は以下の併用です:
> - **`ALLOWED_NUMBERS`** による宛先の個別指定（もっとも確実）
> - **Vonage アカウント側の地域制限・利用額上限・アラート**（サーバーを迂回されても効く唯一の層）
> - `RATE_LIMIT_PER_HOUR` による被害額の上限

> [!NOTE]
> 短縮番号（`110` や海外の `911` / `112` など）は、E.164 の桁数要件を満たさないため一律で拒否されます。日本の緊急通報番号については、桁数検証とは独立した明示的なブロックも入れています（桁数の扱いが将来変わっても効き続けるようにするため）。

#### レートリミットの数え方

**「ツール呼び出し回数」ではなく「送信件数」で消費されます。** `bulk_sms_from_csv` は CSV の送信対象行数の分だけまとめて枠を消費し、残り枠が足りない場合は**1件も送信せず**エラーを返します。巨大なCSVを渡して上限を迂回することはできません。

枠はツールごとではなく、次の2層で管理されます。

| バケット | 消費単位 | 対象 | 環境変数 |
| --- | --- | --- | --- |
| `global` | 件数 | SMS・架電のすべて | `RATE_LIMIT_PER_HOUR` |
| `sms` | 件数 | `send_sms` + `bulk_sms_from_csv` | `SMS_RATE_LIMIT_PER_HOUR` |
| `voice` | 件数 | `make_voice_call` | `VOICE_RATE_LIMIT_PER_HOUR` |
| `segments` | **セグメント数** | SMS のみ | `SMS_SEGMENT_LIMIT_PER_HOUR` |

1回の送信は該当するバケットを**同時に**消費します。どれか1つでも足りなければ**どれも消費せず**エラーになるので、「送っていないのに枠だけ減る」ことはありません。エラーレスポンスの `exceeded_bucket` に、どのバケットで不足したかが入ります。

#### SMS の課金単位 — セグメント

**SMS の課金は通数ではなくセグメント単位です。** 1セグメントに入る文字数はエンコーディングで変わります。

| エンコーディング | 1通の場合 | 連結時（1セグメントあたり） |
| --- | --- | --- |
| GSM-7（英数字のみ） | 160文字 | 153文字 |
| UCS-2（日本語などを含む） | **70文字** | **67文字** |

**非ASCII文字が1文字でも混ざると、本文全体が UCS-2 になります。** 英数字159文字＋日本語1文字で、1セグメントから3セグメントに跳ねます。

> [!IMPORTANT]
> **`RATE_LIMIT_PER_HOUR=5` は「1時間に5通まで」であって「5通分の課金まで」ではありません。**
> 日本語で160文字のSMSは3セグメント＝**3通分の課金**になるため、5通送ると実際の課金は約15通分です。
> 費用そのものを抑えたい場合は `SMS_SEGMENT_LIMIT_PER_HOUR` を設定してください。これがセグメント数を直接数える唯一の設定です。
> 設定しない場合の最悪ケースは `RATE_LIMIT_PER_HOUR × SMS_MAX_SEGMENTS` セグメント（既定なら 5 × 3 = 15）です。

**本文の上限はセグメント数で指定します**（`SMS_MAX_SEGMENTS`、既定 `3`）。文字数で縛っても課金と対応しないためです。既定の3セグメントは、日本語なら約200文字、英数字なら約450文字に相当します。

`dry_run` のレスポンスに `encoding` と `segments`（bulk では `estimated_segments`）が含まれるので、**送信前にユーザーへ提示してください**。

> [!IMPORTANT]
> **`RATE_LIMIT_PER_HOUR=5` は「1時間に合計5件まで」を意味します。**
> ツールごとに別枠ではありません。単発SMSで5件送ったあと1行だけのCSVを繰り返す、といった方法で上限を超えることはできません。

> [!WARNING]
> **v1.3.0 の破壊的変更: SMS 本文の上限が「160文字」から「3セグメント」に変わりました。**
> 英数字だけなら約450文字まで送れるようになり（従来より緩和）、日本語では約200文字までになります（従来の160文字より緩和）。ただし**絵文字や記号を多用すると従来より厳しくなる場合があります**。
> 文字数で縛っても課金と対応しないためです。同じ160文字でも、英数字なら1通分、日本語なら3通分の課金でした。

> [!WARNING]
> **v1.3.0 の破壊的変更: `RATE_LIMIT_PER_HOUR=0` / `BULK_MAX_ROWS=0` の意味が反転しました。**
> v1.2.1 以前は `0` が「無制限」でしたが、v1.3.0 以降は「**すべて拒否**」になります。緊急停止のつもりで `0` を設定した管理者が、逆に無制限にしてしまう事故を防ぐためです。
> 無制限にしたい場合は `DISABLE_RATE_LIMIT=true` を明示的に設定してください。`BULK_MAX_ROWS` に無制限の指定はありません（上限 `10000` まで）。

> [!IMPORTANT]
> **環境変数は起動時に厳格に検証されます。**解釈できない値があると、サーバーは警告を出して動き続けるのではなく、エラーメッセージを表示して**起動に失敗**します（fail-fast）。
> - 真偽値（`ENABLE_*` / `DISABLE_RATE_LIMIT`）に指定できるのは `true` / `false` のみです。**大文字小文字を区別**し、`1` / `yes` / `on` / `True` はすべてエラーになります。`False` のような値を truthy と誤判定して、無効にしたつもりの設定が有効になる事故を防ぐためです
> - 数値（`RATE_LIMIT_PER_HOUR` / `BULK_MAX_ROWS`）は10進整数のみです。小数・指数表記・負数・範囲外はエラーになります
> - 問題は**まとめて**報告されます。1つ直すたびに再起動する必要はありません

> [!IMPORTANT]
> `ALLOWED_NUMBERS` を設定しているのに有効な電話番号が1件も解釈できない場合（例: `ALLOWED_NUMBERS=,`）、「制限なし」ではなく**すべて拒否**として扱います。設定ミスを安全側に倒すためです。制限が不要な場合は環境変数自体を削除してください。

> [!IMPORTANT]
> `VONAGE_API_SIGNATURE_SECRET` と `VONAGE_WEBHOOK_SECRET` の**どちらも未設定の場合、Status Webhook エンドポイントは 503 を返して無効化されます**。未認証で受け付けると、誰でも任意の `message_id` の配信ステータスを偽装できてしまうためです。

> [!IMPORTANT]
> **署名付き Webhook では、署名の一致だけでなく `payload_hash` / `iat` / `jti` をすべて検証し、いずれかが欠けていれば 401 で拒否します。**
> 署名が正しいことは「Vonage が一度発行した」ことしか意味しません。claim が無ければ検証をスキップする実装だと、攻撃者は claim を外した JWT を作るだけで検証を無効化できます。有効な JWT が一度でもログやプロキシから漏れた場合に、**無期限に、任意のボディと組み合わせて**再利用されるのを防ぐための措置です。
> - `payload_hash`: このボディに対して発行された署名か
> - `iat` / `exp`: `WEBHOOK_MAX_AGE_SECONDS` 以内に発行されたものか（未来方向のずれも拒否）
> - `jti`: 同じ JWT の使い回しでないか（受理済みの `jti` は許容時間内は記憶される）

> [!WARNING]
> **`VONAGE_API_SIGNATURE_SECRET` を設定した場合、共有シークレット認証にはフォールバックしません。**
> 両方を設定していても、署名検証に失敗したリクエストは `x-webhook-secret` が正しくても 401 になります。フォールバックすると、攻撃者は `Authorization` ヘッダーを外すか壊すだけで弱いほうの方式を選べてしまうためです（ダウングレード攻撃）。

> [!NOTE]
> レートリミットはオンメモリ管理のため、プロセスを再起動するとカウントはリセットされます。

### 開発用依存関係のインストール

```bash
npm install --save-dev @types/node typescript ts-node
```

## 開発

### 開発サーバーの起動

```bash
npm run dev:start
```

### TypeScriptのコンパイル

```bash
npm run build
```

### コンパイルされたコードの実行

```bash
# 環境変数ファイル(.env)を使用して実行（推奨・Node.js v22以降）
npm start

# 環境変数ファイルを使用せずに実行（従来方式）
npm run start:legacy
```

### ファイル監視モード（コンパイル）

```bash
npm run dev
```

### ビルドファイルのクリーンアップ

```bash
npm run clean
```

### テストの実行

```bash
npm test
```

### テストの監視モード

```bash
npm run test:watch
```

### カバレッジ付きテスト

```bash
npm run test:coverage
```

## Claude Desktopでの利用

このMCPサーバーをClaude Desktopで利用するための設定方法を説明します。

### 方法1: MCPB Bundle（推奨 - ワンクリックインストール）

`.mcpb`ファイルを使用すると、Claude Desktopに簡単にインストールできます。

#### インストール手順

1. **MCPBファイルの作成**

   `mcpb` CLI が必要です（未インストールなら一度だけ）。

   ```bash
   npm install -g @anthropic-ai/mcpb
   ```

   ```bash
   npm run build:mcpb
   ```
   これにより `vonage-mcp-server.mcpb` ファイルが作成されます。

2. **Claude Desktopで開く**
   - 作成された `.mcpb` ファイルをダブルクリック
   - または Claude Desktop にドラッグ&ドロップ

3. **環境変数の設定**
   Claude Desktop のインストールダイアログで以下を入力：
   - **Vonage Application ID**: Vonage Application ID
   - **Private Key Path**: 秘密鍵ファイルの絶対パス（例: `/Users/your-name/vonage/private.key`）
   - **Voice Call From Number**: 音声通話用の電話番号（E.164形式、例: `81345438093`）

4. **インストール完了**
   Claude Desktop を再起動すると、Vonage MCP サーバーが利用可能になります。

#### MCPBファイルの配布

作成した `.mcpb` ファイルは他のユーザーと共有できます：
- GitHub Releases で配布
- 直接ファイルを共有

### 方法2: 手動セットアップ

#### 1. サーバーのビルドと起動

```bash
# プロジェクトをビルド
npm run build

# サーバーを起動（Node.js v22以降、推奨）
npm start

# または従来方式で起動（環境変数ファイルを使用しない場合）
npm run start:legacy
```

#### 2. Claude Desktopの設定

Claude Desktopの設定ファイル `claude_desktop_config.json` に以下の設定を追加します：

```json
{
  "mcpServers": {
    "vonage-mcp-server": {
      "command": "node",
      "args": ["--env-file=.env", "dist/index.js"],
      "cwd": "/Users/your-username/path/to/vonage-mcp-server"
    }
  }
}
```

または環境変数を直接指定する方法もあります：

```json
{
  "mcpServers": {
    "vonage-mcp-server": {
      "command": "node",
      "args": ["/Users/your-username/path/to/vonage-mcp-server/dist/index.js"],
      "env": {
        "VONAGE_APPLICATION_ID": "your-application-id",
        "VONAGE_PRIVATE_KEY_PATH": "/Users/your-username/path/to/vonage-mcp-server/private.key"
      }
    }
  }
}
```

#### 設定ファイルの場所

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux**: `~/.config/Claude/claude_desktop_config.json`

#### 設定手順

1. 上記のパスにある `claude_desktop_config.json` を開く
2. `mcpServers` セクションに上記の設定を追加
3. ファイルを保存
4. Claude Desktopを再起動

### 3. 利用可能な機能

設定完了後、Claude Desktopで以下の機能が利用できます：

#### ツール

すべてのツールは軽量なJSONを返します（Vonage APIの生レスポンスは返しません）。詳細は [ツールのレスポンス形式](#ツールのレスポンス形式) を参照してください。

- **send_sms**: 単発SMS送信ツール
  - 入力:
    - `to` (必須): 送信先の電話番号（E.164形式 `+819012345678` または日本の国内形式 `09012345678`）
    - `message` (必須): 送信するメッセージ（**最大3セグメント** — 日本語なら約200文字、英数字なら約450文字。[SMS の課金単位](#sms-の課金単位--セグメント)を参照）
    - `from` (オプション): 送信元。英数字1〜11文字（A-Z a-z 0-9）。省略時は'VonageMCP'。`dry_run` の時点で検証される。[送信者ID（sender ID）のルール](#送信者idsender-idのルール)を参照
    - `dry_run` (オプション): `true` で送信せず検証のみ（デフォルト: `false`）
  - 機能:
    - 日本の電話番号（0から始まる）は自動的にE.164形式に変換
    - `{"status":"success","message_id":"...","to":"+81..."}` を返却

- **bulk_sms_from_csv**: CSV一括SMS送信ツール
  - 入力:
    - `csv_content` (必須): CSVファイルの内容（phone,from,messageのヘッダー付き）
    - `dry_run` (オプション): `true` で送信せず件数のみ返却
  - 機能:
    - CSVファイルを解析して複数宛先に一括SMS送信
    - 無効な行・`ALLOWED_NUMBERS` 外の行・**セグメント上限を超える行**は自動的にスキップ
    - CSVの行数は `BULK_MAX_ROWS`（デフォルト100、`0` は全拒否）で制限
    - **送信件数の分だけレートリミットを消費**し、残り枠が足りなければ1件も送信しない
    - 送信件数と失敗の要約（先頭10件）を返却
    - API制限回避のため100ms間隔で順次送信

- **make_voice_call**: 音声通話ツール
  - 入力:
    - `to` (必須): 発信先電話番号（E.164形式または0ABJ形式）
    - `message` (必須): 読み上げるメッセージ（最大1000文字）
    - `voice` (オプション): `女性` または `男性`（デフォルト: 女性）
    - `dry_run` (オプション): `true` で発信せず検証のみ
  - 機能:
    - 指定番号に発信してメッセージを音声で読み上げ
    - 日本語音声対応（女性・男性）
    - NCCO（Nexmo Call Control Object）を使用
    - 通話時間の自動見積もり。**見積もりから通話の強制切断時間（`length_timer`）を決める**ため、`dry_run` で提示した時間を大きく超えて課金されることはない
    - `dry_run` は `estimated_duration_seconds`（見積もり）と `max_duration_seconds`（実際に適用される上限）の両方を返す

- **get_call_status**: 通話ステータス取得ツール
  - 入力:
    - `call_id` (必須): 取得する通話のCall ID（UUID形式）
  - 機能:
    - Vonage Voice APIから通話のステータス情報を取得
    - `call_status`（通話ステータス）、`start_time`、`price`、`rate`、`duration_seconds` を返却
    - 環境変数から自動的にApplication IDとPrivate Keyを読み込み

- **get_sms_status**: SMS配信ステータス取得ツール
  - 入力:
    - `message_id` (必須): `send_sms` が返した message_id
  - 機能:
    - `delivery_status`（`submitted` / `delivered` / `failed` 等）を返却
    - **Vonage Messages APIは配信ステータスを同期取得できない**ため、HTTPサーバー版の
      Status Webhook（`POST /webhooks/message-status`）で受信した結果を参照する
    - Webhook未設定時・stdio版では `submitted` のまま（`note` フィールドで明示される）
    - 記録はオンメモリで24時間保持（プロセス再起動でクリア）

#### ツールのレスポンス形式

| status | 意味 | 例 |
| --- | --- | --- |
| `success` | 実行成功 | `{"status":"success","message_id":"abc","to":"+819012345678"}` |
| `partial_success` | 一括送信で一部だけ成功 | `{"status":"partial_success","sent":8,"failed":2,"failures":[...]}` |
| `dry_run_success` | 検証のみ成功（API呼び出しなし） | `{"status":"dry_run_success","message":"Ready to send","to":"+819012345678","characters":12}` |
| `error` | 失敗（一括送信の全件失敗を含む） | `{"status":"error","reason":"無効な電話番号形式です: 123","suggestion":"番号のフォーマットを確認してください。..."}` |

エラー時は必ず `reason`（原因）と `suggestion`（AIが次に取るべき行動）が含まれます。再試行が無意味なケースでは `suggestion` にその旨が明記されるため、AIエージェントの無限リトライを防げます。

一括送信は結果に応じて `success` / `partial_success` / `error` を返し分けます。トップレベルの `status` だけを見て「全件送れた」と誤認しないためです。

### 4. 使用例

Claude Desktopで以下のような質問ができます：

#### 単発SMS送信

```text
「090XXXXYYYYに「これはVonage MCPサーバーを使って送信しています。」とSMSを送ってください」
→ send_smsツールを使用してSMS送信
```

#### CSV一括SMS送信

```text
「以下のCSVデータで一括SMS送信をしてください」
phone,from,message
090-1234-5678,VonageMCP,テストメッセージです
080-9876-5432,SalesTeam,お打ち合わせの件でご連絡しました

→ bulk_sms_from_csvツールを使用して一括送信
```

#### 音声通話

```text
「090XXXXYYYYに女性の声で『会議は明日の10時からです』と電話をかけて」
→ make_voice_callツールを使用して発信・音声読み上げ

「080XXXXYYYYに男性の声で『システム障害が発生しました。至急対応をお願いします』と電話で伝えて」
→ make_voice_callツールを使用して緊急連絡
```

#### 通話ステータス取得

```text
「Call ID ca6b7710-3423-4c8d-b630-7b981ec4b2c2 の通話ステータスを取得してください」
→ get_call_statusツールを使用して通話情報を取得

「先ほどの通話の料金と時間を教えてください」
→ get_call_statusツールで通話詳細を確認
```

## CSV一括送信機能

### CSVファイル形式

CSV一括送信機能では以下の形式のCSVファイルを使用します：

```csv
phone,from,message
090-1234-5678,VonageMCP,テストメッセージです
080-9876-5432,SalesTeam,お打ち合わせの件でご連絡しました
070-1111-2222,Support,システムメンテナンスのお知らせ
```

#### フィールド仕様

- **phone**: 送信先電話番号
  - 日本の0ABJ形式（090-1234-5678）が推奨
  - 自動的にE.164形式（+819012345678）に変換
  
- **from**: 送信者名
  - 単発の `send_sms` とまったく同じルールが適用されます（[送信者ID（sender ID）のルール](#送信者idsender-idのルール)）
  - 英数字1〜11文字（A-Z, a-z, 0-9）。数字始まりも可
  - 日本宛では、電話番号と `INFO` などの汎用語は使用不可
  - 例: `VonageMCP`, `SalesTeam`, `2FA`

- **message**: 送信メッセージ
  - 70文字以内推奨（超過時は警告表示）
  - 日本語使用可能

### バリデーション機能

- 無効な行は自動的にスキップされ、処理継続
- 詳細なエラーレポートを返却
- 送信成功/失敗の件数と詳細を表示

### サンプルCSVファイル

プロジェクトには以下のサンプルCSVファイルが含まれています：

- `csv/sample_contacts.csv` - 基本テスト用
- `csv/meeting_reminder.csv` - 会議リマインダー用
- `csv/emergency_notification.csv` - 緊急連絡用
- `csv/sales_follow_up.csv` - 営業フォロー用
- `csv/invalid_data_example.csv` - バリデーションテスト用

## Voice通話機能

### 機能概要

Voice APIを使用して自動音声通話を発信し、指定されたメッセージを日本語で読み上げます。

### 主な特徴

- **自動発信**: 指定番号への自動発信
- **日本語音声**: 女性・男性音声による自然な読み上げ
- **NCCO制御**: Nexmo Call Control Objectによる通話フロー制御
- **通話時間見積**: メッセージ長から自動的に通話時間を算出し、**通話の強制切断時間に連動させる**

> [!IMPORTANT]
> **通話時間には絶対上限（300秒）があります。**
> v1.2.1 以前は Vonage へ `length_timer: 7200`（2時間）を送っていました。`dry_run` が「約N秒」と提示してユーザーが承認しても、NCCO の挙動や機械検出の結果によっては**最大2時間まで課金され得る**状態でした。音声は分課金なので、SMS と違って金額の跳ね方が大きい点が問題です。
> 現在は「見積もり + 30秒の余裕」を上限として送り、どんな場合も 300 秒を超えません。`dry_run` の `max_duration_seconds` が実際に適用される値です。

### 音声オプション

| 音声タイプ | 性別 | 言語 | 特徴 |
|------------|------|------|------|
| 女性 | 女性 | 日本語 | 自然で聞き取りやすい（デフォルト） |
| 男性 | 男性 | 日本語 | 落ち着いた男性音声 |

### 使用例

```javascript
// 会議リマインダー
make_voice_call({
  to: "090-1234-5678",
  message: "明日の会議は10時から会議室Aで行います。資料をご準備ください。",
  voice: "女性"
})

// 緊急連絡
make_voice_call({
  to: "080-9876-5432",
  message: "システム障害が発生しました。至急対応をお願いします。",
  voice: "男性"
})
```

## 通話ステータス取得機能

### 機能概要

Vonage Voice APIを使用して、過去の通話のステータス情報を取得します。通話の詳細（ステータス、料金、レート、通話時間）を確認できます。

### 主な特徴

- **詳細情報取得**: 通話のステータス、料金、レート、通話時間を一度に取得
- **自動設定読み込み**: 環境変数から自動的にApplication IDとPrivate Keyを取得
- **エラーハンドリング**: 存在しないCall IDに対する適切なエラーメッセージ

### パラメータ

| パラメータ | 型 | 説明 |
|------------|------|------|
| call_id | string | 取得する通話のCall ID（UUID形式）。必須 |

### 返却される情報

- **status**: 通話のステータス（completed, answered, busy, failed など）
- **start_time**: 通話開始時刻（ISO 8601形式）
- **price**: 通話料金（数値形式）
- **rate**: 通話レート（1分あたりの料金）
- **duration**: 通話時間（秒単位）

### 使用例

```javascript
// Call IDを指定して通話ステータスを取得
get_call_status({
  call_id: "ca6b7710-3423-4c8d-b630-7b981ec4b2c2"
})

// 結果例:
// ステータス: completed
// 開始時刻: 2025-12-10T03:53:19.000Z
// 料金: 0.06287850
// レート: 0.13973000
// 通話時間: 27秒
```

### 5. トラブルシューティング

#### サーバーが起動しない場合

- `npm run build` が正常に完了しているか確認
- `npm start` でエラーが出ないか確認
- Node.jsバージョンが20.6.0以降であることを確認（`node -v`）

#### Claudeデスクトップでのエラー

- JSON解析エラー「Unexpected token 'd', "[dotenv@17."... is not valid JSON」が表示される場合:
  - `claude_desktop_config.json`のargsに`--env-file=.env`が含まれていることを確認
  - サーバーコードがdotenvを使用していないことを確認（最新のコードではdotenvは使用していません）
  - MCPサーバーを再起動

#### Claude Desktopで認識されない場合

- `claude_desktop_config.json` の設定が正しいか確認
- 作業ディレクトリ（cwd）のパスが正しいか確認
- Claude Desktopを再起動

#### 機能が利用できない場合

- サーバーのログを確認（Claude Desktopの設定画面で確認可能）
- サーバーを再起動

#### Voice通話機能のトラブルシューティング

- Voice通話が発信されない場合:
  - `VONAGE_VOICE_FROM`環境変数が正しく設定されているか確認
  - VonageアプリケーションでVoice機能が有効になっているか確認
  - FROM番号がVonageアカウントに登録されているか確認
  
- 通話は繋がるが音声が再生されない場合:
  - NCCOパラメータの音声設定を確認
  - 音声オプション（女性/男性）が正しく指定されているか確認

## プロジェクト構造

```sh
vonage-mcp-server/
├── src/                    # TypeScriptソースコード
│   ├── index.ts           # stdio版エントリーポイント
│   ├── http-server.ts     # HTTP版エントリーポイント・Webhook受信
│   ├── tools.ts           # MCPツール定義の共通レジストリ（stdio/HTTP共用）
│   ├── guardrails.ts      # 電話番号検証・ホワイトリスト・レートリミット
│   ├── toolResponse.ts    # 軽量JSONレスポンスの整形
│   ├── messageStatusStore.ts # SMS配信ステータスのオンメモリ保持
│   ├── webhookAuth.ts     # Vonage署名付きWebhookの検証
│   ├── vonage.ts          # Vonage SMS送信機能
│   ├── csvUtils.ts        # CSV解析・バリデーション機能
│   ├── voiceCall.ts       # Voice通話機能・NCCO生成
│   └── callStatus.ts      # 通話ステータス取得機能
├── csv/                    # サンプルCSVファイル
│   ├── sample_contacts.csv        # 基本テスト用
│   ├── meeting_reminder.csv       # 会議リマインダー用
│   ├── emergency_notification.csv # 緊急連絡用
│   ├── sales_follow_up.csv        # 営業フォロー用
│   └── invalid_data_example.csv   # バリデーションテスト用
├── tests/                  # テストファイル
│   ├── index.test.ts      # メイン機能のテスト
│   ├── utils.test.ts      # ユーティリティのテスト
│   ├── callStatus.test.ts # 通話ステータス取得のテスト
│   ├── tools.test.ts      # ツールレジストリ・ガードレール統合のテスト
│   ├── guardrails.test.ts # ホワイトリスト・レートリミットのテスト
│   ├── messageStatusStore.test.ts # 配信ステータス保持のテスト
│   ├── http-server.test.ts # HTTPラッパーのテスト
│   └── integration.test.ts # 統合テスト
├── docs/
│   ├── deployment.md      # デプロイ手順
│   └── gemini_system_instruction.md # Gemini Enterprise向けSystem Instruction

### HTTPラッパー (Dify / 外部アプリ用)

HTTPラッパーを使用してサーバーを実行することで、外部アプリケーション（Difyなど）からHTTP POSTリクエスト経由でMCPツールを呼び出すことができます。

```bash
npm run start:http
```

これにより、ポート3000（デフォルト）でHTTPサーバーが起動します。

#### 認証

**MCP エンドポイント (`/mcp`) は Bearer トークンで認証します。**

```sh
# 32バイトのランダムな値を生成して設定する
MCP_AUTH_TOKEN=$(openssl rand -hex 32)
```

```bash
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $MCP_AUTH_TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

| 環境変数 | 既定 | 説明 |
| --- | --- | --- |
| `MCP_AUTH_TOKEN` | （未設定） | `/mcp` の Bearer トークン。16文字以上。短い値は起動エラーになる。 |
| `TRUST_UPSTREAM_AUTH` | `false` | `true` にすると、このサーバー自身は認証せず上流（Cloud Run IAM / API Gateway など）に任せる。 |
| `BIND_HOST` | 認証があれば `0.0.0.0`、無ければ `127.0.0.1` | 待ち受けアドレス。 |
| `PORT` | `3000` | 待ち受けポート。 |
| `ALLOWED_ORIGINS` | （未設定＝**すべて拒否**） | CORS で許可するオリジン（カンマ区切り）。ブラウザから `/mcp` を呼ぶ場合のみ設定する。 |
| `ALLOWED_HOSTS` | ループバック運用なら `localhost` / `127.0.0.1` / `::1` | 許可する `Host` ヘッダーのホスト名（カンマ区切り）。ポートは比較に含まれない。 |

> [!IMPORTANT]
> **CORS は既定で閉じています。**
> Bearer トークン認証があっても、ブラウザ側がトークンを持つ構成（ブラウザ拡張や Web 版の MCP クライアント）では、CORS が開いていると悪意ある Web ページが `/mcp` を呼び、**レスポンスまで読み取れます**。ツールのレスポンスに含まれる宛先や配信状況も読み取られます。
> MCP クライアントの多くはブラウザではないため、開ける必要があるのは例外的なケースだけです。必要な場合のみ `ALLOWED_ORIGINS` に列挙してください。

> [!IMPORTANT]
> **ループバック運用では `Host` ヘッダーを検証します（DNS rebinding 対策）。**
> 攻撃者が自分のドメインを `127.0.0.1` に解決させると、ブラウザからは同一オリジンに見えるため **CORS では防げません**。このとき `Host` ヘッダーには攻撃者のドメインが入るので、そこで `403` を返します。
> 外部アドレスに bind する場合、正しい `Host` は運用者のドメインでありサーバー側からは分かりません。推測して塞ぐと正規のリクエストまで落ちるため、`ALLOWED_HOSTS` が明示されるまで検証しません。**インターネットに公開する場合は `ALLOWED_HOSTS` の設定を推奨します。**

> [!WARNING]
> **v1.3.0 の破壊的変更: `X-API-KEY` による認証を廃止しました。**
> v1.2.1 以前は `X-API-KEY` ヘッダを `VONAGE_APPLICATION_ID` と比較していました。**Application ID は秘密情報ではありません** — Vonage に送る JWT の claim に入る公開識別子です。これを認証に使うと、Application ID を知っている者は誰でも、そのデプロイの持ち主の課金で SMS 送信や架電ができてしまいます。`MCP_AUTH_TOKEN` に移行してください。

> [!IMPORTANT]
> **認証を設定しない場合、HTTPサーバーは `127.0.0.1` でのみ待ち受けます。**
> 認証なしで `BIND_HOST` に外部アドレスを指定すると、**起動時にエラーで停止します**。
> リクエストごとに接続元が localhost かを判定する方式は採っていません。Cloud Run やリバースプロキシの配下では、アプリから見た接続元が `127.0.0.1` になり、**外部からのリクエストが全部「localhost」と判定されて無認証で通る**ためです。bind するアドレスならプロキシの有無に左右されません。

#### 推奨構成: 認証は手前の層に置く

もっとも堅いのは、**Cloud Run IAM や API Gateway をこのサーバーの手前に置く**構成です。認証の実装をこのサーバーから切り離せるうえ、鍵のローテーションや監査ログもプラットフォーム側の仕組みに乗せられます。

その場合は `TRUST_UPSTREAM_AUTH=true` を設定してください（起動のたびに警告が出ます）。**手前で認証していない環境でこれを有効にすると完全に無防備になります。**

```sh
# Cloud Run IAM で認証する例（--allow-unauthenticated は付けない）
gcloud run deploy vonage-mcp-server \
  --set-env-vars TRUST_UPSTREAM_AUTH=true,ENABLE_SMS=true \
  --no-allow-unauthenticated
```

#### APIエンドポイント

| 経路 | 認証 |
| --- | --- |
| `GET /health` | 不要 |
| `POST /mcp` | Bearer トークン（`/mcp` 配下は**全 HTTP メソッド**が対象） |
| `POST /webhooks/*` | Vonage の署名検証 |

**ALL** `/mcp`

MCP の **Streamable HTTP** エンドポイントです。POST (JSON-RPC) / GET (SSE) / DELETE (セッション終了) を MCP SDK の `StreamableHTTPServerTransport` が処理します。手書きの JSON-RPC 実装ではないので、仕様の追加に追従できます。

仕様どおり、クライアントは POST に `Accept: application/json, text/event-stream` を付ける必要があります（欠けていると `406` になります）。

```bash
curl -X POST http://localhost:3000/mcp \
  -H "Authorization: Bearer $MCP_AUTH_TOKEN" \
  -H "Accept: application/json, text/event-stream" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

> [!NOTE]
> **セッションを持たないステートレス構成です。** リクエストごとにサーバーとトランスポートを生成し、`Mcp-Session-Id` を発行しません。
> セッションを持つとその状態がプロセスのメモリに載るため、Cloud Run のように複数レプリカへ分散する環境では、同じセッションが別のレプリカに届いた時点で壊れます。スティッキーセッションを前提にすると、動く基盤が減ります。このサーバーのツールはどれも1リクエストで完結し、サーバー起点の通知も送らないため、セッションを持つ理由がありません。
> 同じ理由で POST の応答は SSE ではなく通常の JSON で返します（仕様上どちらでも構いません）。SSE はプロキシやゲートウェイにバッファされることがあり、環境依存の不具合を持ち込みやすいためです。

エラーは2種類に分かれます。

| 種類 | 返り方 | 例 |
| --- | --- | --- |
| スキーマ違反 | JSON-RPC エラー (`-32602`) | 電話番号の形式が `inputSchema` に合わない |
| ガードレール違反・実行時エラー | `result` の `isError: true` | `ALLOWED_NUMBERS` 外の宛先、レートリミット超過、Vonage API の失敗 |

前者は MCP SDK が `inputSchema` で検証して弾くため、ハンドラに到達しません（エラーメッセージにはスキーマに書いた説明がそのまま入ります）。後者は原因が `reason`、次に取るべき行動が `suggestion` に入ります。

> [!NOTE]
> 無効化されているツール（capability トグルが OFF）は登録されないため、`tools/call` では「存在しないツール」として扱われます。`tools/list` に出さない以上、これが MCP としての正しい表現です。どの環境変数を設定すべきかは起動ログと本 README を参照してください。

> [!WARNING]
> **v1.3.0 の破壊的変更: `POST /mcp-invoke` と `GET /mcp-tools` を削除しました。**
> MCP と等価な機能を独自のインターフェースで二重に公開していたためです。`/mcp` だけ認証やガードレールを直しても、こうした別経路が残っていればそこから全部迂回できます。ツールの実行経路は `/mcp` の1本に絞りました。
> 既存の呼び出しは JSON-RPC の `tools/call` に置き換えてください。
>
> ```json
> {"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"send_sms","arguments":{"to":"09012345678","message":"hello"}}}
> ```

**POST** `/webhooks/message-status`

Vonage Messages API の Status Webhook（配信結果 / DLR）の受信エンドポイントです。Vonage から呼ばれるため Bearer トークン認証の対象外ですが、**別途Webhook認証が必須**です。

受信した配信結果はオンメモリに24時間保持され、`get_sms_status` ツールから参照できます。

> [!IMPORTANT]
> **このサーバーが送信した記録のない `message_id` は、配信ステータスの保持対象になりません。**
> 同じ Vonage Application を別のシステムと共用していると、そちらが送信したメッセージの DLR もこのエンドポイントに届きます。それをそのまま保持すると、**保持件数の上限（1000件）から自分のレコードが押し出され、`get_sms_status` が使えなくなります**。
> ただし、まれに DLR が送信 API のレスポンスより先に届くことがあります。これを取りこぼさないよう、未知の ID は 5 分間だけ別の小さなバッファに保持し、対応する送信が記録された時点で取り込みます。レスポンスの `pending: true` はこの状態を表します。Vonage Dashboard の Application 設定で **Status URL** に `https://<host>/webhooks/message-status` を登録してください。

認証は以下の優先順位で行われます。

1. `VONAGE_API_SIGNATURE_SECRET` が設定されていれば、`Authorization: Bearer <JWT>` の署名（HS256）と、ボディを束縛する `payload_hash` クレームを検証する（**推奨**）
2. `VONAGE_WEBHOOK_SECRET` が設定されていれば、`x-webhook-secret` ヘッダーと照合する
3. どちらも未設定なら **503 を返してエンドポイントを無効化**する

| 状況 | HTTPステータス |
| --- | --- |
| 取り込み成功 | `200`（`ignored: false`） |
| 再送・順序逆転で古い通知が届いた | `200`（`ignored: true`、既存の状態を維持） |
| 認証情報なし・不正な署名・`payload_hash` 不一致 | `401` |
| `message_uuid` / `status` が欠けたペイロード | `400` |
| Webhook認証が未設定 | `503` |

```bash
# 共有シークレット方式の例
curl -X POST http://localhost:3000/webhooks/message-status \
  -H "Content-Type: application/json" \
  -H "x-webhook-secret: $VONAGE_WEBHOOK_SECRET" \
  -d '{"message_uuid":"abc-123","to":"819012345678","status":"delivered","channel":"sms"}'
```

**POST** `/webhooks/inbound`

受信メッセージ用のスタブ（常に 200 を返す）。Vonage側の設定必須項目を満たすために用意しています。

## Gemini Enterprise などのAIエージェントから利用する

AIエージェントに設定すべき System Instruction（承認フロー、`dry_run` の使い方、エラー対処方針）を [`docs/gemini_system_instruction.md`](docs/gemini_system_instruction.md) にまとめています。そのまま貼り付けられる形式です。

あわせて、サーバー側で [`ALLOWED_NUMBERS` と `RATE_LIMIT_PER_HOUR`](#安全機能guardrailsの環境変数) を設定することを強く推奨します。**System Instruction はプロンプトインジェクションで破られる前提で読んでください。** 実効的な防御はサーバー側の設定だけです。

### ⚠️ Gemini Enterprise のカスタム MCP サーバーコネクタを使う場合

[公式ドキュメント](https://docs.cloud.google.com/gemini/enterprise/docs/connectors/custom-mcp-server/set-up-custom-mcp-server)によれば、このコネクタが送れる認証は **「認証なし」と「OAuth 2.0」の2つだけ**で、任意のヘッダを設定する欄がありません。つまり **`MCP_AUTH_TOKEN` はこの経路では使えません。**

かつコネクタは、MCP サーバーが**公開インターネット上の HTTPS エンドポイントで到達可能**であることを要求します。

> [!CAUTION]
> ここで「認証なし」を選ぶと、**課金を発生させられるサーバーが無認証で全世界に公開されます。** 選ばないでください。

取りうる構成は次の2つです。

**構成A: 上流で OAuth 2.0 を終端する**

API Gateway や Identity-Aware Proxy をこのサーバーの手前に置いて OAuth 2.0 を処理し、本サーバーには `TRUST_UPSTREAM_AUTH=true` を設定します。認証の実装をこのサーバーから切り離せるうえ、監査ログもプラットフォーム側の仕組みに乗せられます。詳しくは[推奨構成: 認証は手前の層に置く](#推奨構成-認証は手前の層に置く)を参照してください。

**構成B: ADK でエージェントを書く**

コネクタを使わず、[Agent Development Kit](https://google.github.io/adk-docs/tools-custom/mcp-tools/) の `McpToolset` から `StreamableHTTPConnectionParams` で接続します。任意のヘッダを送れるので `MCP_AUTH_TOKEN` がそのまま使えます。ただし**ツール実行前の承認UIは自分で実装する必要があります**（コネクタ経由なら既定で表示されます）。

```python
from google.adk.tools.mcp_tool import McpToolset, StreamableHTTPConnectionParams

toolset = McpToolset(
    connection_params=StreamableHTTPConnectionParams(
        url="https://your-server.example.com/mcp",
        headers={"Authorization": f"Bearer {MCP_AUTH_TOKEN}"},
    )
)
```

## プロジェクト構造（続き）

```text
├── dist/                  # コンパイルされたJavaScript
├── package.json           # プロジェクト設定
├── tsconfig.json          # TypeScript設定
├── jest.config.js         # Jest設定
├── .env.example           # 環境変数設定例
├── private.key            # Vonage秘密鍵（要設定・リポジトリには含めない）
├── LICENSE                # Apache License 2.0
├── SECURITY.md            # セキュリティポリシー
├── CONTRIBUTING.md        # コントリビューションガイド
└── README.md             # このファイル
```

## 依存関係

### 主要パッケージ

- `@vonage/server-sdk` - Vonage SMS機能
- `@vonage/voice` - Voice通話機能専用SDK
- `@vonage/jwt` - Webhook の署名検証
- `csv-parse` - CSVファイル解析
- `@modelcontextprotocol/sdk` - MCP Server実装
- `zod` - スキーマ検証
- `zod-to-json-schema` - ZodスキーマからJSON Schemaを生成（HTTP版の `tools/list` 用）
- `express` / `cors` - HTTPラッパー

## Vonage アカウントについて

このサーバーを使うには Vonage の Application ID と秘密鍵が必要です。

**日本国内でご利用の場合**は、[日本語での申し込みページ](https://kwcplus.kddi-web.com/application/vonage) からのお申し込みをご検討ください。日本語でのサポートと請求に対応しています。

海外からご利用の場合は [Vonage Developer Portal](https://developer.vonage.com/sign-up) から直接開設してください。

**このサーバーはどちらの経路で開設したアカウントでも同じように動作します。** 特定の経路を強制することはありません。

## 提供元

このプロジェクトは **株式会社KDDIウェブコミュニケーションズ** が Vonage のリセラーとして開発・公開しています。

私たちは**このサーバーをサービスとして運営していません。** OSS のリファレンス実装として提供しており、利用者の資格情報を預かることはありません。

## ライセンス

[Apache License 2.0](LICENSE)

Copyright 2026 KDDI Web Communications Inc.

## 関連ドキュメント

- [セキュリティポリシー](SECURITY.md) — 脆弱性の報告方法と脅威モデル
- [コントリビューションガイド](CONTRIBUTING.md)
- [デプロイ手順](docs/deployment.md)
- [Gemini Enterprise 向け System Instruction](docs/gemini_system_instruction.md)
