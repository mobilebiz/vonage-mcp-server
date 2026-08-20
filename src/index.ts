import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer, enabledToolNames } from "./mcpServer.js";
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

// 有効な capability のツールだけを登録したサーバーを生成する。
// 生成ロジックは Streamable HTTP 版と共有している (src/mcpServer.ts)。
const server = createMcpServer({
  onCall: (name, args) => debugLog(`${name} が呼び出されました`, args),
  onResult: (name, outcome) => debugLog(`${name} の結果`, outcome.payload),
});

debugLog(`有効なツール: ${enabledToolNames().join(', ') || '(なし)'}`);

// Start receiving messages on stdin and sending messages on stdout
const transport = new StdioServerTransport();
await server.connect(transport);
