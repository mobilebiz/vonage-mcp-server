import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createHash, createHmac } from 'crypto';

// Vonage関数をモック化（ネットワークアクセスを避ける）
const { mockSendSMS, mockMakeVoiceCall, mockSendBulkSMS } = vi.hoisted(() => {
  return {
    mockSendSMS: vi.fn(),
    mockMakeVoiceCall: vi.fn(),
    mockSendBulkSMS: vi.fn(),
  };
});

vi.mock('../src/vonage.js', async () => {
  const actual = await vi.importActual<typeof import('../src/vonage.js')>('../src/vonage.js');
  return { ...actual, sendSMS: mockSendSMS, sendBulkSMS: mockSendBulkSMS };
});

vi.mock('../src/voiceCall.js', async () => {
  const actual = await vi.importActual<typeof import('../src/voiceCall.js')>('../src/voiceCall.js');
  return { ...actual, makeVoiceCall: mockMakeVoiceCall };
});

// モック化の後にappをインポート
import { app } from '../src/http-server.js';
import { toolRateLimiter } from '../src/guardrails.js';
import { clearMessageStatusStore, getMessageStatus } from '../src/messageStatusStore.js';

/**
 * Vonageの署名付きWebhookと同じ形式のJWT（HS256 + payload_hash）を生成する。
 * jsonwebtoken を直接使わず、依存を増やさないため crypto で組み立てる。
 */
