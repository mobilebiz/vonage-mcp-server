/**
 * ガードレール（安全機能）モジュール
 *
 * AIエージェントによる意図しない課金・スパム送信を防ぐための共通ロジックを提供する。
 * - 電話番号の正規化とE.164バリデーション
 * - ALLOWED_NUMBERS によるホワイトリスト
 * - オンメモリの簡易レートリミット
 *
 * このモジュールは Vonage SDK に依存しない（テスト時のモック対象外にするため）。
 *
 * 環境変数のパースは src/config.ts に集約されている（VONAGE_MCP-18）。
 */

import {
  RATE_LIMIT_ENV_VARS,
  arePremiumNumbersAllowed,
  getAllowedCountryCodes,
  getRateLimitPerHour,
  type RateLimitBucket,
} from './config.js';
import { getCallingCode } from './callingCodes.js';
import { JP_MAX_CONCATENATED_CHARS } from './smsSegments.js';

// 既存の import 元を変えずに済むよう、設定系のシンボルはここからも再公開する。
export {
  DEFAULT_BULK_MAX_ROWS,
  DEFAULT_RATE_LIMIT_PER_HOUR,
  getBulkMaxRows,
  getRateLimitPerHour,
} from './config.js';

/** 仕様書準拠のE.164フォーマット */
export const E164_PATTERN = /^\+[1-9]\d{1,14}$/;

/** 実際に発信可能な桁数を要求するE.164フォーマット（既存の validatePhoneNumber と同等） */
export const E164_DIALABLE_PATTERN = /^\+[1-9]\d{9,14}$/;

/**
 * ツールの入力スキーマ（JSON Schema / Zod）に埋め込む電話番号パターン。
 * E.164形式に加えて、日本の国内形式（0始まり）とハイフン・空白区切りを許容する。
 * 実際の厳格な検証はハンドラ内で正規化した後に E164_DIALABLE_PATTERN で行う。
 *
 * 3桁の短縮番号（110 / 119 / 118 など）を**あえて通す**のは、スキーマで弾くと
 * エラーが「引数が不正です」になり、エージェントが表記を直して再試行し続けるため。
 * ハンドラ側で「緊急通報番号なので常にブロックされる」という具体的な理由と
 * 「再試行しても変わらない」という指示を返したい（VONAGE_MCP-8）。
 */
export const PHONE_INPUT_PATTERN = '^(?:\\+[1-9][0-9\\s-]{6,20}|0[0-9\\s-]{8,20}|[1-9][0-9]{2})$';

/**
 * ツールのスキーマに載せる本文長の絶対上限。
 *
 * 実際の制限はセグメント数 (`SMS_MAX_SEGMENTS`) で掛ける。ここは
 * 「日本の連結メッセージの上限を超える本文は受け取らない」という外枠にすぎない。
 *
 * 文字数で縛るのをやめたのは、**課金がセグメント単位**であり、文字数が費用と
 * 対応しないため。従来の 160 は GSM-7 の1通分という意味しか持たず、日本語では
 * 3通分に相当していた (VONAGE_MCP-25)。
 */
export const SMS_INPUT_MAX_LENGTH = JP_MAX_CONCATENATED_CHARS;

/** make_voice_call の読み上げメッセージ長上限（通話時間の暴走を防ぐ） */
export const VOICE_MESSAGE_MAX_LENGTH = 1000;

/**
 * 電話番号をE.164形式（+付き）に正規化する。
 * 日本の国内形式（0始まり）は +81 に変換される。
 */
export function normalizeToE164(phoneNumber: string): string {
  let normalized = (phoneNumber ?? '').replace(/[\s\-]/g, '');

  // 日本の番号（0始まり）は先頭の0を +81 に置き換える
  if (normalized.startsWith('0')) {
    normalized = '+81' + normalized.substring(1);
  }

  if (normalized.startsWith('+')) {
    return normalized;
  }

  return '+' + normalized;
}

/** 電話番号の検証結果 */
export interface PhoneValidationResult {
  valid: boolean;
  /** 正規化済みのE.164番号（valid === true のときのみ有効） */
  normalized: string;
  reason?: string;
  suggestion?: string;
}

