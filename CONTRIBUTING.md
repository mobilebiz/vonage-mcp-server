# コントリビューションガイド / Contributing

日本語が主ですが、英語の Issue / PR も歓迎します。
Japanese is the primary language here, but English issues and pull requests are welcome.

## 開発環境 / Development setup

```sh
npm install
npm run build
npm test
```

Node.js 22 以降が必要です。

## 変更を送る前に / Before you submit

```sh
npm run build   # 型エラーが無いこと
npm test        # 全テストが通ること
```

**テストが赤い状態の PR は受け付けられません。**

## このプロジェクトの方針 / Project principles

コードを書く前に、この3点を把握しておくと判断が早くなります。

**1. エージェントを信頼できる主体として扱わない**

攻撃者はプロンプトインジェクションでエージェントを操れる前提です。「エージェントが正しく使えば安全」という設計は受け付けられません。

**2. ガードレールは課金される単位で引く**

レートリミットのバケットも SMS の本文長も、「通数」や「文字数」ではなく実際に課金される単位（件数・セグメント数）を基準にしています。課金と対応しない単位で制限しても、意図した費用の上限になりません。

**3. 既定は安全側、緩めるのは意識的に**

capability はすべて既定 OFF、宛先は既定で日本国内のみ、CORS は既定で閉じています。解釈できない設定値は起動時にエラーで止めます（fail-fast）。

## エラーレスポンスの書き方 / Writing error responses

ツールが返すエラーには **必ず `reason` と `suggestion` を含めてください。**

- `reason`: なぜ失敗したか
- `suggestion`: **次に何をすべきか**

再試行しても結果が変わらない場合は、`suggestion` に「再試行しても結果は変わりません」と明記してください。これが無いと、エージェントが同じ呼び出しを繰り返します。**そのたびに課金が発生する可能性があります。**

## テストについて / Tests

- ガードレールの変更には必ずテストを添えてください
- **`recordSubmitted()` と固定日付を組み合わせないでください。** `recordSubmitted` は現在時刻を打つため、固定日付は実時刻が追い越した時点で「古い通知」として弾かれます。書いた直後は通るので気づきにくく、過去に3回踏んでいます。相対時刻（`new Date(Date.now() + 1000)`）を使ってください

## 設計上の記録 / Design decisions

「なぜこうなっているのか」はコード内のコメントに書いてあります。既存の判断を変える PR では、**その判断が置かれた理由に触れてください。**

## ライセンス / License

コントリビューションは Apache License 2.0 の下で提供されたものとみなされます。

By contributing, you agree that your contributions will be licensed under the Apache License 2.0.
