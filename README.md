# Vonage MCP Server

VonageのSMS送信機能を提供するMCP (Model Context Protocol) Server実装です。

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
   ```
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
npm start
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

# サーバーを起動（バックグラウンドで実行）
node dist/index.js
```

### 2. Claude Desktopの設定

Claude Desktopの設定ファイル `claude_desktop_config.json` に以下の設定を追加します：

```json
{
  "mcpServers": {
    "vonage-mcp-server": {
      "command": "node",
      "args": ["--experimental-modules", "dist/index.js"],
      "cwd": "/Users/katsumi/Documents/workspace/MCPServer/vonage-mcp-server"
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
- **send_sms**: SMS送信ツール
  - 入力: 
    - `to` (必須): 送信先の電話番号
    - `message` (必須): 送信するメッセージ
    - `from` (オプション): 送信元（省略時は'VonageMCP'）
  - 機能:
    - 日本の電話番号（0から始まる）は自動的にE.164形式に変換
    - 送信結果とメッセージIDを返却



### 4. 使用例

Claude Desktopで以下のような質問ができます：

```
「09045327751に「これはVonage MCPサーバーを使って送信しています。」とSMSを送ってください」
→ send_smsツールを使用してSMS送信
```

### 5. トラブルシューティング

#### サーバーが起動しない場合
- `npm run build` が正常に完了しているか確認
- `node dist/index.js` でエラーが出ないか確認

#### Claude Desktopで認識されない場合
- `claude_desktop_config.json` の設定が正しいか確認
- 作業ディレクトリ（cwd）のパスが正しいか確認
- Claude Desktopを再起動

#### 機能が利用できない場合
- サーバーのログを確認（Claude Desktopの設定画面で確認可能）
- サーバーを再起動

## プロジェクト構造

```
vonage-mcp-server/
├── src/                    # TypeScriptソースコード
│   ├── index.ts           # エントリーポイント
│   └── vonage.ts          # Vonage SMS送信機能
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