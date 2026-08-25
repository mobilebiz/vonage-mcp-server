/**
 * 通話イベントのオンメモリストア
 *
 * Vonage Voice API の `GET /v1/calls/{uuid}` は、通話が失敗した**理由**を返さない。
 * 返るのは `status`（busy / cancelled / failed など）と料金・通話時間だけで、
 * `detail` は null のままである。理由は Event Webhook にしか来ない。
 *
 * この差は実運用で効く。たとえば日本の固定電話宛への発信が `busy` で終わったとき、
 * それが「相手が通話中」なのか「その宛先への経路が無い」のかは status だけでは
 * 区別できない。Event Webhook の `detail`（unavailable / restricted / cannot_route など）
 * と `sip_code` があって初めて切り分けられる。
 *
 * そこで Webhook で受け取ったイベントをここに保持し、get_call_status から
 * API のレスポンスに重ねて返す。
 *
 * 注意:
 * - プロセス再起動でクリアされる（永続化しない簡易実装）。messageStatusStore と同じ。
 * - Webhookを受け取れるのは HTTP サーバー版のみ。stdio 版では常に空になる。
 *
 * @see https://developer.vonage.com/en/voice/voice-api/webhook-reference
 */

/** 保持する通話イベントのレコード */
export interface CallEventRecord {
  callId: string;
  /** started / ringing / answered / completed / busy / cancelled / failed / rejected / unanswered など */
  status: string;
  /** 失敗理由。unavailable / restricted / cannot_route など。status だけでは分からない情報 */
  detail?: string;
  /** SIP のステータスコード。キャリア側の応答をそのまま見たいときに使う */
  sipCode?: number;
  direction?: string;
  to?: string;
  from?: string;
  /** ISO8601形式のタイムスタンプ（Webhook側の値があればそれを使う） */
  timestamp: string;
  /** ストアへの記録時刻（TTL判定用） */
  recordedAt: number;
  /**
   * このサーバーが make_voice_call で発信した通話か。
   * 上限に達したとき、どれを先に捨てるかの判断に使う。
   */
  known: boolean;
}

/** レコードの保持期間（24時間）。messageStatusStore と揃える */
const TTL_MS = 24 * 60 * 60 * 1000;

/**
 * ステータスの進行順。小さいほど早い段階を表す。
 * Webhookの再送や順序逆転で、確定した状態が未確定へ巻き戻るのを防ぐために使う。
 * 未知のステータスは -1 とし、順序判定の対象外にする（常に上書きを許可）。
 */
