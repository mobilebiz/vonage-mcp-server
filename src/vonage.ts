import { Vonage } from '@vonage/server-sdk';
import { readFileSync } from 'fs';

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

// 電話番号をE.164形式に変換する関数
function normalizePhoneNumber(phoneNumber: string): string {
  // 空白やハイフンを削除
  let normalized = phoneNumber.replace(/[\s\-]/g, '');
  
  // 日本の番号の場合（0から始まる場合）
  if (normalized.startsWith('0')) {
    // 先頭の0を削除して+81を追加
    normalized = '+81' + normalized.substring(1);
  }
  
  // 既に+で始まっている場合はそのまま
  if (normalized.startsWith('+')) {
    return normalized;
  }
  
  // その他の場合は+を追加
  return '+' + normalized;
}

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
  if (!/^\+[1-9]\d{9,14}$/.test(normalized)) return false;
  return true;
} 