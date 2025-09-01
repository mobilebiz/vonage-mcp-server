# EXTRA_DEVELOPMENT_REQUIRE.md

## 追加開発要件

### 概要

Vonage MCP Serverに以下の2つの機能を追加実装する。

### 1. CSV一括SMS送信機能（Bulk SMS）

#### 機能概要

CSVファイルをアップロードして、複数の宛先に一括でSMS送信を行う。

#### 入力仕様

- **CSVファイル形式**：

  ```csv
  phone,from,message
  090-1234-5678,VonageMCP,会議のお知らせです
  080-9876-5432,営業部,お打ち合わせの件でご連絡しました
  070-1111-2222,サポート,システムメンテナンスのお知らせ
  ```

#### フィールド定義

- `phone`: 送信先電話番号（0ABJ形式対応、日本のE.164形式（+81〜）自動変換）
- `from`: 送信者名（文字列（3〜11文字、数字のみや、数字から始まる文字列はNG））
- `message`: 送信メッセージ内容（70文字以内を推奨）

#### 実装要件

- CSVファイルの内容を解析
- 各行ごとにSMS送信処理を実行
- 送信結果をまとめて返却（成功件数、失敗件数、エラー詳細）
- 無効な電話番号はスキップして処理を継続

#### MCPツール仕様

```typescript
server.registerTool("bulk_sms_from_csv", {
  title: "CSV一括SMS送信",
  description: "CSVファイル（phone,from,message）から一括SMS送信",
  inputSchema: {
    csv_content: z.string().describe("CSVファイルの内容"),
  }
});
```

### 2. Voice通話機能（Voice Call）

#### 機能概要

指定した電話番号に発信し、指定されたメッセージを音声で読み上げる。

#### 入力仕様

- **電話番号**: 0ABJ形式（例：090-1234-5678）
- **メッセージ**: 読み上げたいテキスト内容

#### 実装要件

- 0ABJ形式の電話番号をE.164形式（日本）に自動変換
- Vonage Voice API（Version 2）を使用して発信
<https://developer.vonage.com/ja/api/voice.v2#createCall>
- NCCO（Nexmo Call Control Object）を発信APIに組み込んで使用してメッセージ読み上げ
- 日本語音声（Mizuki推奨）での読み上げ
- FROM番号は、環境変数内に指定（VONAGE_VOICE_FROM）

#### MCPツール仕様

```typescript
server.registerTool("make_voice_call", {
  title: "音声通話",
  description: "指定した番号に発信してメッセージを読み上げます",
  inputSchema: {
    to: z.string().describe("発信先電話番号（0ABJ形式）"),
    message: z.string().describe("読み上げるメッセージ"),
    voice: z.string().optional().describe("音声タイプ（デフォルト: Mizuki）")
  }
});
```

#### NCCO設定例

```json
{
   "ncco": [
      {
         "action": "talk",
         "language": "ja-JP",
         "style": 1,
         "premium": true,
         "text": "ここに読み上げるメッセージが入ります。"
      }
   ],
   "to": [
      {
         "type": "phone",
         "number": "819012345678",
      }
   ],
   "from": {
      "type": "phone",
      "number": "14155550100"
   },
   "machine_detection": "continue",
   "length_timer": 7200,
   "ringing_timer": 60
}
```

### 3. 実装ファイル構成

#### 新規作成ファイル

- `src/csvUtils.ts`: CSV解析ユーティリティ
- `src/voiceCall.ts`: Voice API実装

#### 修正ファイル

- `src/index.ts`: 新しいツール登録
- `src/vonage.ts`: 共通処理の抽出・整理

### 4. 開発環境要件

#### 必要な追加依存関係

```json
{
  "dependencies": {
    // Voice API用（既存の@vonage/server-sdkに含まれている可能性あり）
  }
}
```

#### 環境変数

既存の設定に加えて、Voice API用の設定が必要な場合は追加。

```env
VONAGE_APPLICATION_ID=your_application_id
VONAGE_PRIVATE_KEY_PATH=./private.key
VONAGE_VOICE_FROM=14155550100
```

### 5. テスト要件

#### 単体テスト

- CSV解析機能のテスト
- 電話番号変換機能のテスト
- エラーハンドリングのテスト

#### 統合テスト

- 実際のVonage APIを使用したSMS/Voice送信テスト
- 大量データでのパフォーマンステスト

### 6. ハンズオン用準備物

#### サンプルファイル

- `sample_contacts.csv`: テスト用CSVデータ
- `README_HANDSON.md`: ハンズオン用セットアップガイド

#### デモシナリオ

1. CSV一括SMS送信のデモ
2. Voice通話機能のデモ
3. エラーハンドリングの確認