/**
 * 電話番号を正規化した上でE.164として妥当か検証する。
 */
export function validateAndNormalizePhoneNumber(phoneNumber: string): PhoneValidationResult {
  const normalized = normalizeToE164(phoneNumber);

  if (!E164_DIALABLE_PATTERN.test(normalized)) {
    return {
      valid: false,
      normalized,
      reason: `無効な電話番号形式です: ${phoneNumber}`,
      suggestion:
        '番号のフォーマットを確認してください。E.164形式（例: +819012345678）か、日本の国内形式（例: 09012345678）で指定してください。',
    };
  }

  return { valid: true, normalized };
}

/** ALLOWED_NUMBERS の解析結果 */
export interface AllowListConfig {
  /** 環境変数が設定されているか（空白のみは未設定扱い） */
  configured: boolean;
  /** 正規化・検証を通過した許可番号 */
  numbers: string[];
  /** E.164として解釈できなかったエントリ（設定ミスの検出用） */
  invalid: string[];
}

/**
 * ALLOWED_NUMBERS 環境変数を解析する。
 *
 * 設定されているのに有効な番号が1件も無い場合（例: `ALLOWED_NUMBERS=,`）は
 * `configured: true` かつ `numbers: []` を返す。この状態は「制限なし」ではなく
 * 「すべて拒否」として扱う（設定ミスを安全側に倒すため）。
 */
export function getAllowedNumbersConfig(): AllowListConfig {
  const raw = process.env.ALLOWED_NUMBERS;
  if (!raw || raw.trim() === '') {
    return { configured: false, numbers: [], invalid: [] };
  }

  const numbers: string[] = [];
  const invalid: string[] = [];

  for (const entry of raw.split(',').map((n) => n.trim())) {
    if (entry === '') {
      continue;
    }
    const normalized = normalizeToE164(entry);
    if (E164_DIALABLE_PATTERN.test(normalized)) {
      numbers.push(normalized);
    } else {
      invalid.push(entry);
    }
  }

  return { configured: true, numbers, invalid };
}

/**
 * 正規化済みの許可番号リストを返す。未設定の場合は null（＝制限なし）。
 */
export function getAllowedNumbers(): string[] | null {
  const config = getAllowedNumbersConfig();
  return config.configured ? config.numbers : null;
}

/** ホワイトリストの判定結果 */
export interface AllowListResult {
  allowed: boolean;
  reason?: string;
  suggestion?: string;
}

/**
 * 正規化済みのE.164番号がホワイトリストに含まれるか判定する。
 * ALLOWED_NUMBERS が未設定の場合は常に許可（fail-open は「未設定」のときだけ）。
 */
export function checkAllowedNumber(normalizedE164: string): AllowListResult {
  const config = getAllowedNumbersConfig();

  if (!config.configured) {
    return { allowed: true };
  }

  // 設定されているのに有効な番号が無い＝設定ミス。すべて拒否する（fail-closed）
  if (config.numbers.length === 0) {
    return {
      allowed: false,
      reason: `環境変数 ALLOWED_NUMBERS の設定が不正です（有効な電話番号が1件もありません${
        config.invalid.length > 0 ? `。解釈できなかった値: ${config.invalid.join(', ')}` : ''
      }）。安全のためすべての送信・架電を拒否しました。`,
      suggestion:
        'サーバー側の設定ミスです。ALLOWED_NUMBERS をE.164形式（例: +819012345678）のカンマ区切りで設定し直すか、制限が不要なら環境変数自体を削除するよう管理者に依頼してください。再試行しても結果は変わりません。',
    };
  }

  if (config.numbers.includes(normalizedE164)) {
    return { allowed: true };
  }

  return {
    allowed: false,
    reason: `送信先 ${normalizedE164} は許可されていません（ALLOWED_NUMBERS による制限）。`,
    suggestion:
      'この番号への送信・架電は環境変数 ALLOWED_NUMBERS で禁止されています。別の番号を指定するか、管理者に許可番号の追加を依頼してください。再試行しても結果は変わりません。',
  };
}

