import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { mockSendSMS, mockSendBulkSMS, mockMakeVoiceCall, mockGetCallStatus, mockGenerateJWT } = vi.hoisted(() => ({
  mockSendSMS: vi.fn(),
  mockSendBulkSMS: vi.fn(),
  mockMakeVoiceCall: vi.fn(),
  mockGetCallStatus: vi.fn(),
  mockGenerateJWT: vi.fn(),
}));

vi.mock('../src/vonage.js', async () => {
  const actual = await vi.importActual<typeof import('../src/vonage.js')>('../src/vonage.js');
  return { ...actual, sendSMS: mockSendSMS, sendBulkSMS: mockSendBulkSMS };
});

vi.mock('../src/voiceCall.js', async () => {
  const actual = await vi.importActual<typeof import('../src/voiceCall.js')>('../src/voiceCall.js');
  return { ...actual, makeVoiceCall: mockMakeVoiceCall };
});

vi.mock('../src/callStatus.js', () => ({ getCallStatus: mockGetCallStatus }));
vi.mock('../src/jwtUtils.js', () => ({ generateVonageJWT: mockGenerateJWT }));

import { listTools, runTool, toolDefinitions } from '../src/tools.js';
import { toolRateLimiter } from '../src/guardrails.js';
import { clearMessageStatusStore, getMessageStatus, ingestStatusWebhook } from '../src/messageStatusStore.js';

/** ツールを実行して軽量ペイロードを取り出す */
async function invoke(name: string, args: unknown): Promise<any> {
  return (await runTool(name, args)).payload;
}

