/**
 * ツールレスポンスの整形モジュール
 *
 * Vonage APIの生レスポンスをそのまま返すとコンテキストウィンドウを浪費するため、
 * AIが必要とする最小限のフィールドだけを含む軽量なJSONに正規化する。
 */

/** ツールが返す軽量ペイロード */
export type ToolPayload = Record<string, unknown>;

/**
 * エラーの種別。HTTPラッパーがステータスコードへ変換するために使う。
 * - `validation`: 引数不正・ホワイトリスト違反など、呼び出し側が直せるもの → 400
 * - `rate_limit`: レートリミット超過 → 429
 * - `disabled`: サーバー側で機能が無効化されている → 403
 * - `not_found`: 指定されたIDのレコードが無い → 404
 * - `upstream`: Vonage API側の失敗。MCPのツール結果として返すのが妥当 → 200
 * - `internal`: 想定外の例外 → 500
 */
export type ToolErrorKind = 'validation' | 'rate_limit' | 'disabled' | 'not_found' | 'upstream' | 'internal';

/** ハンドラの実行結果（MCPレスポンスに変換する前の中間形式） */
export interface ToolOutcome {
  payload: ToolPayload;
  isError: boolean;
  errorKind?: ToolErrorKind;
}

/** MCPのツールレスポンス形式 */
export interface McpToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  [key: string]: unknown;
}

/**
 * 成功レスポンス
 * 例: { "status": "success", "message_id": "xxx", "to": "+81..." }
 */
export function successOutcome(fields: ToolPayload): ToolOutcome {
  return { payload: { status: 'success', ...fields }, isError: false };
}

/**
 * エラーレスポンス
 * AIが自己修復できるよう、原因(reason)と次に取るべき行動(suggestion)を必ず含める。
 */
export function errorOutcome(
  reason: string,
  suggestion: string,
  fields: ToolPayload = {},
  errorKind: ToolErrorKind = 'validation'
): ToolOutcome {
  return { payload: { status: 'error', reason, suggestion, ...fields }, isError: true, errorKind };
}

/**
 * dry_run レスポンス
 * 例: { "status": "dry_run_success", "message": "Ready to send" }
 */
export function dryRunOutcome(fields: ToolPayload = {}): ToolOutcome {
  return { payload: { status: 'dry_run_success', message: 'Ready to send', ...fields }, isError: false };
}

/** ToolOutcome を MCP のツールレスポンス形式に変換する */
export function toMcpResult(outcome: ToolOutcome): McpToolResult {
  const result: McpToolResult = {
    content: [{ type: 'text', text: JSON.stringify(outcome.payload) }],
  };

  if (outcome.isError) {
    result.isError = true;
  }

  return result;
}

/**
 * エラー種別に対応するHTTPステータスコードを返す。
 *
 * `upstream`（Vonage API側の失敗）を 200 にしているのは、これがMCPのツール実行結果
 * であってHTTPリクエスト自体の失敗ではないため。
 *
 * このサーバー自身は使わない。MCP の JSON-RPC はツールのエラーを result として
 * 200 で返すためである（VONAGE_MCP-9 で独自の /mcp-invoke を削除した）。
 * このレジストリを自前のHTTP層に組み込む利用者向けに残してある。
 */
export function httpStatusForOutcome(outcome: ToolOutcome): number {
  if (!outcome.isError) {
    return 200;
  }

  switch (outcome.errorKind) {
    case 'rate_limit':
      return 429;
    case 'disabled':
      // 認証の問題ではなくサーバー設定の問題なので 401 ではなく 403
      return 403;
    case 'not_found':
      return 404;
    case 'upstream':
      return 200;
    case 'internal':
      return 500;
    case 'validation':
    default:
      return 400;
  }
}

/**
 * 予期しない例外を、AIが解釈可能なエラーレスポンスに変換する。
 */
export function unexpectedErrorOutcome(toolName: string, error: unknown): ToolOutcome {
  const message = error instanceof Error ? error.message : String(error);
  return errorOutcome(
    `${toolName} の実行中に予期しないエラーが発生しました: ${message}`,
    'パラメータを見直して再試行してください。同じエラーが続く場合はサーバー設定（環境変数・認証情報）に問題がある可能性があるため、ユーザーに確認してください。',
    {},
    'internal'
  );
}