/**
 * 本文に URL らしき文字列が含まれるかを判定する。
 *
 * 日本のネットワークは、フィッシング SMS 対策として **URL を含むメッセージを
 * 配信しないことがある**。拒否基準は公開されていない。厄介なのは
 * **API が成功を返すのに実際には届かない**点で、エージェントは失敗を検知できず
 * 「送信できました」と報告してしまう。
 *
 * ブロックはしない。正当な用途もあるうえ、拒否基準が非公開である以上
 * こちらで判定しきれないため。代わりに、届かない可能性があることを
 * レスポンスに添えて、エージェントがユーザーに伝えられるようにする。
 *
 * 誤検知しても害は「余計な注意書きが付く」だけなので、広めに拾う。
 */
const URL_LIKE_PATTERN =
  /(https?:\/\/|www\.|[a-z0-9][a-z0-9-]*\.(?:com|net|org|jp|io|me|ly|link|info|biz|app|dev|co)\b)/i;

export function containsUrl(message: string): boolean {
  return URL_LIKE_PATTERN.test(message);
}

/** 日本宛で URL を含む本文に添える注意書き */
export const JP_URL_DELIVERY_WARNING =
  '本文にURLが含まれています。日本のネットワークではフィッシング対策として、' +
  'URLを含むSMSが配信されないことがあります（拒否基準は非公開）。' +
  '送信APIが成功を返しても配信されたとは限らないため、get_sms_status で配信結果を確認し、' +
  '重要な連絡の場合は別の手段も併用するようユーザーに伝えてください。';

/**
 * 常時ブロックする緊急通報番号。環境変数では緩められない。
 *
 * E.164 の桁数検証で既に弾かれるため現時点では冗長だが、多層防御として明示的に
 * 残す。桁数検証が将来緩められた瞬間に効かなくなる類の防御であり、
 * 「気づかないうちに外れていた」が最も起きやすい場所のため。
 */
export const EMERGENCY_NUMBERS: readonly string[] = ['110', '119', '118'];

/**
 * 日本の高額課金番号のプレフィックス（国内表記）。
 * ALLOW_PREMIUM_NUMBERS=true で解除できる。
 */
export const JP_PREMIUM_PREFIXES: ReadonlyArray<{ prefix: string; label: string }> = [
  { prefix: '0990', label: '情報料代理徴収サービス' },
  { prefix: '0570', label: 'ナビダイヤル' },
  { prefix: '0180', label: 'テレドーム・テレゴング' },
];

/**
 * 緊急通報番号かどうかを判定する。
 *
 * 番号全体との**完全一致**で判定する。前方・後方一致で見ると、末尾が 119 の
 * 通常の番号（例: +819012345119）まで誤ってブロックしてしまう。
 */
export function isEmergencyNumber(input: string): boolean {
  const digits = (input ?? '')
    .replace(/[\s\-()]/g, '')
    .replace(/^\+81/, '')
    .replace(/^\+/, '');

  return EMERGENCY_NUMBERS.includes(digits);
}

/** 日本の番号なら国内表記（0始まり）を返す。日本以外は null */
function toJapaneseNationalNumber(normalizedE164: string): string | null {
  return normalizedE164.startsWith('+81') ? '0' + normalizedE164.slice(3) : null;
}

/**
 * 高額課金番号（0990 など）への送信・架電を判定する。
 */
export function checkPremiumNumber(normalizedE164: string): AllowListResult {
  if (arePremiumNumbersAllowed()) {
    return { allowed: true };
  }

  const national = toJapaneseNationalNumber(normalizedE164);
  if (national === null) {
    return { allowed: true };
  }

  const matched = JP_PREMIUM_PREFIXES.find((entry) => national.startsWith(entry.prefix));
  if (!matched) {
    return { allowed: true };
  }

  return {
    allowed: false,
    reason: `${normalizedE164} は高額課金が発生する番号です（${matched.prefix} / ${matched.label}）。安全のためブロックしました。`,
    suggestion:
      'この番号への送信・架電は既定で禁止されています。別の番号を指定してください。' +
      '業務上どうしても必要な場合は、管理者が環境変数 ALLOW_PREMIUM_NUMBERS=true を設定する必要があります。再試行しても結果は変わりません。',
  };
}

