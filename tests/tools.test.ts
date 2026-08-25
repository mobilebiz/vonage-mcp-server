import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { mockSendSMS, mockSendBulkSMS, mockMakeVoiceCall, mockGetCallStatus } = vi.hoisted(() => ({
  mockSendSMS: vi.fn(),
  mockSendBulkSMS: vi.fn(),
  mockMakeVoiceCall: vi.fn(),
  mockGetCallStatus: vi.fn(),
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

import { enabledToolDefinitions, listTools, runTool, toolDefinitions } from '../src/tools.js';
import { CAPABILITY_ENV_VARS } from '../src/config.js';
import { toolRateLimiter } from '../src/guardrails.js';
import {
  clearMessageStatusStore,
  getMessageStatus,
  ingestStatusWebhook,
  recordSubmitted,
} from '../src/messageStatusStore.js';
import { clearCallEventStore, ingestCallEvent } from '../src/callEventStore.js';

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
    delete process.env.SMS_RATE_LIMIT_PER_HOUR;
    delete process.env.SMS_SEGMENT_LIMIT_PER_HOUR;
    delete process.env.SMS_MAX_SEGMENTS;
    delete process.env.VOICE_RATE_LIMIT_PER_HOUR;
    delete process.env.ALLOWED_COUNTRY_CODES;
    delete process.env.ALLOW_PREMIUM_NUMBERS;
    delete process.env.BULK_MAX_ROWS;
    delete process.env.RATE_LIMIT_PER_HOUR;
    // RATE_LIMIT_PER_HOUR=0 は「全拒否」の意味なので、無効化には使えない
    process.env.DISABLE_RATE_LIMIT = 'true';
    // capability は既定で全 OFF。ツールの挙動を検証するテストでは明示的に有効化する
    process.env.ENABLE_SMS = 'true';
    process.env.ENABLE_BULK_SMS = 'true';
    process.env.ENABLE_VOICE = 'true';

  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('スキーマ', () => {
    it('全ツールがJSON Schemaを生成できる', () => {
      const tools = listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([
        'bulk_sms_from_csv',
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

    it('send_sms の to に電話番号パターン、message に絶対上限が設定されている', () => {
      const schema = listTools().find((t) => t.name === 'send_sms')!.inputSchema as any;
      expect(schema.properties.to.pattern).toBeDefined();
      // 実際の制限はセグメント数で掛ける。ここは日本の連結上限という外枠
      expect(schema.properties.message.maxLength).toBe(660);
      expect(schema.properties.message.description).toContain('セグメント');
      expect(schema.properties.dry_run.type).toBe('boolean');
      expect(schema.required).toEqual(expect.arrayContaining(['to', 'message']));
      expect(schema.required).not.toContain('dry_run');
    });

    it('make_voice_call の message にはSMSの制限を課さない', () => {
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

  // 注釈は Gemini Enterprise などの確認UIを直接左右する。readOnlyHint を
  // 課金対象のツールに付けると、実行前の確認が黙って省かれる（VONAGE_MCP-4）。
  describe('ツール注釈', () => {
    it('課金対象のツールは破壊的として宣言され、確認を省く注釈を持たない', () => {
      for (const name of ['send_sms', 'bulk_sms_from_csv', 'make_voice_call']) {
        const annotations = toolDefinitions.find((t) => t.name === name)!.annotations;
        expect(annotations.readOnlyHint).toBe(false);
        expect(annotations.destructiveHint).toBe(true);
        // 同じ引数で2回呼べば2通送られ、2回課金される
        expect(annotations.idempotentHint).toBe(false);
        expect(annotations.openWorldHint).toBe(true);
      }
    });

    it('参照系のツールは読み取り専用として宣言される', () => {
      for (const name of ['get_sms_status', 'get_call_status']) {
        const annotations = toolDefinitions.find((t) => t.name === name)!.annotations;
        expect(annotations.readOnlyHint).toBe(true);
      }
    });

    it('全ツールが注釈を持つ（付け忘れると確認UIが基盤の既定任せになる）', () => {
      for (const tool of toolDefinitions) {
        expect(tool.annotations, tool.name).toBeDefined();
        expect(typeof tool.annotations.readOnlyHint, tool.name).toBe('boolean');
      }
    });
  });

  describe('引数バリデーション', () => {
    it('未知のツールは自己修復可能なエラーを返す', async () => {
      const payload = await invoke('no_such_tool', {});
      expect(payload.status).toBe('error');
      expect(payload.suggestion).toContain('send_sms');
    });

    // 日本語は UCS-2 なので 1セグメント70文字(連結時67文字)。250文字で4セグメント
    it('セグメント上限を超える本文は拒否される', async () => {
      const payload = await invoke('send_sms', { to: '09012345678', message: 'あ'.repeat(250) });

      expect(payload.status).toBe('error');
      expect(payload.reason).toContain('セグメント');
      expect(payload.segments).toBe(4);
      expect(payload.max_segments).toBe(3);
      expect(payload.encoding).toBe('UCS-2');
      expect(payload.suggestion).toContain('SMS_MAX_SEGMENTS');
      expect(mockSendSMS).not.toHaveBeenCalled();
    });

    // 従来の 160 文字上限では、英数字だけの本文でも1セグメントしか使わないのに弾かれていた
    it('英数字だけなら160文字を超えても送れる', async () => {
      mockSendSMS.mockResolvedValue({ success: true, messageId: 'm' });

      const payload = await invoke('send_sms', { to: '09012345678', message: 'a'.repeat(400) });

      expect(payload.status).toBe('success');
    });

    it('パターンに合わない電話番号は拒否される', async () => {
      const payload = await invoke('send_sms', { to: 'abc', message: 'hello' });
      expect(payload.status).toBe('error');
      expect(mockSendSMS).not.toHaveBeenCalled();
    });
  });

  describe('send_sms', () => {
    it('成功時は軽量なペイロードを返す', async () => {
      mockSendSMS.mockResolvedValue({ success: true, messageId: 'msg-123' });

      const payload = await invoke('send_sms', { to: '09012345678', message: 'hello' });

      expect(payload).toEqual({
        status: 'success',
        message_id: 'msg-123',
        to: '+819012345678',
        segments: 1,
      });
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
        encoding: 'GSM-7',
        segments: 1,
      });
      expect(mockSendSMS).not.toHaveBeenCalled();
    });

    // 日本のネットワークは URL を含む SMS を配信しないことがある。
    // API は成功を返すので、エージェントは失敗を検知できない。
    describe('URL を含む本文の配信不確実性', () => {
      it('日本宛では dry_run と成功レスポンスに注意書きが付く', async () => {
        mockSendSMS.mockResolvedValue({ success: true, messageId: 'm' });

        const preview = await invoke('send_sms', {
          to: '09012345678',
          message: '詳細は https://example.com をご覧ください',
          dry_run: true,
        });
        expect(preview.delivery_warning).toContain('配信されないことがあります');

        const sent = await invoke('send_sms', {
          to: '09012345678',
          message: '詳細は https://example.com をご覧ください',
        });
        expect(sent.status).toBe('success');
        expect(sent.delivery_warning).toContain('get_sms_status');
      });

      it('URL が無ければ注意書きは付かない', async () => {
        mockSendSMS.mockResolvedValue({ success: true, messageId: 'm' });

        const payload = await invoke('send_sms', { to: '09012345678', message: 'お知らせです' });

        expect(payload.delivery_warning).toBeUndefined();
      });

      // 制限は日本のネットワーク固有のもの
      it('日本以外の宛先には付かない', async () => {
        process.env.ALLOWED_COUNTRY_CODES = '81,1';
        mockSendSMS.mockResolvedValue({ success: true, messageId: 'm' });

        const payload = await invoke('send_sms', {
          to: '+12125551234',
          message: 'See https://example.com',
        });

        expect(payload.delivery_warning).toBeUndefined();
      });

      // ブロックはしない。正当な用途があり、拒否基準も非公開のため
      it('URL があっても送信自体は止めない', async () => {
        mockSendSMS.mockResolvedValue({ success: true, messageId: 'm' });

        const payload = await invoke('send_sms', {
          to: '09012345678',
          message: 'https://example.com',
        });

        expect(payload.status).toBe('success');
        expect(mockSendSMS).toHaveBeenCalled();
      });
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
        from: 'Vonage MCP',
        dry_run: true,
      });

      expect(payload.status).toBe('error');
      expect(payload.reason).toContain('無効な送信元');
      expect(mockSendSMS).not.toHaveBeenCalled();
    });

    it('日本宛の数値送信元は dry_run の時点で拒否される', async () => {
      const payload = await invoke('send_sms', {
        to: '09012345678',
        message: 'hello',
        from: '+819087654321',
        dry_run: true,
      });

      expect(payload.status).toBe('error');
      expect(payload.reason).toContain('上書き');
      expect(mockSendSMS).not.toHaveBeenCalled();
    });

    it('日本で禁止されている Generic Sender ID は拒否される', async () => {
      const payload = await invoke('send_sms', {
        to: '09012345678',
        message: 'hello',
        from: 'INFO',
        dry_run: true,
      });

      expect(payload.status).toBe('error');
      expect(payload.reason).toContain('Generic Sender ID');
    });

    it('有効な英数字の送信元は許可される', async () => {
      mockSendSMS.mockResolvedValue({ success: true, messageId: 'msg-123' });

      for (const from of ['VonageMCP', '2FA', 'AB']) {
        const payload = await invoke('send_sms', { to: '09012345678', message: 'a', from, dry_run: true });
        expect(payload.status, `${from} は許可されるべき`).toBe('dry_run_success');
      }
    });

    it('海外宛なら発信元電話番号を送信元にできる', async () => {
      process.env.ALLOWED_COUNTRY_CODES = '81,1';

      const payload = await invoke('send_sms', {
        to: '+12125551234',
        message: 'a',
        from: '+819087654321',
        dry_run: true,
      });

      expect(payload.status).toBe('dry_run_success');
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
      delete process.env.DISABLE_RATE_LIMIT;
      process.env.RATE_LIMIT_PER_HOUR = '2';
    });

    it('RATE_LIMIT_PER_HOUR=0 は無制限ではなく全拒否（VONAGE_MCP-18）', async () => {
      process.env.RATE_LIMIT_PER_HOUR = '0';
      mockSendSMS.mockResolvedValue({ success: true, messageId: 'm' });

      const payload = await invoke('send_sms', { to: '09012345678', message: 'a' });

      expect(payload.status).toBe('error');
      expect(payload.reason).toContain('停止されています');
      expect(mockSendSMS).not.toHaveBeenCalled();
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

    // RATE_LIMIT_PER_HOUR は「合計何件まで」を意味する。SMS と架電で別枠にすると
    // 管理者が設定した上限の2倍が送れてしまう（VONAGE_MCP-17）。
    it('SMSと架電は共通の global バケットを消費する', async () => {
      mockSendSMS.mockResolvedValue({ success: true, messageId: 'msg-123' });
      mockMakeVoiceCall.mockResolvedValue({ success: true, callId: 'call-1' });

      await invoke('send_sms', { to: '09012345678', message: 'a' });
      await invoke('make_voice_call', { to: '09012345678', message: 'a' });

      const third = await invoke('send_sms', { to: '09012345678', message: 'a' });
      expect(third.status).toBe('error');
      expect(third.exceeded_bucket).toBe('global');
    });

    // これが元のバグ。単発で使い切ったあと1行CSVを繰り返せば上限を素通りできた
    it('単発SMSと bulk は同じ枠を消費し、合計が上限を超えない', async () => {
      mockSendSMS.mockResolvedValue({ success: true, messageId: 'msg-123' });
      mockSendBulkSMS.mockResolvedValue({
        totalRequests: 1,
        successCount: 1,
        failureCount: 0,
        results: [{ to: '+819012345678', success: true, messageId: 'm1' }],
      });

      await invoke('send_sms', { to: '09012345678', message: 'a' });
      await invoke('send_sms', { to: '09012345678', message: 'a' });

      const bulk = await invoke('bulk_sms_from_csv', {
        csv_content: 'phone,from,message\n09012345678,VonageMCP,hi\n',
      });

      expect(bulk.status).toBe('error');
      expect(mockSendBulkSMS).not.toHaveBeenCalled();
    });

    // 課金はセグメント単位。RATE_LIMIT_PER_HOUR=5 のつもりでも、
    // 日本語の長文なら実際の課金は5通分では済まない
    describe('セグメント数の上限', () => {
      it('SMS_SEGMENT_LIMIT_PER_HOUR はセグメント数で消費される', async () => {
        process.env.RATE_LIMIT_PER_HOUR = '10';
        process.env.SMS_SEGMENT_LIMIT_PER_HOUR = '5';
        mockSendSMS.mockResolvedValue({ success: true, messageId: 'm' });

        // 3セグメントの本文を1通 → 残り2セグメント
        const first = await invoke('send_sms', { to: '09012345678', message: 'あ'.repeat(160) });
        expect(first.status).toBe('success');

        // もう1通送ると3セグメント必要で、残り2では足りない
        const second = await invoke('send_sms', { to: '09012345678', message: 'あ'.repeat(160) });
        expect(second.status).toBe('error');
        expect(second.exceeded_bucket).toBe('segments');
        expect(second.reason).toContain('SMS_SEGMENT_LIMIT_PER_HOUR');

        // 1セグメントに収まる本文なら通る
        const third = await invoke('send_sms', { to: '09012345678', message: 'hi' });
        expect(third.status).toBe('success');
      });

      it('未設定ならセグメント数では制限しない', async () => {
        process.env.RATE_LIMIT_PER_HOUR = '10';
        mockSendSMS.mockResolvedValue({ success: true, messageId: 'm' });

        for (let i = 0; i < 5; i++) {
          const payload = await invoke('send_sms', { to: '09012345678', message: 'あ'.repeat(160) });
          expect(payload.status).toBe('success');
        }
      });

      it('架電はセグメントのバケットを消費しない', async () => {
        process.env.RATE_LIMIT_PER_HOUR = '10';
        process.env.SMS_SEGMENT_LIMIT_PER_HOUR = '0';
        mockMakeVoiceCall.mockResolvedValue({ success: true, callId: 'c' });

        const payload = await invoke('make_voice_call', { to: '09012345678', message: 'テスト' });

        expect(payload.status).toBe('success');
      });

      it('bulk はセグメント数の合計を消費する', async () => {
        process.env.RATE_LIMIT_PER_HOUR = '10';
        process.env.SMS_SEGMENT_LIMIT_PER_HOUR = '4';

        // 3セグメント + 1セグメント = 4セグメント。ちょうど収まる
        const csv =
          `phone,from,message\n09012345678,VonageMCP,${'あ'.repeat(160)}\n09087654321,VonageMCP,hi\n`;

        const preview = await invoke('bulk_sms_from_csv', { csv_content: csv, dry_run: true });
        expect(preview.estimated_segments).toBe(4);

        mockSendBulkSMS.mockResolvedValue({
          totalRequests: 2,
          successCount: 2,
          failureCount: 0,
          results: [
            { to: '+819012345678', success: true, messageId: 'm1' },
            { to: '+819087654321', success: true, messageId: 'm2' },
          ],
        });

        expect((await invoke('bulk_sms_from_csv', { csv_content: csv })).status).toBe('success');

        // 枠を使い切ったので次は通らない
        const blocked = await invoke('bulk_sms_from_csv', { csv_content: csv });
        expect(blocked.status).toBe('error');
        expect(blocked.exceeded_bucket).toBe('segments');
      });
    });

    describe('チャネル別の上限', () => {
      it('SMS_RATE_LIMIT_PER_HOUR は global より先に効く', async () => {
        process.env.RATE_LIMIT_PER_HOUR = '10';
        process.env.SMS_RATE_LIMIT_PER_HOUR = '1';
        mockSendSMS.mockResolvedValue({ success: true, messageId: 'm' });
        mockMakeVoiceCall.mockResolvedValue({ success: true, callId: 'c' });

        expect((await invoke('send_sms', { to: '09012345678', message: 'a' })).status).toBe('success');

        const blocked = await invoke('send_sms', { to: '09012345678', message: 'a' });
        expect(blocked.status).toBe('error');
        expect(blocked.exceeded_bucket).toBe('sms');
        expect(blocked.reason).toContain('SMS_RATE_LIMIT_PER_HOUR');

        // SMS が尽きても架電は global の残枠で通る
        expect((await invoke('make_voice_call', { to: '09012345678', message: 'a' })).status).toBe(
          'success'
        );
      });

      // 一部のバケットだけ消費して失敗すると、送っていない分の枠が減る
      it('チャネル側で拒否された場合、global の枠は消費されない', async () => {
        process.env.RATE_LIMIT_PER_HOUR = '10';
        process.env.SMS_RATE_LIMIT_PER_HOUR = '0';
        mockMakeVoiceCall.mockResolvedValue({ success: true, callId: 'c' });

        for (let i = 0; i < 5; i++) {
          const blocked = await invoke('send_sms', { to: '09012345678', message: 'a' });
          expect(blocked.status).toBe('error');
        }

        // global を5件消費していたなら、この10件目までの架電が通らなくなる
        for (let i = 0; i < 10; i++) {
          expect((await invoke('make_voice_call', { to: '09012345678', message: 'a' })).status).toBe(
            'success'
          );
        }
      });
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

    // CSV 経路だけ + 無しの国際番号を受理していた不整合 (Codex L-1)。
    // 2125551234 に + を補うと +212 = モロッコ宛になる
    it('+ も先頭 0 も無い番号の行は無効として扱う', async () => {
      const payload = await invoke('bulk_sms_from_csv', {
        csv_content: 'phone,from,message\n2125551234,VonageMCP,hi\n',
        dry_run: true,
      });

      expect(payload.status).toBe('error');
      expect(payload.invalid_rows).toBe(1);
      expect(mockSendBulkSMS).not.toHaveBeenCalled();
    });

    it('セグメント上限を超える行は送信されない（単発と同じ制限を適用）', async () => {
      const long = 'あ'.repeat(250);
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
      // 第2引数は「1件送るたびに recordSubmitted する」コールバック
      expect(mockSendBulkSMS).toHaveBeenCalledWith(
        [{ to: '+819087654321', message: 'ok', from: 'VonageMCP' }],
        expect.any(Function)
      );
    });

    it('全行がセグメント上限超ならAPIを呼ばずエラーを返す', async () => {
      const long = 'あ'.repeat(250);
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

    it('BULK_MAX_ROWS=0 は無制限ではなく全拒否（VONAGE_MCP-18）', async () => {
      process.env.BULK_MAX_ROWS = '0';

      const payload = await invoke('bulk_sms_from_csv', {
        csv_content: 'phone,from,message\n09012345678,VonageMCP,hi\n',
      });

      expect(payload.status).toBe('error');
      expect(payload.reason).toContain('停止されています');
      expect(payload.max_rows).toBe(0);
      expect(mockSendBulkSMS).not.toHaveBeenCalled();
    });

    it('送信件数の分だけレート枠を消費する', async () => {
      delete process.env.DISABLE_RATE_LIMIT;
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
      delete process.env.DISABLE_RATE_LIMIT;
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
      expect(mockSendBulkSMS).toHaveBeenCalledWith(
        [{ to: '+819012345678', message: 'hello', from: 'VonageMCP' }],
        expect.any(Function)
      );
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
    it('call_id で取得できる', async () => {
      mockGetCallStatus.mockResolvedValue({
        success: true,
        status: 'completed',
        price: '0.05',
        rate: '0.05',
        duration: 12,
        startTime: '2026-08-04T10:00:00.000Z',
      });

      const payload = await invoke('get_call_status', { call_id: 'call-1' });

      expect(payload).toMatchObject({ status: 'success', call_id: 'call-1', call_status: 'completed' });
    });

    // 以前は callId / call_id の両方が optional で required が空になり、
    // AI が {} を送れてしまっていた (Codex L-2)
    it('call_id はスキーマ上も必須になっている', () => {
      const schema = listTools().find((t) => t.name === 'get_call_status')!.inputSchema as any;

      expect(schema.required).toEqual(['call_id']);
      expect(schema.properties.callId).toBeUndefined();
    });

    it('IDが無い場合はエラーを返す', async () => {
      const payload = await invoke('get_call_status', {});
      expect(payload.status).toBe('error');
      expect(mockGetCallStatus).not.toHaveBeenCalled();
    });

    // Voice API の GET /calls は detail を返さない。理由は Event Webhook にしか来ない。
    describe('Event Webhook で受け取った理由の反映', () => {
      beforeEach(() => {
        clearCallEventStore();
        mockGetCallStatus.mockResolvedValue({
          success: true,
          status: 'busy',
          price: '0',
          rate: '0',
          duration: 0,
          startTime: new Date().toISOString(),
        });
      });

      it('detail と sip_code を重ねて返す', async () => {
        ingestCallEvent({
          uuid: 'call-detail',
          status: 'busy',
          detail: 'cannot_route',
          sip_code: 486,
          timestamp: new Date().toISOString(),
        });

        const payload = await invoke('get_call_status', { call_id: 'call-detail' });

        expect(payload).toMatchObject({ status: 'success', detail: 'cannot_route', sip_code: 486 });
      });

      // detail は status ごとに意味が違う。まとめて「経路が無い」と扱うと、
      // 再試行すれば繋がる相手に「もう掛けるな」と言うことになる
      it('cannot_route は「相手の状態ではない」と断定する', async () => {
        ingestCallEvent({
          uuid: 'call-unroutable',
          status: 'failed',
          detail: 'cannot_route',
          timestamp: new Date().toISOString(),
        });

        const payload = await invoke('get_call_status', { call_id: 'call-unroutable' });

        expect(payload.note).toContain('相手の状態ではなく');
        expect(payload.note).toContain('cannot_route');
      });

      it('unavailable は一時的な状態として扱い、経路の問題とは言わない', async () => {
        ingestCallEvent({
          uuid: 'call-unavailable',
          status: 'unanswered',
          detail: 'unavailable',
          timestamp: new Date().toISOString(),
        });

        const payload = await invoke('get_call_status', { call_id: 'call-unavailable' });

        expect(payload.note).toContain('一時的');
        expect(payload.note).not.toContain('相手の状態ではなく');
        expect(payload.note).not.toContain('繰り返さないでください');
      });

      it('restricted は拒否として扱い、経路の問題とは言わない', async () => {
        ingestCallEvent({
          uuid: 'call-restricted',
          status: 'rejected',
          detail: 'restricted',
          timestamp: new Date().toISOString(),
        });

        const payload = await invoke('get_call_status', { call_id: 'call-restricted' });

        expect(payload.note).toContain('拒否');
        expect(payload.note).not.toContain('相手の状態ではなく');
      });

      it('分類表に無い detail は断定しない', async () => {
        ingestCallEvent({
          uuid: 'call-unknown-detail',
          status: 'failed',
          detail: 'brand_new_reason',
          timestamp: new Date().toISOString(),
        });

        const payload = await invoke('get_call_status', { call_id: 'call-unknown-detail' });

        expect(payload.note).toContain('brand_new_reason');
        expect(payload.note).not.toContain('相手の状態ではなく');
      });

      // API が終端ステータスを返したあとに Webhook が届くことがある。
      // 「未設定」と決めつけると、数秒待てば取れた理由を永久に取り逃す
      it('理由が無い場合は、未設定と決めつけず一度だけの再確認を案内する', async () => {
        const payload = await invoke('get_call_status', { call_id: 'call-no-event' });

        expect(payload.note).toContain('Event Webhook が未設定');
        expect(payload.note).toContain('一度だけ');
        expect(payload.detail).toBeUndefined();
      });

      it('成功した通話には注記を付けない', async () => {
        mockGetCallStatus.mockResolvedValue({
          success: true,
          status: 'completed',
          price: '0.01',
          rate: '0.13',
          duration: 5,
          startTime: new Date().toISOString(),
        });

        const payload = await invoke('get_call_status', { call_id: 'call-ok' });

        expect(payload.note).toBeUndefined();
      });
    });
  });

  describe('get_sms_status', () => {
    it('Webhook受信済みのステータスを返す', async () => {
      // 送信履歴に無いIDは隔離バッファ行きになるので、先に送信を記録する
      recordSubmitted('msg-1', '+819012345678');
      ingestStatusWebhook({
        message_uuid: 'msg-1',
        status: 'delivered',
        to: '819012345678',
        // recordSubmitted は現在時刻を打つので、webhook 側は必ずそれより後にする。
        // 固定日付だと、その日付を実時刻が追い越した時点で順序保護に弾かれる。
        timestamp: new Date(Date.now() + 1000).toISOString(),
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


  describe('エラー種別 (errorKind)', () => {
    it('入力エラーは validation', async () => {
      const r = await runTool('send_sms', { to: 'abc', message: 'hi' });
      expect(r.errorKind).toBe('validation');
    });

    it('レートリミット超過は rate_limit', async () => {
      delete process.env.DISABLE_RATE_LIMIT;
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

  // 単発とCSVでルールがずれていると、`2FA` は CSV だけ弾かれ、日本で禁止されている
  // `INFO` は CSV だけ通る、という食い違いが起きる
  describe('送信者IDのルールが単発とCSVで一致している', () => {
    async function bulkRowErrors(from: string): Promise<string[]> {
      const payload = await invoke('bulk_sms_from_csv', {
        csv_content: `phone,from,message\n09012345678,${from},hi\n`,
        dry_run: true,
      });
      return payload.status === 'error' ? [payload.reason] : [];
    }

    it('CSV でも 2FA のような数字始まりの送信者IDが通る', async () => {
      const payload = await invoke('bulk_sms_from_csv', {
        csv_content: 'phone,from,message\n09012345678,2FA,hi\n',
        dry_run: true,
      });

      expect(payload.status).toBe('dry_run_success');
      expect(payload.sendable_rows).toBe(1);
    });

    it('CSV でも日本で禁止されている INFO は弾かれる', async () => {
      const errors = await bulkRowErrors('INFO');
      expect(errors.join()).toContain('送信可能な行がありません');
    });

    it('CSV でも日本宛の数値送信元は弾かれる', async () => {
      const errors = await bulkRowErrors('09087654321');
      expect(errors.join()).toContain('送信可能な行がありません');
    });
  });

  describe('セグメント上限の設定', () => {
    it('SMS_MAX_SEGMENTS で1通あたりの上限を変更できる', async () => {
      process.env.SMS_MAX_SEGMENTS = '1';

      const payload = await invoke('send_sms', { to: '09012345678', message: 'あ'.repeat(100) });

      expect(payload.status).toBe('error');
      expect(payload.max_segments).toBe(1);
      expect(mockSendSMS).not.toHaveBeenCalled();
    });

    it('緩めることもできる', async () => {
      process.env.SMS_MAX_SEGMENTS = '10';
      mockSendSMS.mockResolvedValue({ success: true, messageId: 'm' });

      const payload = await invoke('send_sms', { to: '09012345678', message: 'あ'.repeat(600) });

      expect(payload.status).toBe('success');
    });
  });

  describe('宛先ガードレール', () => {
    it.each(['110', '119', '118'])('緊急番号 %s は送信もAPI呼び出しもしない', async (number) => {
      const payload = await invoke('send_sms', { to: number, message: 'test' });

      expect(payload.status).toBe('error');
      expect(payload.reason).toContain('緊急通報番号');
      expect(mockSendSMS).not.toHaveBeenCalled();
    });

    it('緊急番号は make_voice_call でもブロックされる', async () => {
      const payload = await invoke('make_voice_call', { to: '110', message: 'test' });

      expect(payload.status).toBe('error');
      expect(payload.reason).toContain('緊急通報番号');
      expect(mockMakeVoiceCall).not.toHaveBeenCalled();
    });

    it('高額課金番号 0990 は既定でブロックされる', async () => {
      const payload = await invoke('send_sms', { to: '0990123456', message: 'test' });

      expect(payload.status).toBe('error');
      expect(payload.reason).toContain('高額課金');
      expect(mockSendSMS).not.toHaveBeenCalled();
    });

    it('海外宛は既定でブロックされる', async () => {
      const payload = await invoke('send_sms', { to: '+12125551234', message: 'test' });

      expect(payload.status).toBe('error');
      expect(payload.reason).toContain('国番号 +1');
      expect(mockSendSMS).not.toHaveBeenCalled();
    });

    it('ALLOWED_COUNTRY_CODES に追加すれば海外宛も送信できる', async () => {
      process.env.ALLOWED_COUNTRY_CODES = '81,1';
      mockSendSMS.mockResolvedValue({ success: true, messageId: 'm' });

      const payload = await invoke('send_sms', { to: '+12125551234', message: 'test' });

      expect(payload.status).toBe('success');
    });

    // dry_run が「送れる」と言ったのに本実行で弾かれる状況を作らない
    it('dry_run の時点でブロックされる', async () => {
      const payload = await invoke('send_sms', { to: '+12125551234', message: 'test', dry_run: true });

      expect(payload.status).toBe('error');
      expect(payload.reason).toContain('国番号');
    });

    it('bulk でもブロックされた行は送信対象から除かれる', async () => {
      mockSendBulkSMS.mockResolvedValue({
        totalRequests: 1,
        successCount: 1,
        failureCount: 0,
        results: [{ to: '+819012345678', success: true, messageId: 'm1' }],
      });

      const payload = await invoke('bulk_sms_from_csv', {
        csv_content:
          'phone,from,message\n09012345678,VonageMCP,hi\n0990123456,VonageMCP,hi\n+12125551234,VonageMCP,hi\n',
      });

      expect(payload.blocked_rows).toBe(2);
      expect(mockSendBulkSMS).toHaveBeenCalledWith(
        [{ to: '+819012345678', message: 'hi', from: 'VonageMCP' }],
        expect.any(Function)
      );
    });
  });

  describe('capability トグル', () => {
    /** 全 capability を無効にする */
    function disableAll(): void {
      for (const name of CAPABILITY_ENV_VARS) {
        delete process.env[name];
      }
    }

    // これが stdio 迂回を構造的に潰している部分。
    // 型からもオブジェクトからも handler が消えているので、
    // トランスポートは runTool() を通す以外にツールを実行できない。
    it('公開されるツール定義に handler が含まれない', () => {
      for (const tool of toolDefinitions) {
        expect(Object.keys(tool)).not.toContain('handler');
        expect((tool as any).handler).toBeUndefined();
      }
    });

    it('ツール定義は凍結されていて capability を書き換えられない', () => {
      const sendSms = toolDefinitions.find((t) => t.name === 'send_sms')!;
      expect(() => {
        (sendSms as any).capability = 'ENABLE_VOICE';
      }).toThrow();
    });

    it('全ツールに capability が割り当てられている', () => {
      for (const tool of toolDefinitions) {
        expect(CAPABILITY_ENV_VARS).toContain(tool.capability);
      }
    });

    it.each([
      ['ENABLE_SMS', ['get_sms_status', 'send_sms']],
      ['ENABLE_BULK_SMS', ['bulk_sms_from_csv']],
      ['ENABLE_VOICE', ['get_call_status', 'make_voice_call']],
    ])('%s だけを有効にすると対象ツールだけが公開される', (capability, expected) => {
      disableAll();
      process.env[capability] = 'true';

      expect(listTools().map((t) => t.name).sort()).toEqual(expected);
      expect(enabledToolDefinitions().map((t) => t.name).sort()).toEqual(expected);
    });

    it('全 OFF なら tools/list は空になる', () => {
      disableAll();
      expect(listTools()).toEqual([]);
    });

    it('ENABLE_X=false は未設定と同じく無効', () => {
      disableAll();
      for (const name of CAPABILITY_ENV_VARS) {
        process.env[name] = 'false';
      }
      expect(listTools()).toEqual([]);
    });

    it('無効なツールを直接呼ぶと自己修復可能なエラーを返し、APIを呼ばない', async () => {
      disableAll();
      mockMakeVoiceCall.mockResolvedValue({ success: true, callId: 'c' });

      const outcome = await runTool('make_voice_call', { to: '09012345678', message: 'テスト' });

      expect(outcome.isError).toBe(true);
      expect(outcome.errorKind).toBe('disabled');
      expect(outcome.payload.reason).toContain('無効化されています');
      expect(outcome.payload.suggestion).toContain('ENABLE_VOICE=true');
      expect(outcome.payload.required_capability).toBe('ENABLE_VOICE');
      expect(mockMakeVoiceCall).not.toHaveBeenCalled();
    });

    // 「引数が不正です」と返すと、エージェントが引数を直して再試行し続けてしまう
    it('引数が不正でも capability の判定を優先する', async () => {
      disableAll();

      const outcome = await runTool('send_sms', { to: 'not-a-number' });

      expect(outcome.errorKind).toBe('disabled');
      expect(outcome.payload.reason).toContain('ENABLE_SMS');
    });

    it('bulk は ENABLE_SMS では有効にならない（独立したトグル）', async () => {
      disableAll();
      process.env.ENABLE_SMS = 'true';

      const outcome = await runTool('bulk_sms_from_csv', {
        csv_content: 'phone,from,message\n09012345678,VonageMCP,hi\n',
        dry_run: true,
      });

      expect(outcome.errorKind).toBe('disabled');
      expect(outcome.payload.required_capability).toBe('ENABLE_BULK_SMS');
      expect(mockSendBulkSMS).not.toHaveBeenCalled();
    });

    it('全 OFF のときの未知ツールエラーは、有効なツールが無いことを伝える', async () => {
      disableAll();

      const outcome = await runTool('no_such_tool', {});

      expect(outcome.payload.suggestion).toContain('どのツールも有効になっていません');
    });
  });
});
