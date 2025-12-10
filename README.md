# Vonage MCP Server

VonageのSMS送信、CSV一括送信、音声通話機能を提供するMCP (Model Context Protocol) Server実装です。

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
   - [Vonage Developer Portal](https://developer.vonage.com/) でアカウントを作成
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

- **send_sms**: 単発SMS送信ツール
  - 入力:
    - `to` (必須): 送信先の電話番号
    - `message` (必須): 送信するメッセージ
    - `from` (オプション): 送信元（省略時は'VonageMCP'）
  - 機能:
    - 日本の電話番号（0から始まる）は自動的にE.164形式に変換
    - 送信結果とメッセージIDを返却

- **bulk_sms_from_csv**: CSV一括SMS送信ツール
  - 入力:
    - `csv_content` (必須): CSVファイルの内容（phone,from,messageのヘッダー付き）
  - 機能:
    - CSVファイルを解析して複数宛先に一括SMS送信
    - 無効な行は自動的にスキップ
    - 送信結果の詳細レポートを返却
    - API制限回避のため100ms間隔で順次送信

- **make_voice_call**: 音声通話ツール
  - 入力:
    - `to` (必須): 発信先電話番号(0ABJ形式)
    - `message` (必須): 読み上げるメッセージ
    - `voice` (オプション): 音声タイプ（デフォルト: 女性）
  - 機能:
    - 指定番号に発信してメッセージを音声で読み上げ
    - 日本語音声対応（女性・男性）
    - NCCO（Nexmo Call Control Object）を使用
    - 通話時間の自動見積もり

- **get_call_status**: 通話ステータス取得ツール
  - 入力:
    - `callId` (必須): 取得する通話のCall ID（UUID形式）
  - 機能:
    - Vonage Voice APIから通話のステータス情報を取得
    - status（通話ステータス）、start_time（開始時刻）、price（料金）、rate（レート）、duration（通話時間）を返却
    - 環境変数から自動的にApplication IDとPrivate Keyを読み込み

- **generate_jwt**: JWT生成ツール
  - 入力:
    - `expiresIn` (オプション): トークンの有効期限（秒単位、デフォルト: 86400 = 24時間）
    - `subject` (オプション): トークンのサブジェクト（デフォルト: VonageMCP）
  - 機能:
    - Vonage Voice API用のJWT認証トークンを生成
    - 環境変数から自動的にApplication IDとPrivate Keyを読み込み
    - デフォルトのACL設定を含む（Voice API用の標準パス）
    - 有効期限とサブジェクトをカスタマイズ可能


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

#### JWT生成

```text
「Vonage Voice API用のJWTトークンを生成してください」
→ generate_jwtツールを使用してデフォルト設定（24時間有効）でJWT生成

「有効期限1時間のJWTトークンを生成してください」
→ generate_jwtツールを使用してexpiresIn=3600でJWT生成

「サブジェクトを'AdminUser'にしてJWTトークンを生成してください」
→ generate_jwtツールを使用してカスタムサブジェクトでJWT生成
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
  - 3〜11文字の英数字のみ（A-Z, a-z, 0-9）
  - 数字のみ、数字始まり、日本語は使用不可
  - 例: `VonageMCP`, `SalesTeam`, `Support`

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
- **通話時間見積**: メッセージ長から自動的に通話時間を算出

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
| callId | string | 取得する通話のCall ID（UUID形式） |

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
  callId: "ca6b7710-3423-4c8d-b630-7b981ec4b2c2"
})

// 結果例:
// ステータス: completed
// 開始時刻: 2025-12-10T03:53:19.000Z
// 料金: 0.06287850
// レート: 0.13973000
// 通話時間: 27秒
```

## JWT生成機能

### 機能概要

Vonage Voice API用のJWT認証トークンを生成します。環境変数から自動的にApplication IDとPrivate Keyを読み込み、セキュアなトークンを生成します。

### 主な特徴

- **自動設定読み込み**: 環境変数から自動的にApplication IDとPrivate Keyを取得
- **カスタマイズ可能**: 有効期限とサブジェクトを柔軟に設定
- **デフォルトACL**: Voice API用の標準的なACL設定を自動適用
- **有効期限管理**: トークンの有効期限を自動計算・表示

### パラメータ

| パラメータ | 型 | デフォルト | 説明 |
|------------|------|------------|------|
| expiresIn | number | 86400 | トークンの有効期限（秒単位、86400 = 24時間） |
| subject | string | VonageMCP | トークンのサブジェクト（識別用） |

### 使用例

```javascript
// デフォルト設定（24時間有効）
generate_jwt()

// 1時間有効のトークン
generate_jwt({
  expiresIn: 3600
})

// カスタムサブジェクト
generate_jwt({
  subject: "AdminUser",
  expiresIn: 7200  // 2時間
})
```

### ACL設定

生成されるJWTには以下のデフォルトACL（Access Control List）が含まれます：

- `/*/users/**` - ユーザー管理
- `/*/conversations/**` - 会話管理
- `/*/sessions/**` - セッション管理
- `/*/devices/**` - デバイス管理
- `/*/image/**` - 画像管理
- `/*/media/**` - メディア管理
- `/*/applications/**` - アプリケーション管理
- `/*/push/**` - プッシュ通知
- `/*/knocking/**` - ノッキング機能
- `/*/legs/**` - 通話レッグ管理


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
│   ├── index.ts           # エントリーポイント・MCPツール定義
│   ├── vonage.ts          # Vonage SMS送信機能
│   ├── csvUtils.ts        # CSV解析・バリデーション機能
│   ├── voiceCall.ts       # Voice通話機能・NCCO生成
│   ├── jwtUtils.ts        # JWT生成機能
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
│   ├── jwtUtils.test.ts   # JWT生成のテスト
│   ├── callStatus.test.ts # 通話ステータス取得のテスト
│   └── integration.test.ts # 統合テスト

### HTTPラッパー (Dify / 外部アプリ用)

HTTPラッパーを使用してサーバーを実行することで、外部アプリケーション（Difyなど）からHTTP POSTリクエスト経由でMCPツールを呼び出すことができます。

```bash
npm run start:http
```

これにより、ポート3000（デフォルト）でHTTPサーバーが起動します。

#### 認証

すべてのリクエスト（`/health`を除く）には、`X-API-KEY` ヘッダが必要です。
値には、環境変数 `VONAGE_APPLICATION_ID` の値を指定してください。

```bash
curl -X POST http://localhost:3000/mcp-invoke \
  -H "Content-Type: application/json" \
  -H "X-API-KEY: your_application_id" \
  -d '{"tool": "tool_name", "params": { ... }}'
```

#### APIエンドポイント

**GET** `/mcp-tools`

利用可能なツールの一覧を返します。

**Response:**
```json
{
  "tools": [
    {
      "name": "tool_name",
      "description": "Tool description",
      "inputSchema": { ... }
    }
  ]
}
```

**POST** `/mcp-invoke`

**Body:**
```json
{
  "tool": "tool_name",
  "params": {
    "param1": "value1"
  }
}
```

**Response:**
MCPツールからのJSON形式の結果。

├── dist/                  # コンパイルされたJavaScript
├── package.json           # プロジェクト設定
├── tsconfig.json          # TypeScript設定
├── jest.config.js         # Jest設定
├── .env.example           # 環境変数設定例
├── private.key            # Vonage秘密鍵（要設定）
└── README.md             # このファイル
```

## 依存関係

### 主要パッケージ

- `@vonage/server-sdk` - Vonage SMS機能
- `@vonage/voice` - Voice通話機能専用SDK
- `@vonage/jwt` - JWT認証トークン生成
- `csv-parse` - CSVファイル解析
- `@modelcontextprotocol/sdk` - MCP Server実装
- `zod` - スキーマ検証

## ライセンス

ISC