function signWebhookJwt(secret: string, body: unknown): string {
  const b64 = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const header = b64({ alg: 'HS256', typ: 'JWT' });
  const payload = b64({
    iat: Math.floor(Date.now() / 1000),
    jti: 'test-jti',
    payload_hash: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
  });
  const signature = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

/** レスポンスの content[0].text をJSONとしてパースする */
function payloadOf(res: request.Response): any {
  return JSON.parse(res.body.content[0].text);
}

describe('HTTP MCP Wrapper', () => {
  const TEST_API_KEY = 'test-api-key';

  beforeEach(() => {
    vi.clearAllMocks();
    toolRateLimiter.reset();
    clearMessageStatusStore();
    process.env.VONAGE_APPLICATION_ID = TEST_API_KEY;
    process.env.RATE_LIMIT_PER_HOUR = '0'; // テストではレートリミットを無効化
    delete process.env.ALLOWED_NUMBERS;
    delete process.env.BULK_MAX_ROWS;
    delete process.env.VONAGE_API_SIGNATURE_SECRET;
    // Webhook認証は既定で fail-closed のため、明示的に設定してから検証する
    process.env.VONAGE_WEBHOOK_SECRET = 'test-webhook-secret';
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

  it('POST /mcp-invoke は send_sms を正常に実行し軽量JSONを返すべき', async () => {
    mockSendSMS.mockResolvedValue({ success: true, messageId: 'msg-123' });

    const res = await request(app)
      .post('/mcp-invoke')
      .set('X-API-KEY', TEST_API_KEY)
      .send({ tool: 'send_sms', params: { to: '+819012345678', message: 'Hello' } });

    expect(res.status).toBe(200);
    expect(payloadOf(res)).toEqual({
      status: 'success',
      message_id: 'msg-123',
      to: '+819012345678',
    });
    expect(mockSendSMS).toHaveBeenCalledWith({ to: '+819012345678', message: 'Hello', from: undefined });
  });

  it('POST /mcp-invoke は無効な電話番号で 400 を返すべき', async () => {
    const res = await request(app)
      .post('/mcp-invoke')
      .set('X-API-KEY', TEST_API_KEY)
      .send({ tool: 'send_sms', params: { to: 'invalid', message: 'Hello' } });

    expect(res.status).toBe(400);
    expect(payloadOf(res).status).toBe('error');
    expect(payloadOf(res).suggestion).toBeTruthy();
    expect(mockSendSMS).not.toHaveBeenCalled();
  });

  it('POST /mcp-invoke は dry_run で送信せずに検証結果を返すべき', async () => {
    const res = await request(app)
      .post('/mcp-invoke')
      .set('X-API-KEY', TEST_API_KEY)
      .send({ tool: 'send_sms', params: { to: '09012345678', message: 'Hello', dry_run: true } });

    expect(res.status).toBe(200);
    expect(payloadOf(res)).toMatchObject({ status: 'dry_run_success', message: 'Ready to send' });
    expect(mockSendSMS).not.toHaveBeenCalled();
  });

  it('POST /mcp-invoke は ALLOWED_NUMBERS 外の宛先をブロックすべき', async () => {
    process.env.ALLOWED_NUMBERS = '+819087654321';

    const res = await request(app)
      .post('/mcp-invoke')
      .set('X-API-KEY', TEST_API_KEY)
      .send({ tool: 'send_sms', params: { to: '+819012345678', message: 'Hello' } });

    expect(res.status).toBe(400);
    expect(payloadOf(res).reason).toContain('許可されていません');
    expect(mockSendSMS).not.toHaveBeenCalled();
  });

  it('POST /mcp-invoke は make_voice_call を正常に実行すべき', async () => {
    mockMakeVoiceCall.mockResolvedValue({ success: true, callId: 'call-123' });

    const res = await request(app)
      .post('/mcp-invoke')
      .set('X-API-KEY', TEST_API_KEY)
      .send({ tool: 'make_voice_call', params: { to: '+819012345678', message: 'Test message' } });

    expect(res.status).toBe(200);
    expect(payloadOf(res)).toMatchObject({ status: 'success', call_id: 'call-123' });
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
    expect(res.body.tools.length).toBe(6);
    expect(res.body.tools[0].name).toBe('send_sms');
    expect(res.body.tools[0].inputSchema.properties.dry_run).toBeDefined();
    expect(res.body.tools.map((t: any) => t.name)).toContain('get_sms_status');
  });

  describe('POST /mcp (JSON-RPC)', () => {
    it('tools/list は全ツールを返すべき', async () => {
      const res = await request(app)
        .post('/mcp')
        .set('X-API-KEY', TEST_API_KEY)
        .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });

      expect(res.status).toBe(200);
      expect(res.body.result.tools.length).toBe(6);
    });

    it('tools/call は send_sms を実行すべき', async () => {
      mockSendSMS.mockResolvedValue({ success: true, messageId: 'msg-123' });

      const res = await request(app)
        .post('/mcp')
        .set('X-API-KEY', TEST_API_KEY)
        .send({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'send_sms', arguments: { to: '09012345678', message: 'Hello' } },
        });

      expect(res.status).toBe(200);
      expect(JSON.parse(res.body.result.content[0].text)).toMatchObject({ status: 'success' });
    });

    it('tools/call は未知のツールでエラーペイロードを返すべき', async () => {
      const res = await request(app)
        .post('/mcp')
        .set('X-API-KEY', TEST_API_KEY)
        .send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'nope', arguments: {} } });

      expect(res.status).toBe(200);
      expect(res.body.result.isError).toBe(true);
      expect(JSON.parse(res.body.result.content[0].text).status).toBe('error');
    });
  });

  describe('エラー種別ごとのHTTPステータス', () => {
    it('入力エラーは 400', async () => {
      const res = await request(app)
        .post('/mcp-invoke')
        .set('X-API-KEY', TEST_API_KEY)
        .send({ tool: 'send_sms', params: { to: 'abc', message: 'Hello' } });
      expect(res.status).toBe(400);
    });

    it('レートリミット超過は 429', async () => {
      process.env.RATE_LIMIT_PER_HOUR = '1';
      mockSendSMS.mockResolvedValue({ success: true, messageId: 'm' });

      await request(app)
        .post('/mcp-invoke')
        .set('X-API-KEY', TEST_API_KEY)
        .send({ tool: 'send_sms', params: { to: '09012345678', message: 'a' } });

      const res = await request(app)
        .post('/mcp-invoke')
        .set('X-API-KEY', TEST_API_KEY)
        .send({ tool: 'send_sms', params: { to: '09012345678', message: 'a' } });

      expect(res.status).toBe(429);
      expect(payloadOf(res).retry_after_seconds).toBeGreaterThan(0);
    });

    it('Vonage API の送信失敗は 200（v1.2.1以前と同じ挙動）', async () => {
      mockSendSMS.mockResolvedValue({ success: false, error: 'service unavailable' });

      const res = await request(app)
        .post('/mcp-invoke')
        .set('X-API-KEY', TEST_API_KEY)
        .send({ tool: 'send_sms', params: { to: '09012345678', message: 'a' } });

      expect(res.status).toBe(200);
      expect(payloadOf(res).status).toBe('error');
    });

    it('ステータス未検出は 404', async () => {
      const res = await request(app)
        .post('/mcp-invoke')
        .set('X-API-KEY', TEST_API_KEY)
        .send({ tool: 'get_sms_status', params: { message_id: 'unknown' } });

      expect(res.status).toBe(404);
    });

    it('想定外の例外は 500', async () => {
      mockSendSMS.mockRejectedValue(new Error('boom'));

      const res = await request(app)
        .post('/mcp-invoke')
        .set('X-API-KEY', TEST_API_KEY)
        .send({ tool: 'send_sms', params: { to: '09012345678', message: 'a' } });

      expect(res.status).toBe(500);
    });
  });

  describe('POST /webhooks/message-status', () => {
    it('共有シークレットが一致すればDLRを取り込むべき（x-api-key は不要）', async () => {
      const res = await request(app)
        .post('/webhooks/message-status')
        .set('x-webhook-secret', 'test-webhook-secret')
        .send({
          message_uuid: 'msg-abc',
          to: '819012345678',
          status: 'delivered',
          channel: 'sms',
          timestamp: '2026-08-04T10:00:00.000Z',
        });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        status: 'ok',
        message_id: 'msg-abc',
        delivery_status: 'delivered',
        ignored: false,
      });
      expect(getMessageStatus('msg-abc')!.status).toBe('delivered');
    });

    it('認証情報が無ければ 401 を返し、ステータスを取り込まないべき', async () => {
      const res = await request(app)
        .post('/webhooks/message-status')
        .send({ message_uuid: 'msg-spoof', status: 'delivered' });

      expect(res.status).toBe(401);
      expect(getMessageStatus('msg-spoof')).toBeNull();
    });

    it('シークレットが不一致なら 401 を返すべき', async () => {
      const res = await request(app)
        .post('/webhooks/message-status')
        .set('x-webhook-secret', 'wrong')
        .send({ message_uuid: 'msg-spoof', status: 'delivered' });

      expect(res.status).toBe(401);
      expect(getMessageStatus('msg-spoof')).toBeNull();
    });

    it('認証手段が一つも設定されていなければ 503 で無効化されるべき（fail-closed）', async () => {
      delete process.env.VONAGE_WEBHOOK_SECRET;
      delete process.env.VONAGE_API_SIGNATURE_SECRET;

      const res = await request(app)
        .post('/webhooks/message-status')
        .send({ message_uuid: 'msg-spoof', status: 'delivered' });

      expect(res.status).toBe(503);
      expect(getMessageStatus('msg-spoof')).toBeNull();
    });

    describe('署名付きJWT (VONAGE_API_SIGNATURE_SECRET)', () => {
      const SECRET = 'a'.repeat(32);

      beforeEach(() => {
        process.env.VONAGE_API_SIGNATURE_SECRET = SECRET;
        delete process.env.VONAGE_WEBHOOK_SECRET;
      });

      it('有効な署名なら取り込むべき', async () => {
        const body = { message_uuid: 'msg-signed', status: 'delivered' };
        const res = await request(app)
          .post('/webhooks/message-status')
          .set('Authorization', `Bearer ${signWebhookJwt(SECRET, body)}`)
          .send(body);

        expect(res.status).toBe(200);
        expect(getMessageStatus('msg-signed')!.status).toBe('delivered');
      });

      it('署名が改ざんされていれば 401', async () => {
        const body = { message_uuid: 'msg-bad', status: 'delivered' };
        const res = await request(app)
          .post('/webhooks/message-status')
          .set('Authorization', `Bearer ${signWebhookJwt(SECRET, body)}x`)
          .send(body);

        expect(res.status).toBe(401);
        expect(getMessageStatus('msg-bad')).toBeNull();
      });

      it('別のシークレットで署名されていれば 401', async () => {
        const body = { message_uuid: 'msg-bad', status: 'delivered' };
        const res = await request(app)
          .post('/webhooks/message-status')
          .set('Authorization', `Bearer ${signWebhookJwt('b'.repeat(32), body)}`)
          .send(body);

        expect(res.status).toBe(401);
        expect(getMessageStatus('msg-bad')).toBeNull();
      });

      it('Authorization ヘッダーが無ければ 401', async () => {
        const res = await request(app)
          .post('/webhooks/message-status')
          .send({ message_uuid: 'msg-bad2', status: 'delivered' });

        expect(res.status).toBe(401);
      });

      it('有効な署名でもボディが差し替えられていれば 401（payload_hash 不一致）', async () => {
        // 正規のボディに対して発行された署名を、別のボディで再利用する
        const token = signWebhookJwt(SECRET, { message_uuid: 'msg-legit', status: 'submitted' });

        const res = await request(app)
          .post('/webhooks/message-status')
          .set('Authorization', `Bearer ${token}`)
          .send({ message_uuid: 'msg-spoof', status: 'delivered' });

        expect(res.status).toBe(401);
        expect(getMessageStatus('msg-spoof')).toBeNull();
      });
    });

    it('不正なペイロードは 400 を返すべき', async () => {
      const res = await request(app)
        .post('/webhooks/message-status')
        .set('x-webhook-secret', 'test-webhook-secret')
        .send({ status: 'delivered' });
      expect(res.status).toBe(400);
    });

    it('古い通知は ignored: true で既存状態を維持すべき', async () => {
      await request(app)
        .post('/webhooks/message-status')
        .set('x-webhook-secret', 'test-webhook-secret')
        .send({ message_uuid: 'msg-ord', status: 'delivered', timestamp: '2026-08-04T10:00:00.000Z' });

      const res = await request(app)
        .post('/webhooks/message-status')
        .set('x-webhook-secret', 'test-webhook-secret')
        .send({ message_uuid: 'msg-ord', status: 'submitted', timestamp: '2026-08-04T09:00:00.000Z' });

      expect(res.status).toBe(200);
      expect(res.body.ignored).toBe(true);
      expect(getMessageStatus('msg-ord')!.status).toBe('delivered');
    });
  });
});
