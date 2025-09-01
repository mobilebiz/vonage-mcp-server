import { Voice, NCCOAction } from '@vonage/voice';
import { Auth } from '@vonage/auth';
import { readFileSync } from 'fs';

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
    
    const privateKeyPath = process.env.VONAGE_PRIVATE_KEY_PATH || './private.key';
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
    
    // デバッグ用: NCCOの内容をログ出力
    console.log('Generated NCCO:', JSON.stringify(ncco, null, 2));
    
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
      length_timer: 7200,
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

// 通話時間の見積もり（文字数から概算）
export function estimateCallDuration(message: string): number {
  // 日本語の読み上げ速度: 約300文字/分
  const charsPerMinute = 300;
  const duration = Math.ceil(message.length / charsPerMinute * 60); // 秒単位
  
  // 最小10秒、最大300秒
  return Math.max(10, Math.min(300, duration));
}