/**
 * Vonage Webhook の認証モジュール
 *
 * Status Webhook は Vonage から呼ばれるため x-api-key 認証の対象外だが、
 * 「Vonage由来であること」は必ず検証する必要がある。検証しないと、誰でも任意の
 * message_uuid のステータスを偽装したり、大量POSTで正規レコードを追い出したりできる。
 *
 * 優先順位:
 *   1. VONAGE_API_SIGNATURE_SECRET が設定されていれば、Authorization ヘッダーの
 *      署名付きJWT を検証する（Vonage推奨）
 *   2. VONAGE_WEBHOOK_SECRET が設定されていれば、x-webhook-secret ヘッダーと照合する
 *   3. どちらも未設定なら受理しない（fail-closed）
 *
 * @see https://developer.vonage.com/en/getting-started/concepts/webhooks#validating-signed-webhooks
 */

import { createHash, timingSafeEqual } from 'crypto';
import { verifySignature } from '@vonage/jwt';

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
function safeEqual(a: string, b: string): boolean {
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
 * Vonageの署名付きWebhookに含まれる payload_hash を検証する。
 *
 * payload_hash はリクエストボディの SHA-256 ハッシュで、これを検証しないと
 * 有効な署名を再利用して別のボディを送り込める（リプレイ・改ざん）。
 *
 * @returns 検証結果。payload_hash が無い、または rawBody が取得できない場合は true（検証をスキップ）
 */
function verifyPayloadHash(claims: Record<string, unknown>, rawBody?: Buffer): boolean {
  const expected = claims['payload_hash'];
  if (typeof expected !== 'string' || expected === '') {
    return true; // Vonage側が付与していない場合はスキップ
  }

  if (!rawBody) {
    return true; // 生ボディを取得できない構成ではスキップ
  }

  const actual = createHash('sha256').update(rawBody).digest('hex');
  return safeEqual(actual.toLowerCase(), expected.toLowerCase());
}

/**
 * Webhookリクエストを検証する。
 *
 * @param headers リクエストヘッダー（Express の req.headers を想定）
 * @param rawBody 生のリクエストボディ。署名JWTの payload_hash 検証に使う
 */
export function authenticateWebhook(
  headers: Record<string, string | string[] | undefined>,
  rawBody?: Buffer
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

    if (valid) {
      const claims = decodeClaims(token);
      if (claims && !verifyPayloadHash(claims, rawBody)) {
        // 署名は正しいがボディが一致しない＝有効な署名の再利用（リプレイ・改ざん）
        return { authorized: false, status: 401, reason: 'Webhook payload hash mismatch' };
      }
      return { authorized: true, method: 'signature' };
    }

    // 署名検証に失敗しても、共有シークレットが設定されていればそちらで再判定する
    if (!sharedSecret) {
      return { authorized: false, status: 401, reason: 'Invalid webhook signature' };
    }
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
