import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { SERVER_VERSION, createMcpServer, enabledToolNames } from './mcpServer.js';
import { ingestStatusWebhook } from './messageStatusStore.js';
import { authenticateWebhook, isWebhookAuthConfigured, safeEqual } from './webhookAuth.js';
import {
  applyStartupConfig,
  getBindHost,
  getMcpAuthToken,
  getPort,
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

// ミドルウェアの設定
app.use(cors());
// Webhookの署名検証（payload_hash）に生のボディが必要なため、パース時に保持しておく
app.use(
  express.json({
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
function requireMcpAuth(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
): void {
  if (isUpstreamAuthTrusted()) {
    next();
    return;
  }

  const expected = getMcpAuthToken();
  if (expected === null) {
    next();
    return;
  }

  const header = req.headers['authorization'];
  const value = Array.isArray(header) ? header[0] : header;
  const match = typeof value === 'string' ? /^Bearer\s+(.+)$/i.exec(value.trim()) : null;

  if (!match || !safeEqual(match[1].trim(), expected)) {
    res.status(401).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Unauthorized: missing or invalid bearer token' },
      id: null,
    });
    return;
  }

  next();
}

app.use('/mcp', requireMcpAuth);

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
        '[WARN] Webhook認証が未設定のため POST /webhooks/message-status は無効です。' +
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
