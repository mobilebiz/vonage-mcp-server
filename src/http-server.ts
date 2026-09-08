import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { SERVER_VERSION, createMcpServer, enabledToolNames } from './mcpServer.js';
import { ingestStatusWebhook } from './messageStatusStore.js';
import { ingestCallEvent, setCallEventWebhookHosted } from './callEventStore.js';
import { generateNCCO } from './voiceCall.js';
import { authenticateWebhook, isWebhookAuthConfigured, safeEqual } from './webhookAuth.js';
import {
  activeOAuthConfig,
  buildWwwAuthenticate,
  PROTECTED_RESOURCE_METADATA_PREFIX,
  parseAuthorizationHeader,
  protectedResourceMetadata,
  protectedResourceMetadataPaths,
  verifyAccessToken,
  type OAuthConfigOrNull,
} from './oauthResourceServer.js';
import {
  applyStartupConfig,
  getMaxRequestBodyBytes,
  extractHostname,
  getAllowedHostnames,
  getAllowedOrigins,
  getBindHost,
  getMcpAuthToken,
  getPort,
  getVoiceInboundMessage,
  isLoopbackHost,
  isUpstreamAuthTrusted,
} from './config.js';

// 環境変数の読み込み
dotenv.config();

// このファイルが直接実行されたか（テストが app を import しただけか）。
// モジュールのトップレベルでツールを登録する前に判定しておく必要がある。
const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);

// 環境変数の検証。不正な設定はツールを1つでも登録する前にプロセスを落とす。
// ここより後ろに置くと、capability のパースエラーが ConfigError の
// スタックトレースとして表面化し、[FATAL] の読みやすいメッセージが出ない。
if (isMainModule) {
  applyStartupConfig();
}

export const app = express();

// このプロセスは Event Webhook を待ち受ける（下の /webhooks/voice/event）。
// get_call_status は、理由がまだ空のときに「待てば届く」のか「stdio なので
// 永久に届かない」のかでまったく違う案内を返す（→ callEventStore）。
setCallEventWebhookHosted(true);

/**
 * CORS は既定で閉じる。
 *
 * 以前は `app.use(cors())` で全オリジンを許可していた。Bearer トークン認証が
 * あっても、ブラウザ側がトークンを持っている構成（ブラウザ拡張やWeb版の
 * MCPクライアント）では、悪意あるページが /mcp を呼んで**レスポンスまで
 * 読み取れる**。generate_jwt が有効なら、生成したトークンの窃取に直結する。
 *
 * MCP クライアントの多くはブラウザではないので、開ける必要があるのは
 * 例外的なケースだけ。必要な運用者だけが ALLOWED_ORIGINS で明示する。
 */
app.use((req, res, next) => {
  const origins = getAllowedOrigins();
  if (origins === null) {
    next();
    return;
  }

  cors({ origin: origins, credentials: false })(req, res, next);
});
// Webhookの署名検証（payload_hash）に生のボディが必要なため、パース時に保持しておく
//
// 上限は express.json() の既定（100KB）ではなく getMaxRequestBodyBytes() を使う。
// 既定では小さすぎて、トランスポートによって通る入力が変わってしまうため
// （VONAGE_MCP-4）。
app.use(
  express.json({
    limit: getMaxRequestBodyBytes(),
    verify: (req, _res, buf) => {
      (req as express.Request & { rawBody?: Buffer }).rawBody = Buffer.from(buf);
    },
  })
);

/**
 * MCP エンドポイントの認証ミドルウェア。
 *
 * `app.use('/mcp', ...)` として**パス単位**で適用する。メソッドごとに書くと、
 * Streamable HTTP が使う GET (SSE) や DELETE (セッション終了) を書き漏らして
 * そこだけ無認証になる（VONAGE_MCP-9 / -10）。
 *
 * 認証が未設定の場合は素通しする。この構成ではサーバー自体が 127.0.0.1 にしか
 * bind されておらず（getBindHost 参照）、外部からは到達できない。リクエストごとに
 * 接続元を見て localhost か判定する方式は、プロキシ配下で誤判定するため採らない。
 */
