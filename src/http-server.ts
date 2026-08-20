import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { enabledToolDefinitions, listTools, runTool } from './tools.js';
import { toMcpResult, unexpectedErrorOutcome } from './toolResponse.js';
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

const SERVER_VERSION = '1.3.0';

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

// Create MCP server instance
const mcpServer = new McpServer({
  name: 'vonage-mcp-server',
  version: SERVER_VERSION
});

// 共通レジストリから、有効になっているツールだけを登録する（stdio版と同一の判定）。
// 実行は必ず runTool() を経由させる (VONAGE_MCP-7)。
for (const tool of enabledToolDefinitions()) {
  mcpServer.registerTool(
    tool.name,
    {
      title: tool.title,
      description: tool.description,
      inputSchema: tool.schema
    },
    async (args: any) => {
      const outcome = await runTool(tool.name, args).catch((error) =>
        unexpectedErrorOutcome(tool.name, error)
      );
      return toMcpResult(outcome) as any;
    }
  );
}

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
  res.json({ status: 'ok', connected: true });
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
 * MCP protocol endpoint
 * POST /mcp
 * Handles MCP JSON-RPC requests with authentication
 */
app.post('/mcp', async (req, res) => {
  // 認証は app.use('/mcp', requireMcpAuth) で済んでいる
  try {
    const { jsonrpc, id, method, params } = req.body;

    // Validate JSON-RPC 2.0 format
    if (jsonrpc !== '2.0') {
      res.status(400).json({
        jsonrpc: '2.0',
        error: {
          code: -32600,
          message: 'Invalid Request: jsonrpc must be "2.0"'
        },
        id: id ?? null
      });
      return;
    }

    // Handle MCP methods
    let result: any;

    switch (method) {
      case 'initialize':
        result = {
          protocolVersion: '2024-11-05',
          capabilities: {
            tools: {}
          },
          serverInfo: {
            name: 'vonage-mcp-server',
            version: SERVER_VERSION
          }
        };
        break;

      case 'tools/list':
        // リクエストごとに評価する。無効な capability のツールは含まれない。
        result = { tools: listTools() };
        break;

      case 'tools/call': {
        const { name, arguments: args } = params ?? {};
        const outcome = await runTool(name, args);
        result = toMcpResult(outcome);
        break;
      }

      case 'ping':
        result = {};
        break;

      default:
        res.json({
          jsonrpc: '2.0',
          error: {
            code: -32601,
            message: `Method not found: ${method}`
          },
          id: id ?? null
        });
        return;
    }

    // Return successful response
    res.json({
      jsonrpc: '2.0',
      result,
      id: id ?? null
    });

  } catch (error: any) {
    console.error('MCP endpoint error:', error);
    res.status(500).json({
      jsonrpc: '2.0',
      error: {
        code: -32603,
        message: 'Internal server error',
        data: error.message
      },
      id: null
    });
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
    console.log(`HTTP MCP Wrapper listening on ${host}:${port}`);
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
