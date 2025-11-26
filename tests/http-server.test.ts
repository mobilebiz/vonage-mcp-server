import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';

// Vonage関数をモック化
const { mockSendSMS, mockMakeVoiceCall, mockValidatePhoneNumber, mockSendBulkSMS, mockParseAndValidateCSV } = vi.hoisted(() => {
  return {
    mockSendSMS: vi.fn(),
    mockMakeVoiceCall: vi.fn(),
    mockValidatePhoneNumber: vi.fn(),
    mockSendBulkSMS: vi.fn(),
    mockParseAndValidateCSV: vi.fn(),
  };
});

vi.mock('../src/vonage.js', () => ({
  sendSMS: mockSendSMS,
  validatePhoneNumber: mockValidatePhoneNumber,
  sendBulkSMS: mockSendBulkSMS,
}));

vi.mock('../src/voiceCall.js', () => ({
  makeVoiceCall: mockMakeVoiceCall,
  validateVoiceName: vi.fn((name: string) => name === '女性' || name === '男性'),
  estimateCallDuration: vi.fn(() => 30),
  normalizeVoiceName: vi.fn((name: string) => name),
}));

vi.mock('../src/csvUtils.js', () => ({
  parseAndValidateCSV: mockParseAndValidateCSV,
  generateCSVSummary: vi.fn(() => 'CSV summary'),
}));

// モック化の後にappをインポート
import { app } from '../src/http-server.js';

describe('HTTP MCP Wrapper', () => {
  const TEST_API_KEY = 'test-api-key';

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.VONAGE_APPLICATION_ID = TEST_API_KEY;
  });

  it('GET /health は connected: true を返すべき（認証不要）', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', connected: true });
  });

  it('POST /mcp-invoke は tool パラメータがない場合 400 を返すべき', async () => {
    const res = await request(app)
      .post('/mcp-invoke')
      .set('X-API-KEY', TEST_API_KEY)
      .send({ params: {} });
    
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Missing "tool" parameter' });
  });

  it('認証キーがない場合 401 を返すべき', async () => {
    const res = await request(app)
      .post('/mcp-invoke')
      .send({ tool: 'send_sms' });
    
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Unauthorized: Invalid or missing API Key' });
  });

  it('認証キーが無効な場合 401 を返すべき', async () => {
    const res = await request(app)
      .post('/mcp-invoke')
      .set('X-API-KEY', 'invalid-key')
      .send({ tool: 'send_sms' });
    
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Unauthorized: Invalid or missing API Key' });
  });

  it('POST /mcp-invoke は send_sms を正常に実行すべき', async () => {
    mockValidatePhoneNumber.mockReturnValue(true);
    mockSendSMS.mockResolvedValue({ success: true, messageId: 'msg-123' });

    const res = await request(app)
      .post('/mcp-invoke')
      .set('X-API-KEY', TEST_API_KEY)
      .send({ tool: 'send_sms', params: { to: '+819012345678', message: 'Hello' } });
    
    expect(res.status).toBe(200);
    expect(res.body.content[0].text).toContain('SMS送信成功');
    expect(mockSendSMS).toHaveBeenCalledWith({ to: '+819012345678', message: 'Hello', from: undefined });
  });

  it('POST /mcp-invoke は無効な電話番号で 400 を返すべき', async () => {
    mockValidatePhoneNumber.mockReturnValue(false);

    const res = await request(app)
      .post('/mcp-invoke')
      .set('X-API-KEY', TEST_API_KEY)
      .send({ tool: 'send_sms', params: { to: 'invalid', message: 'Hello' } });
    
    expect(res.status).toBe(400);
    expect(res.body.content[0].text).toContain('無効な電話番号');
  });

  it('POST /mcp-invoke は make_voice_call を正常に実行すべき', async () => {
    mockValidatePhoneNumber.mockReturnValue(true);
    mockMakeVoiceCall.mockResolvedValue({ success: true, callId: 'call-123' });

    const res = await request(app)
      .post('/mcp-invoke')
      .set('X-API-KEY', TEST_API_KEY)
      .send({ tool: 'make_voice_call', params: { to: '+819012345678', message: 'Test message' } });
    
    expect(res.status).toBe(200);
    expect(res.body.content[0].text).toContain('音声通話を開始しました');
    expect(mockMakeVoiceCall).toHaveBeenCalled();
  });

  it('POST /mcp-invoke は不明なツールで 404 を返すべき', async () => {
    const res = await request(app)
      .post('/mcp-invoke')
      .set('X-API-KEY', TEST_API_KEY)
      .send({ tool: 'unknown_tool', params: {} });
    
    expect(res.status).toBe(404);
    expect(res.body.error).toContain('Unknown tool');
  });

  it('GET /mcp-tools はツール一覧を返すべき', async () => {
    const res = await request(app)
      .get('/mcp-tools')
      .set('X-API-KEY', TEST_API_KEY);
    
    expect(res.status).toBe(200);
    expect(res.body.tools).toBeDefined();
    expect(res.body.tools.length).toBeGreaterThan(0);
    expect(res.body.tools[0].name).toBe('send_sms');
  });
});
