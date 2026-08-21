/**
 * McpServer インスタンスの生成
 *
 * stdio (src/index.ts) と Streamable HTTP (src/http-server.ts) が同じ関数を使う。
 * 以前は HTTP 側が McpServer を作って registerTool までしながら connect して
 * おらず、実際のリクエストは手書きの JSON-RPC 実装が処理していた。生成と実行が
 * 二重になっていると、片方だけ直したときに気づけない（VONAGE_MCP-10）。
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { enabledToolDefinitions, runTool } from './tools.js';
import { toMcpResult, unexpectedErrorOutcome, type ToolOutcome } from './toolResponse.js';

/** サーバー名とバージョン（package.json と揃える） */
export const SERVER_NAME = 'vonage-mcp-server';
export const SERVER_VERSION = '2.0.0';

/** ツール呼び出しを観測するためのフック（デバッグログ用） */
export interface McpServerHooks {
  onCall?: (name: string, args: unknown) => void;
  onResult?: (name: string, outcome: ToolOutcome) => void;
}

/**
 * 有効な capability のツールだけを登録した McpServer を返す。
 *
 * 実行は必ず runTool() を経由する。ハンドラを直接呼ぶ経路は作らない
 * （VONAGE_MCP-7）。
 */
export function createMcpServer(hooks: McpServerHooks = {}): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  const tools = enabledToolDefinitions();

  for (const tool of tools) {
    // SDK 1.30 の registerTool はジェネリクスの展開が深く、ツールの shape を
    // そのまま渡すと TS2589 で落ちる。**実行時の登録内容は変わらない**ので、
    // 呼び出し口で型の展開だけを止める。
    const register = server.registerTool.bind(server) as (
      name: string,
      config: Record<string, unknown>,
      handler: (args: any) => Promise<unknown>
    ) => unknown;

    register(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.schema,
        // 注釈を送らないと、クライアントは「破壊的かどうか不明」なツールとして
        // 扱う。Gemini Enterprise はその場合に安全側（確認UIを出す）へ倒すが、
        // それは基盤の既定に助けられているだけで、こちらが要求した結果では
        // ない。送信系は destructiveHint を明示し、参照系は readOnlyHint で
        // 不要な確認を省く（VONAGE_MCP-4）。
        annotations: tool.annotations,
      },
      async (args: any) => {
        hooks.onCall?.(tool.name, args);
        const outcome = await runTool(tool.name, args).catch((error) =>
          unexpectedErrorOutcome(tool.name, error)
        );
        hooks.onResult?.(tool.name, outcome);
        return toMcpResult(outcome) as any;
      }
    );
  }

  // capability が全 OFF だと registerTool が1度も呼ばれず、SDK は tools
  // capability 自体を宣言しない。その結果 tools/list が "Method not found" で
  // 失敗する。既定は全 OFF なので、これは初回起動でいちばん起きやすい状態であり、
  // クライアントの疎通確認がプロトコルエラーで死ぬ。「ツールが0件」と正しく
  // 伝えるために、空の一覧を返すハンドラを自前で登録する。
  if (tools.length === 0) {
    server.server.registerCapabilities({ tools: { listChanged: true } });
    server.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [] }));
  }

  return server;
}

/** 現在有効なツール名の一覧（起動ログ用） */
export function enabledToolNames(): string[] {
  return enabledToolDefinitions().map((tool) => tool.name);
}
