import { describe, it, expect, beforeEach } from 'vitest';
import {
  clearMessageStatusStore,
  getMessageStatus,
  ingestStatusWebhook,
  messageStatusStoreSize,
  pendingStatusStoreSize,
  recordMessageStatus,
  recordSubmitted,
} from '../src/messageStatusStore.js';

describe('messageStatusStore', () => {
  beforeEach(() => {
    clearMessageStatusStore();
  });

  it('送信直後は submitted として記録される', () => {
    recordSubmitted('msg-1', '+819012345678', 'VonageMCP');

    const record = getMessageStatus('msg-1');
    expect(record).not.toBeNull();
    expect(record!.status).toBe('submitted');
    expect(record!.to).toBe('+819012345678');
    expect(record!.from).toBe('VonageMCP');
  });

  it('未登録の message_id は null を返す', () => {
    expect(getMessageStatus('unknown')).toBeNull();
  });

  it('Status Webhook を取り込んでステータスを上書きする', () => {
    recordSubmitted('msg-1', '+819012345678');

    // recordSubmitted は現在時刻を打つため、webhook 側は必ずそれより後の時刻にする。
    // 固定日付を書くと、その日付を実時刻が追い越した時点で順序保護に弾かれて壊れる。
    const deliveredAt = new Date(Date.now() + 1000).toISOString();

    const result = ingestStatusWebhook({
      message_uuid: 'msg-1',
      to: '819012345678',
      from: 'VonageMCP',
      channel: 'sms',
      status: 'delivered',
      timestamp: deliveredAt,
    });

    expect(result).not.toBeNull();
    expect(result!.ignored).toBe(false);
    expect(getMessageStatus('msg-1')!.status).toBe('delivered');
    expect(getMessageStatus('msg-1')!.timestamp).toBe(deliveredAt);
    expect(messageStatusStoreSize()).toBe(1);
  });

  describe('イベント順序の保護', () => {
    /**
     * 順序保護は「送信履歴にあるID」に対する挙動なので、初期状態は
     * recordMessageStatus で直接作る。recordSubmitted だと timestamp が
     * 「いま」になり、固定日付を使うテストが成立しない。
     */
    function seed(messageId: string, status: string, timestamp: string): void {
      recordMessageStatus({ messageId, status, timestamp });
    }

    it('古いtimestampの通知は取り込まず、既存の状態を維持する', () => {
      seed('m', 'delivered', '2026-08-04T10:00:00.000Z');

      const result = ingestStatusWebhook({
        message_uuid: 'm',
        status: 'submitted',
        timestamp: '2026-08-04T09:00:00.000Z',
      });

      expect(result!.ignored).toBe(true);
      expect(getMessageStatus('m')!.status).toBe('delivered');
    });

    it('timestampが同一でも、確定済みの状態を前段階へ巻き戻さない', () => {
      const ts = '2026-08-04T10:00:00.000Z';
      seed('m', 'delivered', ts);

      const result = ingestStatusWebhook({ message_uuid: 'm', status: 'submitted', timestamp: ts });

      expect(result!.ignored).toBe(true);
      expect(getMessageStatus('m')!.status).toBe('delivered');
    });

    it('submitted → delivered のような正常な進行は取り込む', () => {
      recordSubmitted('m', '+819012345678');

      const result = ingestStatusWebhook({
        message_uuid: 'm',
        status: 'delivered',
        timestamp: new Date(Date.now() + 1000).toISOString(),
      });

      expect(result!.ignored).toBe(false);
      expect(getMessageStatus('m')!.status).toBe('delivered');
    });

    it('同じ通知が重複して届いても状態は変わらない', () => {
      const payload = { message_uuid: 'm', status: 'delivered', timestamp: '2026-08-04T10:00:00.000Z' };
      seed('m', 'delivered', '2026-08-04T10:00:00.000Z');
      ingestStatusWebhook(payload);
      ingestStatusWebhook(payload);

      expect(getMessageStatus('m')!.status).toBe('delivered');
      expect(messageStatusStoreSize()).toBe(1);
    });

    it('未知のステータスは順序判定せず取り込む', () => {
      seed('m', 'delivered', '2026-08-04T10:00:00.000Z');

      const result = ingestStatusWebhook({
        message_uuid: 'm',
        status: 'some_new_status',
        timestamp: '2026-08-04T10:00:00.000Z',
      });

      expect(result!.ignored).toBe(false);
      expect(getMessageStatus('m')!.status).toBe('some_new_status');
    });
  });

  describe('容量管理', () => {
    it('1001件目を入れると最も古いレコードが破棄される', () => {
      for (let i = 0; i < 1000; i++) {
        recordMessageStatus({ messageId: `bulk-${i}`, status: 'delivered', timestamp: 'x' });
      }
      expect(messageStatusStoreSize()).toBe(1000);
      expect(getMessageStatus('bulk-0')).not.toBeNull();

      recordMessageStatus({ messageId: 'newest', status: 'delivered', timestamp: 'x' });

      expect(messageStatusStoreSize()).toBe(1000);
      expect(getMessageStatus('bulk-0')).toBeNull();
      expect(getMessageStatus('newest')).not.toBeNull();
    });
  });

  describe('TTL', () => {
    it('24時間ちょうど経過したレコードは破棄され、直前のものは残る', () => {
      const now = Date.now();
      const TTL = 24 * 60 * 60 * 1000;

      recordMessageStatus({ messageId: 'expired', status: 'delivered', timestamp: 'x', recordedAt: now - TTL });
      recordMessageStatus({ messageId: 'alive', status: 'delivered', timestamp: 'x', recordedAt: now - TTL + 60_000 });

      expect(getMessageStatus('expired')).toBeNull();
      expect(getMessageStatus('alive')).not.toBeNull();
    });
  });

  it('失敗Webhookのエラー情報を保持する', () => {
    recordSubmitted('msg-2', '+819012345678');
    ingestStatusWebhook({
      message_uuid: 'msg-2',
      status: 'failed',
      error: { code: '1000', reason: 'Throttled' },
    });

    const record = getMessageStatus('msg-2');
    expect(record!.status).toBe('failed');
    expect(record!.error).toEqual({ code: '1000', reason: 'Throttled' });
  });

  describe('送信履歴に無い message_id (VONAGE_MCP-20)', () => {
    // 同じ Vonage Application を他システムと共用しているだけで、そちらの DLR が
    // 流れ込んで正規のレコードを上限から追い出してしまう
    it('本ストアには入れず、隔離バッファに置く', () => {
      const result = ingestStatusWebhook({ message_uuid: 'someone-else', status: 'delivered' });

      expect(result!.pending).toBe(true);
      expect(messageStatusStoreSize()).toBe(0);
      expect(pendingStatusStoreSize()).toBe(1);
      expect(getMessageStatus('someone-else')).toBeNull();
    });

    it('大量に届いても本ストアの正規レコードを追い出さない', () => {
      recordSubmitted('mine', '+819012345678');

      for (let i = 0; i < 2000; i++) {
        ingestStatusWebhook({ message_uuid: `other-${i}`, status: 'delivered' });
      }

      expect(getMessageStatus('mine')).not.toBeNull();
      expect(messageStatusStoreSize()).toBe(1);
      expect(pendingStatusStoreSize()).toBeLessThanOrEqual(200);
    });

    // Webhook が送信レスポンスより先に届く競合。捨てると配信結果を失う
    it('後から recordSubmitted されたら隔離バッファから取り込む', () => {
      ingestStatusWebhook({
        message_uuid: 'race',
        status: 'delivered',
        to: '819012345678',
        timestamp: new Date(Date.now() - 1000).toISOString(),
      });
      expect(getMessageStatus('race')).toBeNull();

      recordSubmitted('race', '+819012345678', 'VonageMCP');

      const record = getMessageStatus('race');
      expect(record).not.toBeNull();
      expect(record!.status).toBe('delivered');
      expect(pendingStatusStoreSize()).toBe(0);
    });

    it('取り込み時に送信元・宛先は recordSubmitted の値で補完される', () => {
      ingestStatusWebhook({ message_uuid: 'race2', status: 'delivered' });
      recordSubmitted('race2', '+819012345678', 'VonageMCP');

      const record = getMessageStatus('race2')!;
      expect(record.to).toBe('+819012345678');
      expect(record.from).toBe('VonageMCP');
    });

    it('取り込み後は通常のレコードとして順序保護が効く', () => {
      ingestStatusWebhook({
        message_uuid: 'race3',
        status: 'delivered',
        timestamp: '2026-08-04T10:00:00.000Z',
      });
      recordSubmitted('race3', '+819012345678');

      const result = ingestStatusWebhook({
        message_uuid: 'race3',
        status: 'submitted',
        timestamp: '2026-08-04T09:00:00.000Z',
      });

      expect(result!.ignored).toBe(true);
      expect(getMessageStatus('race3')!.status).toBe('delivered');
    });
  });

  it('message_uuid や status が欠けたペイロードは取り込まない', () => {
    expect(ingestStatusWebhook({ status: 'delivered' })).toBeNull();
    expect(ingestStatusWebhook({ message_uuid: 'msg-3' })).toBeNull();
    expect(ingestStatusWebhook(null)).toBeNull();
    expect(ingestStatusWebhook('not-an-object')).toBeNull();
    expect(messageStatusStoreSize()).toBe(0);
  });

  it('timestamp が無い場合は受信時刻で補完する', () => {
    recordSubmitted('msg-4', '+819012345678');
    ingestStatusWebhook({ message_uuid: 'msg-4', status: 'delivered' });
    expect(getMessageStatus('msg-4')!.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
