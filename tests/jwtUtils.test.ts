import { describe, it, expect, beforeEach, vi } from 'vitest';
import { generateVonageJWT } from '../src/jwtUtils.js';
import * as fs from 'fs';

// Mock fs.readFileSync
vi.mock('fs', () => ({
  readFileSync: vi.fn()
}));

describe('JWT Generation', () => {
  const mockPrivateKey = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC...
-----END PRIVATE KEY-----`;

  beforeEach(() => {
    // Reset environment variables
    delete process.env.VONAGE_APPLICATION_ID;
    delete process.env.VONAGE_PRIVATE_KEY_PATH;
    
    // Reset mocks
    vi.clearAllMocks();
  });

  it('環境変数が設定されていない場合はエラーを返す', async () => {
    const result = await generateVonageJWT();
    
    expect(result.success).toBe(false);
    expect(result.error).toContain('Application ID');
  });

  it('秘密鍵ファイルが存在しない場合はエラーを返す', async () => {
    process.env.VONAGE_APPLICATION_ID = 'test-app-id';
    process.env.VONAGE_PRIVATE_KEY_PATH = './nonexistent.key';
    
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error('File not found');
    });
    
    const result = await generateVonageJWT();
    
    expect(result.success).toBe(false);
    expect(result.error).toContain('秘密鍵ファイルの読み込みに失敗');
  });

  it('有効なパラメータでJWTを生成できる', async () => {
    process.env.VONAGE_APPLICATION_ID = 'aaaaaaaa-bbbb-cccc-dddd-0123456789ab';
    process.env.VONAGE_PRIVATE_KEY_PATH = './private.key';
    
    vi.mocked(fs.readFileSync).mockReturnValue(Buffer.from(mockPrivateKey));
    
    const result = await generateVonageJWT();
    
    expect(result.success).toBe(true);
    expect(result.token).toBeDefined();
    expect(result.expiresAt).toBeDefined();
  });

  it('カスタムの有効期限を設定できる', async () => {
    process.env.VONAGE_APPLICATION_ID = 'aaaaaaaa-bbbb-cccc-dddd-0123456789ab';
    process.env.VONAGE_PRIVATE_KEY_PATH = './private.key';
    
    vi.mocked(fs.readFileSync).mockReturnValue(Buffer.from(mockPrivateKey));
    
    const expiresIn = 3600; // 1時間
    const result = await generateVonageJWT({ expiresIn });
    
    expect(result.success).toBe(true);
    expect(result.token).toBeDefined();
  });

  it('カスタムのサブジェクトを設定できる', async () => {
    process.env.VONAGE_APPLICATION_ID = 'aaaaaaaa-bbbb-cccc-dddd-0123456789ab';
    process.env.VONAGE_PRIVATE_KEY_PATH = './private.key';
    
    vi.mocked(fs.readFileSync).mockReturnValue(Buffer.from(mockPrivateKey));
    
    const result = await generateVonageJWT({ subject: 'TestUser' });
    
    expect(result.success).toBe(true);
    expect(result.token).toBeDefined();
  });
});