describe('tools registry', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    toolRateLimiter.reset();
    clearMessageStatusStore();
    delete process.env.ALLOWED_NUMBERS;
    delete process.env.BULK_MAX_ROWS;
    process.env.RATE_LIMIT_PER_HOUR = '0'; // テストではレートリミットを無効化
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('スキーマ', () => {
    it('全ツールがJSON Schemaを生成できる', () => {
      const tools = listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([
        'bulk_sms_from_csv',
        'generate_jwt',
        'get_call_status',
        'get_sms_status',
        'make_voice_call',
        'send_sms',
      ]);

      for (const tool of tools) {
        expect(tool.inputSchema).toMatchObject({ type: 'object' });
        expect(tool.description.length).toBeGreaterThan(0);
      }
    });

    it('send_sms の to に電話番号パターン、message に maxLength 160 が設定されている', () => {
      const schema = listTools().find((t) => t.name === 'send_sms')!.inputSchema as any;
      expect(schema.properties.to.pattern).toBeDefined();
      expect(schema.properties.message.maxLength).toBe(160);
      expect(schema.properties.message.description).toContain('要約');
      expect(schema.properties.dry_run.type).toBe('boolean');
      expect(schema.required).toEqual(expect.arrayContaining(['to', 'message']));
      expect(schema.required).not.toContain('dry_run');
    });

    it('make_voice_call の message には160文字制限を課さない', () => {
      const schema = listTools().find((t) => t.name === 'make_voice_call')!.inputSchema as any;
      expect(schema.properties.message.maxLength).toBe(1000);
      expect(schema.properties.voice.enum).toEqual(['女性', '男性']);
    });

    it('課金対象の全ツールに dry_run がある', () => {
      for (const name of ['send_sms', 'bulk_sms_from_csv', 'make_voice_call']) {
        expect(toolDefinitions.find((t) => t.name === name)!.schema).toHaveProperty('dry_run');
      }
    });
  });

  describe('引数バリデーション', () => {
    it('未知のツールは自己修復可能なエラーを返す', async () => {
      const payload = await invoke('no_such_tool', {});
      expect(payload.status).toBe('error');
      expect(payload.suggestion).toContain('send_sms');
    });

    it('160文字を超える本文は拒否される', async () => {
      const payload = await invoke('send_sms', { to: '09012345678', message: 'あ'.repeat(161) });
      expect(payload.status).toBe('error');
      expect(payload.reason).toContain('message');
      expect(mockSendSMS).not.toHaveBeenCalled();
    });

    it('パターンに合わない電話番号は拒否される', async () => {
      const payload = await invoke('send_sms', { to: 'abc', message: 'hello' });
      expect(payload.status).toBe('error');
      expect(mockSendSMS).not.toHaveBeenCalled();
    });
  });

  describe('send_sms', () => {
    it('成功時は message_id と to だけを返す', async () => {
      mockSendSMS.mockResolvedValue({ success: true, messageId: 'msg-123' });

      const payload = await invoke('send_sms', { to: '09012345678', message: 'hello' });

      expect(payload).toEqual({ status: 'success', message_id: 'msg-123', to: '+819012345678' });
      expect(mockSendSMS).toHaveBeenCalledWith({
        to: '+819012345678',
        message: 'hello',
        from: undefined,
      });
    });

    it('成功時は submitted としてステータスストアに記録される', async () => {
      mockSendSMS.mockResolvedValue({ success: true, messageId: 'msg-123' });
      await invoke('send_sms', { to: '09012345678', message: 'hello' });

      expect(getMessageStatus('msg-123')!.status).toBe('submitted');
    });

    it('失敗時は reason と suggestion を返す', async () => {
      mockSendSMS.mockResolvedValue({ success: false, error: 'SMS送信エラー: Invalid sender' });

      const payload = await invoke('send_sms', { to: '09012345678', message: 'hello' });

      expect(payload.status).toBe('error');
      expect(payload.reason).toContain('Invalid sender');
      expect(payload.suggestion).toBeTruthy();
    });

    it('dry_run では送信せず dry_run_success を返す', async () => {
      const payload = await invoke('send_sms', { to: '09012345678', message: 'hello', dry_run: true });

      expect(payload).toEqual({
        status: 'dry_run_success',
        message: 'Ready to send',
        tool: 'send_sms',
        to: '+819012345678',
        from: 'VonageMCP',
        characters: 5,
      });
      expect(mockSendSMS).not.toHaveBeenCalled();
    });

    it('ALLOWED_NUMBERS 外の番号はブロックされる', async () => {
      process.env.ALLOWED_NUMBERS = '+819087654321';

      const payload = await invoke('send_sms', { to: '09012345678', message: 'hello' });

      expect(payload.status).toBe('error');
      expect(payload.reason).toContain('許可されていません');
      expect(mockSendSMS).not.toHaveBeenCalled();
    });

    it('無効な送信元は dry_run の時点で拒否される', async () => {
      const payload = await invoke('send_sms', {
        to: '09012345678',
        message: 'hello',
        from: '123',
        dry_run: true,
      });

      expect(payload.status).toBe('error');
      expect(payload.reason).toContain('無効な送信元');
      expect(mockSendSMS).not.toHaveBeenCalled();
    });

    it('有効な送信元（英数字・電話番号）は許可される', async () => {
      mockSendSMS.mockResolvedValue({ success: true, messageId: 'msg-123' });

      for (const from of ['VonageMCP', '+819087654321']) {
        const payload = await invoke('send_sms', { to: '09012345678', message: 'a', from, dry_run: true });
        expect(payload.status, `${from} は許可されるべき`).toBe('dry_run_success');
      }
    });

    it('ALLOWED_NUMBERS 内の番号は送信できる', async () => {
      process.env.ALLOWED_NUMBERS = '090-1234-5678';
      mockSendSMS.mockResolvedValue({ success: true, messageId: 'msg-123' });

      const payload = await invoke('send_sms', { to: '+819012345678', message: 'hello' });
      expect(payload.status).toBe('success');
    });
  });

  describe('レートリミット', () => {
    beforeEach(() => {
      process.env.RATE_LIMIT_PER_HOUR = '2';
    });

    it('上限を超えると再試行方針付きのエラーを返す', async () => {
      mockSendSMS.mockResolvedValue({ success: true, messageId: 'msg-123' });

      expect((await invoke('send_sms', { to: '09012345678', message: 'a' })).status).toBe('success');
      expect((await invoke('send_sms', { to: '09012345678', message: 'a' })).status).toBe('success');

      const blocked = await invoke('send_sms', { to: '09012345678', message: 'a' });
      expect(blocked.status).toBe('error');
      expect(blocked.reason).toContain('レートリミット超過');
      expect(blocked.retry_after_seconds).toBeGreaterThan(0);
      expect(mockSendSMS).toHaveBeenCalledTimes(2);
    });

    it('dry_run はレートリミットを消費しない', async () => {
      mockSendSMS.mockResolvedValue({ success: true, messageId: 'msg-123' });

      for (let i = 0; i < 5; i++) {
        await invoke('send_sms', { to: '09012345678', message: 'a', dry_run: true });
      }

      expect((await invoke('send_sms', { to: '09012345678', message: 'a' })).status).toBe('success');
    });

    it('ツールごとに独立してカウントする', async () => {
      mockSendSMS.mockResolvedValue({ success: true, messageId: 'msg-123' });
      mockMakeVoiceCall.mockResolvedValue({ success: true, callId: 'call-1' });

      await invoke('send_sms', { to: '09012345678', message: 'a' });
      await invoke('send_sms', { to: '09012345678', message: 'a' });
      expect((await invoke('send_sms', { to: '09012345678', message: 'a' })).status).toBe('error');

      expect((await invoke('make_voice_call', { to: '09012345678', message: 'a' })).status).toBe('success');
    });
  });

  describe('make_voice_call', () => {
    it('成功時は call_id と推定通話時間を返す', async () => {
      mockMakeVoiceCall.mockResolvedValue({ success: true, callId: 'call-123' });

      const payload = await invoke('make_voice_call', { to: '09012345678', message: 'テストです' });

      expect(payload).toMatchObject({
        status: 'success',
        call_id: 'call-123',
        to: '+819012345678',
        voice: '女性',
      });
      expect(payload.estimated_duration_seconds).toBeGreaterThan(0);
    });

    it('dry_run では発信しない', async () => {
      const payload = await invoke('make_voice_call', {
        to: '09012345678',
        message: 'テストです',
        voice: '男性',
        dry_run: true,
      });

      expect(payload.status).toBe('dry_run_success');
      expect(payload.voice).toBe('男性');
      expect(mockMakeVoiceCall).not.toHaveBeenCalled();
    });

    it('未対応の音声タイプは拒否される', async () => {
      const payload = await invoke('make_voice_call', { to: '09012345678', message: 'a', voice: 'ロボット' });
      expect(payload.status).toBe('error');
      expect(mockMakeVoiceCall).not.toHaveBeenCalled();
    });
  });

  describe('bulk_sms_from_csv', () => {
    const csv = 'phone,from,message\n09012345678,VonageMCP,hello\n09087654321,VonageMCP,hello2\n';

    it('160文字を超える行は送信されない（単発と同じ本文長制限を適用）', async () => {
      const long = 'あ'.repeat(161);
      mockSendBulkSMS.mockResolvedValue({
        totalRequests: 1,
        successCount: 1,
        failureCount: 0,
        results: [{ to: '+819087654321', from: 'VonageMCP', success: true, messageId: 'm1' }],
      });

      const payload = await invoke('bulk_sms_from_csv', {
        csv_content: `phone,from,message\n09012345678,VonageMCP,${long}\n09087654321,VonageMCP,ok\n`,
      });

      expect(payload.too_long_rows).toBe(1);
      expect(mockSendBulkSMS).toHaveBeenCalledWith([
        { to: '+819087654321', message: 'ok', from: 'VonageMCP' },
      ]);
    });

    it('全行が160文字超ならAPIを呼ばずエラーを返す', async () => {
      const long = 'あ'.repeat(161);
      const payload = await invoke('bulk_sms_from_csv', {
        csv_content: `phone,from,message\n09012345678,VonageMCP,${long}\n`,
      });

      expect(payload.status).toBe('error');
      expect(payload.too_long_rows).toBe(1);
      expect(mockSendBulkSMS).not.toHaveBeenCalled();
    });

    it('BULK_MAX_ROWS を超えるCSVはAPIを呼ばず拒否する', async () => {
      process.env.BULK_MAX_ROWS = '2';
      const rows = ['09012345678', '09087654321', '09011112222']
        .map((p) => `${p},VonageMCP,hi`)
        .join('\n');

      const payload = await invoke('bulk_sms_from_csv', { csv_content: `phone,from,message\n${rows}\n` });

      expect(payload.status).toBe('error');
      expect(payload.reason).toContain('行数が上限を超えています');
      expect(payload.max_rows).toBe(2);
      expect(mockSendBulkSMS).not.toHaveBeenCalled();
    });

    it('送信件数の分だけレート枠を消費する', async () => {
      process.env.RATE_LIMIT_PER_HOUR = '3';
      mockSendBulkSMS.mockResolvedValue({
        totalRequests: 2,
        successCount: 2,
        failureCount: 0,
        results: [
          { to: '+819012345678', from: 'VonageMCP', success: true, messageId: 'm1' },
          { to: '+819087654321', from: 'VonageMCP', success: true, messageId: 'm2' },
        ],
      });

      expect((await invoke('bulk_sms_from_csv', { csv_content: csv })).status).toBe('success');

      // 残り枠は1件。2件のCSVは通らない
      const blocked = await invoke('bulk_sms_from_csv', { csv_content: csv });
      expect(blocked.status).toBe('error');
      expect(blocked.reason).toContain('2件の送信を要求');
      expect(blocked.remaining_quota).toBe(1);
      expect(mockSendBulkSMS).toHaveBeenCalledTimes(1);
    });

    it('レート枠が足りない場合は1件も送信しない', async () => {
      process.env.RATE_LIMIT_PER_HOUR = '1';

      const payload = await invoke('bulk_sms_from_csv', { csv_content: csv });

      expect(payload.status).toBe('error');
      expect(payload.reason).toContain('1件も送信していません');
      expect(mockSendBulkSMS).not.toHaveBeenCalled();
    });

    it('全件失敗なら status=error を返す', async () => {
      mockSendBulkSMS.mockResolvedValue({
        totalRequests: 2,
        successCount: 0,
        failureCount: 2,
        results: [
          { to: '+819012345678', from: 'VonageMCP', success: false, error: 'auth failed' },
          { to: '+819087654321', from: 'VonageMCP', success: false, error: 'auth failed' },
        ],
      });

      const payload = await invoke('bulk_sms_from_csv', { csv_content: csv });

      expect(payload.status).toBe('error');
      expect(payload.sent).toBe(0);
      expect(payload.failed).toBe(2);
    });

    it('一部失敗なら status=partial_success を返す', async () => {
      mockSendBulkSMS.mockResolvedValue({
        totalRequests: 2,
        successCount: 1,
        failureCount: 1,
        results: [
          { to: '+819012345678', from: 'VonageMCP', success: true, messageId: 'm1' },
          { to: '+819087654321', from: 'VonageMCP', success: false, error: 'rejected' },
        ],
      });

      const payload = await invoke('bulk_sms_from_csv', { csv_content: csv });

      expect(payload.status).toBe('partial_success');
      expect(payload.sent).toBe(1);
      expect(payload.failed).toBe(1);
    });

    it('dry_run では件数のみを返す', async () => {
      const payload = await invoke('bulk_sms_from_csv', { csv_content: csv, dry_run: true });

      expect(payload).toMatchObject({
        status: 'dry_run_success',
        total_rows: 2,
        sendable_rows: 2,
        invalid_rows: 0,
        blocked_rows: 0,
      });
      expect(mockSendBulkSMS).not.toHaveBeenCalled();
    });

    it('ALLOWED_NUMBERS で絞り込まれた行だけを送信する', async () => {
      process.env.ALLOWED_NUMBERS = '+819012345678';
      mockSendBulkSMS.mockResolvedValue({
        totalRequests: 1,
        successCount: 1,
        failureCount: 0,
        results: [{ to: '+819012345678', from: 'VonageMCP', success: true, messageId: 'm1' }],
      });

      const payload = await invoke('bulk_sms_from_csv', { csv_content: csv });

      expect(payload.status).toBe('success');
      expect(payload.sent).toBe(1);
      expect(payload.blocked_rows).toBe(1);
      expect(mockSendBulkSMS).toHaveBeenCalledWith([
        { to: '+819012345678', message: 'hello', from: 'VonageMCP' },
      ]);
    });

    it('送信可能な行が無ければエラーを返す', async () => {
      process.env.ALLOWED_NUMBERS = '+819099999999';

      const payload = await invoke('bulk_sms_from_csv', { csv_content: csv });

      expect(payload.status).toBe('error');
      expect(payload.blocked_rows).toBe(2);
      expect(mockSendBulkSMS).not.toHaveBeenCalled();
    });
  });

  describe('get_call_status', () => {
    it('callId でも call_id でも取得できる', async () => {
      mockGetCallStatus.mockResolvedValue({
        success: true,
        status: 'completed',
        price: '0.05',
        rate: '0.05',
        duration: 12,
        startTime: '2026-08-04T10:00:00.000Z',
      });

      const byCamel = await invoke('get_call_status', { callId: 'call-1' });
      const bySnake = await invoke('get_call_status', { call_id: 'call-1' });

      expect(byCamel).toMatchObject({ status: 'success', call_id: 'call-1', call_status: 'completed' });
      expect(bySnake).toMatchObject({ status: 'success', call_status: 'completed' });
    });

    it('IDが無い場合はエラーを返す', async () => {
      const payload = await invoke('get_call_status', {});
      expect(payload.status).toBe('error');
      expect(mockGetCallStatus).not.toHaveBeenCalled();
    });
  });

  describe('get_sms_status', () => {
    it('Webhook受信済みのステータスを返す', async () => {
      ingestStatusWebhook({
        message_uuid: 'msg-1',
        status: 'delivered',
        to: '819012345678',
        timestamp: '2026-08-04T10:00:00.000Z',
      });

      const payload = await invoke('get_sms_status', { message_id: 'msg-1' });

      expect(payload).toMatchObject({
        status: 'success',
        message_id: 'msg-1',
        delivery_status: 'delivered',
      });
      expect(payload.note).toBeUndefined();
    });

    it('未確定（submitted）の場合は注釈を付ける', async () => {
      mockSendSMS.mockResolvedValue({ success: true, messageId: 'msg-2' });
      await invoke('send_sms', { to: '09012345678', message: 'hello' });

      const payload = await invoke('get_sms_status', { message_id: 'msg-2' });

      expect(payload.delivery_status).toBe('submitted');
      expect(payload.note).toContain('Status Webhook');
    });

    it('記録が無い場合は再試行不要である旨を伝える', async () => {
      const payload = await invoke('get_sms_status', { message_id: 'unknown' });

      expect(payload.status).toBe('error');
      expect(payload.suggestion).toContain('再試行しても結果は変わらない');
    });
  });

  describe('generate_jwt', () => {
    it('成功時は token と有効期限を返す', async () => {
      mockGenerateJWT.mockResolvedValue({ success: true, token: 'jwt-token', expiresAt: '2026-08-05T00:00:00.000Z' });

      const payload = await invoke('generate_jwt', {});

      expect(payload).toEqual({
        status: 'success',
        token: 'jwt-token',
        expires_at: '2026-08-05T00:00:00.000Z',
        subject: 'VonageMCP',
      });
    });

    it('失敗時は設定確認を促す', async () => {
      mockGenerateJWT.mockResolvedValue({ success: false, error: 'private key not found' });

      const payload = await invoke('generate_jwt', {});

      expect(payload.status).toBe('error');
      expect(payload.suggestion).toContain('VONAGE_APPLICATION_ID');
    });
  });

  describe('エラー種別 (errorKind)', () => {
    it('入力エラーは validation', async () => {
      const r = await runTool('send_sms', { to: 'abc', message: 'hi' });
      expect(r.errorKind).toBe('validation');
    });

    it('レートリミット超過は rate_limit', async () => {
      process.env.RATE_LIMIT_PER_HOUR = '1';
      mockSendSMS.mockResolvedValue({ success: true, messageId: 'm' });
      await runTool('send_sms', { to: '09012345678', message: 'a' });

      const r = await runTool('send_sms', { to: '09012345678', message: 'a' });
      expect(r.errorKind).toBe('rate_limit');
    });

    it('Vonage API の失敗は upstream', async () => {
      mockSendSMS.mockResolvedValue({ success: false, error: 'service unavailable' });
      const r = await runTool('send_sms', { to: '09012345678', message: 'a' });
      expect(r.errorKind).toBe('upstream');
    });

    it('ステータス未検出は not_found', async () => {
      const r = await runTool('get_sms_status', { message_id: 'nope' });
      expect(r.errorKind).toBe('not_found');
    });

    it('想定外の例外は internal', async () => {
      mockSendSMS.mockRejectedValue(new Error('boom'));
      const r = await runTool('send_sms', { to: '09012345678', message: 'a' });
      expect(r.errorKind).toBe('internal');
    });
  });

  describe('ハンドラの例外', () => {
    it('想定外の例外もエラーレスポンスに変換される', async () => {
      mockSendSMS.mockRejectedValue(new Error('boom'));

      const payload = await invoke('send_sms', { to: '09012345678', message: 'hello' });

      expect(payload.status).toBe('error');
      expect(payload.reason).toContain('boom');
    });
  });
});
