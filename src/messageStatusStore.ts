/**
 * SMS配信ステータスのオンメモリストア
 *
 * Vonage Messages API には配信ステータスを同期的に取得するエンドポイントが存在せず、
 * 配信結果(DLR)は Status Webhook 経由で非同期に通知される。
 * そのため、送信時に "submitted" として記録し、Webhook受信時に上書きしていく。
 *
 * 注意:
 * - プロセス再起動でクリアされる（永続化しない簡易実装）。
 * - Webhookを受け取れるのは HTTP サーバー版のみ。stdio 版では "submitted" のまま更新されない。
 */

/** 保持するステータスレコード */
export interface MessageStatusRecord {
  messageId: string;
  /** submitted / delivered / failed / rejected / undeliverable など */
  status: string;
  to?: string;
  from?: string;
  channel?: string;
  /** ISO8601形式のタイムスタンプ（Webhook側の値があればそれを使う） */
  timestamp: string;
  /** 失敗時のエラー情報 */
  error?: { code?: string | number; reason?: string };
  /** ストアへの記録時刻（TTL判定用） */
  recordedAt: number;
}

/** レコードの保持期間（24時間） */
const TTL_MS = 24 * 60 * 60 * 1000;

/** 保持する最大件数（超えた場合は古いものから破棄） */
const MAX_ENTRIES = 1000;

/**
 * ステータスの進行順。小さいほど早い段階を表す。
 * Webhookの再送や順序逆転で、確定した状態が未確定へ巻き戻るのを防ぐために使う。
 * 未知のステータスは -1 とし、順序判定の対象外にする（常に上書きを許可）。
 */
const STATUS_RANK: Record<string, number> = {
  submitted: 0,
  accepted: 1,
  buffered: 1,
  delivered: 2,
  read: 3,
  // 終端状態（失敗系）
  rejected: 3,
  undeliverable: 3,
  failed: 3,
};

function rankOf(status: string): number {
  return STATUS_RANK[status.toLowerCase()] ?? -1;
}

