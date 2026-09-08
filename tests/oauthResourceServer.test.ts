import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';

// Vonage 関数をモック化（ネットワークアクセスを避ける）
const { mockSendSMS, mockMakeVoiceCall } = vi.hoisted(() => {
  return { mockSendSMS: vi.fn(), mockMakeVoiceCall: vi.fn() };
});

vi.mock('../src/vonage.js', async () => {
  const actual = await vi.importActual<typeof import('../src/vonage.js')>('../src/vonage.js');
  return { ...actual, sendSMS: mockSendSMS };
});

vi.mock('../src/voiceCall.js', async () => {
  const actual = await vi.importActual<typeof import('../src/voiceCall.js')>('../src/voiceCall.js');
  return { ...actual, makeVoiceCall: mockMakeVoiceCall };
});

import { app } from '../src/http-server.js';
import {
  ConfigError,
  getBindHost,
  getOAuthConfig,
  isHttpAuthConfigured,
  validateStartupConfig,
  type OAuthConfig,
} from '../src/config.js';
import {
  buildWwwAuthenticate,
  clearJwksCache,
  extractScopes,
  parseAuthorizationHeader,
  protectedResourceMetadata,
  protectedResourceMetadataPaths,
  resourceMetadataUrl,
  setJwksResolverForTesting,
  verifyAccessToken,
} from '../src/oauthResourceServer.js';

/** このスイートが触る環境変数（テストごとに完全にクリアする） */
const MANAGED_ENV = [
  'OAUTH_ISSUER',
  'OAUTH_RESOURCE',
  'OAUTH_JWKS_URI',
  'OAUTH_AUDIENCE',
  'OAUTH_SCOPES_SUPPORTED',
  'OAUTH_REQUIRED_SCOPE',
  'OAUTH_REQUIRE_AT_JWT',
  'MCP_AUTH_TOKEN',
  'TRUST_UPSTREAM_AUTH',
  'BIND_HOST',
  'ALLOWED_HOSTS',
  'ALLOWED_ORIGINS',
];

const ISSUER = 'https://idp.example.com';
const RESOURCE = 'https://mcp.example.com/mcp';
const JWKS_URI = 'https://idp.example.com/.well-known/jwks.json';

const MCP_ACCEPT = 'application/json, text/event-stream';

/** 署名鍵。1度だけ作って使い回す（鍵生成は遅い） */
const keys = await generateKeyPair('RS256');

/**
 * ネットワークに出ない JWKS 解決器。
 *
 * **公開鍵をそのまま返すだけのモックにはしない。** それだと jose の鍵選択
 * （kid の照合、alg の対応可否）を通らず、実際には鍵の解決中に落ちるケースを
 * 「解決に成功した」ものとして扱ってしまう。`createLocalJWKSet` は本番と同じ
 * 選択ロジックを通る。 */
const localJwks = createLocalJWKSet({
  keys: [{ ...(await exportJWK(keys.publicKey)), alg: 'RS256' }],
});

