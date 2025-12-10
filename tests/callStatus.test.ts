import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getCallStatus } from '../src/callStatus.js';
import * as fs from 'fs';

// Mock fs.readFileSync
vi.mock('fs', () => ({
  readFileSync: vi.fn()
}));

// Mock @vonage/server-sdk
vi.mock('@vonage/server-sdk', () => ({
  Vonage: vi.fn().mockImplementation(() => ({
    voice: {
      getCall: vi.fn()
    }
  }))
}));

describe('Call Status Retrieval', () => {
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
    const result = await getCallStatus({ callId: 'test-call-id' });
    
    expect(result.success).toBe(false);
    expect(result.error).toContain('Application ID');
  });

  it('Call IDが指定されていない場合はエラーを返す', async () => {
    process.env.VONAGE_APPLICATION_ID = 'test-app-id';
    process.env.VONAGE_PRIVATE_KEY_PATH = './private.key';
    
    const result = await getCallStatus({ callId: '' });
    
    expect(result.success).toBe(false);
    expect(result.error).toContain('Call ID');
  });

  it('秘密鍵ファイルが存在しない場合はエラーを返す', async () => {
    process.env.VONAGE_APPLICATION_ID = 'test-app-id';
    process.env.VONAGE_PRIVATE_KEY_PATH = './nonexistent.key';
    
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error('File not found');
    });
    
    const result = await getCallStatus({ callId: 'test-call-id' });
    
    expect(result.success).toBe(false);
    expect(result.error).toContain('秘密鍵ファイルの読み込みに失敗');
  });

  it('有効なCall IDで通話ステータスを取得できる', async () => {
    process.env.VONAGE_APPLICATION_ID = 'test-app-id';
    process.env.VONAGE_PRIVATE_KEY_PATH = './private.key';
    
    vi.mocked(fs.readFileSync).mockReturnValue(mockPrivateKey);
    
    // Mock successful API response
    const { Vonage } = await import('@vonage/server-sdk');
    const mockVonageInstance = new Vonage({} as any);
    vi.mocked(mockVonageInstance.voice.getCall).mockResolvedValue({
      status: 'completed',
      price: '0.06287850',
      rate: '0.13973000',
      duration: '27'
    } as any);
    
    const result = await getCallStatus({ callId: 'ca6b7710-3423-4c8d-b630-7b981ec4b2c2' });
    
    expect(result.success).toBe(true);
    expect(result.status).toBe('completed');
    expect(result.duration).toBe(27);
  });
});
