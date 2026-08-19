import { describe, it, expect, beforeEach } from 'vitest';
import {
  clearMessageStatusStore,
  getMessageStatus,
  ingestStatusWebhook,
  messageStatusStoreSize,
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
    it('古いtimestampの通知は取り込まず、既存の状態を維持する', () => {
      ingestStatusWebhook({ message_uuid: 'm', status: 'delivered', timestamp: '2026-08-04T10:00:00.000Z' });

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
      ingestStatusWebhook({ message_uuid: 'm', status: 'delivered', timestamp: ts });

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
      ingestStatusWebhook(payload);
      ingestStatusWebhook(payload);

      expect(getMessageStatus('m')!.status).toBe('delivered');
      expect(messageStatusStoreSize()).toBe(1);
    });

    it('未知のステータスは順序判定せず取り込む', () => {
      ingestStatusWebhook({ message_uuid: 'm', status: 'delivered', timestamp: '2026-08-04T10:00:00.000Z' });

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
        ingestStatusWebhook({ message_uuid: `bulk-${i}`, status: 'delivered' });
      }
      expect(messageStatusStoreSize()).toBe(1000);
      expect(getMessageStatus('bulk-0')).not.toBeNull();

      ingestStatusWebhook({ message_uuid: 'newest', status: 'delivered' });

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
    ingestStatusWebhook({
      message_uuid: 'msg-2',
      status: 'failed',
      error: { code: '1000', reason: 'Throttled' },
    });

    const record = getMessageStatus('msg-2');
    expect(record!.status).toBe('failed');
    expect(record!.error).toEqual({ code: '1000', reason: 'Throttled' });
  });

  it('message_uuid や status が欠けたペイロードは取り込まない', () => {
    expect(ingestStatusWebhook({ status: 'delivered' })).toBeNull();
    expect(ingestStatusWebhook({ message_uuid: 'msg-3' })).toBeNull();
    expect(ingestStatusWebhook(null)).toBeNull();
    expect(ingestStatusWebhook('not-an-object')).toBeNull();
    expect(messageStatusStoreSize()).toBe(0);
  });

  it('timestamp が無い場合は受信時刻で補完する', () => {
    ingestStatusWebhook({ message_uuid: 'msg-4', status: 'delivered' });
    expect(getMessageStatus('msg-4')!.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
