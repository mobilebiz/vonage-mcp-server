import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * bulk 送信の記録タイミングを固定する。
 *
 * `sendBulkSMS` は1行ずつ100ms待って逐次送信するため、200件なら数十秒かかる。
 * 呼び出し側が `recordSubmitted()` を全件完了後にまとめて実行していると、
 * ループ中に届いた前半のDLRが「知らない message_id」として隔離バッファ
 * （200件・5分）へ回され、大きなCSVではそこから溢れて配信ステータスが
 * 永久に取れなくなる（VONAGE_MCP-4 / Codex 再レビュー）。
 *
 * 「全件終わってからまとめて記録する」実装でも件数だけは合うので、
 * **送信と記録が交互に起きること**を順序で固定する。
 */

const sendCalls: string[] = [];

vi.mock('@vonage/server-sdk', () => ({
  Vonage: class {
    messages = {
      send: async (params: any) => {
        sendCalls.push(`send:${params.to}`);
        return { messageUuid: `uuid-${params.to}` };
      },
    };
  },
}));

describe('bulk 送信の記録タイミング', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    sendCalls.length = 0;
    process.env.VONAGE_APPLICATION_ID = 'test-app-id';
    process.env.VONAGE_PRIVATE_KEY_PATH = './private.key';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('1件送るたびにコールバックが呼ばれる（全件完了後のまとめ処理ではない）', async () => {
    const { sendBulkSMS } = await import('../src/vonage.js');

    const events: string[] = [];
    const requests = [
      { to: '+819011111111', message: 'a' },
      { to: '+819022222222', message: 'b' },
      { to: '+819033333333', message: 'c' },
    ];

    const result = await sendBulkSMS(requests, (item) => {
      events.push(`recorded:${item.to}`);
    });

    // 件数と順序。タイミングそのものは次のテストで固定する
    expect(events).toEqual([
      'recorded:+819011111111',
      'recorded:+819022222222',
      'recorded:+819033333333',
    ]);
    expect(result.successCount).toBe(3);
  });

  it('記録は送信のたびに割り込む（送信→記録→送信→記録の順）', async () => {
    const { sendBulkSMS } = await import('../src/vonage.js');

    const timeline: string[] = [];
    const requests = [
      { to: '+819011111111', message: 'a' },
      { to: '+819022222222', message: 'b' },
    ];

    // 送信側の記録は sendCalls に入るので、コールバックでその長さを見れば
    // 「何件送った時点で記録されたか」が分かる
    await sendBulkSMS(requests, (item) => {
      timeline.push(`after ${sendCalls.length} sends: ${item.to}`);
    });

    expect(timeline).toEqual([
      'after 1 sends: +819011111111',
      'after 2 sends: +819022222222',
    ]);
  });

  it('記録側が throw しても残りの行の送信は続く', async () => {
    const { sendBulkSMS } = await import('../src/vonage.js');

    const requests = [
      { to: '+819011111111', message: 'a' },
      { to: '+819022222222', message: 'b' },
      { to: '+819033333333', message: 'c' },
    ];

    const result = await sendBulkSMS(requests, (item) => {
      if (item.to === '+819011111111') {
        throw new Error('ストアが一時的に壊れた');
      }
    });

    // 1件目の記録に失敗しても、送信自体は3件とも完了している。
    // ここで throw を素通しすると「一部だけ送信済み」でエラーになる
    expect(result.successCount).toBe(3);
    expect(sendCalls).toHaveLength(3);
  });

  it('コールバックを渡さなくても動く（既存の呼び出し側を壊さない）', async () => {
    const { sendBulkSMS } = await import('../src/vonage.js');

    const result = await sendBulkSMS([{ to: '+819011111111', message: 'a' }]);

    expect(result.successCount).toBe(1);
  });
});