async function requireMcpAuth(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
): Promise<void> {
  let oauth: OAuthConfigOrNull;
  let expected: string | null;

  // 設定の解釈で落ちたら**拒否に倒す**。ここで例外を握り潰して素通りさせると、
  // 壊れた設定のサーバーが無認証で動く。通常は applyStartupConfig が起動時に
  // 止めるが、この経路自体が安全側でなければ「起動時検証を通らない読み込まれ方」
  // で穴になる。
  try {
    if (isUpstreamAuthTrusted()) {
      next();
      return;
    }

    oauth = activeOAuthConfig();
    expected = getMcpAuthToken();
  } catch (error) {
    denyMisconfigured(res, error);
    return;
  }

  if (oauth === null && expected === null) {
    next();
    return;
  }

  const authorization = parseAuthorizationHeader(req.headers['authorization']);

  // 認証情報がまったく無いリクエストへの 401 には error を載せない（RFC 6750 3.1）。
  // 未認証は異常ではなく、認可フローの1歩目である。
  // Bearer 以外の認証方式も、RFC 6750 では「認証情報が無い」のと同じ扱いにする。
  // 400 を返すと、401 を起点とする認可フローに入れないクライアントが出る。
  if (authorization.kind === 'absent' || authorization.kind === 'other-scheme') {
    denyMcp(res, oauth, 401, undefined, 'Unauthorized: missing bearer token');
    return;
  }

  // 送ってきたが Bearer として読めない。これは要求そのものが壊れているので 400。
  if (authorization.kind === 'malformed') {
    denyMcp(res, oauth, 400, 'invalid_request', 'Bad Request: malformed Authorization header');
    return;
  }

  // 静的トークンを先に見る。両方設定されている構成では、どちらの資格情報でも
  // 通る（起動時に警告済み）。OAuth しか喋れない基盤と任意ヘッダを送れる基盤を、
  // 同じデプロイに同時に繋ぐのは実際にある構成なので、片方を黙って無効化しない。
  if (expected !== null && safeEqual(authorization.token, expected)) {
    next();
    return;
  }

  if (oauth === null) {
    denyMcp(res, null, 401, 'invalid_token', 'Unauthorized: invalid bearer token');
    return;
  }

  const result = await verifyAccessToken(authorization.token, oauth);

  if (result.ok) {
    next();
    return;
  }

  denyMcp(res, oauth, result.status, result.error, result.description);
}

/**
 * 設定の解釈に失敗したときの応答。
 *
 * **例外を素通りさせない。** Express の既定のエラーハンドラに任せると 500 は返るが、
 * ミドルウェアの並びによっては例外が認証より前で起きて、そこから先の判断が
 * まるごと飛ぶ。設定が読めない状態は「誰も通さない」に倒す。
 */
function denyMisconfigured(res: express.Response, error: unknown): void {
  console.error('設定の解釈に失敗しました:', error);
  res.status(500).json({
    jsonrpc: '2.0',
    error: {
      code: -32603,
      message: 'Server misconfigured: settings could not be parsed',
    },
    id: null,
  });
}

/**
 * /mcp の認証失敗を返す。
 *
 * OAuth モードでは `WWW-Authenticate` を必ず付ける。**これが無いと、クライアントは
 * どこへ認可を取りに行けばよいか分からない。** 仕様上、401 に載せるこのヘッダーが
 * discovery の起点であり、付け忘れると「認証が要るのは分かるが繋ぎようがない」
 * サーバーになる。
 */
function denyMcp(
  res: express.Response,
  oauth: OAuthConfigOrNull,
  status: 400 | 401 | 403 | 503,
  error: string | undefined,
  description: string
): void {
  if (oauth !== null) {
    res.setHeader('WWW-Authenticate', buildWwwAuthenticate(oauth, error));
  }

  res.status(status).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: description },
    id: null,
  });
}

