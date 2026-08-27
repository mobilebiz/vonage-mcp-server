import { Voice, NCCOAction } from '@vonage/voice';
import { Auth } from '@vonage/auth';
import { readFileSync } from 'fs';

import { getPrivateKeyPath } from './config.js';

// Voice通話パラメータのインターフェース
export interface VoiceCallParams {
  to: string;
  message: string;
  voice?: string;
}

// 電話番号をE.164形式に変換する関数
export function formatPhoneNumberForVoice(phoneNumber: string): string {
  // 空白やハイフンを削除
  let normalized = phoneNumber.replace(/[\s\-]/g, '');
  
  // 日本の番号の場合（0から始まる場合）
  if (normalized.startsWith('0')) {
    // 先頭の0を削除して+81を追加
    normalized = '81' + normalized.substring(1);
  }
  
  // 既に国番号で始まっている場合はそのまま
  if (/^[1-9]\d{9,14}$/.test(normalized)) {
    return normalized;
  }
  
  // +が付いている場合は削除
  if (normalized.startsWith('+')) {
    return normalized.substring(1);
  }
  
  return normalized;
}

// NCCOを生成する関数
export function generateNCCO(message: string, voice: string = '女性'): NCCOAction[] {
  // 音声タイプからstyleパラメータを決定
  // style: 1 = 女性音声, style: 3 = 男性音声
  const voiceStyleMapping: { [key: string]: number } = {
    '女性': 1,   // 女性音声
    '男性': 3    // 男性音声
  };
  
  const style = voiceStyleMapping[voice] || 1; // デフォルトは女性音声
  
  return [
    {
      action: 'talk',
      text: message,
      language: 'ja-JP',
      style: style,
      premium: true
    } as NCCOAction
  ];
}

// Voice通話を発信する関数
export async function makeVoiceCall(params: VoiceCallParams): Promise<{ success: boolean; callId?: string; error?: string }> {
  try {
    // 環境変数から設定を取得
    const applicationId = process.env.VONAGE_APPLICATION_ID;
    if (!applicationId) {
      throw new Error('VONAGE_APPLICATION_ID環境変数が設定されていません');
    }
    
    const privateKeyPath = getPrivateKeyPath();
    const fromNumber = process.env.VONAGE_VOICE_FROM;
    if (!fromNumber) {
      throw new Error('VONAGE_VOICE_FROM環境変数が設定されていません');
    }
    
    // 秘密鍵を読み込み
    const privateKey = readFileSync(privateKeyPath, 'utf8');
    
    // Authオブジェクトを作成
    const auth = new Auth({
      applicationId: applicationId,
      privateKey: privateKey
    });
    
    // Voice SDKクライアントを初期化
    const voiceClient = new Voice(auth);
    
    // 電話番号をE.164形式に変換（+なし）
    const normalizedTo = formatPhoneNumberForVoice(params.to);
    
    // NCCOを生成（音声名を正規化）
    const normalizedVoice = normalizeVoiceName(params.voice || '女性');
    const ncco = generateNCCO(params.message, normalizedVoice);
    
    
    // Voice通話パラメータを構築
    // @vonage/voice SDKのCreateCallRequestインターフェースに準拠
    const callRequest = {
      ncco: ncco,
      to: [{
        type: 'phone' as const,
        number: normalizedTo
      }],
      from: {
        type: 'phone' as const,
        number: fromNumber
      },
      machine_detection: 'continue' as const,
      // 見積もりに連動させる。dry_run で提示した時間と実際の上限を一致させるため。
      length_timer: callLengthTimer(params.message),
      ringing_timer: 60
    };
    
    try {
      // Voice SDKを使用して発信
      const response = await voiceClient.createOutboundCall(callRequest);
      
      return {
        success: true,
        callId: response.uuid
      };
    } catch (error: any) {
      // APIエラーの詳細を取得
      let errorMessage = 'Voice通話エラー: ';
      
      if (error.response?.data) {
        // APIレスポンスエラー
        const errorData = error.response.data;
        if (errorData.title) {
          errorMessage += errorData.title;
        }
        if (errorData.detail) {
          errorMessage += ` - ${errorData.detail}`;
        }
        if (errorData.type) {
          errorMessage += ` (${errorData.type})`;
        }
      } else if (error.message) {
        errorMessage += error.message;
      } else {
        errorMessage += String(error);
      }
      
      return {
        success: false,
        error: errorMessage
      };
    }
  } catch (error) {
    return {
      success: false,
      error: `予期しないエラー: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

// 音声オプションのバリデーション
export function validateVoiceName(voice: string): boolean {
  const validVoices = ['女性', '男性'];
  return validVoices.includes(voice);
}

// 音声名を正規化する関数
export function normalizeVoiceName(voice: string): string {
  const validVoices = ['女性', '男性'];
  return validVoices.includes(voice) ? voice : '女性';
}

/** 通話時間の見積もりの下限（秒） */
export const MIN_CALL_DURATION_SECONDS = 10;

/** 通話時間の絶対上限（秒）。これを超えて課金されることはない */
export const MAX_CALL_DURATION_SECONDS = 300;

/**
 * 見積もりに上乗せする余裕（秒）。
 *
 * 読み上げ速度は文字の内容で変わるうえ、応答直後の無音や機械検出の分もある。
 * 見積もりちょうどで切ると、正常な通話が途中で切断される。
 */
export const CALL_DURATION_MARGIN_SECONDS = 30;

// 通話時間の見積もり（文字数から概算）
export function estimateCallDuration(message: string): number {
  // 日本語の読み上げ速度: 約300文字/分
  const charsPerMinute = 300;
  const duration = Math.ceil(message.length / charsPerMinute * 60); // 秒単位

  return Math.max(MIN_CALL_DURATION_SECONDS, Math.min(MAX_CALL_DURATION_SECONDS, duration));
}

/**
 * Vonage に渡す `length_timer`（通話の強制切断までの秒数）を求める。
 *
 * 見積もりに連動させる。以前は固定で 7200 秒（2時間）を送っており、
 * **dry_run が「約300秒」と表示して承認を得ても、実際には最大2時間まで
 * 課金され得た**。音声は分課金なので、SMS と違って金額の跳ね方が大きい。
 *
 * NCCO の挙動、機械検出の結果、Vonage 側の異常などで通話が期待どおり
 * 終了しなかった場合の歯止めであり、正常系では到達しない値。
 */
export function callLengthTimer(message: string): number {
  return Math.min(
    MAX_CALL_DURATION_SECONDS,
    estimateCallDuration(message) + CALL_DURATION_MARGIN_SECONDS
  );
}