# Vonage MCP Server

VonageのSMS送信機能とCSV一括送信機能を提供するMCP (Model Context Protocol) Server実装です。

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
# 環境変数ファイル(.env)を使用して実行（推奨・Node.js v20.6.0以降）
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

### 1. サーバーのビルドと起動

```bash
# プロジェクトをビルド
npm run build

# サーバーを起動（Node.js v20.6.0以降、推奨）
npm start

# または従来方式で起動（環境変数ファイルを使用しない場合）
npm run start:legacy
```

### 2. Claude Desktopの設定

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

## プロジェクト構造

```sh
vonage-mcp-server/
├── src/                    # TypeScriptソースコード
│   ├── index.ts           # エントリーポイント・MCPツール定義
│   ├── vonage.ts          # Vonage SMS送信機能
│   └── csvUtils.ts        # CSV解析・バリデーション機能
├── csv/                    # サンプルCSVファイル
│   ├── sample_contacts.csv        # 基本テスト用
│   ├── meeting_reminder.csv       # 会議リマインダー用
│   ├── emergency_notification.csv # 緊急連絡用
│   ├── sales_follow_up.csv        # 営業フォロー用
│   └── invalid_data_example.csv   # バリデーションテスト用
├── tests/                  # テストファイル
│   ├── index.test.ts      # メイン機能のテスト
│   ├── utils.test.ts      # ユーティリティのテスト
│   └── integration.test.ts # 統合テスト
├── dist/                  # コンパイルされたJavaScript
├── package.json           # プロジェクト設定
├── tsconfig.json          # TypeScript設定
├── jest.config.js         # Jest設定
├── .env.example           # 環境変数設定例
├── private.key            # Vonage秘密鍵（要設定）
└── README.md             # このファイル
```

## ライセンス

ISC
