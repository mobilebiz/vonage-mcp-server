# ChatGPT のカスタムプラグインから使う

**2026-09-11 に実機で確認しました。** ChatGPT から接続し、SMS の実送信（配信ステータスの受信まで）と音声の実発信（通話イベントの受信まで）が通っています。

この経路は、ここまで検証してきた他の基盤と**前提がひとつ違います。**

> [!IMPORTANT]
> **ChatGPT には `MCP_AUTH_TOKEN` を渡せません。** 認証の選択肢は「OAuth」「認証なし」「両方」の3つだけで、任意のヘッダーを設定する欄がありません。課金の発生するサーバーに「認証なし」は選べないため、**OAuth 以外の道がありません。**
>
> そして **OAuth を使うには、このサーバーとは別に認可サーバー（IdP）が必要です。** このサーバーはトークンを発行しません（→ [なぜ IdP が必要か](#なぜ-idp-が必要か)）。

---

## 全体像

```
ChatGPT ──① 認可 ──▶ IdP（WorkOS など）
   │                        │
   │                        ② アクセストークン（JWT）
   │◀───────────────────────┘
   │
   └──③ Bearer <トークン> ──▶ このサーバー ──▶ Vonage
                                 │
                                 └─ ④ JWKS で署名・iss・aud・exp を検証
```

| 役割 | 担うもの |
| --- | --- |
| 認可サーバー（AS） | **IdP**。ログイン画面を出し、トークンを発行する |
| リソースサーバー（RS） | **このサーバー**。トークンを検証し、ツールを実行する |

MCP 仕様も同じ分担で、**認可サーバーの実装は仕様のスコープ外**と明記されています。このサーバーが RS だけを実装しているのはそのためです。

---

## なぜ IdP が必要か

**このサーバーはトークンを発行しません。** 検証するだけです。

ChatGPT が「OAuth」を選ぶと、ChatGPT は次の順に動きます。

1. `/mcp` を叩く → **401** と `WWW-Authenticate` が返る
2. そこに書かれた**保護リソースメタデータ**を読む → 「認可サーバーはここだ」と分かる
3. その**認可サーバー**へ行き、自分を登録し、ユーザーにログインさせ、トークンを受け取る
4. トークンを付けて `/mcp` を叩き直す

**3 を担当する相手がいなければ、この流れは成立しません。** それが IdP です。

### IdP に必要な条件は2つ

| 条件 | 満たさないとどうなるか |
| --- | --- |
| **CIMD か DCR に対応している** | **ChatGPT が自分を登録できず、認可が始まりません。** ChatGPT は IdP と事前の関係を持たないため、手動でクライアントを登録する道がありません |
| **`aud` をこのサーバーの URI にできる** | トークンは発行されるが、**このサーバーが「自分宛ではない」と判断して 401 にします** |

2つめは RFC 8707（`resource` パラメータ）への対応か、IdP 側で audience を固定できることを意味します。

> [!WARNING]
> **主要な IdP でも、この2つを満たさないものが多くあります。**
>
> | IdP | CIMD / DCR | `aud` をこのサーバー向けにできるか |
> | --- | --- | --- |
> | **WorkOS** | ✅ CIMD | ✅ Resource Indicator を登録する |
> | Keycloak | ✅ DCR | ⚠️ `resource` 非対応。audience mapper で固定する回避が要る |
> | Auth0 | ✅ DCR | ❌ 独自の `audience` を使い `resource` を見ない |
> | Entra ID | ❌ | ❌ |
>
> **IdP 選びがこの経路の成否をほぼ決めます。**

---

## 手順（WorkOS AuthKit の場合）

実機で通した構成です。WorkOS を選んだのは、**CIMD にネイティブ対応しており、無料枠で足りる**ためです。他の IdP でも、上の2条件を満たせば同じ手順で繋がります。

### 1. WorkOS 側の設定

ダッシュボードの **Connect → Configuration** で2つ設定します。

| 設定 | 値 |
| --- | --- |
| **MCP Auth → Client ID Metadata Document** | **Enabled**（既定は OFF） |
| **MCP resource indicators → Resource indicator** | **このサーバーの `/mcp` の URL** |

Resource indicator は、このサーバーの `OAUTH_RESOURCE` と**1文字も違わない値**にしてください。

```
https://<あなたのホスト>/mcp
```

> [!IMPORTANT]
> **Resource indicator を登録しないと繋がりません。** WorkOS はこう明記しています — 登録が無い場合、`resource` パラメータは**無視され**、環境固有の既定 `aud` が使われます。その `aud` はこのサーバーの URI ではないので、**401 になります。**

Dynamic Client Registration は **Disabled のままで構いません。** ChatGPT は CIMD を優先します（DCR が無効だと「登録 URL が設定されていないため DCR を利用できません」と警告が出ますが、CIMD が有効なら問題ありません）。

### 2. このサーバー側の設定

```sh
OAUTH_ISSUER=https://<テナント>.authkit.app
OAUTH_RESOURCE=https://<あなたのホスト>/mcp
OAUTH_JWKS_URI=https://<テナント>.authkit.app/oauth2/jwks
```

**必要なのはこの3つだけです。** `OAUTH_AUDIENCE` を上書きしなければ、他の設定は要りません。

`OAUTH_ISSUER` と `OAUTH_JWKS_URI` の正確な値は、IdP のメタデータから取ってください。

```sh
curl -s https://<テナント>.authkit.app/.well-known/oauth-authorization-server | jq '{issuer, jwks_uri}'
```

> [!WARNING]
> **`OAUTH_ISSUER` は末尾スラッシュまで含めて、メタデータの `issuer` と完全に一致させてください。** このサーバーは `iss` を書かれたとおりに照合します。`https://example.com/` と `https://example.com` は OAuth では別の識別子で、**1文字違うだけで全トークンが 401 になります。**

Cloud Run に設定を足す場合は `--update-env-vars` を使ってください。`--set-env-vars` は全置換で、書かなかった変数が消えます。

```sh
gcloud run services update <サービス名> \
  --update-env-vars OAUTH_ISSUER=...,OAUTH_RESOURCE=...,OAUTH_JWKS_URI=...
```

設定できたか確認します。

```sh
curl -s https://<あなたのホスト>/.well-known/oauth-protected-resource/mcp
# {"resource":"https://.../mcp","authorization_servers":["https://<テナント>.authkit.app"],...}

curl -si -X POST https://<あなたのホスト>/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | grep -i www-authenticate
# www-authenticate: Bearer resource_metadata="https://.../.well-known/oauth-protected-resource/mcp"
```

### 3. ChatGPT 側の設定

設定 → コネクタ → 開発者モードを有効にし、新規プラグインを作ります。

| 項目 | 値 |
| --- | --- |
| 接続 | **サーバーの URL** |
| URL | **`https://<あなたのホスト>/mcp`** |
| 認証 | **OAuth** |

URL を入れると ChatGPT が discovery を走らせ、**登録方法が自動で「クライアント ID メタデータ ドキュメント（CIMD）」になります。** そのまま「理解したうえで、続行します」にチェックを入れて作成し、表示される WorkOS の画面でサインイン・承認します。

### 4. 動作確認

**いきなり送信せず、`dry_run` から始めてください。** 送信されず、課金もされません。

> Vonage MCP のツール一覧を見せて。そのあと `+8190XXXXXXXX` 宛に「テスト」という本文で、dry_run で検証して。

通ったら実送信に進みます。宛先は `ALLOWED_NUMBERS` で制限しておくことを強く勧めます（下記）。

---

## 実機で分かったこと

### WorkOS は `typ: at+jwt` を付けません

**これは WorkOS のドキュメントに書かれていません。実際に繋いで初めて分かりました。**

当初このサーバーは、ID トークン対策として RFC 9068 の `typ: at+jwt` を**無条件で**要求していました。WorkOS のトークンには付いていないため、**正しく設定したのに全リクエストが 401 になりました。**

```
OAUTH_REQUIRE_AT_JWT=true のため、typ が at+jwt のアクセストークンだけを受け付けます（受信: 無し）。
```

**この要求は条件付きに改めました。** ID トークンの `aud` はクライアント識別子なので、`OAUTH_AUDIENCE` を上書きしていなければ（＝期待する `aud` がこのサーバーの URI のままなら）**衝突しえません**。標識を要求するのは**上書きしたときだけ**です。

**そのため、WorkOS では追加の設定が要りません。** 必須の3つだけで動きます。

> [!NOTE]
> **`OAUTH_AUDIENCE` を上書きする場合は話が変わります。** `OAUTH_REQUIRE_AT_JWT=true` か `OAUTH_REQUIRED_SCOPE` のどちらかが必須になり、両方欠けていると起動時にエラーで停止します。WorkOS が既定で出す scope は `email` / `profile` / `openid` / `offline_access` で、**どれも API のスコープではないので標識としては弱いものです。**

### ツール実行前の承認は保証されません

**ChatGPT がツールを実行する前に必ず確認を出す、という保証はありません。** Dify で `destructiveHint` が無視された前例があり、この経路でも注釈に頼れません。

**`ALLOWED_NUMBERS` を設定してください。** 承認 UI が無い基盤では、それが唯一の実効的な防御です。

### `Accept` ヘッダーが要ります（自分で叩く場合）

MCP のクライアントは必ず付けますが、`curl` などで手動で確認するときは忘れがちです。

```
Accept: application/json, text/event-stream
```

無いと **406** が返ります。

---

## うまくいかないとき

このサーバーは 401 の**理由を本文に書いて返します**が、**ChatGPT はそれを表示せず「接続で問題が発生しました」としか出しません。** 手元から同じトークンで叩くか、下の対応表で切り分けてください。

| 症状 | 原因 |
| --- | --- |
| ChatGPT が「接続で問題が発生しました」 | 下のいずれか。理由は表示されない |
| `typ が at+jwt の...だけを受け付けます` | IdP が `typ` を付けていない。`OAUTH_REQUIRE_AT_JWT=true` を明示しているか、`OAUTH_AUDIENCE` を上書きしている |
| `audience がこのサーバー向けではありません` | **IdP 側に resource indicator を登録していない**、または `OAUTH_RESOURCE` と値が違う |
| `署名鍵が JWKS に見つかりません` | `OAUTH_JWKS_URI` が違う |
| `iss がこのサーバー向けではありません` | `OAUTH_ISSUER` が違う（**末尾スラッシュに注意**） |
| `503` が返る | IdP の JWKS を取得できない。**トークンは無効とは限りません** |
| 起動時にエラーで停止 | `OAUTH_*` の設定が不完全。3つ揃えるか、すべて削除する |

**Cloud Run のログでも切り分けられます。** discovery が動いていれば、次の並びが見えます。

```
POST /mcp                                      401   ← 未認証の探り（正常）
GET  /.well-known/oauth-protected-resource/mcp 200   ← discovery 成功
POST /mcp                                      200   ← トークン付きで成功
```

**401 のあとに 200 が来ていなければ、トークンの検証で落ちています。** メタデータの 200 すら無ければ、ChatGPT が discovery に到達していません。