/** ISO8601文字列をミリ秒に変換する。解釈できない場合は null。 */
function parseTimestamp(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

const store = new Map<string, MessageStatusRecord>();

/**
 * このサーバーの送信履歴に無い message_id を隔離するバッファ。
 *
 * 送信レスポンスより先に Webhook が届く競合があるため、未知のIDを即座に捨てると
 * ステータスを取りこぼす。かといって本ストアに入れると、**同じ Vonage Application
 * を別システムと共用しているだけで**そちらの DLR が流れ込み、1000件の上限から
 * こちらの正規レコードを追い出してしまう（VONAGE_MCP-20）。
 *
 * そこで、対応する recordSubmitted() が来るまでは別の小さな入れ物に置いておく。
 * 本ストアより上限を小さく、保持期間を短くしてあるのは、ここが「素性の分からない
 * データの置き場」であり、溜め込む価値がないため。
 */
const pending = new Map<string, MessageStatusRecord>();

/** 隔離バッファの保持期間（5分）。送信レスポンスとの競合を吸収できれば十分 */
const PENDING_TTL_MS = 5 * 60 * 1000;

/** 隔離バッファの最大件数 */
const PENDING_MAX_ENTRIES = 200;

/** TTL切れのレコードを取り除く */
function pruneExpired(now: number): void {
  for (const [id, record] of store) {
    if (now - record.recordedAt >= TTL_MS) {
      store.delete(id);
    }
  }
}

/** 件数上限を超えていたら古いものから破棄する */
function enforceCapacity(): void {
  while (store.size > MAX_ENTRIES) {
    // Map は挿入順を保持するため、先頭が最も古い
    const oldestKey = store.keys().next().value;
    if (oldestKey === undefined) {
      break;
    }
    store.delete(oldestKey);
  }
}

/**
 * ステータスを記録する。同じ message_id が既にある場合は上書きする。
 */
export function recordMessageStatus(
  record: Omit<MessageStatusRecord, 'recordedAt'> & { recordedAt?: number }
): void {
  if (!record.messageId) {
    return;
  }

  const now = Date.now();
  pruneExpired(now);

  // 上書き時も挿入順を最新にするため、いったん削除してから追加する
  store.delete(record.messageId);
  store.set(record.messageId, { ...record, recordedAt: record.recordedAt ?? now });

  enforceCapacity();
}

/** 隔離バッファの掃除（TTL と件数上限） */
function prunePending(now: number): void {
  for (const [id, record] of pending) {
    if (now - record.recordedAt >= PENDING_TTL_MS) {
      pending.delete(id);
    }
  }

  while (pending.size > PENDING_MAX_ENTRIES) {
    const oldestKey = pending.keys().next().value;
    if (oldestKey === undefined) {
      break;
    }
    pending.delete(oldestKey);
  }
}

/**
 * 送信直後の初期ステータス（submitted）を記録する。
 *
 * 送信レスポンスより先に Webhook が届いていた場合は、隔離バッファから
 * 取り込む。これをしないと「Webhook が先に来た」というだけで配信結果を失う。
 */
export function recordSubmitted(messageId: string, to: string, from?: string): void {
  recordMessageStatus({
    messageId,
    status: 'submitted',
    to,
    from,
    channel: 'sms',
    timestamp: new Date().toISOString(),
  });

  const buffered = pending.get(messageId);
  if (!buffered) {
    return;
  }

  pending.delete(messageId);

  // ここで shouldIgnoreUpdate を通してはいけない。直前に打った submitted の
  // timestamp は「いま」であり、先に届いていた DLR の timestamp より必ず新しい。
  // 順序保護に掛けると、拾うために取っておいた通知を自分で捨てることになる。
  // 隔離バッファにあるのはこのメッセージに対する本物の DLR なので、
  // 合成した submitted より常に優先してよい。
  const { recordedAt: _recordedAt, ...update } = buffered;
  recordMessageStatus({ ...update, to: update.to ?? to, from: update.from ?? from });
}

/** Webhook取り込みの結果 */
export interface IngestResult {
  /** 取り込みに成功した場合の現在のレコード */
  record: MessageStatusRecord;
  /** 順序が古いため無視した場合 true（レコードは既存のまま） */
  ignored: boolean;
  /**
   * このサーバーの送信履歴に無いため、隔離バッファに置いた場合 true。
   * get_sms_status からはまだ見えない。
   */
  pending: boolean;
}

/**
 * Vonage Messages API の Status Webhook ペイロードを取り込む。
 *
 * Webhookは再送・順序逆転があり得るため、以下の場合は取り込まずに既存レコードを維持する。
 * - 受信したtimestampが記録済みのものより古い
 * - 確定済みの状態（delivered / failed 等）を、より前の段階（submitted 等）で上書きしようとしている
 *
 * @returns 取り込めた場合は結果、ペイロードが不正な場合は null
 * @see https://developer.vonage.com/en/api/messages-olympus#message-status
 */
export function ingestStatusWebhook(payload: any): IngestResult | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const messageId: unknown = payload.message_uuid ?? payload.messageUuid ?? payload.message_id;
  const status: unknown = payload.status;

  if (typeof messageId !== 'string' || messageId === '' || typeof status !== 'string' || status === '') {
    return null;
  }

  const error =
    payload.error && typeof payload.error === 'object'
      ? { code: payload.error.code, reason: payload.error.reason ?? payload.error.detail }
      : undefined;

  const timestamp = typeof payload.timestamp === 'string' ? payload.timestamp : new Date().toISOString();

  // このサーバーが送信したものか。そうでなければ隔離バッファ側で扱う。
  const isKnown = store.has(messageId);
  const existing = isKnown ? store.get(messageId) : pending.get(messageId);

  if (existing && shouldIgnoreUpdate(existing, status, timestamp)) {
    return { record: existing, ignored: true, pending: !isKnown };
  }

  const record: Omit<MessageStatusRecord, 'recordedAt'> = {
    messageId,
    status,
    to: typeof payload.to === 'string' ? payload.to : existing?.to,
    from: typeof payload.from === 'string' ? payload.from : existing?.from,
    channel: typeof payload.channel === 'string' ? payload.channel : existing?.channel,
    timestamp,
    error,
  };

  if (isKnown) {
    recordMessageStatus(record);
    return { record: store.get(messageId)!, ignored: false, pending: false };
  }

  const now = Date.now();
  prunePending(now);

  // 上書き時も挿入順を最新にするため、いったん削除してから追加する
  pending.delete(messageId);
  pending.set(messageId, { ...record, recordedAt: now });
  prunePending(now);

  return { record: pending.get(messageId)!, ignored: false, pending: true };
}

/** 既存レコードに対して、届いた更新が「古い」ものかどうかを判定する */
function shouldIgnoreUpdate(
  existing: MessageStatusRecord,
  incomingStatus: string,
  incomingTimestamp: string
): boolean {
  const incomingMs = parseTimestamp(incomingTimestamp);
  const existingMs = parseTimestamp(existing.timestamp);

  // タイムスタンプで明確に古いと分かる場合は無視する
  if (incomingMs !== null && existingMs !== null && incomingMs < existingMs) {
    return true;
  }

  // タイムスタンプが同一・不明な場合は、状態の進行順で判定する
  const incomingRank = rankOf(incomingStatus);
  const existingRank = rankOf(existing.status);

  if (incomingRank < 0 || existingRank < 0) {
    return false; // 未知のステータスは順序判定しない
  }

  return incomingRank < existingRank;
}

/**
 * message_id からステータスを取得する。見つからない場合は null。
 */
export function getMessageStatus(messageId: string): MessageStatusRecord | null {
  pruneExpired(Date.now());
  return store.get(messageId) ?? null;
}

/** テスト用: ストアと隔離バッファを空にする */
export function clearMessageStatusStore(): void {
  store.clear();
  pending.clear();
}

/** テスト用: 現在の保持件数 */
export function messageStatusStoreSize(): number {
  return store.size;
}

/** テスト用: 隔離バッファの保持件数 */
export function pendingStatusStoreSize(): number {
  return pending.size;
}
