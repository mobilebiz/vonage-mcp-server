# セキュリティポリシー / Security Policy

## 脆弱性の報告 / Reporting a Vulnerability

**公開の Issue で脆弱性を報告しないでください。**

GitHub の [Security Advisories](https://github.com/mobilebiz/vonage-mcp-server/security/advisories/new) から非公開で報告してください。

Please do **not** open a public issue for security vulnerabilities. Use
[GitHub Security Advisories](https://github.com/mobilebiz/vonage-mcp-server/security/advisories/new)
to report privately.

報告には以下を含めてください。

- 影響を受けるバージョン
- 再現手順
- 想定される影響（課金の発生、資格情報の漏洩、ガードレールの迂回など）

## このプロジェクトの脅威モデル / Threat model

**攻撃者はプロンプトインジェクションによって AI エージェントを操れるものとします。つまり、エージェント自身を信頼できる主体として扱いません。**

We assume an attacker can drive the AI agent through prompt injection. The agent
is **not** a trusted principal.

この前提から、次のものは脆弱性として扱います。

- エージェントがガードレール（宛先制限・レートリミット・capability トグル）を迂回できる経路
- 認証を経ずに `/mcp` に到達できる経路
- Webhook の署名検証を迂回できる経路
- `dry_run` が提示した内容と実際の送信内容が食い違う経路

一方、次のものは**設計上の前提**であって脆弱性ではありません。

- 環境変数を設定できる運用者が制限を緩められること（`ALLOW_PREMIUM_NUMBERS` など）
- 単一インスタンス前提のため、複数インスタンスではレートリミットが実効的に緩むこと（README の「単一インスタンスで動かすこと」を参照）
- 送信 API が成功を返しても配信が保証されないこと（キャリア側の仕様）

## 運用者への推奨 / Recommendations for operators

このサーバーは**あなたの Vonage アカウントで課金が発生する操作**を AI エージェントに開放します。次の設定を強く推奨します。

- `ALLOWED_NUMBERS` で宛先を明示的に限定する（サーバー側で完結する唯一の信頼境界）
- `RATE_LIMIT_PER_HOUR` と `SMS_SEGMENT_LIMIT_PER_HOUR` で被害額の上限を決める
- **Vonage アカウント側の地域制限・利用額上限・アラートを設定する**（このサーバーを迂回されても効く唯一の層）
- HTTP で公開する場合は `MCP_AUTH_TOKEN` を設定するか、Cloud Run IAM などを手前に置く

## サポート対象バージョン / Supported versions

`main` ブランチの最新リリースのみサポートします。

Only the latest release on `main` is supported.
