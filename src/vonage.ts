import { Vonage } from '@vonage/server-sdk';
import { readFileSync } from 'fs';
import { E164_DIALABLE_PATTERN, normalizeToE164 } from './guardrails.js';

// Vonage設定のインターフェース
interface VonageConfig {
  applicationId: string;
  privateKeyPath: string;
}

// SMS送信パラメータのインターフェース
interface SMSParams {
  to: string;
  message: string;
  from?: string;
}

// 電話番号をE.164形式に変換する関数（正規化ロジックは guardrails.ts に集約）
const normalizePhoneNumber = normalizeToE164;

// Vonageクライアントを初期化する関数
function createVonageClient(config: VonageConfig): any {
  try {
    const privateKey = readFileSync(config.privateKeyPath, 'utf8');

    // @ts-ignore - Vonageライブラリの型定義の問題を回避
    return new Vonage({
      applicationId: config.applicationId,
      privateKey: privateKey
    });
  } catch (error) {
    throw new Error(`Vonageクライアントの初期化に失敗しました: ${error}`);
  }
}

// SMS送信関数
export async function sendSMS(params: SMSParams): Promise<{ success: boolean; messageId?: string; error?: string }> {
  try {
    // 環境変数から設定を取得
    const applicationId = process.env.VONAGE_APPLICATION_ID;
    if (!applicationId) {
      throw new Error('VONAGE_APPLICATION_ID環境変数が設定されていません');
    }
    
    const privateKeyPath = process.env.VONAGE_PRIVATE_KEY_PATH || './private.key';
    
    // Vonageクライアントを初期化
    const vonage = createVonageClient({
      applicationId,
      privateKeyPath
    });
    
    // 電話番号をE.164形式に変換
    const normalizedTo = normalizePhoneNumber(params.to);
    const from = params.from || 'VonageMCP';
    
    // SMS送信（シンプルなPromiseベース）
    try {
      const response = await vonage.messages.send({
        text: params.message,
        message_type: "text",
        to: normalizedTo,
        from: from,
        channel: "sms",
      });

      return {
        success: true,
        messageId: response.messageUUID
      };
    } catch (error) {
      return {
        success: false,
        error: `SMS送信エラー: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  } catch (error) {
    return {
      success: false,
      error: `予期しないエラー: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

// 電話番号の検証関数
export function validatePhoneNumber(phoneNumber: string): boolean {
  const normalized = normalizePhoneNumber(phoneNumber);
  // E.164形式: +[国番号][番号]（合計10～15桁）
  return E164_DIALABLE_PATTERN.test(normalized);
}

// バルクSMS送信の結果インターフェース
export interface BulkSMSResult {
  totalRequests: number;
  successCount: number;
  failureCount: number;
  results: Array<{
    to: string;
    from: string;
    success: boolean;
    messageId?: string;
    error?: string;
  }>;
}

/**
 * バルクSMS送信関数
 *
 * @param onSent 1件送るたびに、その結果で**即座に**呼ばれる。全件終わってから
 *   まとめて処理してはいけない理由は、この関数が1行ごとに100ms待って逐次
 *   送信するため。200件なら数十秒かかり、その間に前半のDLRが届く。呼び出し
 *   側が送信を記録するのが全件完了後だと、先に届いたDLRは「知らない
 *   message_id」として隔離バッファ（200件・5分）へ回され、大きなCSVでは
 *   そこから溢れて**配信ステータスが永久に取れなくなる**（VONAGE_MCP-4）。
 */
export async function sendBulkSMS(
  requests: SMSParams[],
  onSent?: (result: BulkSMSResult['results'][number]) => void
): Promise<BulkSMSResult> {
  const results: BulkSMSResult['results'] = [];
  let successCount = 0;
  let failureCount = 0;

  // 並列実行ではなく順次実行でAPI制限を回避
  for (const params of requests) {
    const result = await sendSMS(params);

    let entry: BulkSMSResult['results'][number];
    if (result.success) {
      successCount++;
      entry = {
        to: params.to,
        from: params.from || 'VonageMCP',
        success: true,
        messageId: result.messageId
      };
    } else {
      failureCount++;
      entry = {
        to: params.to,
        from: params.from || 'VonageMCP',
        success: false,
        error: result.error
      };
    }
    results.push(entry);

    // 記録側の失敗で送信ループを止めない。ここで throw すると、残りの行が
    // 送られないまま「一部だけ送信済み」の状態でエラーになる。
    try {
      onSent?.(entry);
    } catch {
      // 記録できなくても送信自体は成功している
    }
    
    // API制限を回避するため、送信間隔を設ける（100ms）
    if (requests.length > 1) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  return {
    totalRequests: requests.length,
    successCount,
    failureCount,
    results
  };
} 