function configure(overrides: Record<string, string | undefined> = {}): void {
  process.env.OAUTH_ISSUER = ISSUER;
  process.env.OAUTH_RESOURCE = RESOURCE;
  process.env.OAUTH_JWKS_URI = JWKS_URI;

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

/**
 * 認可サーバーが発行したのと同じ形のアクセストークンを作る。
 *
 * 既定はこのサーバー宛の正当なトークン。個々のテストは claim を1つだけ
 * 壊して、その1つが検証されていることを確かめる。
 */
async function issueToken(
  claims: {
    aud?: string;
    iss?: string;
    scope?: string;
    expiresIn?: string;
    sub?: string;
    /** true にすると exp を付けない（無期限トークン） */
    withoutExpiry?: boolean;
  } = {}
): Promise<string> {
  let jwt = new SignJWT({
    ...(claims.scope === undefined ? {} : { scope: claims.scope }),
  })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuedAt()
    .setIssuer(claims.iss ?? ISSUER)
    .setAudience(claims.aud ?? RESOURCE)
    .setSubject(claims.sub ?? 'user-1');

  if (claims.withoutExpiry !== true) {
    jwt = jwt.setExpirationTime(claims.expiresIn ?? '5m');
  }

  return jwt.sign(keys.privateKey);
}

beforeEach(() => {
  for (const name of MANAGED_ENV) {
    delete process.env[name];
  }

  clearJwksCache();
  // JWKS の取得はネットワークに出るため、手元の鍵集合に差し替える。
  // 差し替えないと、認証まわりのテストが IdP の可用性に依存する。
  setJwksResolverForTesting(localJwks);
});

afterAll(() => {
  setJwksResolverForTesting(null);
});

describe('OAuth 設定の解釈', () => {
  it('OAUTH_* が1つも無ければ null（既定では OAuth モードに入らない）', () => {
    expect(getOAuthConfig()).toBeNull();
  });

  it('必須の3つが揃えば設定を返し、audience は resource に既定する', () => {
    configure();

    expect(getOAuthConfig()).toEqual<OAuthConfig>({
      issuer: ISSUER,
      resource: RESOURCE,
      audience: RESOURCE,
      jwksUri: JWKS_URI,
      scopesSupported: null,
      requiredScope: null,
      requireAtJwt: false,
      loopbackHttp: false,
    });
  });

  it('OAUTH_AUDIENCE を指定すればそちらを使う（IdP の API 識別子が URI と違う場合）', () => {
    configure({ OAUTH_AUDIENCE: 'vonage-mcp-api' });

    expect(getOAuthConfig()?.audience).toBe('vonage-mcp-api');
  });

  // 部分設定を黙って無視すると、「OAuth にしたつもりのサーバーが実は
  // 静的トークンで動いていた」という最も気づきにくい形になる
  it('OAUTH_ISSUER だけ設定すると起動エラーになる', () => {
    process.env.OAUTH_ISSUER = ISSUER;

    expect(() => getOAuthConfig()).toThrow(ConfigError);

    try {
      getOAuthConfig();
    } catch (error) {
      const messages = (error as ConfigError).message;
      expect(messages).toContain('OAUTH_RESOURCE');
      expect(messages).toContain('OAUTH_JWKS_URI');
    }
  });

  it('http の issuer は拒否する（アクセストークンが平文で流れる）', () => {
    configure({ OAUTH_ISSUER: 'http://idp.example.com' });

    expect(() => getOAuthConfig()).toThrow(ConfigError);
  });

  it('ループバックの http は手元での確認用に許す', () => {
    configure({
      OAUTH_ISSUER: 'http://localhost:8080',
      OAUTH_RESOURCE: 'http://127.0.0.1:3000/mcp',
      OAUTH_JWKS_URI: 'http://localhost:8080/jwks',
    });

    expect(getOAuthConfig()?.issuer).toBe('http://localhost:8080');
  });

  it('URL として解釈できない値は起動エラー', () => {
    configure({ OAUTH_RESOURCE: 'mcp.example.com' });

    expect(() => getOAuthConfig()).toThrow(ConfigError);
  });

  // RFC 8707 の canonical URI はフラグメントを持てない
  it('OAUTH_RESOURCE のフラグメントとクエリは拒否する', () => {
    configure({ OAUTH_RESOURCE: 'https://mcp.example.com/mcp#fragment' });
    expect(() => getOAuthConfig()).toThrow(ConfigError);

    configure({ OAUTH_RESOURCE: 'https://mcp.example.com/mcp?a=1' });
    expect(() => getOAuthConfig()).toThrow(ConfigError);
  });

  // issuer は OAuth の識別子で、末尾スラッシュの有無で別物として扱われる。
  // こちらで正規化すると、IdP の設定どおりに書いた運用者のトークンが
  // iss 不一致で 401 になる
  // issuer 識別子はクエリもフラグメントも持てない（RFC 8414）。持ったまま起動できると、
  // メタデータには載るのに discovery の URL を組み立てる段階で落ちる
  it('OAUTH_ISSUER のフラグメントとクエリは拒否する', () => {
    configure({ OAUTH_ISSUER: 'https://idp.example.com#x' });
    expect(() => getOAuthConfig()).toThrow(ConfigError);

    configure({ OAUTH_ISSUER: 'https://idp.example.com?x=1' });
    expect(() => getOAuthConfig()).toThrow(ConfigError);
  });

  // WHATWG URL は `?` だけ・`#` だけを空文字として扱うため、パース結果を見ると
  // 素通りする。しかし設定値は区切り文字を含んだまま iss と比較されるので、
  // 起動は成功するのに1本も通らないサーバーができる
  it.each(['https://idp.example.com?', 'https://idp.example.com#'])(
    '区切り文字だけの issuer（%s）も拒否する',
    (issuer) => {
      configure({ OAUTH_ISSUER: issuer });

      expect(() => getOAuthConfig()).toThrow(ConfigError);
    }
  );

  it.each(['https://mcp.example.com/mcp?', 'https://mcp.example.com/mcp#'])(
    '区切り文字だけの resource（%s）も拒否する',
    (resource) => {
      configure({ OAUTH_RESOURCE: resource });

      expect(() => getOAuthConfig()).toThrow(ConfigError);
    }
  );

  it('末尾のスラッシュを含め、書かれたとおりの値を使う', () => {
    configure({ OAUTH_ISSUER: 'https://idp.example.com/', OAUTH_RESOURCE: 'https://mcp.example.com/' });

    expect(getOAuthConfig()?.issuer).toBe('https://idp.example.com/');
    expect(getOAuthConfig()?.resource).toBe('https://mcp.example.com/');
  });

  it('OAUTH_REQUIRED_SCOPE に使えない文字があれば起動エラー', () => {
    configure({ OAUTH_REQUIRED_SCOPE: 'sms:送信' });

    expect(() => getOAuthConfig()).toThrow(ConfigError);
  });

  // 2つを1つの it にまとめると、片方の不正値がもう片方の検証漏れを隠す
  it('OAUTH_SCOPES_SUPPORTED に使えない文字があれば起動エラー', () => {
    configure({ OAUTH_SCOPES_SUPPORTED: 'sms:send, sms"send' });

    expect(() => getOAuthConfig()).toThrow(ConfigError);
  });

  // new URL('http://[::1]:8080').hostname は角括弧つきで返る
  it('IPv6 のループバックも http で許す', () => {
    configure({
      OAUTH_ISSUER: 'http://[::1]:8080',
      OAUTH_RESOURCE: 'http://[::1]:3000/mcp',
      OAUTH_JWKS_URI: 'http://[::1]:8080/jwks',
    });

    expect(getOAuthConfig()?.issuer).toBe('http://[::1]:8080');
  });

  it('OAUTH_SCOPES_SUPPORTED はカンマ区切りで読む', () => {
    configure({ OAUTH_SCOPES_SUPPORTED: 'sms:send, sms:read ' });

    expect(getOAuthConfig()?.scopesSupported).toEqual(['sms:send', 'sms:read']);
  });

  // ここを落とすと、OAuth だけ設定したサーバーが「認証なし」と判定されて
  // 127.0.0.1 にしか bind されず、正しく設定したのに外から繋がらない
  it('OAuth 設定だけでも HTTP 認証が構成済みと判定される', () => {
    configure();

    expect(isHttpAuthConfigured()).toBe(true);
    expect(getBindHost()).toBe('0.0.0.0');
  });

  // http を許しているのは「手元で試すあいだだけ」という前提。その構成で
  // 0.0.0.0 に bind すると、平文でトークンを受け取るサーバーが外に出る
  it('ループバックの http な OAuth 設定では 0.0.0.0 に bind しない', () => {
    configure({
      OAUTH_ISSUER: 'http://localhost:8080',
      OAUTH_RESOURCE: 'http://localhost:3000/mcp',
      OAUTH_JWKS_URI: 'http://localhost:8080/jwks',
    });

    expect(getOAuthConfig()?.loopbackHttp).toBe(true);
    expect(getBindHost()).toBe('127.0.0.1');
  });

  it('ループバックの http な OAuth 設定で外部アドレスを指定すると起動エラー', () => {
    configure({
      OAUTH_ISSUER: 'http://localhost:8080',
      OAUTH_RESOURCE: 'http://localhost:3000/mcp',
      OAUTH_JWKS_URI: 'http://localhost:8080/jwks',
      BIND_HOST: '0.0.0.0',
    });

    expect(() => validateStartupConfig()).toThrow(ConfigError);
  });

  // 認証は OR 条件なので、静的トークンがあってもアクセストークンだけで通過できる。
  // 静的トークンの存在は、その通信が暗号化されることを何も保証しない
  it('MCP_AUTH_TOKEN を併用しても、http な OAuth 設定なら外に出さない', () => {
    configure({
      OAUTH_ISSUER: 'http://localhost:8080',
      OAUTH_RESOURCE: 'http://localhost:3000/mcp',
      OAUTH_JWKS_URI: 'http://localhost:8080/jwks',
      MCP_AUTH_TOKEN: 'a'.repeat(32),
    });

    expect(getBindHost()).toBe('127.0.0.1');
  });

  it('MCP_AUTH_TOKEN を併用しても、外部 BIND_HOST は起動エラーのまま', () => {
    configure({
      OAUTH_ISSUER: 'http://localhost:8080',
      OAUTH_RESOURCE: 'http://localhost:3000/mcp',
      OAUTH_JWKS_URI: 'http://localhost:8080/jwks',
      MCP_AUTH_TOKEN: 'a'.repeat(32),
      BIND_HOST: '0.0.0.0',
    });

    expect(() => validateStartupConfig()).toThrow(ConfigError);
  });
});

describe('保護リソースメタデータ', () => {
  function config(overrides: Partial<OAuthConfig> = {}): OAuthConfig {
    return {
      issuer: ISSUER,
      resource: RESOURCE,
      audience: RESOURCE,
      jwksUri: JWKS_URI,
      scopesSupported: null,
      requiredScope: null,
      requireAtJwt: false,
      loopbackHttp: false,
      ...overrides,
    };
  }

  // クライアントによって「パス付きを先に試す」ものと「ルートに落とす」ものがある
  it('パス付きとルートの両方を配る', () => {
    expect(protectedResourceMetadataPaths(config())).toEqual([
      '/.well-known/oauth-protected-resource/mcp',
      '/.well-known/oauth-protected-resource',
    ]);
  });

  // RFC 9728 はリソースのパスをそのまま差し込む。削って配ると、導出した
  // エンドポイントを引くクライアントが 404 を受け取る
  it('リソースパスの末尾スラッシュを保ったまま配る', () => {
    expect(protectedResourceMetadataPaths(config({ resource: 'https://mcp.example.com/mcp/' }))).toEqual([
      '/.well-known/oauth-protected-resource/mcp/',
      '/.well-known/oauth-protected-resource/mcp',
      '/.well-known/oauth-protected-resource',
    ]);
  });

  it('リソースにパスが無ければルートだけ', () => {
    expect(protectedResourceMetadataPaths(config({ resource: 'https://mcp.example.com' }))).toEqual([
      '/.well-known/oauth-protected-resource',
    ]);
  });

  it('resource / authorization_servers / bearer_methods_supported を含む', () => {
    expect(protectedResourceMetadata(config())).toEqual({
      resource: RESOURCE,
      authorization_servers: [ISSUER],
      bearer_methods_supported: ['header'],
    });
  });

  it('scopes_supported は設定されているときだけ載せる', () => {
    expect(protectedResourceMetadata(config({ scopesSupported: ['sms:send'] })).scopes_supported).toEqual([
      'sms:send',
    ]);
  });

  // Host ヘッダーから組み立てると、攻撃者のメタデータへ誘導する 401 を作れる
  it('メタデータ URL は設定値の origin から決まる', () => {
    expect(resourceMetadataUrl(config())).toBe(
      'https://mcp.example.com/.well-known/oauth-protected-resource/mcp'
    );
  });
});

describe('WWW-Authenticate', () => {
  const base: OAuthConfig = {
    issuer: ISSUER,
    resource: RESOURCE,
    audience: RESOURCE,
    jwksUri: JWKS_URI,
    scopesSupported: null,
    requiredScope: null,
    requireAtJwt: false,
    loopbackHttp: false,
  };

  it('resource_metadata を必ず載せる（discovery の起点）', () => {
    expect(buildWwwAuthenticate(base)).toBe(
      'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp"'
    );
  });

  it('必須 scope があれば scope を載せる', () => {
    expect(buildWwwAuthenticate({ ...base, requiredScope: 'sms:send' })).toContain('scope="sms:send"');
  });

  it('error は載せるが、error_description は載せない', () => {
    const value = buildWwwAuthenticate(base, 'invalid_token');

    expect(value).toContain('error="invalid_token"');
    // 理由の文面は日本語で、Node の setHeader が ISO-8859-1 の範囲外を弾く。
    // 本文に入れるので情報は失われない
    expect(value).not.toContain('error_description');
  });

  // OAUTH_REQUIRED_SCOPE に日本語を書かれただけで、401 を返そうとした
  // サーバーが setHeader の例外で 500 を返すようになる
  it('ASCII 以外を落として setHeader の例外を防ぐ', () => {
    const value = buildWwwAuthenticate({ ...base, requiredScope: 'sms:送信' });

    expect(value).toContain('scope="sms:"');
    // eslint-disable-next-line no-control-regex
    expect(/^[\u0020-\u007e]*$/.test(value)).toBe(true);
  });

  // 環境変数の値がそのままヘッダーに入るため、改行を混ぜられるとヘッダーを分割できる
  it('引用符と制御文字を落としてヘッダー分割を防ぐ', () => {
    const value = buildWwwAuthenticate({ ...base, requiredScope: 'a"\r\nX-Injected: 1' });

    expect(value).not.toContain('\n');
    expect(value).not.toContain('\r');
    expect(value).toContain('scope="aX-Injected: 1"');
  });
});

describe('scope の取り出し', () => {
  it('scope は空白区切りの文字列', () => {
    expect(extractScopes({ scope: 'sms:send sms:read' })).toEqual(['sms:send', 'sms:read']);
  });

  // Entra ID は scp を使う。片方しか見ないと IdP を変えた瞬間に全部 403 になる
  it('scp の配列も読む', () => {
    expect(extractScopes({ scp: ['sms:send'] } as never)).toEqual(['sms:send']);
  });

  it('scp の文字列も読む', () => {
    expect(extractScopes({ scp: 'sms:send sms:read' } as never)).toEqual(['sms:send', 'sms:read']);
  });

  it('どちらも無ければ空', () => {
    expect(extractScopes({})).toEqual([]);
  });
});

describe('Authorization ヘッダーの解釈', () => {
  it('Bearer を大文字小文字を問わず読む', () => {
    expect(parseAuthorizationHeader('bearer abc')).toEqual({ kind: 'bearer', token: 'abc' });
  });

  // 「送っていない」と「送ったが形式が違う」で返すべき応答が違う（RFC 6750 3.1）
  it('未送信は absent', () => {
    expect(parseAuthorizationHeader(undefined)).toEqual({ kind: 'absent' });
    expect(parseAuthorizationHeader('   ')).toEqual({ kind: 'absent' });
  });

  // RFC 6750 は未対応の認証方式を「認証情報が無い」のと並べて例示している
  it('Bearer 以外の方式は other-scheme', () => {
    expect(parseAuthorizationHeader('Basic abc')).toEqual({ kind: 'other-scheme' });
  });

  it('Bearer だが中身が無ければ malformed', () => {
    expect(parseAuthorizationHeader('Bearer   ')).toEqual({ kind: 'malformed' });
    expect(parseAuthorizationHeader('Bearer')).toEqual({ kind: 'malformed' });
  });
});

describe('アクセストークンの検証', () => {
  function config(overrides: Partial<OAuthConfig> = {}): OAuthConfig {
    return {
      issuer: ISSUER,
      resource: RESOURCE,
      audience: RESOURCE,
      jwksUri: JWKS_URI,
      scopesSupported: null,
      requiredScope: null,
      requireAtJwt: false,
      loopbackHttp: false,
      ...overrides,
    };
  }

  it('自分宛の有効なトークンは通る', async () => {
    const result = await verifyAccessToken(await issueToken(), config());

    expect(result).toMatchObject({ ok: true, subject: 'user-1' });
  });

  // 仕様の MUST。ここを省くと、同じ IdP が別サービス向けに出したトークンで
  // このサーバーが動く。その利用者は SMS を送る同意をしていない
  it('別のサービス宛のトークンは拒否する（audience 検証）', async () => {
    const result = await verifyAccessToken(await issueToken({ aud: 'https://other.example.com' }), config());

    expect(result).toMatchObject({ ok: false, status: 401, error: 'invalid_token' });
  });

  it('別の認可サーバーが発行したトークンは拒否する（issuer 検証）', async () => {
    const result = await verifyAccessToken(await issueToken({ iss: 'https://evil.example.com' }), config());

    expect(result).toMatchObject({ ok: false, status: 401, error: 'invalid_token' });
  });

  it('期限切れのトークンは理由を添えて拒否する', async () => {
    const result = await verifyAccessToken(await issueToken({ expiresIn: '-1s' }), config());

    expect(result).toMatchObject({ ok: false, status: 401 });
    expect(result.ok === false && result.description).toContain('有効期限');
  });

  // exp を必須にしないと、漏れた1本を失効させる手段が無くなる
  it('有効期限を持たないトークンは拒否する', async () => {
    const result = await verifyAccessToken(await issueToken({ withoutExpiry: true }), config());

    expect(result).toMatchObject({ ok: false, status: 401, error: 'invalid_token' });
    expect(result.ok === false && result.description).toContain('exp');
  });

  it('末尾スラッシュ付きの issuer でも、設定どおりなら通る', async () => {
    const issuer = 'https://idp.example.com/';
    const result = await verifyAccessToken(await issueToken({ iss: issuer }), config({ issuer }));

    expect(result.ok).toBe(true);
  });

  it('署名が壊れていれば拒否する', async () => {
    const token = await issueToken();
    const tampered = `${token.slice(0, -3)}aaa`;

    const result = await verifyAccessToken(tampered, config());

    expect(result).toMatchObject({ ok: false, status: 401, error: 'invalid_token' });
  });

  // 鍵を取りに行けなかっただけで invalid_token を返すと、クライアントは
  // 正当なトークンを捨てて取り直しに行く。不調な IdP に追加の負荷を掛ける
  it('署名鍵を取得できないときは 503 を返し、トークンのせいにしない', async () => {
    const token = await issueToken();
    setJwksResolverForTesting(() => {
      const error = new Error('Timeout') as Error & { code: string };
      error.code = 'ERR_JWKS_TIMEOUT';
      throw error;
    });

    const result = await verifyAccessToken(token, config());

    expect(result).toMatchObject({ ok: false, status: 503, error: undefined });
  });

  // 鍵の解決が成功しているなら、落ちた原因はトークンの側にある。**エラーコードで
  // 分類しようとして2周続けて外した**ので、コードではなく落ちた場所で判定している
  // 実際の鍵選択は alg の不一致を**鍵の解決中に**投げる。落ちた場所だけで
  // 判定していると、これが「こちらの障害」に落ちて 503 になる
  it('alg: none のトークンは 401', async () => {
    const result = await verifyAccessToken('eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0.', config());

    expect(result).toMatchObject({ ok: false, status: 401, error: 'invalid_token' });
  });

  // JWKS から検証鍵を取る構成で対称鍵を許すと、公開された鍵素材で署名した
  // トークンを受け入れる余地ができる
  it('HS256 のトークンは 401（対称鍵は受け付けない）', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ sub: 'x' })).toString('base64url');

    const result = await verifyAccessToken(`${header}.${payload}.AA`, config());

    expect(result).toMatchObject({ ok: false, status: 401, error: 'invalid_token' });
    expect(result.ok === false && result.description).toContain('HS256');
  });

  // EdDSA だけ許して Ed25519 を落とすと、そのアルゴリズムを使う IdP では
  // 一切認証できなくなる
  it.each(['EdDSA', 'Ed25519', 'ES256'])('%s で署名されたトークンも通る', async (alg) => {
    const pair = await generateKeyPair(alg);
    setJwksResolverForTesting(createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), alg }] }));

    const token = await new SignJWT({})
      .setProtectedHeader({ alg })
      .setIssuedAt()
      .setIssuer(ISSUER)
      .setAudience(RESOURCE)
      .setExpirationTime('5m')
      .sign(pair.privateKey);

    expect((await verifyAccessToken(token, config())).ok).toBe(true);
  });

  it('JWT の形をしていない文字列は 401', async () => {
    const result = await verifyAccessToken('not-a-jwt', config());

    expect(result).toMatchObject({ ok: false, status: 401, error: 'invalid_token' });
  });

  it('コードを持たない例外（ネットワーク障害など）は 503', async () => {
    const token = await issueToken();
    setJwksResolverForTesting(() => {
      throw new TypeError('fetch failed');
    });

    const result = await verifyAccessToken(token, config());

    expect(result).toMatchObject({ ok: false, status: 503 });
  });

  // jose は JWKS が 429 / 503 を返したときも JSON が壊れていたときも
  // ERR_JOSE_GENERIC を投げる。コードでは取得失敗と区別できない
  it('JWKS が汎用エラーを返しても 503（コードでは区別できない）', async () => {
    const token = await issueToken();
    setJwksResolverForTesting(() => {
      const error = new Error('Expected 200 OK from the JSON Web Key Set HTTP response') as Error & {
        code: string;
      };
      error.code = 'ERR_JOSE_GENERIC';
      throw error;
    });

    const result = await verifyAccessToken(token, config());

    expect(result).toMatchObject({ ok: false, status: 503 });
  });

  // 鍵の解決中に落ちても、原因がトークンの側なら再試行しても直らない
  it('トークンの kid が JWKS に無ければ 401', async () => {
    const token = await issueToken();
    setJwksResolverForTesting(() => {
      const error = new Error('no applicable key found') as Error & { code: string };
      error.code = 'ERR_JWKS_NO_MATCHING_KEY';
      throw error;
    });

    const result = await verifyAccessToken(token, config());

    expect(result).toMatchObject({ ok: false, status: 401, error: 'invalid_token' });
  });

  // ログインできる利用者が、API の委譲を受けないまま課金の発生するツールを
  // 呼べてしまう構成がある（同じ鍵・同じ issuer・audience にクライアント識別子）
  it('ID トークン（at_hash を持つ）はアクセストークンとして受け付けない', async () => {
    const token = await new SignJWT({ at_hash: 'abc' })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuedAt()
      .setIssuer(ISSUER)
      .setAudience(RESOURCE)
      .setExpirationTime('5m')
      .sign(keys.privateKey);

    const result = await verifyAccessToken(token, config());

    expect(result).toMatchObject({ ok: false, status: 401, error: 'invalid_token' });
    expect(result.ok === false && result.description).toContain('ID トークン');
  });

  it('OAUTH_REQUIRE_AT_JWT=true なら typ が at+jwt でないトークンを拒否する', async () => {
    const result = await verifyAccessToken(await issueToken(), config({ requireAtJwt: true }));

    expect(result).toMatchObject({ ok: false, status: 401, error: 'invalid_token' });
  });

  it('OAUTH_REQUIRE_AT_JWT=true でも typ: at+jwt なら通る', async () => {
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', typ: 'at+jwt' })
      .setIssuedAt()
      .setIssuer(ISSUER)
      .setAudience(RESOURCE)
      .setExpirationTime('5m')
      .sign(keys.privateKey);

    expect((await verifyAccessToken(token, config({ requireAtJwt: true }))).ok).toBe(true);
  });

  it('必須 scope が無ければ 403 insufficient_scope', async () => {
    const result = await verifyAccessToken(
      await issueToken({ scope: 'sms:read' }),
      config({ requiredScope: 'sms:send' })
    );

    expect(result).toMatchObject({ ok: false, status: 403, error: 'insufficient_scope' });
  });

  it('必須 scope を持っていれば通る', async () => {
    const result = await verifyAccessToken(
      await issueToken({ scope: 'sms:read sms:send' }),
      config({ requiredScope: 'sms:send' })
    );

    expect(result.ok).toBe(true);
  });
});

