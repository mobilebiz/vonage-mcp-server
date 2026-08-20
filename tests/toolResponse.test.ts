import { describe, it, expect } from 'vitest';
import {
  dryRunOutcome,
  errorOutcome,
  httpStatusForOutcome,
  partialSuccessOutcome,
  successOutcome,
  toMcpResult,
} from '../src/toolResponse.js';

describe('toolResponse', () => {
  describe('httpStatusForOutcome', () => {
    // このサーバー自身は使わない（MCP はツールのエラーも 200 の result で返す）。
    // レジストリを自前のHTTP層に組み込む利用者向けの写像なので、意図を固定しておく。
    it.each([
      ['validation', 400],
      ['disabled', 403],
      ['not_found', 404],
      ['rate_limit', 429],
      ['internal', 500],
    ] as const)('%s は %d', (kind, status) => {
      expect(httpStatusForOutcome(errorOutcome('reason', 'suggestion', {}, kind))).toBe(status);
    });

    // Vonage 側の失敗は「HTTPリクエストの失敗」ではなく「ツールの実行結果」
    it('upstream は 200', () => {
      expect(httpStatusForOutcome(errorOutcome('r', 's', {}, 'upstream'))).toBe(200);
    });

    it('errorKind が無いエラーは 400', () => {
      expect(httpStatusForOutcome({ payload: {}, isError: true })).toBe(400);
    });

    it.each([
      ['success', successOutcome({})],
      ['partial_success', partialSuccessOutcome({})],
      ['dry_run', dryRunOutcome()],
    ])('%s は 200', (_label, outcome) => {
      expect(httpStatusForOutcome(outcome)).toBe(200);
    });
  });

  describe('toMcpResult', () => {
    it('ペイロードをJSON文字列として content に載せる', () => {
      const result = toMcpResult(successOutcome({ message_id: 'm' }));

      expect(result.content).toHaveLength(1);
      expect(JSON.parse(result.content[0].text)).toEqual({ status: 'success', message_id: 'm' });
      expect(result.isError).toBeUndefined();
    });

    it('エラーには isError を立てる', () => {
      const result = toMcpResult(errorOutcome('reason', 'suggestion'));
      expect(result.isError).toBe(true);
    });
  });

  describe('errorOutcome', () => {
    // エラーは必ず「なぜ」と「次に何をすべきか」を含む
    it('reason と suggestion を必ず含む', () => {
      const outcome = errorOutcome('なぜ', 'どうする', { extra: 1 });

      expect(outcome.payload).toEqual({
        status: 'error',
        reason: 'なぜ',
        suggestion: 'どうする',
        extra: 1,
      });
      expect(outcome.isError).toBe(true);
      expect(outcome.errorKind).toBe('validation');
    });
  });
});
