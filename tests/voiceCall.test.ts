import { describe, it, expect, beforeEach, vi } from 'vitest';

const { createOutboundCallMock } = vi.hoisted(() => ({ createOutboundCallMock: vi.fn() }));

vi.mock('@vonage/voice', () => ({
  Voice: vi.fn().mockImplementation(() => ({ createOutboundCall: createOutboundCallMock })),
}));
vi.mock('@vonage/auth', () => ({ Auth: vi.fn().mockImplementation(() => ({})) }));
vi.mock('fs', () => ({ readFileSync: vi.fn(() => 'dummy-key') }));

import {
  CALL_DURATION_MARGIN_SECONDS,
  MAX_CALL_DURATION_SECONDS,
  MIN_CALL_DURATION_SECONDS,
  callLengthTimer,
  estimateCallDuration,
  makeVoiceCall,
} from '../src/voiceCall.js';
import { VOICE_MESSAGE_MAX_LENGTH } from '../src/guardrails.js';

describe('通話時間の上限', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    process.env.VONAGE_APPLICATION_ID = 'app-id';
    process.env.VONAGE_PRIVATE_KEY_PATH = './private.key';
    process.env.VONAGE_VOICE_FROM = '+815012345678';
    createOutboundCallMock.mockResolvedValue({ uuid: 'call-1' });
  });

  describe('estimateCallDuration', () => {
    it('下限と上限で頭打ちになる', () => {
      expect(estimateCallDuration('あ')).toBe(MIN_CALL_DURATION_SECONDS);
      expect(estimateCallDuration('あ'.repeat(10_000))).toBe(MAX_CALL_DURATION_SECONDS);
    });

    it('文字数に比例する', () => {
      // 300文字/分 = 5文字/秒
      expect(estimateCallDuration('あ'.repeat(300))).toBe(60);
    });
  });

  describe('callLengthTimer', () => {
    it('見積もりに余裕を足した値になる', () => {
      const message = 'あ'.repeat(300);
      expect(callLengthTimer(message)).toBe(estimateCallDuration(message) + CALL_DURATION_MARGIN_SECONDS);
    });

    // 見積もりちょうどで切ると、読み上げ速度のぶれで正常な通話が途中で切れる
    it('必ず見積もりより大きい', () => {
      for (const length of [1, 50, 300, 1000]) {
        const message = 'あ'.repeat(length);
        expect(callLengthTimer(message)).toBeGreaterThan(estimateCallDuration(message));
      }
    });

    it('どんなに長くても絶対上限を超えない', () => {
      expect(callLengthTimer('あ'.repeat(100_000))).toBe(MAX_CALL_DURATION_SECONDS);
    });
  });

  describe('Vonage へ渡す length_timer', () => {
    /** 直近の createOutboundCall に渡されたリクエストを取り出す */
    function lastRequest(): any {
      return createOutboundCallMock.mock.calls.at(-1)![0];
    }

    // 以前は固定で 7200 秒(2時間)を送っていた。dry_run が「約300秒」と
    // 表示して承認を得ても、実際には最大2時間まで課金され得た。
    it('見積もりに連動し、7200 のような固定値ではない', async () => {
      const message = 'テストです';

      await makeVoiceCall({ to: '09012345678', message });

      expect(lastRequest().length_timer).toBe(callLengthTimer(message));
      expect(lastRequest().length_timer).toBeLessThanOrEqual(MAX_CALL_DURATION_SECONDS);
    });

    // makeVoiceCall を直接呼べばスキーマの maxLength を超える本文も渡せる
    it('本文が長くても絶対上限を超える値は送らない', async () => {
      await makeVoiceCall({ to: '09012345678', message: 'あ'.repeat(5000) });

      expect(lastRequest().length_timer).toBe(MAX_CALL_DURATION_SECONDS);
    });

    // ツール経由の最長本文でも上限に余裕があることを確かめておく。
    // ここが上限に張り付くようなら、見積もりか本文長のどちらかを見直す合図。
    it('ツールが許す最長の本文でも絶対上限に達しない', async () => {
      await makeVoiceCall({ to: '09012345678', message: 'あ'.repeat(VOICE_MESSAGE_MAX_LENGTH) });

      expect(lastRequest().length_timer).toBeLessThan(MAX_CALL_DURATION_SECONDS);
    });

    it('本文が短ければ短い上限が送られる', async () => {
      await makeVoiceCall({ to: '09012345678', message: 'あ' });

      expect(lastRequest().length_timer).toBe(
        MIN_CALL_DURATION_SECONDS + CALL_DURATION_MARGIN_SECONDS
      );
    });
  });
});
