import { Vonage } from '@vonage/server-sdk';
import { readFileSync } from 'fs';

/**
 * Call Status取得パラメータ
 */
export interface CallStatusParams {
  callId: string;
  applicationId?: string;
  privateKeyPath?: string;
}

/**
 * Call Status結果
 */
export interface CallStatusResult {
  success: boolean;
  status?: string;
  price?: string;
  rate?: string;
  duration?: number;
  startTime?: string;
  error?: string;
}

/**
 * Vonage Voice APIからCall Statusを取得
 * 
 * @param params Call Status取得パラメータ
 * @returns Call Status結果
 */
export async function getCallStatus(params: CallStatusParams): Promise<CallStatusResult> {
  try {
    // 環境変数から設定を取得（パラメータで上書き可能）
    const applicationId = params.applicationId || process.env.VONAGE_APPLICATION_ID;
    const privateKeyPath = params.privateKeyPath || process.env.VONAGE_PRIVATE_KEY_PATH;
    
    // 必須パラメータのチェック
    if (!applicationId) {
      return {
        success: false,
        error: 'Application IDが設定されていません。環境変数VONAGE_APPLICATION_IDを設定してください。'
      };
    }
    
    if (!privateKeyPath) {
      return {
        success: false,
        error: 'Private Key Pathが設定されていません。環境変数VONAGE_PRIVATE_KEY_PATHを設定してください。'
      };
    }
    
    if (!params.callId) {
      return {
        success: false,
        error: 'Call IDが指定されていません。'
      };
    }
    
    // 秘密鍵ファイルの読み込み
    let privateKey: string;
    try {
      privateKey = readFileSync(privateKeyPath, 'utf-8');
    } catch (error) {
      return {
        success: false,
        error: `秘密鍵ファイルの読み込みに失敗しました: ${privateKeyPath}`
      };
    }
    
    // Vonage SDKの初期化
    // @ts-ignore - Vonageライブラリの型定義の問題を回避
    const vonage = new Vonage({
      applicationId,
      privateKey
    });
    
    // Call Statusの取得
    const call = await vonage.voice.getCall(params.callId);
    
    return {
      success: true,
      status: call.status,
      price: call.price,
      rate: call.rate,
      duration: call.duration ? parseInt(call.duration, 10) : undefined,
      startTime: call.startTime
    };
    
  } catch (error: any) {
    // エラーハンドリング
    if (error.response?.status === 404) {
      return {
        success: false,
        error: `指定されたCall ID (${params.callId}) が見つかりませんでした。`
      };
    }
    
    return {
      success: false,
      error: `Call Status取得エラー: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}
