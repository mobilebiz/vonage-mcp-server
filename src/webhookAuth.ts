/**
 * Vonage Webhook の認証モジュール
 *
 * Status Webhook は Vonage から呼ばれるため x-api-key 認証の対象外だが、
 * 「Vonage由来であること」は必ず検証する必要がある。検証しないと、誰でも任意の
 * message_uuid のステータスを偽装したり、大量POSTで正規レコードを追い出したりできる。
 *
 * 優先順位:
 *   1. VONAGE_API_SIGNATURE_SECRET が設定されていれば、Authorization ヘッダーの
 *      署名付きJWT を検証する（Vonage推奨）。この場合、共有シークレットには
 *      **フォールバックしない** — 弱い方式への降格を攻撃者に選ばせないため
 *   2. VONAGE_API_SIGNATURE_SECRET が未設定で VONAGE_WEBHOOK_SECRET が設定されて
 *      いれば、x-webhook-secret ヘッダーと照合する
 *   3. どちらも未設定なら受理しない（fail-closed）
 *
 * 署名付きJWTでは、署名の一致だけでなく payload_hash・iat/exp・jti をすべて
 * 検証する。署名だけを見ていると、一度漏れた有効なJWTを**無期限に、任意の
 * ボディと組み合わせて**再利用できてしまう。
 *
 * @see https://developer.vonage.com/en/getting-started/concepts/webhooks#validating-signed-webhooks
 */

import { createHash, timingSafeEqual } from 'crypto';
import { verifySignature } from '@vonage/jwt';

import { getWebhookMaxAgeSeconds } from './config.js';

/** 認証結果 */
export interface WebhookAuthResult {
  authorized: boolean;
  /** 認証に使った方式 */
  method?: 'signature' | 'shared_secret';
  /** 拒否理由（authorized === false のとき） */
  reason?: string;
  /** HTTPステータスコード（authorized === false のとき） */
  status?: 401 | 503;
}

/** タイミング攻撃に強い文字列比較 */
export function safeEqual(a: string, b: string): boolean {
  // 長さの違いから情報が漏れないよう、ハッシュ化してから固定長で比較する
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** Authorization ヘッダーから Bearer トークンを取り出す */
function extractBearerToken(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== 'string') {
    return null;
  }

  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  return match ? match[1].trim() : null;
}

/** 検証済みJWTのクレームを取り出す（署名検証後に呼ぶこと） */
function decodeClaims(token: string): Record<string, unknown> | null {
  const segments = token.split('.');
  if (segments.length !== 3) {
    return null;
  }

  try {
    const json = Buffer.from(segments[1], 'base64url').toString('utf8');
    const claims = JSON.parse(json);
    return claims && typeof claims === 'object' ? claims : null;
  } catch {
    return null;
  }
}

/**
 * 一度受理した jti を記録してリプレイを防ぐ。
 *
 * 有効期間（iat の許容幅）を過ぎたものは捨てる。それ以降は iat の検証で
 * 弾かれるため、覚えておく必要がない。
 */
const seenJti = new Map<string, number>();

/** jti を覚えておく上限。異常なトラフィックでメモリを食い潰さないための歯止め */
const MAX_SEEN_JTI = 10_000;

/**
 * jti が未使用なら記録して true を返す。使用済みなら false。
 *
 * すべての検証を通過した後に呼ぶこと。先に呼ぶと、検証に失敗したリクエストが
 * jti を消費し、正規の再送を拒否してしまう。
 */
function consumeJti(jti: string, now: number, maxAgeMs: number): boolean {
  for (const [key, recordedAt] of seenJti) {
    if (now - recordedAt > maxAgeMs) {
      seenJti.delete(key);
    } else {
      // Map は挿入順を保つので、期限内のものに当たったらそれ以降は消す必要がない
      break;
    }
  }

  if (seenJti.has(jti)) {
    return false;
  }

  if (seenJti.size >= MAX_SEEN_JTI) {
    const oldest = seenJti.keys().next();
    if (!oldest.done) {
      seenJti.delete(oldest.value);
    }
  }

  seenJti.set(jti, now);
  return true;
}

/** テスト用: リプレイ検出のキャッシュを消す */
export function clearWebhookReplayCache(): void {
  seenJti.clear();
}

/**
 * 署名検証を通過したJWTのクレームを検証する。
 *
 * 署名が正しいことは「Vonageが一度発行した」ことしか意味しない。それが
 * **このリクエストのために、いま**発行されたものかは、以下で確かめる必要がある。
 *
 * @returns 問題があれば理由、無ければ null
 */