/**
 * DNS rebinding 対策の Host 検証。
 *
 * ループバック運用では、攻撃者のドメインを 127.0.0.1 に解決させることで、
 * ブラウザから同一オリジン扱いでローカルのサーバーを叩ける。CORS では防げない
 * （ブラウザから見て同一オリジンになるため）。このとき Host ヘッダーには
 * 攻撃者のドメインが入るので、そこで弾く。
 *
 * SDK の enableDnsRebindingProtection は Host をポート込みで比較するため使わない。
 * リバースプロキシ配下では Host のポートが待ち受けポートと一致しないのが普通で、
 * 正規のリクエストまで落ちる。
 */
function requireAllowedHost(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
): void {
  let allowed: string[] | null;

  // getAllowedHostnames() は BIND_HOST の既定を通じて認証設定まで読む。
  // 認証設定が壊れていればここで落ちるので、拒否に倒す。
  try {
    allowed = getAllowedHostnames();
  } catch (error) {
    denyMisconfigured(res, error);
    return;
  }

  if (allowed === null) {
    next();
    return;
  }

  const header = req.headers.host;
  if (typeof header !== 'string' || !allowed.includes(extractHostname(header))) {
    res.status(403).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: `Forbidden: host not allowed (${header ?? 'missing Host'})` },
      id: null,
    });
    return;
  }

  next();
}

/**
 * RFC 9728 の保護リソースメタデータ
 * GET /.well-known/oauth-protected-resource[/<リソースのパス>]
 *
 * **認証不要。** クライアントは「まだトークンを持っていない」状態でここを読む。
 * 保護すると discovery が成立しない。載っているのは issuer と自分の URI だけで、
 * 秘密は含まれない。
 *
 * OAuth モードでないときは 404 を返す。空のメタデータを返すと、クライアントは
 * 「OAuth に対応しているが認可サーバーが無い」と読んで別の失敗の仕方をする。
 */
app.get(`${PROTECTED_RESOURCE_METADATA_PREFIX}{/*path}`, (req, res) => {
  let oauth: OAuthConfigOrNull;

  try {
    oauth = activeOAuthConfig();
  } catch (error) {
    console.error('認証設定の解釈に失敗しました:', error);
    res.status(500).json({ error: 'Server misconfigured: authentication settings could not be parsed' });
    return;
  }

  if (oauth === null || !protectedResourceMetadataPaths(oauth).includes(req.path)) {
    res.status(404).json({ error: 'Not found' });
    return;
  }

  res.json(protectedResourceMetadata(oauth));
});

app.use('/mcp', requireAllowedHost, requireMcpAuth);

/**
 * ヘルスチェック用エンドポイント
 * GET /health
 * 認証不要
 */
app.get('/health', (_req, res) => {
  // version を含めるのは、デプロイしたつもりのものが動いているかを
  // 認証なしで確かめられるようにするため。
  res.json({ status: 'ok', connected: true, version: SERVER_VERSION });
});

/**
 * Vonage Messages API の Status Webhook 受信エンドポイント
 * POST /webhooks/message-status
 *
 * Messages API には配信ステータスを同期的に取得するAPIが無いため、
 * ここで受け取ったDLRをオンメモリに保持し、get_sms_status ツールから参照する。
 * Vonage Dashboard の Application 設定で Status URL にこのURLを登録すること。
 *
 * 認証: Vonageから呼ばれるため x-api-key 認証の対象外だが、必ず「Vonage由来であること」を
 *       検証する。VONAGE_API_SIGNATURE_SECRET による署名付きJWT検証を推奨。
 *       どちらの認証手段も未設定の場合はエンドポイントを無効化する（fail-closed）。
 */
