import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { enabledToolDefinitions, runTool } from "./tools.js";
import { toMcpResult, unexpectedErrorOutcome } from "./toolResponse.js";
import { applyStartupConfig } from "./config.js";

// dotenvを使用せず、直接Node.jsの--env-fileオプションを使用して環境変数を読み込むことを推奨
// 実行方法: node --env-file=.env dist/index.js
// または: npm run start:env

console.error("DEBUG: src/index.ts is starting...");

// デバッグログ機能（環境変数DEBUG=trueで有効化）
import { appendFileSync } from 'fs';

const isDebugMode = process.env.DEBUG === 'true';
const logFile = process.env.LOG_FILE;

function debugLog(message: string, data?: any) {
  if (isDebugMode) {
    const timestamp = new Date().toISOString();
    const logMessage = `[DEBUG ${timestamp}] ${message}`;
    const logData = data ? JSON.stringify(data, null, 2) : '';
    const fullLog = logData ? `${logMessage}\n${logData}\n` : `${logMessage}\n`;

    // コンソール出力（stderr）
    console.error(logMessage);
    if (data) {
      console.error(logData);
    }

    // ファイル出力（指定されている場合）
    if (logFile) {
      try {
        appendFileSync(logFile, fullLog);
      } catch (error) {
        console.error(`Failed to write to log file: ${error}`);
      }
    }
  }
}

// 環境変数の検証。不正な設定はここでプロセスを落とす（fail-fast）。
// ツールを1つでも公開する前に実行する。
applyStartupConfig();

// Create an MCP server
const server = new McpServer({
  name: "vonage-mcp-server",
  version: "1.3.0"
});

// 共通レジストリ (src/tools.ts) から、有効になっているツールだけを登録する。
// 実行は必ず runTool() を経由させる。以前はここで tool.handler() を直接呼んで
// おり、capability の判定を stdio 経由で丸ごと迂回できた (VONAGE_MCP-7)。
const enabledTools = enabledToolDefinitions();
debugLog(`有効なツール: ${enabledTools.map((t) => t.name).join(', ') || '(なし)'}`);

for (const tool of enabledTools) {
  server.registerTool(
    tool.name,
    {
      title: tool.title,
      description: tool.description,
      inputSchema: tool.schema
    },
    async (args: any) => {
      debugLog(`${tool.name} が呼び出されました`, args);
      const outcome = await runTool(tool.name, args).catch((error) =>
        unexpectedErrorOutcome(tool.name, error)
      );
      debugLog(`${tool.name} の結果`, outcome.payload);
      return toMcpResult(outcome) as any;
    }
  );
}

// capability が全 OFF だと registerTool が1度も呼ばれず、SDK は tools capability
// 自体を宣言しない。その結果 tools/list が "Method not found" で失敗する。
// 既定は全 OFF なので、これは初回起動でいちばん起きやすい状態であり、
// 「ツールが0件」と正しく伝えるために空の一覧ハンドラを自前で登録する。
if (enabledTools.length === 0) {
  server.server.registerCapabilities({ tools: { listChanged: true } });
  server.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [] }));
}

// Start receiving messages on stdin and sending messages on stdout
const transport = new StdioServerTransport();
await server.connect(transport);
