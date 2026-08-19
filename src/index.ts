import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { toolDefinitions } from "./tools.js";
import { toMcpResult, unexpectedErrorOutcome } from "./toolResponse.js";

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

// Create an MCP server
const server = new McpServer({
  name: "vonage-mcp-server",
  version: "1.3.0"
});

// 共通レジストリ (src/tools.ts) の定義からツールを一括登録する。
// スキーマ・ガードレール・レスポンス整形はすべてレジストリ側に集約されている。
for (const tool of toolDefinitions) {
  server.registerTool(
    tool.name,
    {
      title: tool.title,
      description: tool.description,
      inputSchema: tool.schema
    },
    async (args: any) => {
      debugLog(`${tool.name} が呼び出されました`, args);
      const outcome = await tool.handler(args).catch((error) =>
        unexpectedErrorOutcome(tool.name, error)
      );
      debugLog(`${tool.name} の結果`, outcome.payload);
      return toMcpResult(outcome) as any;
    }
  );
}

// Start receiving messages on stdin and sending messages on stdout
const transport = new StdioServerTransport();
await server.connect(transport);