/**
 * 国番号による宛先制限を判定する。
 *
 * これは IRSF（国際収益分配詐欺）に対する主防御ではない。国番号は地域と
 * 一対一ではなく（`+1` は米国・カナダ・カリブ海諸国が共有）、粗い制限にしか
 * ならない。主防御は ALLOWED_NUMBERS と Vonage アカウント側の地域制限・
 * 利用額上限であり、その旨を README に明記している。
 */
export function checkCountryCode(normalizedE164: string): AllowListResult {
  const allowed = getAllowedCountryCodes();
  if (allowed === null) {
    return { allowed: true };
  }

  const code = getCallingCode(normalizedE164);
  if (code === null) {
    return {
      allowed: false,
      reason: `${normalizedE164} から国番号を判定できませんでした。実在しない国番号の可能性があります。`,
      suggestion:
        '宛先をE.164形式（例: +819012345678）で指定し直してください。日本の番号は国内形式（例: 09012345678）でも指定できます。',
    };
  }

  if (allowed.has(code)) {
    return { allowed: true };
  }

  const allowedList = [...allowed].sort().join(', ');
  return {
    allowed: false,
    reason: `宛先 ${normalizedE164}（国番号 +${code}）は許可されていません。このサーバーが許可している国番号: ${allowedList}。`,
    suggestion:
      `国番号 +${code} 宛の送信・架電はサーバー側で禁止されています。許可されている国の番号を指定するか、` +
      '管理者に環境変数 ALLOWED_COUNTRY_CODES への追加を依頼してください。再試行しても結果は変わりません。',
  };
}

/**
 * 宛先に関するガードレールをまとめて適用する。
 *
 * 判定順は「緩められない制限 → 緩められる制限」。緊急番号を最初に見るのは、
 * 形式検証で先に弾くと「無効な電話番号形式です」という的外れな理由になり、
 * エージェントが表記を直して再試行し続けるため。
 */
export function checkDestination(rawInput: string, normalizedE164: string): AllowListResult {
  if (isEmergencyNumber(rawInput) || isEmergencyNumber(normalizedE164)) {
    return {
      allowed: false,
      reason: `${rawInput} は緊急通報番号です。このサーバーからは発信・送信できません。`,
      suggestion:
        '緊急通報番号（110 / 119 / 118）への発信は、設定にかかわらず常にブロックされます。緊急の場合は電話機から直接おかけください。再試行しても結果は変わりません。',
    };
  }

  const premium = checkPremiumNumber(normalizedE164);
  if (!premium.allowed) {
    return premium;
  }

  const country = checkCountryCode(normalizedE164);
  if (!country.allowed) {
    return country;
  }

  return checkAllowedNumber(normalizedE164);
}

/**
 * Vonage 公式の英数字 sender ID ルール。
 * https://developer.vonage.com/en/messaging/sms/guides/custom-sender-id
 *
 * 「最大11文字、a-z A-Z 0-9」。先頭文字と最小長の規定は無い。
 * 以前の実装は「3文字以上・先頭は英字」を課しており、`2FA` や `AB` のような
 * 実際に使える sender ID を弾いていた。
 */
export const ALPHANUMERIC_SENDER_ID_PATTERN = /^[A-Za-z0-9]{1,11}$/;

/**
 * 日本で禁止されている Generic Sender ID。
 *
 * いずれも「英数字11文字以内」を満たすため、書式チェックだけでは素通りする。
 * 判定は大文字小文字を区別しない。
 */
export const GENERIC_SENDER_IDS: readonly string[] = [
  'INFO',
  'SMS',
  'NOTICE',
  'MSG',
  'TEXT',
  'ALERT',
  'NOTIFY',
  'VERIFY',
  'OTP',
];

/** 電話番号として書かれた送信元か（数字のみ、または + 始まりの数字） */
function looksLikePhoneNumber(from: string): boolean {
  return /^\+?\d[\d\s-]*$/.test(from);
}

/**
 * SMSの送信元表示名（sender ID）を検証する。
 *
 * 日本宛かどうかで可否が変わるため、宛先を受け取る。宛先が分からない場合は
 * 日本宛として扱う（このサーバーは日本国内利用を前提としており、判断できない
 * ときは厳しい側に倒すため）。
 *
 * dry_run の時点でここを通しておかないと、「Ready to send」と言った内容と
 * 実際に届くものが食い違う。それが最も避けたい失敗の形。
 */
