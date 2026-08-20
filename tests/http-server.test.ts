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
import {
  clearMessageStatusStore,
  getMessageStatus,
  recordSubmitted,
} from '../src/messageStatusStore.js';
import { clearWebhookReplayCache } from '../src/webhookAuth.js';

/** jti はリプレイ検出の対象なので、テストごとに必ず別の値を使う */
let jtiCounter = 0;

/**
 * Vonageの署名付きWebhookと同じ形式のJWT（HS256 + payload_hash + iat + jti）を生成する。
 * jsonwebtoken を直接使わず、依存を増やさないため crypto で組み立てる。
 *
 * claims で個別の claim を上書き・削除できる（undefined を渡すとその claim を落とす）。
 */
function signWebhookJwt(
  secret: string,
  body: unknown,
  claims: Record<string, unknown> = {}
): string {
  const b64 = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const header = b64({ alg: 'HS256', typ: 'JWT' });

  const defaults: Record<string, unknown> = {
    iat: Math.floor(Date.now() / 1000),
    jti: `test-jti-${++jtiCounter}`,
    payload_hash: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
  };

  const merged: Record<string, unknown> = { ...defaults, ...claims };
  for (const [key, value] of Object.entries(merged)) {
    if (value === undefined) {
      delete merged[key];
    }
  }

  const payload = b64(merged);
  const signature = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

/** JSON-RPC の result.content[0].text をJSONとしてパースする */
function resultPayload(res: request.Response): any {
  return JSON.parse(res.body.result.content[0].text);
}

/**
 * Streamable HTTP が POST に要求する Accept ヘッダー。
 * 仕様上クライアントは application/json と text/event-stream の両方を
 * 受け入れると宣言する必要があり、欠けていると 406 になる。
 */
const MCP_ACCEPT = 'application/json, text/event-stream';

/** /mcp に JSON-RPC リクエストを投げる（認証トークンが設定されていれば添える） */
function callMcp(body: Record<string, unknown>): request.Test {
  const req = request(app).post('/mcp').set('Accept', MCP_ACCEPT);
  if (process.env.MCP_AUTH_TOKEN) {
    req.set('Authorization', `Bearer ${process.env.MCP_AUTH_TOKEN}`);
  }
  return req.send(body) as request.Test;
}

/** tools/call を1回実行する */
function callTool(name: string, args: Record<string, unknown>): request.Test {
  return callMcp({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
}

describe('HTTP MCP Wrapper', () => {
  const TEST_API_KEY = 'test-api-key';

  beforeEach(() => {
    vi.clearAllMocks();
    toolRateLimiter.reset();
    clearMessageStatusStore();
    clearWebhookReplayCache();
    delete process.env.WEBHOOK_MAX_AGE_SECONDS;
    // 既定は無認証（サーバー自体がループバックにしか bind されない構成）。
    // 認証を検証するテストだけが個別に設定する。
    delete process.env.MCP_AUTH_TOKEN;
    delete process.env.TRUST_UPSTREAM_AUTH;
    delete process.env.ALLOWED_ORIGINS;
    delete process.env.ALLOWED_HOSTS;
    process.env.VONAGE_APPLICATION_ID = TEST_API_KEY;
    delete process.env.RATE_LIMIT_PER_HOUR;
    // RATE_LIMIT_PER_HOUR=0 は「全拒否」の意味なので、無効化には使えない
    process.env.DISABLE_RATE_LIMIT = 'true';
    // capability は既定で全 OFF。ツールの挙動を検証するテストでは明示的に有効化する
    process.env.ENABLE_SMS = 'true';
    process.env.ENABLE_BULK_SMS = 'true';
    process.env.ENABLE_VOICE = 'true';

    delete process.env.ALLOWED_NUMBERS;
    delete process.env.BULK_MAX_ROWS;
    delete process.env.VONAGE_API_SIGNATURE_SECRET;
    // Webhook認証は既定で fail-closed のため、明示的に設定してから検証する
    process.env.VONAGE_WEBHOOK_SECRET = 'test-webhook-secret';
  });

  it('GET /health は connected: true を返すべき（認証不要）', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', connected: true });
    expect(res.body.version).toBeTruthy();
  });

  it('POST /mcp は JSON-RPC 2.0 以外を 400 で拒否する', async () => {
    const res = await callMcp({ jsonrpc: '1.0', id: 1, method: 'ping' });

    expect(res.status).toBe(400);
  });

  describe('Bearer トークン認証', () => {
    const TOKEN = 'a'.repeat(32);

    beforeEach(() => {
      process.env.MCP_AUTH_TOKEN = TOKEN;
    });

    it('トークンが無ければ 401', async () => {
      const res = await request(app)
        .post('/mcp')
        .set('Accept', MCP_ACCEPT)
        .send({ jsonrpc: '2.0', id: 1, method: 'ping' });

      expect(res.status).toBe(401);
      expect(res.body.error.message).toContain('bearer token');
    });

    it('トークンが違えば 401', async () => {
      const res = await request(app)
        .post('/mcp')
        .set('Accept', MCP_ACCEPT)
        .set('Authorization', `Bearer ${'b'.repeat(32)}`)
        .send({ jsonrpc: '2.0', id: 1, method: 'ping' });

      expect(res.status).toBe(401);
    });

    it('正しいトークンなら通る', async () => {
      const res = await request(app)
        .post('/mcp')
        .set('Accept', MCP_ACCEPT)
        .set('Authorization', `Bearer ${TOKEN}`)
        .send({ jsonrpc: '2.0', id: 1, method: 'ping' });

      expect(res.status).toBe(200);
    });

    // Application ID は公開識別子であって秘密情報ではない（VONAGE_MCP-9）
    it('Application ID を X-API-KEY に入れても通らない', async () => {
      const res = await request(app)
        .post('/mcp')
        .set('Accept', MCP_ACCEPT)
        .set('X-API-KEY', TEST_API_KEY)
        .send({ jsonrpc: '2.0', id: 1, method: 'ping' });

      expect(res.status).toBe(401);
    });

    // メソッドごとに認証を書くと、Streamable HTTP の GET / DELETE で漏れる
    it.each(['get', 'delete', 'put', 'patch'] as const)('%s /mcp も認証される', async (method) => {
      const res = await request(app)[method]('/mcp');
      expect(res.status).toBe(401);
    });

    it('TRUST_UPSTREAM_AUTH=true なら自前では認証しない', async () => {
      process.env.TRUST_UPSTREAM_AUTH = 'true';

      const res = await request(app)
        .post('/mcp')
        .set('Accept', MCP_ACCEPT)
        .send({ jsonrpc: '2.0', id: 1, method: 'ping' });

      expect(res.status).toBe(200);
    });
  });

  // MCP と等価な機能を独自インターフェースで二重に公開していた経路。
  // 片方だけ認証を直しても、もう片方が残っていれば全部迂回できる。
  describe('削除した独自エンドポイント (VONAGE_MCP-9)', () => {
    beforeEach(() => {
      process.env.MCP_AUTH_TOKEN = 'a'.repeat(32);
    });

    it('POST /mcp-invoke は存在しない', async () => {
      mockSendSMS.mockResolvedValue({ success: true, messageId: 'msg-123' });

      const res = await request(app)
        .post('/mcp-invoke')
        .set('X-API-KEY', TEST_API_KEY)
        .send({ tool: 'send_sms', params: { to: '+819012345678', message: 'Hello' } });

      expect(res.status).toBe(404);
      expect(mockSendSMS).not.toHaveBeenCalled();
    });

    it('GET /mcp-tools は存在しない', async () => {
      const res = await request(app).get('/mcp-tools').set('X-API-KEY', TEST_API_KEY);
      expect(res.status).toBe(404);
    });
  });

  describe('tools/call', () => {
    it('send_sms を実行し軽量JSONを返す', async () => {
      mockSendSMS.mockResolvedValue({ success: true, messageId: 'msg-123' });

      const res = await callTool('send_sms', { to: '+819012345678', message: 'Hello' });

      expect(res.status).toBe(200);
      expect(resultPayload(res)).toEqual({
        status: 'success',
        message_id: 'msg-123',
        to: '+819012345678',
      });
      expect(mockSendSMS).toHaveBeenCalledWith({
        to: '+819012345678',
        message: 'Hello',
        from: undefined,
      });
    });

    // スキーマ違反は SDK が inputSchema で弾くため、ハンドラに届く前に
    // JSON-RPC エラーになる。エラーメッセージにはスキーマに書いた
    // 日本語の説明がそのまま入る。
    it('スキーマに反する電話番号は送信せず JSON-RPC エラーになる', async () => {
      const res = await callTool('send_sms', { to: 'invalid', message: 'Hello' });

      expect(res.body.error.code).toBe(-32602);
      expect(res.body.error.message).toContain('E.164');
      expect(mockSendSMS).not.toHaveBeenCalled();
    });

    // 形式は正しいがガードレールで落ちるものはハンドラまで届くので、
    // reason + suggestion 形式のペイロードが返る
    it('スキーマは通るがガードレールで落ちる入力は result として返る', async () => {
      const res = await callTool('send_sms', { to: '0990123456', message: 'Hello' });

      expect(res.body.result.isError).toBe(true);
      expect(resultPayload(res).reason).toContain('高額課金');
      expect(resultPayload(res).suggestion).toBeTruthy();
      expect(mockSendSMS).not.toHaveBeenCalled();
    });

    it('dry_run では送信しない', async () => {
      const res = await callTool('send_sms', { to: '09012345678', message: 'Hello', dry_run: true });

      expect(resultPayload(res)).toMatchObject({ status: 'dry_run_success', message: 'Ready to send' });
      expect(mockSendSMS).not.toHaveBeenCalled();
    });

    it('ALLOWED_NUMBERS 外の宛先はブロックする', async () => {
      process.env.ALLOWED_NUMBERS = '+819087654321';

      const res = await callTool('send_sms', { to: '+819012345678', message: 'Hello' });

      expect(resultPayload(res).reason).toContain('許可されていません');
      expect(mockSendSMS).not.toHaveBeenCalled();
    });

    it('make_voice_call を実行できる', async () => {
      mockMakeVoiceCall.mockResolvedValue({ success: true, callId: 'call-123' });

      const res = await callTool('make_voice_call', { to: '+819012345678', message: 'Test message' });

      expect(resultPayload(res)).toMatchObject({ status: 'success', call_id: 'call-123' });
      expect(mockMakeVoiceCall).toHaveBeenCalled();
    });
  });

  describe('capability トグル', () => {
    it('無効なツールは tools/list に現れない', async () => {
      delete process.env.ENABLE_VOICE;
      delete process.env.ENABLE_BULK_SMS;

      const res = await callMcp({ jsonrpc: '2.0', id: 1, method: 'tools/list' });

      const names = res.body.result.tools.map((t: any) => t.name);
      expect(names).not.toContain('make_voice_call');
      expect(names).not.toContain('get_call_status');
      expect(names).not.toContain('bulk_sms_from_csv');
      expect(names).toContain('send_sms');
    });

    // 無効なツールは registerTool されないので、MCP 上は「存在しないツール」
    // として扱われる。tools/list に出さない以上これが正しい表現であり、
    // capability 名を含む詳しい案内は runTool のレベルで返す（tools.test.ts）。
    it('tools/call でも無効なツールは実行されない', async () => {
      delete process.env.ENABLE_VOICE;
      mockMakeVoiceCall.mockResolvedValue({ success: true, callId: 'c' });

      const res = await callTool('make_voice_call', { to: '09012345678', message: 'テスト' });

      expect(res.body.error).toBeTruthy();
      expect(mockMakeVoiceCall).not.toHaveBeenCalled();
    });
  });

  describe('CORS', () => {
    const EVIL = 'https://evil.example.com';
    const OK = 'https://console.example.com';

    // 開いていると、ブラウザ側がトークンを持つ構成で悪意あるページが
    // /mcp を呼び、レスポンスまで読み取れてしまう
    it('既定ではクロスオリジンを許可しない', async () => {
      const res = await request(app)
        .post('/mcp')
        .set('Accept', MCP_ACCEPT)
        .set('Origin', EVIL)
        .send({ jsonrpc: '2.0', id: 1, method: 'ping' });

      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('既定ではプリフライトを通さない', async () => {
      const res = await request(app)
        .options('/mcp')
        .set('Origin', EVIL)
        .set('Access-Control-Request-Method', 'POST');

      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('ALLOWED_ORIGINS に載せたオリジンだけ許可する', async () => {
      process.env.ALLOWED_ORIGINS = OK;

      const allowed = await request(app)
        .post('/mcp')
        .set('Accept', MCP_ACCEPT)
        .set('Origin', OK)
        .send({ jsonrpc: '2.0', id: 1, method: 'ping' });
      expect(allowed.headers['access-control-allow-origin']).toBe(OK);

      const denied = await request(app)
        .post('/mcp')
        .set('Accept', MCP_ACCEPT)
        .set('Origin', EVIL)
        .send({ jsonrpc: '2.0', id: 1, method: 'ping' });
      expect(denied.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('複数オリジンを指定できる', async () => {
      process.env.ALLOWED_ORIGINS = `${OK}, ${EVIL}`;

      const res = await request(app)
        .post('/mcp')
        .set('Accept', MCP_ACCEPT)
        .set('Origin', EVIL)
        .send({ jsonrpc: '2.0', id: 1, method: 'ping' });

      expect(res.headers['access-control-allow-origin']).toBe(EVIL);
    });
  });

  describe('DNS rebinding 対策 (Host 検証)', () => {
    // 攻撃者のドメインを 127.0.0.1 に解決させると、ブラウザからは同一オリジンに
    // 見えるため CORS では防げない。Host ヘッダーで弾く。
    it('ループバック運用では見知らぬ Host を 403 で拒否する', async () => {
      process.env.ALLOWED_HOSTS = 'localhost,127.0.0.1';

      const res = await request(app)
        .post('/mcp')
        .set('Accept', MCP_ACCEPT)
        .set('Host', 'attacker.example.com')
        .send({ jsonrpc: '2.0', id: 1, method: 'ping' });

      expect(res.status).toBe(403);
      expect(res.body.error.message).toContain('host not allowed');
    });

    // リバースプロキシ配下では Host のポートが待ち受けポートと一致しない
    it('ポートが違っても、ホスト名が一致すれば通す', async () => {
      process.env.ALLOWED_HOSTS = 'localhost';

      const res = await request(app)
        .post('/mcp')
        .set('Accept', MCP_ACCEPT)
        .set('Host', 'localhost:8443')
        .send({ jsonrpc: '2.0', id: 1, method: 'ping' });

      expect(res.status).toBe(200);
    });

    it('ALLOWED_HOSTS にポート付きで書かれていてもホスト名で比較する', async () => {
      process.env.ALLOWED_HOSTS = 'mcp.example.com:3000';

      const res = await request(app)
        .post('/mcp')
        .set('Accept', MCP_ACCEPT)
        .set('Host', 'mcp.example.com')
        .send({ jsonrpc: '2.0', id: 1, method: 'ping' });

      expect(res.status).toBe(200);
    });

    it('Host 検証は認証より先に効く', async () => {
      process.env.ALLOWED_HOSTS = 'localhost';
      process.env.MCP_AUTH_TOKEN = 'a'.repeat(32);

      const res = await request(app)
        .post('/mcp')
        .set('Accept', MCP_ACCEPT)
        .set('Host', 'attacker.example.com')
        .send({ jsonrpc: '2.0', id: 1, method: 'ping' });

      expect(res.status).toBe(403);
    });
  });

  describe('Streamable HTTP transport', () => {
    it('initialize はプロトコルバージョンとサーバー情報を返す', async () => {
      const res = await callMcp({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0.0' },
        },
      });

      expect(res.status).toBe(200);
      expect(res.body.result.serverInfo.name).toBe('vonage-mcp-server');
      expect(res.body.result.protocolVersion).toBeTruthy();
    });

    // ステートフルにするとレプリカ間でセッションが壊れる。
    // セッションIDを発行しないことを固定しておく。
    it('ステートレス動作: セッションIDを発行しない', async () => {
      const res = await callMcp({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } },
      });

      expect(res.headers['mcp-session-id']).toBeUndefined();
    });

    // セッションが無いので、initialize を経ずに tools/list を呼べる
    it('initialize 無しでも tools/list に応答する', async () => {
      const res = await callMcp({ jsonrpc: '2.0', id: 1, method: 'tools/list' });

      expect(res.status).toBe(200);
      expect(res.body.result.tools.length).toBe(5);
    });

    it('ping に応答する', async () => {
      const res = await callMcp({ jsonrpc: '2.0', id: 1, method: 'ping' });

      expect(res.status).toBe(200);
      expect(res.body.result).toEqual({});
    });

    it('tools/call は send_sms を実行する', async () => {
      mockSendSMS.mockResolvedValue({ success: true, messageId: 'msg-123' });

      const res = await callTool('send_sms', { to: '09012345678', message: 'Hello' });

      expect(res.status).toBe(200);
      expect(resultPayload(res)).toMatchObject({ status: 'success' });
    });

    it('tools/call は未知のツールで JSON-RPC エラーを返す', async () => {
      const res = await callTool('nope', {});

      expect(res.body.error).toBeTruthy();
      expect(res.body.error.message).toContain('nope');
    });

    it('未知のメソッドは JSON-RPC のエラーを返す', async () => {
      const res = await callMcp({ jsonrpc: '2.0', id: 1, method: 'no/such/method' });

      expect(res.body.error.code).toBe(-32601);
    });

    // 仕様上クライアントは両方を受け入れると宣言する必要がある
    it('Accept ヘッダーが不足していれば 406', async () => {
      const res = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json')
        .send({ jsonrpc: '2.0', id: 1, method: 'ping' });

      expect(res.status).toBe(406);
    });

    it('PUT / PATCH は 405', async () => {
      for (const method of ['put', 'patch'] as const) {
        const res = await request(app)[method]('/mcp').set('Accept', MCP_ACCEPT);
        expect(res.status, `${method} は 405 であるべき`).toBe(405);
      }
    });
  });

  // /mcp-invoke を削除したため、HTTPステータスへの写像は toolResponse の
  // 単体テスト（tests/toolResponse.test.ts）に移した。ここでは MCP の
  // JSON-RPC としての振る舞い — ツールのエラーは HTTP 200 の result として
  // 返る — を確認する。
  describe('ツールのエラーは JSON-RPC の result として返る', () => {
    it('ガードレール違反は HTTP 200 で isError が立つ', async () => {
      process.env.ALLOWED_NUMBERS = '+819087654321';

      const res = await callTool('send_sms', { to: '09012345678', message: 'Hello' });

      expect(res.status).toBe(200);
      expect(res.body.result.isError).toBe(true);
      expect(resultPayload(res).status).toBe('error');
    });

    it('レートリミット超過も result として返る', async () => {
      delete process.env.DISABLE_RATE_LIMIT;
      process.env.RATE_LIMIT_PER_HOUR = '1';
      mockSendSMS.mockResolvedValue({ success: true, messageId: 'm' });

      await callTool('send_sms', { to: '09012345678', message: 'a' });
      const res = await callTool('send_sms', { to: '09012345678', message: 'a' });

      expect(res.status).toBe(200);
      expect(resultPayload(res).retry_after_seconds).toBeGreaterThan(0);
    });

    it('Vonage API の送信失敗も result として返る', async () => {
      mockSendSMS.mockResolvedValue({ success: false, error: 'service unavailable' });

      const res = await callTool('send_sms', { to: '09012345678', message: 'a' });

      expect(res.status).toBe(200);
      expect(resultPayload(res).status).toBe('error');
    });

    it('想定外の例外も result として返る（プロセスは落ちない）', async () => {
      mockSendSMS.mockRejectedValue(new Error('boom'));

      const res = await callTool('send_sms', { to: '09012345678', message: 'a' });

      expect(res.status).toBe(200);
      expect(resultPayload(res).reason).toContain('boom');
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
        // 送信履歴に無いIDなので隔離バッファ行き（VONAGE_MCP-20）
        pending: true,
      });
      // まだ本ストアには入らない
      expect(getMessageStatus('msg-abc')).toBeNull();

      // 対応する送信が記録された時点で取り込まれる
      recordSubmitted('msg-abc', '+819012345678');
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
        recordSubmitted('msg-signed', '+819012345678');

        const body = { message_uuid: 'msg-signed', status: 'delivered' };
        const res = await request(app)
          .post('/webhooks/message-status')
          .set('Authorization', `Bearer ${signWebhookJwt(SECRET, body)}`)
          .send(body);

        expect(res.status).toBe(200);
        expect(res.body.pending).toBe(false);
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

      // 「claim が無ければ検証をスキップ」だと、攻撃者は claim を外すだけで
      // 検証そのものを無効化できる
      it.each(['payload_hash', 'iat', 'jti'])('%s claim が欠けていれば 401', async (claim) => {
        const body = { message_uuid: `msg-no-${claim}`, status: 'delivered' };

        const res = await request(app)
          .post('/webhooks/message-status')
          .set('Authorization', `Bearer ${signWebhookJwt(SECRET, body, { [claim]: undefined })}`)
          .send(body);

        expect(res.status).toBe(401);
        expect(res.body.error).toContain(claim);
        expect(getMessageStatus(body.message_uuid)).toBeNull();
      });

      it('古いJWTは 401（一度漏れた署名を無期限に使い回せない）', async () => {
        const body = { message_uuid: 'msg-old', status: 'delivered' };
        const oldIat = Math.floor(Date.now() / 1000) - 3600;

        const res = await request(app)
          .post('/webhooks/message-status')
          .set('Authorization', `Bearer ${signWebhookJwt(SECRET, body, { iat: oldIat })}`)
          .send(body);

        expect(res.status).toBe(401);
        expect(getMessageStatus('msg-old')).toBeNull();
      });

      // 時計を進めたJWTで有効期間を伸ばされないこと
      it('未来のJWTも 401', async () => {
        const body = { message_uuid: 'msg-future', status: 'delivered' };
        const futureIat = Math.floor(Date.now() / 1000) + 3600;

        const res = await request(app)
          .post('/webhooks/message-status')
          .set('Authorization', `Bearer ${signWebhookJwt(SECRET, body, { iat: futureIat })}`)
          .send(body);

        expect(res.status).toBe(401);
      });

      it('exp を過ぎたJWTは 401', async () => {
        const body = { message_uuid: 'msg-exp', status: 'delivered' };
        const exp = Math.floor(Date.now() / 1000) - 10;

        const res = await request(app)
          .post('/webhooks/message-status')
          .set('Authorization', `Bearer ${signWebhookJwt(SECRET, body, { exp })}`)
          .send(body);

        expect(res.status).toBe(401);
      });

      it('同じJWTの再送は 401（リプレイ検出）', async () => {
        recordSubmitted('msg-replay', '+819012345678');

        const body = { message_uuid: 'msg-replay', status: 'delivered' };
        const token = signWebhookJwt(SECRET, body);

        const first = await request(app)
          .post('/webhooks/message-status')
          .set('Authorization', `Bearer ${token}`)
          .send(body);
        expect(first.status).toBe(200);

        const second = await request(app)
          .post('/webhooks/message-status')
          .set('Authorization', `Bearer ${token}`)
          .send(body);

        expect(second.status).toBe(401);
        expect(second.body.error).toContain('replay');
      });

      it('WEBHOOK_MAX_AGE_SECONDS で許容幅を広げられる', async () => {
        process.env.WEBHOOK_MAX_AGE_SECONDS = '3600';
        const body = { message_uuid: 'msg-window', status: 'delivered' };
        const oldIat = Math.floor(Date.now() / 1000) - 1800;

        const res = await request(app)
          .post('/webhooks/message-status')
          .set('Authorization', `Bearer ${signWebhookJwt(SECRET, body, { iat: oldIat })}`)
          .send(body);

        expect(res.status).toBe(200);
      });

      // Authorization ヘッダーを外すだけで弱い方式を選べてしまってはいけない
      describe('共有シークレットへのフォールバックをしない', () => {
        beforeEach(() => {
          process.env.VONAGE_WEBHOOK_SECRET = 'test-webhook-secret';
        });

        it('署名が不正なら、正しい共有シークレットを添えても 401', async () => {
          const body = { message_uuid: 'msg-downgrade1', status: 'delivered' };

          const res = await request(app)
            .post('/webhooks/message-status')
            .set('Authorization', `Bearer ${signWebhookJwt('b'.repeat(32), body)}`)
            .set('x-webhook-secret', 'test-webhook-secret')
            .send(body);

          expect(res.status).toBe(401);
          expect(getMessageStatus('msg-downgrade1')).toBeNull();
        });

        it('Authorization を省いて共有シークレットだけ送っても 401', async () => {
          const body = { message_uuid: 'msg-downgrade2', status: 'delivered' };

          const res = await request(app)
            .post('/webhooks/message-status')
            .set('x-webhook-secret', 'test-webhook-secret')
            .send(body);

          expect(res.status).toBe(401);
          expect(getMessageStatus('msg-downgrade2')).toBeNull();
        });
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
      // 順序保護は本ストアのレコードに対する挙動なので、送信を先に記録する
      recordSubmitted('msg-ord', '+819012345678');

      await request(app)
        .post('/webhooks/message-status')
        .set('x-webhook-secret', 'test-webhook-secret')
        .send({
          message_uuid: 'msg-ord',
          status: 'delivered',
          timestamp: new Date(Date.now() + 2000).toISOString(),
        });

      const res = await request(app)
        .post('/webhooks/message-status')
        .set('x-webhook-secret', 'test-webhook-secret')
        .send({
          message_uuid: 'msg-ord',
          status: 'submitted',
          timestamp: new Date(Date.now() + 1000).toISOString(),
        });

      expect(res.status).toBe(200);
      expect(res.body.ignored).toBe(true);
      expect(getMessageStatus('msg-ord')!.status).toBe('delivered');
    });
  });
});