describe('HTTP 経路', () => {
  it('OAuth 未設定ならメタデータは 404', async () => {
    const res = await request(app).get('/.well-known/oauth-protected-resource');

    expect(res.status).toBe(404);
  });

  it('パス付きのメタデータを認証なしで読める', async () => {
    configure();

    const res = await request(app).get('/.well-known/oauth-protected-resource/mcp');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ resource: RESOURCE, authorization_servers: [ISSUER] });
  });

  it('ルートのメタデータも読める（クライアントの落とし方の違いを吸収する）', async () => {
    configure();

    const res = await request(app).get('/.well-known/oauth-protected-resource');

    expect(res.status).toBe(200);
    expect(res.body.resource).toBe(RESOURCE);
  });

  it('設定と違うパスのメタデータは 404', async () => {
    configure();

    const res = await request(app).get('/.well-known/oauth-protected-resource/other');

    expect(res.status).toBe(404);
  });

  // これが無いとクライアントはどこへ認可を取りに行けばよいか分からない
  it('トークンなしの /mcp は 401 と WWW-Authenticate を返す', async () => {
    configure();

    const res = await request(app)
      .post('/mcp')
      .set('Accept', MCP_ACCEPT)
      .send({ jsonrpc: '2.0', id: 1, method: 'ping' });

    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toContain(
      'resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp"'
    );
  });

  // 認証情報がまったく無いリクエストへの 401 に error を載せると、
  // クライアントによっては「認可を取りに行く」のではなく「失敗した」と扱う
  it('トークン未送信の 401 には error を載せない', async () => {
    configure();

    const res = await request(app)
      .post('/mcp')
      .set('Accept', MCP_ACCEPT)
      .send({ jsonrpc: '2.0', id: 1, method: 'ping' });

    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).not.toContain('error=');
  });

  it('Bearer 以外の認証方式は 401 のチャレンジに倒す（400 にしない）', async () => {
    configure();

    const res = await request(app)
      .post('/mcp')
      .set('Accept', MCP_ACCEPT)
      .set('Authorization', 'Basic dXNlcjpwYXNz')
      .send({ jsonrpc: '2.0', id: 1, method: 'ping' });

    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).not.toContain('error=');
  });

  it('中身の無い Bearer は 400 invalid_request', async () => {
    configure();

    const res = await request(app)
      .post('/mcp')
      .set('Accept', MCP_ACCEPT)
      .set('Authorization', 'Bearer')
      .send({ jsonrpc: '2.0', id: 1, method: 'ping' });

    expect(res.status).toBe(400);
    expect(res.headers['www-authenticate']).toContain('error="invalid_request"');
  });

  // 壊れた設定で素通りさせると、無認証のサーバーができる
  it('OAUTH_* が部分設定なら、素通りさせず 500 を返す', async () => {
    process.env.OAUTH_ISSUER = ISSUER;

    const res = await request(app)
      .post('/mcp')
      .set('Accept', MCP_ACCEPT)
      .send({ jsonrpc: '2.0', id: 1, method: 'ping' });

    expect(res.status).toBe(500);
    expect(res.body.error.message).toContain('misconfigured');
  });

  // ALLOWED_HOSTS を設定すると requireAllowedHost は設定を読まずに通すので、
  // 認証ミドルウェア自身の fail-closed が試される
  it('ホスト検証を通過したあとでも、部分設定なら素通りさせない', async () => {
    process.env.ALLOWED_HOSTS = '127.0.0.1';
    process.env.OAUTH_ISSUER = ISSUER;

    const res = await request(app)
      .post('/mcp')
      .set('Accept', MCP_ACCEPT)
      .send({ jsonrpc: '2.0', id: 1, method: 'ping' });

    expect(res.status).toBe(500);
    expect(res.body.error.message).toContain('misconfigured');
  });

  it('部分設定ではメタデータも 500 を返す', async () => {
    process.env.OAUTH_ISSUER = ISSUER;

    const res = await request(app).get('/.well-known/oauth-protected-resource');

    expect(res.status).toBe(500);
  });

  it('有効なアクセストークンなら通る', async () => {
    configure();

    const res = await request(app)
      .post('/mcp')
      .set('Accept', MCP_ACCEPT)
      .set('Authorization', `Bearer ${await issueToken()}`)
      .send({ jsonrpc: '2.0', id: 1, method: 'ping' });

    expect(res.status).toBe(200);
  });

  it('別サービス宛のトークンは 401', async () => {
    configure();

    const res = await request(app)
      .post('/mcp')
      .set('Accept', MCP_ACCEPT)
      .set('Authorization', `Bearer ${await issueToken({ aud: 'https://other.example.com' })}`)
      .send({ jsonrpc: '2.0', id: 1, method: 'ping' });

    expect(res.status).toBe(401);
  });

  it('scope が足りなければ 403 と insufficient_scope', async () => {
    configure({ OAUTH_REQUIRED_SCOPE: 'sms:send' });

    const res = await request(app)
      .post('/mcp')
      .set('Accept', MCP_ACCEPT)
      .set('Authorization', `Bearer ${await issueToken({ scope: 'sms:read' })}`)
      .send({ jsonrpc: '2.0', id: 1, method: 'ping' });

    expect(res.status).toBe(403);
    expect(res.headers['www-authenticate']).toContain('error="insufficient_scope"');
  });

  // OAuth しか喋れない基盤と、任意ヘッダを送れる基盤を同じデプロイに繋ぐ構成
  it('MCP_AUTH_TOKEN と併用すると、静的トークンでも通る', async () => {
    const token = 'a'.repeat(32);
    configure({ MCP_AUTH_TOKEN: token });

    const res = await request(app)
      .post('/mcp')
      .set('Accept', MCP_ACCEPT)
      .set('Authorization', `Bearer ${token}`)
      .send({ jsonrpc: '2.0', id: 1, method: 'ping' });

    expect(res.status).toBe(200);
  });

  it('併用時でも、どちらでもないトークンは 401', async () => {
    configure({ MCP_AUTH_TOKEN: 'a'.repeat(32) });

    const res = await request(app)
      .post('/mcp')
      .set('Accept', MCP_ACCEPT)
      .set('Authorization', `Bearer ${'b'.repeat(32)}`)
      .send({ jsonrpc: '2.0', id: 1, method: 'ping' });

    expect(res.status).toBe(401);
  });

  it('TRUST_UPSTREAM_AUTH=true は OAuth より優先される', async () => {
    configure({ TRUST_UPSTREAM_AUTH: 'true' });

    const res = await request(app)
      .post('/mcp')
      .set('Accept', MCP_ACCEPT)
      .send({ jsonrpc: '2.0', id: 1, method: 'ping' });

    expect(res.status).toBe(200);
  });

  // expose しないと、許可したオリジンのブラウザ JS からチャレンジを読めない
  it('許可したオリジンには WWW-Authenticate を expose する', async () => {
    configure({ ALLOWED_ORIGINS: 'https://app.example.com' });

    const res = await request(app)
      .post('/mcp')
      .set('Accept', MCP_ACCEPT)
      .set('Origin', 'https://app.example.com')
      .send({ jsonrpc: '2.0', id: 1, method: 'ping' });

    expect(res.status).toBe(401);
    expect(res.headers['access-control-expose-headers']).toContain('WWW-Authenticate');
  });

  it('/health は OAuth を設定しても認証不要のまま', async () => {
    configure();

    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
  });
});