const STATUS_RANK: Record<string, number> = {
  started: 0,
  ringing: 1,
  answered: 2,
  // 終端状態。どれも「これ以上進まない」ので同じ順位に置く
  completed: 3,
  busy: 3,
  cancelled: 3,
  failed: 3,
  rejected: 3,
  timeout: 3,
  unanswered: 3,
  machine: 3,
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

/**
 * このサーバーが make_voice_call で発信した通話のイベント。
 * get_call_status から引けるのはこちらだけ。
 */
const store = new Map<string, CallEventRecord>();

/**
 * それ以外の通話のイベント（着信レグ、同じ Application を共用する別システムの通話）。
 *
 * **枠を完全に分ける。** 総枠を共有すると、未知のレコードが専用枠に収まっていても
 * 合計が上限を超えた時点で「古い順」の退避が走り、**結局いちばん古い自分の記録から
 * 消えていく**。それでは枠を分けた意味がない。SMS 側の隔離バッファ（VONAGE_MCP-20）と
 * 同じ構造にする。
 *
 * 捨てないのは、着信レグのイベントが障害調査に役立つため。今回の固定電話宛の切り分けでも、
 * 発信のたびに着信が1本立っていることが手がかりになった。
 */
const unknownStore = new Map<string, CallEventRecord>();

/** 自分の通話の保持上限 */
const MAX_ENTRIES = 1000;

/** 自分以外の通話の保持上限。素性の分からないデータなので小さく取る */
const UNKNOWN_MAX_ENTRIES = 200;

/** このサーバーが発信した call_id */
const knownCallIds = new Set<string>();

/** 記録する call_id の上限。発信のたびに増えるので、ストアと同じ規模で抑える */
const KNOWN_MAX_ENTRIES = 1000;

/**
 * make_voice_call が発信に成功したときに呼ぶ。
 *
 * 発信レスポンスより先にイベントが届くことがあるため、**既に未知として記録されていれば
 * こちらへ移す**。移さずに放置すると、素性の分からないデータの枠で押し出される。
 */
export function recordOutboundCall(callId: string): void {
  if (!callId) {
    return;
  }

  // 挿入順を最新にするため、いったん削除してから追加する
  knownCallIds.delete(callId);
  knownCallIds.add(callId);

  while (knownCallIds.size > KNOWN_MAX_ENTRIES) {
    const oldest = knownCallIds.values().next().value;
    if (oldest === undefined) {
      break;
    }
    knownCallIds.delete(oldest);
  }

  const pending = unknownStore.get(callId);
  if (pending) {
    unknownStore.delete(callId);
    pending.known = true;
    store.set(callId, pending);
    enforceCapacity(store, MAX_ENTRIES);
  }
}

/** TTL切れのレコードを取り除く */
function pruneExpired(now: number): void {
  for (const target of [store, unknownStore]) {
    for (const [id, record] of target) {
      if (now - record.recordedAt >= TTL_MS) {
        target.delete(id);
      }
    }
  }
}

/** 件数上限を超えていたら古いものから破棄する（Map は挿入順を保持する） */
function enforceCapacity(target: Map<string, CallEventRecord>, max: number): void {
  while (target.size > max) {
    const oldestKey = target.keys().next().value;
    if (oldestKey === undefined) {
      break;
    }
    target.delete(oldestKey);
  }
}

/** Webhook取り込みの結果 */
export interface CallEventIngestResult {
  /** 取り込みに成功した場合の現在のレコード */
  record: CallEventRecord;
  /** 順序が古いため無視した場合 true（レコードは既存のまま） */
  ignored: boolean;
}

/**
 * Vonage Voice API の Event Webhook ペイロードを取り込む。
 *
 * 再送・順序逆転があり得るため、以下の場合は取り込まずに既存レコードを維持する。
 * - 受信したtimestampが記録済みのものより古い
 * - 確定済みの状態（completed / busy 等）を、より前の段階（ringing 等）で上書きしようとしている
 *
 * **失敗理由（detail / sip_code）は、後続のイベントで欠けていても消さない。**
 * 終端イベントに理由が乗り、その後に別のイベントが来たときに理由が消えると、
 * このストアを置いた意味が無くなるため。
 *
 * @returns 取り込めた場合は結果、ペイロードが不正な場合は null
 */
export function ingestCallEvent(payload: unknown): CallEventIngestResult | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const body = payload as Record<string, unknown>;
  const callId = body.uuid ?? body.call_uuid ?? body.callUuid;
  const status = body.status;

  if (typeof callId !== 'string' || callId === '' || typeof status !== 'string' || status === '') {
    return null;
  }

  const timestamp = typeof body.timestamp === 'string' ? body.timestamp : new Date().toISOString();
  const known = knownCallIds.has(callId) || store.has(callId);
  const existing = known ? store.get(callId) : unknownStore.get(callId);

  if (existing && shouldIgnoreUpdate(existing, status, timestamp)) {
    return { record: existing, ignored: true };
  }

  const sipCodeRaw = body.sip_code ?? body.sipCode;
  const sipCode =
    typeof sipCodeRaw === 'number'
      ? sipCodeRaw
      : typeof sipCodeRaw === 'string' && sipCodeRaw !== '' && Number.isFinite(Number(sipCodeRaw))
        ? Number(sipCodeRaw)
        : undefined;

  const now = Date.now();
  const record: CallEventRecord = {
    callId,
    status,
    // 一度受け取った理由は、後続イベントに無くても保持する
    detail: typeof body.detail === 'string' && body.detail !== '' ? body.detail : existing?.detail,
    sipCode: sipCode ?? existing?.sipCode,
    direction: typeof body.direction === 'string' ? body.direction : existing?.direction,
    to: typeof body.to === 'string' ? body.to : existing?.to,
    from: typeof body.from === 'string' ? body.from : existing?.from,
    timestamp,
    recordedAt: now,
    known,
  };

  pruneExpired(now);

  // 上書き時も挿入順を最新にするため、いったん削除してから追加する
  const target = known ? store : unknownStore;
  target.delete(callId);
  target.set(callId, record);
  enforceCapacity(target, known ? MAX_ENTRIES : UNKNOWN_MAX_ENTRIES);

  return { record, ignored: false };
}

/** 既存レコードに対して、届いた更新が「古い」ものかどうかを判定する */
function shouldIgnoreUpdate(
  existing: CallEventRecord,
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

/** call_id からイベント記録を取得する。見つからない場合は null。 */
export function getCallEvent(callId: string): CallEventRecord | null {
  pruneExpired(Date.now());
  return store.get(callId) ?? unknownStore.get(callId) ?? null;
}

/** テスト用: ストアと発信IDの記録を空にする */
export function clearCallEventStore(): void {
  store.clear();
  unknownStore.clear();
  knownCallIds.clear();
}

/** テスト用: 現在の保持件数（自分の通話 + それ以外） */
export function callEventStoreSize(): number {
  return store.size + unknownStore.size;
}

/** テスト用: 自分が発信した通話の保持件数 */
export function knownCallEventStoreSize(): number {
  return store.size;
}