app.post('/webhooks/message-status', (req, res) => {
  const auth = authenticateWebhook(req.headers, (req as express.Request & { rawBody?: Buffer }).rawBody);
  if (!auth.authorized) {
    res.status(auth.status ?? 401).json({ error: auth.reason });
    return;
  }

  const result = ingestStatusWebhook(req.body);

  if (!result) {
    // Vonageのリトライを防ぐため 200 は返さず、不正なペイロードとして 400 を返す
    res.status(400).json({ error: 'Invalid status webhook payload: message_uuid and status are required' });
    return;
  }

  res.status(200).json({
    status: 'ok',
    message_id: result.record.messageId,
    delivery_status: result.record.status,
    // 再送・順序逆転で古い通知が届いた場合は取り込まず、既存の状態を維持する
    ignored: result.ignored,
    // このサーバーの送信履歴に無いIDは隔離バッファに置く。同じ Vonage
    // Application を他システムと共用している場合に true になる。
    pending: result.pending,
  });
});

/**
 * Vonage Messages API の Inbound Webhook 受信エンドポイント
 * POST /webhooks/inbound
 *
 * 受信メッセージは現時点で利用しないが、Vonage側の設定必須項目のため 200 を返すだけのスタブを用意する。
 */
app.post('/webhooks/inbound', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

/**
 * 着信時に読み上げる案内。
 *
 * このサーバーは発信専用で、着信を処理する機能を持たない。それでも Answer URL を
 * 置くのは、番号をアプリケーションにリンクすると**着信がアプリに向く**ためで、
 * URL が無いと発信者は無言のまま切られる。
 *
 * 文面の長さ検証は getVoiceInboundMessage() 側にある（起動時に落とす）。
 */
function inboundGreeting(): string {
  return (
    getVoiceInboundMessage() ??
    'おかけになった電話番号では、お電話をお受けしておりません。恐れ入りますが、担当者へ直接ご連絡ください。'
  );
}

/**
 * Vonage Voice API の Answer Webhook 受信エンドポイント
 * POST /webhooks/voice/answer
 *
 * 着信に対して NCCO を返す。案内を読み上げて切るだけで、通話は受け付けない。
 * NCCO は最後のアクションが終わると通話が終了するため、hangup は不要。
 *
 * 認証: message-status と同じく fail-closed。認証できない場合 NCCO を返さないため
 *       着信は cancelled になるが、着信を受け付けない方針なので実害はない。
 */
app.post('/webhooks/voice/answer', (req, res) => {
  const auth = authenticateWebhook(req.headers, (req as express.Request & { rawBody?: Buffer }).rawBody);
  if (!auth.authorized) {
    res.status(auth.status ?? 401).json({ error: auth.reason });
    return;
  }

  res.status(200).json(generateNCCO(inboundGreeting()));
});

/**
 * Answer URL は Vonage の既定が GET だが、このサーバーは POST しか受けない。
 *
 * 署名付きJWTの検証は payload_hash（＝ボディのハッシュ）を必須にしており、
 * ボディの無い GET でこれが成立するかは公式ドキュメントに記載が無い。認証を
 * 弱める代わりに、アプリケーション側で `answer_method` を POST にしてもらう。
 *
 * 黙って 404 を返すと「Webhookが動かない」原因が分からなくなるので、
 * 何をすればよいかを本文に書いて返す。
 */
app.get('/webhooks/voice/answer', (_req, res) => {
  res.status(405).json({
    error: 'This endpoint accepts POST only',
    reason:
      'Vonage アプリケーションの Answer URL の HTTP メソッド（answer_method）を POST に変更してください。' +
      '署名付きWebhookの検証にリクエストボディが必要なため、GET は受け付けません。',
  });
});

/**
 * Vonage Voice API の Event Webhook 受信エンドポイント
 * POST /webhooks/voice/event
 *
 * **通話が失敗した理由が届く唯一の経路。** `GET /v1/calls/{uuid}` は status しか
 * 返さず detail は null のままなので、`busy` が「相手が通話中」なのか
 * 「その宛先への経路が無い」のかを、この Webhook 無しには区別できない。
 * 受け取った detail / sip_code は get_call_status から返す。
 */
app.post('/webhooks/voice/event', (req, res) => {
  const auth = authenticateWebhook(req.headers, (req as express.Request & { rawBody?: Buffer }).rawBody);
  if (!auth.authorized) {
    res.status(auth.status ?? 401).json({ error: auth.reason });
    return;
  }

  const result = ingestCallEvent(req.body);

  if (!result) {
    // Vonageのリトライを防ぐため 200 は返さず、不正なペイロードとして 400 を返す
    res.status(400).json({ error: 'Invalid call event payload: uuid and status are required' });
    return;
  }

  res.status(200).json({
    status: 'ok',
    call_id: result.record.callId,
    call_status: result.record.status,
    // 再送・順序逆転で古い通知が届いた場合は取り込まず、既存の状態を維持する
    ignored: result.ignored,
  });
});

/**
 * MCP Streamable HTTP エンドポイント
 * ALL /mcp
 *
 * POST (JSON-RPC) / GET (SSE) / DELETE (セッション終了) を MCP SDK の
 * StreamableHTTPServerTransport がすべて処理する。以前は JSON-RPC を手書きし、
 * initialize / tools/list / tools/call / ping にだけ応答していた。仕様の
 * 取りこぼしを自前で追いかけないために、トランスポートは SDK に任せる。
 *
 * ## ステートレスにしている理由
 *
 * リクエストごとにサーバーとトランスポートを作り、セッションIDを発行しない。
 * セッションを持つとその状態がプロセスのメモリに載るため、Cloud Run のように
 * 複数レプリカへ分散する環境では**同じセッションが別のレプリカに届いた時点で
 * 壊れる**。スティッキーセッションを前提にすると動く基盤が減る。
 *
 * このサーバーのツールはどれも1リクエストで完結し、サーバー起点の通知を
 * 送らないので、セッションを持つ理由がない。
 *
 * `enableJsonResponse` を有効にしているのも同じ理由で、POST の応答を SSE では
 * なく通常の JSON で返す。SSE はプロキシやゲートウェイにバッファされることが
 * あり、環境依存の不具合を持ち込みやすい。仕様上どちらで返してもよい。
 */
app.all('/mcp', async (req, res) => {
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  // リクエストが終わったら必ず片付ける。残すとレプリカあたりの
  // トランスポートが際限なく増える。
  res.on('close', () => {
    void transport.close();
    void server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error: any) {
    console.error('MCP endpoint error:', error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error', data: error?.message },
        id: null,
      });
    }
  }
});

