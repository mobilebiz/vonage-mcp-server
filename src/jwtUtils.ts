import { tokenGenerate } from '@vonage/jwt';
import type { ACL } from '@vonage/jwt';
import { readFileSync } from 'fs';

/**
 * JWT生成パラメータ
 */
export interface JWTGenerateParams {
  applicationId?: string;
  privateKeyPath?: string;
  expiresIn?: number; // 秒単位（デフォルト: 86400 = 24時間）
  subject?: string;
  aclPaths?: ACL;
}

/**
 * JWT生成結果
 */
export interface JWTGenerateResult {
  success: boolean;
  token?: string;
  error?: string;
  expiresAt?: string;
}

/**
 * Vonage Voice API用のJWTトークンを生成
 * 
 * @param params JWT生成パラメータ
 * @returns JWT生成結果
 */
export async function generateVonageJWT(params: JWTGenerateParams = {}): Promise<JWTGenerateResult> {
  try {
    // 環境変数から設定を取得（パラメータで上書き可能）
    const applicationId = params.applicationId || process.env.VONAGE_APPLICATION_ID;
    const privateKeyPath = params.privateKeyPath || process.env.VONAGE_PRIVATE_KEY_PATH;
    const expiresIn = params.expiresIn || 86400; // デフォルト24時間
    const subject = params.subject || 'VonageMCP';
    
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
    
    // 秘密鍵ファイルの読み込み
    let privateKey: Buffer;
    try {
      privateKey = readFileSync(privateKeyPath);
    } catch (error) {
      return {
        success: false,
        error: `秘密鍵ファイルの読み込みに失敗しました: ${privateKeyPath}`
      };
    }
    
    // デフォルトのACL設定（Voice API用）
    const defaultAclPaths: ACL = {
      paths: {
        '/*/users/**': {},
        '/*/conversations/**': {},
        '/*/sessions/**': {},
        '/*/devices/**': {},
        '/*/image/**': {},
        '/*/media/**': {},
        '/*/applications/**': {},
        '/*/push/**': {},
        '/*/knocking/**': {},
        '/*/legs/**': {}
      }
    };
    
    const aclPaths: ACL = params.aclPaths || defaultAclPaths;
    
    // 有効期限の計算
    const exp = Math.round(new Date().getTime() / 1000) + expiresIn;
    const expiresAt = new Date(exp * 1000).toISOString();
    
    // JWTトークンの生成
    const token = tokenGenerate(
      applicationId,
      privateKey,
      {
        exp,
        sub: subject,
        acl: aclPaths
      }
    );
    
    return {
      success: true,
      token,
      expiresAt
    };
    
  } catch (error) {
    return {
      success: false,
      error: `JWT生成エラー: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}