export function validateSenderId(
  from: string,
  destinationE164?: string
): { valid: boolean; reason?: string; suggestion?: string } {
  const isJapanDestination = destinationE164 === undefined || destinationE164.startsWith('+81');

  // 日本宛の Numeric Sender ID は原則不可で、**指定しても Vonage 側で上書きされる**。
  // 通してしまうと、ユーザーが承認した送信元とは別の送信者IDで届く。
  if (isJapanDestination && looksLikePhoneNumber(from)) {
    return {
      valid: false,
      reason: `日本宛のSMSでは数値の送信元（${from}）は使用できません。指定しても Vonage 側で別の送信者IDに上書きされます。`,
      suggestion:
        '送信元には英数字の送信者ID（1〜11文字、例: VonageMCP）を指定してください。' +
        '電話番号を送信元として表示することは日本の携帯キャリアの仕様上できません。同じ番号で再試行しても結果は変わりません。',
    };
  }

  if (isJapanDestination && GENERIC_SENDER_IDS.includes(from.trim().toUpperCase())) {
    return {
      valid: false,
      reason: `送信元 ${from} は日本で禁止されている汎用送信者ID（Generic Sender ID）です。`,
      suggestion:
        `${GENERIC_SENDER_IDS.join(' / ')} のような汎用的な語は日本では使用できません。` +
        '自社名やサービス名など、送信者を特定できる英数字1〜11文字を指定してください。再試行しても結果は変わりません。',
    };
  }

  if (ALPHANUMERIC_SENDER_ID_PATTERN.test(from)) {
    return { valid: true };
  }

  // 日本以外の宛先では、自社の発信元電話番号を送信元に使える
  if (!isJapanDestination && E164_DIALABLE_PATTERN.test(normalizeToE164(from))) {
    return { valid: true };
  }

  return {
    valid: false,
    reason: `無効な送信元です: ${from}`,
    suggestion:
      '送信元は英数字1〜11文字（a-z A-Z 0-9、例: VonageMCP）で指定してください。' +
      '日本語・記号・空白は使用できません。' +
      (isJapanDestination ? '日本宛では電話番号を送信元にすることもできません。' : ''),
  };
}

/** レートリミットの判定結果 */
export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** 上限に達している場合、次に呼び出せるようになるまでの秒数 */
  retryAfterSeconds?: number;
}

/**
 * スライディングウィンドウ方式のオンメモリ・レートリミッタ。
 *
 * 1件の送信・架電を1単位としてカウントする。bulk_sms_from_csv のように1回の
 * ツール呼び出しで複数件を送るものは、送信件数分をまとめて消費する（cost）。
 * プロセスが再起動するとカウントはリセットされる（簡易実装）。
 */
export class RateLimiter {
  private readonly buckets = new Map<string, number[]>();

  constructor(private readonly windowMs: number = 60 * 60 * 1000) {}

  /** ウィンドウ外のタイムスタンプを取り除いた配列を返す */
  private prune(key: string, now: number): number[] {
    const timestamps = (this.buckets.get(key) ?? []).filter((t) => now - t < this.windowMs);
    this.buckets.set(key, timestamps);
    return timestamps;
  }

  /** 消費せずに、cost 件分の空きがあるかを確認する */
  check(
    key: string,
    limit: number = getRateLimitPerHour(),
    now: number = Date.now(),
    cost: number = 1
  ): RateLimitResult {
    if (!Number.isFinite(limit)) {
      return { allowed: true, limit: Infinity, remaining: Infinity };
    }

    // limit === 0 は「全拒否」。待っても解けないので retryAfterSeconds は返さない。
    if (limit === 0) {
      return { allowed: false, limit: 0, remaining: 0 };
    }

    const timestamps = this.prune(key, now);
    const remaining = Math.max(0, limit - timestamps.length);

    if (cost > remaining) {
      // 空きが無いときは最古のエントリが期限切れになるまでの秒数を返す
      const retryAfterSeconds =
        timestamps.length > 0
          ? Math.max(1, Math.ceil((this.windowMs - (now - Math.min(...timestamps))) / 1000))
          : 1;
      return { allowed: false, limit, remaining, retryAfterSeconds };
    }

    return { allowed: true, limit, remaining };
  }

