import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { enabledToolDefinitions, findToolDefinition, listTools, runTool } from './tools.js';
import { httpStatusForOutcome, toMcpResult, unexpectedErrorOutcome } from './toolResponse.js';
import { ingestStatusWebhook } from './messageStatusStore.js';
import { authenticateWebhook, isWebhookAuthConfigured } from './webhookAuth.js';
import { applyStartupConfig } from './config.js';

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
const port = process.env.PORT || 3000;

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
 * APIキー認証ミドルウェア
 */
const authenticateApiKey = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const apiKey = req.headers['x-api-key'];
  const validApiKey = process.env.VONAGE_APPLICATION_ID;

  if (!apiKey || apiKey !== validApiKey) {
    res.status(401).json({ error: 'Unauthorized: Invalid or missing API Key' });
    return;
  }
  next();
};

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
  // Check API key authentication
  const apiKey = req.headers['x-api-key'];
  const validApiKey = process.env.VONAGE_APPLICATION_ID;

  if (!apiKey || apiKey !== validApiKey) {
    res.status(401).json({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: 'Unauthorized: Invalid or missing API Key'
      },
      id: null
    });
    return;
  }

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

// これ以降のエンドポイントには認証を適用
app.use(authenticateApiKey);

/**
 * MCPツールを実行するためのエンドポイント
 * POST /mcp-invoke
 * Body: { "tool": "tool_name", "params": { ... } }
 */
app.post('/mcp-invoke', async (req, res) => {
  const { tool, params } = req.body;

  // ツール名が指定されていない場合は400エラーを返す
  if (!tool) {
    res.status(400).json({ error: 'Missing "tool" parameter' });
    return;
  }

  // 存在しないツールは 404。無効化されているだけのツールはここを通し、
  // runTool() の capability 判定に 403 を返させる（404 だと管理者が
  // 「デプロイし忘れた」のか「無効化しただけ」なのか切り分けられない）。
  if (!findToolDefinition(tool)) {
    res.status(404).json({ error: `Unknown tool: ${tool}` });
    return;
  }

  try {
    console.log(`Invoking tool: ${tool}`);

    const outcome = await runTool(tool, params);
    const result = toMcpResult(outcome);

    // エラー種別に応じたステータスを返す。
    // 入力エラー/ガードレール違反=400、レート超過=429、未検出=404、想定外=500。
    // Vonage API 側の送信失敗は 200（MCPのツール結果）で、v1.2.1 以前の挙動と一致する。
    res.status(httpStatusForOutcome(outcome)).json(result);
  } catch (error: any) {
    console.error(`Error invoking tool ${tool}:`, error);
    res.status(500).json({
      error: 'Internal Server Error',
      details: error.message
    });
  }
});

/**
 * 利用可能なツールの一覧を取得するエンドポイント
 * GET /mcp-tools
 */
app.get('/mcp-tools', async (_req, res) => {
  res.json({ tools: listTools() });
});

// メインモジュールとして実行された場合のみサーバーを起動
if (isMainModule) {
  // HTTPサーバーの起動
  const server = app.listen(port, () => {
    console.log(`HTTP MCP Wrapper listening on port ${port}`);
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
