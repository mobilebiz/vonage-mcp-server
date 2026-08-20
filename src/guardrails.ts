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

import { getRateLimitPerHour } from './config.js';

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
 */
export const PHONE_INPUT_PATTERN = '^(?:\\+[1-9][0-9\\s-]{6,20}|0[0-9\\s-]{8,20})$';

/** send_sms の本文長上限（SMSの1通あたりの上限に合わせる） */
export const SMS_MAX_LENGTH = 160;

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
 * SMSの送信元表示名（sender ID）を検証する。
 *
 * Vonageは英数字のsender ID（3〜11文字・数字始まり不可）と、発信元電話番号の
 * どちらも受け付けるため、両方を許容する。csvUtils.validateFrom より緩いが、
 * dry_run が「送れる」と言ったのに本実行で弾かれる状況を防ぐのが目的。
 */
export function validateSenderId(from: string): { valid: boolean; reason?: string; suggestion?: string } {
  // 英数字のsender ID: 3〜11文字、先頭は英字
  if (/^[A-Za-z][A-Za-z0-9]{2,10}$/.test(from)) {
    return { valid: true };
  }

  // 発信元電話番号として解釈できる場合も許容
  if (E164_DIALABLE_PATTERN.test(normalizeToE164(from))) {
    return { valid: true };
  }

  return {
    valid: false,
    reason: `無効な送信元です: ${from}`,
    suggestion:
      '送信元は英数字3〜11文字（先頭は英字、例: VonageMCP）か、E.164形式の電話番号（例: +819012345678）で指定してください。日本語や記号、数字のみの短い文字列は使用できません。',
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
  cost: number = 1
): {
  reason: string;
  suggestion: string;
  retry_after_seconds: number;
  remaining: number;
} {
  // RATE_LIMIT_PER_HOUR=0 は緊急停止。待機を促すのは誤誘導になる。
  if (result.limit === 0) {
    return {
      reason: `${toolName} は管理者によって停止されています（RATE_LIMIT_PER_HOUR=0）。1件も送信していません。`,
      suggestion:
        '再試行しても結果は変わりません。利用を再開するには、管理者に RATE_LIMIT_PER_HOUR の設定変更を依頼してください。',
      retry_after_seconds: 0,
      remaining: 0,
    };
  }

  const retryAfter = result.retryAfterSeconds ?? 3600;
  const waitMessage = `約${retryAfter}秒（${Math.ceil(retryAfter / 60)}分）待ってから再試行してください。それまでは同じツールを呼び出さないでください。`;

  if (cost > 1) {
    return {
      reason: `レートリミット超過: ${toolName} は${cost}件の送信を要求しましたが、残り枠は${result.remaining}件です（上限: 1時間あたり${result.limit}件）。1件も送信していません。`,
      suggestion:
        result.remaining > 0
          ? `CSVを${result.remaining}行以下に分割して再試行するか、${waitMessage}管理者に RATE_LIMIT_PER_HOUR の引き上げを依頼することもできます。`
          : `${waitMessage}管理者に RATE_LIMIT_PER_HOUR の引き上げを依頼することもできます。`,
      retry_after_seconds: retryAfter,
      remaining: result.remaining,
    };
  }

  return {
    reason: `レートリミット超過: ${toolName} は1時間あたり${result.limit}件までです。`,
    suggestion: waitMessage,
    retry_after_seconds: retryAfter,
    remaining: result.remaining,
  };
}