function verifyClaims(
  claims: Record<string, unknown>,
  rawBody: Buffer | undefined,
  now: number
): string | null {
  // --- payload_hash: このボディに対する署名か ---
  //
  // 欠落を許すと、有効な署名を任意のボディと組み合わせて再利用できる。
  // 「Vonage が付けていなければスキップ」は、攻撃者が claim を外した
  // JWT を作れば検証を無効化できるということでもある。
  const expectedHash = claims['payload_hash'];
  if (typeof expectedHash !== 'string' || expectedHash === '') {
    return 'Webhook JWT is missing the payload_hash claim';
  }

  if (!rawBody) {
    return 'Raw request body is unavailable, cannot verify payload_hash';
  }

  const actualHash = createHash('sha256').update(rawBody).digest('hex');
  if (!safeEqual(actualHash.toLowerCase(), expectedHash.toLowerCase())) {
    return 'Webhook payload hash mismatch';
  }

  // --- iat / exp: いま発行されたものか ---
  const maxAgeSeconds = getWebhookMaxAgeSeconds();
  const nowSeconds = Math.floor(now / 1000);

  const iat = claims['iat'];
  if (typeof iat !== 'number' || !Number.isFinite(iat)) {
    return 'Webhook JWT is missing the iat claim';
  }

  // 未来方向のずれも見る。時計を進めたJWTで有効期間を伸ばされないため。
  if (Math.abs(nowSeconds - iat) > maxAgeSeconds) {
    return `Webhook JWT timestamp is outside the allowed window of ${maxAgeSeconds}s`;
  }

  const exp = claims['exp'];
  if (typeof exp === 'number' && Number.isFinite(exp) && nowSeconds > exp) {
    return 'Webhook JWT has expired';
  }

  // --- jti: 同じJWTの使い回しでないか ---
  const jti = claims['jti'];
  if (typeof jti !== 'string' || jti === '') {
    return 'Webhook JWT is missing the jti claim';
  }

  if (!consumeJti(jti, now, maxAgeSeconds * 1000)) {
    return 'Webhook JWT has already been used (replay detected)';
  }

  return null;
}

/**
 * Webhookリクエストを検証する。
 *
 * @param headers リクエストヘッダー（Express の req.headers を想定）
 * @param rawBody 生のリクエストボディ。署名JWTの payload_hash 検証に使う
 */
export function authenticateWebhook(
  headers: Record<string, string | string[] | undefined>,
  rawBody?: Buffer,
  now: number = Date.now()
): WebhookAuthResult {
  const signatureSecret = process.env.VONAGE_API_SIGNATURE_SECRET;
  const sharedSecret = process.env.VONAGE_WEBHOOK_SECRET;

  // どちらも未設定なら受理しない。未認証で受け付けるとステータス偽装が可能になるため。
  if (!signatureSecret && !sharedSecret) {
    return {
      authorized: false,
      status: 503,
      reason:
        'Webhook authentication is not configured. Set VONAGE_API_SIGNATURE_SECRET (recommended) or VONAGE_WEBHOOK_SECRET.',
    };
  }

  if (signatureSecret) {
    const token = extractBearerToken(headers['authorization']);
    if (!token) {
      return {
        authorized: false,
        status: 401,
        reason: 'Missing signed JWT in Authorization header',
      };
    }

    let valid = false;
    try {
      valid = verifySignature(token, signatureSecret);
    } catch {
      valid = false;
    }

    if (!valid) {
      return { authorized: false, status: 401, reason: 'Invalid webhook signature' };
    }

    const claims = decodeClaims(token);
    if (!claims) {
      return { authorized: false, status: 401, reason: 'Webhook JWT claims could not be decoded' };
    }

    const problem = verifyClaims(claims, rawBody, now);
    if (problem) {
      return { authorized: false, status: 401, reason: problem };
    }

    // ここを抜けたら必ず return する。署名方式を設定した場合、共有シークレットには
    // フォールバックしない。フォールバックすると、攻撃者は Authorization ヘッダーを
    // 外すか壊すだけで弱いほうの方式を選べてしまう（ダウングレード攻撃）。
    return { authorized: true, method: 'signature' };
  }

  if (sharedSecret) {
    const provided = headers['x-webhook-secret'];
    const value = Array.isArray(provided) ? provided[0] : provided;

    if (typeof value === 'string' && safeEqual(value, sharedSecret)) {
      return { authorized: true, method: 'shared_secret' };
    }

    return { authorized: false, status: 401, reason: 'Invalid or missing webhook secret' };
  }

  return { authorized: false, status: 401, reason: 'Unauthorized webhook request' };
}

/** Webhook認証が構成されているか（起動時の警告表示用） */
export function isWebhookAuthConfigured(): boolean {
  return Boolean(process.env.VONAGE_API_SIGNATURE_SECRET || process.env.VONAGE_WEBHOOK_SECRET);
}