  /** 空きがあれば cost 件分を消費する。足りない場合は1件も消費しない。 */
  consume(
    key: string,
    limit: number = getRateLimitPerHour(),
    now: number = Date.now(),
    cost: number = 1
  ): RateLimitResult {
    const result = this.check(key, limit, now, cost);
    if (!result.allowed || !Number.isFinite(limit)) {
      return result;
    }

    const timestamps = this.buckets.get(key) ?? [];
    for (let i = 0; i < cost; i++) {
      timestamps.push(now);
    }
    this.buckets.set(key, timestamps);

    return { allowed: true, limit, remaining: Math.max(0, limit - timestamps.length) };
  }

  /**
   * 複数バケットを**原子的に**消費する。
   *
   * 先に全バケットの空きを確認し、1つでも足りなければ**どのバケットも消費しない**。
   * 順に消費すると、global を消費した直後に sms で弾かれ、送っていない分の枠だけ
   * 減るという状態が残る。
   */
  consumeAll(
    requests: Array<{ bucket: RateLimitBucket; key: string; limit: number; cost: number }>,
    now: number = Date.now()
  ): { allowed: true } | { allowed: false; bucket: RateLimitBucket; result: RateLimitResult } {
    for (const request of requests) {
      const result = this.check(request.key, request.limit, now, request.cost);
      if (!result.allowed) {
        return { allowed: false, bucket: request.bucket, result };
      }
    }

    for (const request of requests) {
      this.consume(request.key, request.limit, now, request.cost);
    }

    return { allowed: true };
  }

  /** テスト用: カウンタをリセットする */
  reset(key?: string): void {
    if (key === undefined) {
      this.buckets.clear();
    } else {
      this.buckets.delete(key);
    }
  }
}

/**
 * 課金が発生するツール（send_sms / bulk_sms_from_csv / make_voice_call）で共有するレートリミッタ。
 * ステータス取得系やJWT生成などの副作用のないツールはカウント対象外。
 */
export const toolRateLimiter = new RateLimiter();

/** レートリミット超過時のエラー文面を組み立てる */
export function buildRateLimitError(
  toolName: string,
  result: RateLimitResult,
  cost: number = 1,
  bucket: RateLimitBucket = 'global'
): {
  reason: string;
  suggestion: string;
  retry_after_seconds: number;
  remaining: number;
} {
  const envVar = RATE_LIMIT_ENV_VARS[bucket];

  // 上限 0 は緊急停止。待機を促すのは誤誘導になる。
  if (result.limit === 0) {
    return {
      reason: `${toolName} は管理者によって停止されています（${envVar}=0）。1件も送信していません。`,
      suggestion:
        `再試行しても結果は変わりません。利用を再開するには、管理者に ${envVar} の設定変更を依頼してください。`,
      retry_after_seconds: 0,
      remaining: 0,
    };
  }

  const retryAfter = result.retryAfterSeconds ?? 3600;
  const waitMessage = `約${retryAfter}秒（${Math.ceil(retryAfter / 60)}分）待ってから再試行してください。それまでは同じツールを呼び出さないでください。`;

  if (cost > 1) {
    return {
      reason: `レートリミット超過: ${toolName} は${cost}件の送信を要求しましたが、残り枠は${result.remaining}件です（${envVar}: 1時間あたり${result.limit}件）。1件も送信していません。`,
      suggestion:
        result.remaining > 0
          ? `CSVを${result.remaining}行以下に分割して再試行するか、${waitMessage}管理者に ${envVar} の引き上げを依頼することもできます。`
          : `${waitMessage}管理者に ${envVar} の引き上げを依頼することもできます。`,
      retry_after_seconds: retryAfter,
      remaining: result.remaining,
    };
  }

  return {
    reason: `レートリミット超過: ${toolName} は1時間あたり${result.limit}件までです（${envVar}）。`,
    suggestion: waitMessage,
    retry_after_seconds: retryAfter,
    remaining: result.remaining,
  };
}