/*
 * 削除したエンドポイント (VONAGE_MCP-9)
 *
 * - POST /mcp-invoke
 * - GET  /mcp-tools
 *
 * MCP と等価な機能を独自のインターフェースで二重に公開していた。/mcp だけ認証や
 * ガードレールを直しても、こうした別経路が残っていればそこから全部迂回できる。
 * ツールの実行経路は /mcp（MCP プロトコル）1本に絞る。
 */

// メインモジュールとして実行された場合のみサーバーを起動
if (isMainModule) {
  // HTTPサーバーの起動
  const host = getBindHost();
  const port = getPort();

  const server = app.listen(port, host, () => {
    console.log(`Vonage MCP Server (Streamable HTTP) listening on ${host}:${port}`);
    console.log(`有効なツール: ${enabledToolNames().join(', ') || '(なし)'}`);
    if (isLoopbackHost(host)) {
      console.warn(
        '[WARN] ループバックアドレスで待ち受けています。外部からは接続できません。' +
          ' 外部公開する場合は MCP_AUTH_TOKEN を設定してください。'
      );
    }
    if (!isWebhookAuthConfigured()) {
      console.warn(
        '[WARN] Webhook認証が未設定のため、以下のエンドポイントはすべて 503 で無効です:' +
          ' POST /webhooks/message-status（配信ステータス）,' +
          ' POST /webhooks/voice/answer（着信への応答。NCCOを返さないため着信は切断されます）,' +
          ' POST /webhooks/voice/event（通話イベント。失敗理由が記録されません）。' +
          ' VONAGE_API_SIGNATURE_SECRET（推奨）または VONAGE_WEBHOOK_SECRET を設定してください。'
      );
    }
  });

  // プロセス終了時のクリーンアップ処理
  process.on('SIGINT', () => {
    console.log('Shutting down...');
    server.close();
    process.exit(0);
  });
}
