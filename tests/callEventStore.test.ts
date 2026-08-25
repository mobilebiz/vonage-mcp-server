import { describe, it, expect, beforeEach } from 'vitest';

import {
  callEventStoreSize,
  clearCallEventStore,
  getCallEvent,
  ingestCallEvent,
} from '../src/callEventStore.js';

/**
 * タイムスタンプは必ず「いま」からの相対で作る。
 *
 * 固定日付を使うと、実時刻がその日付を追い越した瞬間に順序保護の判定が変わり、
 * 書いた直後だけ通るテストになる。messageStatusStore で3回踏んだ罠
 * （VONAGE_MCP-13 / -20）と同じもの。
 */
const at = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

describe('callEventStore', () => {
  beforeEach(() => {
    clearCallEventStore();
  });

  it('uuid と status があれば取り込める', () => {
    const result = ingestCallEvent({
      uuid: 'call-1',
      status: 'completed',
      direction: 'outbound',
      to: '819045327751',
      from: '81345438093',
      timestamp: at(0),
    });

    expect(result).not.toBeNull();
    expect(result!.ignored).toBe(false);
    expect(getCallEvent('call-1')).toMatchObject({
      callId: 'call-1',
      status: 'completed',
      direction: 'outbound',
      to: '819045327751',
    });
  });

  it('uuid か status が欠けているペイロードは取り込まない', () => {
    expect(ingestCallEvent({ status: 'completed' })).toBeNull();
    expect(ingestCallEvent({ uuid: 'call-x' })).toBeNull();
    expect(ingestCallEvent(null)).toBeNull();
    expect(ingestCallEvent('busy')).toBeNull();
    expect(callEventStoreSize()).toBe(0);
  });

  it('detail と sip_code を保持する（これが無いと busy の理由が分からない）', () => {
    ingestCallEvent({
      uuid: 'call-2',
      status: 'busy',
      detail: 'cannot_route',
      sip_code: 486,
      timestamp: at(0),
    });

    expect(getCallEvent('call-2')).toMatchObject({ status: 'busy', detail: 'cannot_route', sipCode: 486 });
  });

  it('sip_code が文字列で来ても数値として保持する', () => {
    ingestCallEvent({ uuid: 'call-3', status: 'failed', sip_code: '503', timestamp: at(0) });

    expect(getCallEvent('call-3')!.sipCode).toBe(503);
  });

  it('一度受け取った detail は、後続イベントに無くても消えない', () => {
    ingestCallEvent({ uuid: 'call-4', status: 'busy', detail: 'cannot_route', timestamp: at(0) });
    // 理由を伴わない後続イベント（同じ順位の終端ステータス）
    ingestCallEvent({ uuid: 'call-4', status: 'completed', timestamp: at(1000) });

    expect(getCallEvent('call-4')).toMatchObject({ status: 'completed', detail: 'cannot_route' });
  });

  it('古いタイムスタンプの通知は取り込まない', () => {
    ingestCallEvent({ uuid: 'call-5', status: 'completed', timestamp: at(2000) });
    const result = ingestCallEvent({ uuid: 'call-5', status: 'ringing', timestamp: at(1000) });

    expect(result!.ignored).toBe(true);
    expect(getCallEvent('call-5')!.status).toBe('completed');
  });

  it('確定した状態を前の段階へ巻き戻さない（タイムスタンプが同じ場合）', () => {
    const ts = at(0);
    ingestCallEvent({ uuid: 'call-6', status: 'completed', timestamp: ts });
    const result = ingestCallEvent({ uuid: 'call-6', status: 'started', timestamp: ts });

    expect(result!.ignored).toBe(true);
    expect(getCallEvent('call-6')!.status).toBe('completed');
  });

  it('進行方向の更新は取り込む', () => {
    ingestCallEvent({ uuid: 'call-7', status: 'ringing', timestamp: at(0) });
    ingestCallEvent({ uuid: 'call-7', status: 'answered', timestamp: at(1000) });

    expect(getCallEvent('call-7')!.status).toBe('answered');
  });

  it('未知のステータスは順序判定の対象外（常に上書きできる）', () => {
    const ts = at(0);
    ingestCallEvent({ uuid: 'call-8', status: 'completed', timestamp: ts });
    const result = ingestCallEvent({ uuid: 'call-8', status: 'something_new', timestamp: ts });

    expect(result!.ignored).toBe(false);
    expect(getCallEvent('call-8')!.status).toBe('something_new');
  });

  it('存在しない call_id は null', () => {
    expect(getCallEvent('missing')).toBeNull();
  });

  it('件数上限を超えたら古いものから捨てる', () => {
    // MAX_ENTRIES は 1000。上限を超えるまで入れて、先頭が消えることを確かめる
    for (let i = 0; i < 1001; i++) {
      ingestCallEvent({ uuid: `bulk-${i}`, status: 'completed', timestamp: at(i) });
    }

    expect(callEventStoreSize()).toBe(1000);
    expect(getCallEvent('bulk-0')).toBeNull();
    expect(getCallEvent('bulk-1000')).not.toBeNull();
  });
});
