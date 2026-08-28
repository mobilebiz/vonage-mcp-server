import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  CAPABILITY_ENV_VARS,
  ConfigError,
  DEFAULT_RATE_LIMIT_PER_HOUR,
  MAX_RATE_LIMIT_PER_HOUR,
  getCapabilities,
  extractHostname,
  getAllowedHostnames,
  getAllowedOrigins,
  getBindHost,
  getMcpAuthToken,
  getPort,
  getPrivateKeyPath,
  DEFAULT_PRIVATE_KEY_PATH,
  getRateLimitPerHour,
  getVoiceInboundMessage,
  VOICE_MESSAGE_MAX_LENGTH,
  isCapabilityEnabled,
  isHttpAuthConfigured,
  isLoopbackHost,
  isRateLimitDisabled,
  parseBooleanEnv,
  parseIntegerEnv,
  validateStartupConfig,
  getMaxRequestBodyBytes,
  MIN_REQUEST_BODY_BYTES,
} from '../src/config.js';

/** このモジュールが読む環境変数（テストごとに完全にクリアする） */
const MANAGED_ENV = [
  'ENABLE_SMS',
  'ENABLE_VOICE',
  'DISABLE_RATE_LIMIT',
  'RATE_LIMIT_PER_HOUR',
  'VONAGE_APPLICATION_ID',
  'VONAGE_PRIVATE_KEY_PATH',
  'VONAGE_VOICE_FROM',
  'MCP_AUTH_TOKEN',
  'TRUST_UPSTREAM_AUTH',
  'BIND_HOST',
  'PORT',
  'ALLOWED_ORIGINS',
  'ALLOWED_HOSTS',
  'VOICE_INBOUND_MESSAGE',
];

describe('config', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    for (const name of MANAGED_ENV) {
      delete process.env[name];
    }
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('parseBooleanEnv', () => {
    it('未設定・空文字・false は無効', () => {
      expect(parseBooleanEnv('X', undefined)).toBe(false);
      expect(parseBooleanEnv('X', '')).toBe(false);
      expect(parseBooleanEnv('X', '   ')).toBe(false);
      expect(parseBooleanEnv('X', 'false')).toBe(false);
      expect(parseBooleanEnv('X', ' false ')).toBe(false);
    });

    it('true のみが有効', () => {
      expect(parseBooleanEnv('X', 'true')).toBe(true);
      expect(parseBooleanEnv('X', '  true  ')).toBe(true);
    });

    // Boolean(process.env.X) 方式で最も危険な入力。
    // これが true になると、無効化したつもりの機能が公開される。
    it.each(['True', 'TRUE', '1', '0', 'yes', 'no', 'on', 'off', 'enabled'])(
      '曖昧な値 %s は推測せず起動エラーにする',
      (value) => {
        expect(() => parseBooleanEnv('ENABLE_SMS', value)).toThrow(ConfigError);
      }
    );

    it('エラーメッセージに変数名と与えられた値が含まれる', () => {
      try {
        parseBooleanEnv('ENABLE_VOICE', 'yes');
        expect.unreachable('例外が投げられるべき');
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigError);
        expect((error as ConfigError).message).toContain('ENABLE_VOICE');
        expect((error as ConfigError).message).toContain('yes');
      }
    });
  });

  describe('parseIntegerEnv', () => {
    const options = { min: 0, max: 100, defaultValue: 7 };

    it('未設定・空文字は既定値', () => {
      expect(parseIntegerEnv('N', options, undefined)).toBe(7);
      expect(parseIntegerEnv('N', options, '  ')).toBe(7);
    });

    it('10進整数を受け付ける', () => {
      expect(parseIntegerEnv('N', options, '0')).toBe(0);
      expect(parseIntegerEnv('N', options, ' 42 ')).toBe(42);
      expect(parseIntegerEnv('N', options, '100')).toBe(100);
    });

    // Number() は以下をすべて通してしまうため、表記そのものを縛っている
    it.each(['1.5', '1e3', '0x10', 'abc', 'Infinity', '5件', '1_0', '+5'])(
      '整数として解釈できない %s は起動エラー',
      (value) => {
        expect(() => parseIntegerEnv('N', options, value)).toThrow(ConfigError);
      }
    );

    it('範囲外は起動エラー', () => {
      expect(() => parseIntegerEnv('N', options, '-1')).toThrow(ConfigError);
      expect(() => parseIntegerEnv('N', options, '101')).toThrow(ConfigError);
    });
  });

  describe('getRateLimitPerHour', () => {
    it('未設定なら既定値', () => {
      expect(getRateLimitPerHour()).toBe(DEFAULT_RATE_LIMIT_PER_HOUR);
    });

    it('0 は全拒否（無制限ではない）', () => {
      process.env.RATE_LIMIT_PER_HOUR = '0';
      expect(getRateLimitPerHour()).toBe(0);
      expect(isRateLimitDisabled()).toBe(false);
    });

    it('無制限には DISABLE_RATE_LIMIT=true が必要', () => {
      process.env.DISABLE_RATE_LIMIT = 'true';
      expect(getRateLimitPerHour()).toBe(Infinity);
    });

    it('安全上限を超える値は起動エラー', () => {
      process.env.RATE_LIMIT_PER_HOUR = String(MAX_RATE_LIMIT_PER_HOUR + 1);
      expect(() => getRateLimitPerHour()).toThrow(ConfigError);
    });
  });

  describe('getCapabilities', () => {
    const allOff = {
      ENABLE_SMS: false,
      ENABLE_VOICE: false,
    };

    it('既定はすべて OFF', () => {
      expect(getCapabilities()).toEqual(allOff);
    });

    it('ENABLE_X=false は確実に無効になる', () => {
      for (const name of CAPABILITY_ENV_VARS) {
        process.env[name] = 'false';
      }
      expect(getCapabilities()).toEqual(allOff);
      for (const name of CAPABILITY_ENV_VARS) {
        expect(isCapabilityEnabled(name)).toBe(false);
      }
    });

    it('ENABLE_X=true で有効になる', () => {
      process.env.ENABLE_SMS = 'true';
      expect(getCapabilities()).toEqual({ ...allOff, ENABLE_SMS: true });
      expect(isCapabilityEnabled('ENABLE_SMS')).toBe(true);
    });

    it('各トグルは独立している（voice だけ有効にできる）', () => {
      process.env.ENABLE_VOICE = 'true';
      expect(getCapabilities()).toEqual({ ...allOff, ENABLE_VOICE: true });
    });
  });

  describe('HTTP の認証と待ち受けアドレス', () => {
    it('認証が未設定ならループバックに bind する', () => {
      expect(isHttpAuthConfigured()).toBe(false);
      expect(getBindHost()).toBe('127.0.0.1');
      expect(isLoopbackHost(getBindHost())).toBe(true);
    });

    it('MCP_AUTH_TOKEN を設定すると全インターフェースで待ち受ける', () => {
      process.env.MCP_AUTH_TOKEN = 'a'.repeat(32);
      expect(isHttpAuthConfigured()).toBe(true);
      expect(getBindHost()).toBe('0.0.0.0');
    });

    it('TRUST_UPSTREAM_AUTH=true でも認証済みとみなす', () => {
      process.env.TRUST_UPSTREAM_AUTH = 'true';
      expect(isHttpAuthConfigured()).toBe(true);
      expect(getBindHost()).toBe('0.0.0.0');
    });

    it('短いトークンは起動エラー', () => {
      process.env.MCP_AUTH_TOKEN = 'short';
      expect(() => getMcpAuthToken()).toThrow(ConfigError);
    });

    // 無認証のサーバーが外部公開されるのを警告で済ませない
    it('認証なしで外部アドレスに bind しようとすると起動エラー', () => {
      process.env.BIND_HOST = '0.0.0.0';
      expect(() => validateStartupConfig()).toThrow(/BIND_HOST/);
    });

    it('認証があれば外部アドレスに bind できる', () => {
      process.env.BIND_HOST = '0.0.0.0';
      process.env.MCP_AUTH_TOKEN = 'a'.repeat(32);
      expect(() => validateStartupConfig()).not.toThrow();
    });

    it('認証なしでもループバックの明示指定は許される', () => {
      process.env.BIND_HOST = '127.0.0.1';
      expect(() => validateStartupConfig()).not.toThrow();
    });

    it('TRUST_UPSTREAM_AUTH=true は警告を出す', () => {
      process.env.TRUST_UPSTREAM_AUTH = 'true';
      expect(validateStartupConfig().join('\n')).toContain('TRUST_UPSTREAM_AUTH');
    });

    it('PORT は範囲を検証する', () => {
      process.env.PORT = '70000';
      expect(() => getPort()).toThrow(ConfigError);
    });
  });

  describe('CORS と Host の許可リスト', () => {
    it('ALLOWED_ORIGINS の既定は「一切許可しない」', () => {
      expect(getAllowedOrigins()).toBeNull();
    });

    it('カンマ区切りで複数指定でき、空要素は無視する', () => {
      process.env.ALLOWED_ORIGINS = ' https://a.example.com , , https://b.example.com ';
      expect(getAllowedOrigins()).toEqual(['https://a.example.com', 'https://b.example.com']);
    });

    it('設定したのに有効な値が無ければ起動エラー', () => {
      process.env.ALLOWED_ORIGINS = ' , ,';
      expect(() => getAllowedOrigins()).toThrow(ConfigError);
    });

    it('ループバック運用では localhost 系だけを許可する', () => {
      expect(getAllowedHostnames()).toEqual(['localhost', '127.0.0.1', '::1']);
    });

    // 正しい Host は運用者のドメインで、こちらからは分からない。
    // 推測して塞ぐと正規のリクエストまで落ちる。
    it('外部アドレスに bind する場合は、明示されるまで Host を検証しない', () => {
      process.env.MCP_AUTH_TOKEN = 'a'.repeat(32);
      process.env.BIND_HOST = '0.0.0.0';

      expect(getAllowedHostnames()).toBeNull();

      process.env.ALLOWED_HOSTS = 'mcp.example.com';
      expect(getAllowedHostnames()).toEqual(['mcp.example.com']);
    });

    it.each([
      ['localhost', 'localhost'],
      ['localhost:3000', 'localhost'],
      ['MCP.Example.COM:8443', 'mcp.example.com'],
      ['[::1]:3000', '::1'],
      ['[::1]', '::1'],
    ])('extractHostname(%s) は %s', (input, expected) => {
      expect(extractHostname(input)).toBe(expected);
    });
  });

  // 鍵は送信のたびに readFileSync される。起動時の検証と実行時の読み取りが
  // 同じ値を指していなければ、検証は何も保証しない
  describe('getPrivateKeyPath', () => {
    it('未設定なら既定値を返す', () => {
      expect(getPrivateKeyPath()).toBe(DEFAULT_PRIVATE_KEY_PATH);
    });

    it('前後の空白を落として返す', () => {
      process.env.VONAGE_PRIVATE_KEY_PATH = '  ./keys/app.key  ';

      expect(getPrivateKeyPath()).toBe('./keys/app.key');
    });

    // 以前は起動時だけ trim していたため、空白だけの値は「起動時は ./private.key を
    // 確認して通り、実行時は "   " を読んで毎回失敗する」という食い違いを起こした。
    // しかも失敗はレート枠を消費したあとに来る
    it('空白だけの値は未設定として扱い、起動時の検証と同じパスを指す', () => {
      process.env.VONAGE_PRIVATE_KEY_PATH = '   ';
      process.env.ENABLE_SMS = 'true';
      process.env.VONAGE_APPLICATION_ID = 'app-id';

      expect(getPrivateKeyPath()).toBe(DEFAULT_PRIVATE_KEY_PATH);
      // 既定の鍵は存在するので、起動時の検証も同じ判断になる
      expect(() => validateStartupConfig()).not.toThrow();
    });
  });

  // 着信番号は公開されていて誰でも掛けられる。発信側だけ長さを縛っても、
  // 案内文が長ければ1件ごとに TTS の課金と通話時間が伸びる
  describe('getVoiceInboundMessage', () => {
    it('未設定なら null を返す（呼び出し側の既定文を使う）', () => {
      expect(getVoiceInboundMessage()).toBeNull();
    });

    it('空白だけの指定は未設定として扱う', () => {
      process.env.VOICE_INBOUND_MESSAGE = '   ';

      expect(getVoiceInboundMessage()).toBeNull();
    });

    it('前後の空白を落として返す', () => {
      process.env.VOICE_INBOUND_MESSAGE = '  こちらは発信専用です。  ';

      expect(getVoiceInboundMessage()).toBe('こちらは発信専用です。');
    });

    it('上限ちょうどは受け付ける', () => {
      process.env.VOICE_INBOUND_MESSAGE = 'あ'.repeat(VOICE_MESSAGE_MAX_LENGTH);

      expect(getVoiceInboundMessage()).toHaveLength(VOICE_MESSAGE_MAX_LENGTH);
    });

    // 黙って切り詰めない。運用者が設定したはずの案内が流れていないことに気づけなくなる
    it('上限を超えたら起動エラーにする（切り詰めない）', () => {
      process.env.VOICE_INBOUND_MESSAGE = 'あ'.repeat(VOICE_MESSAGE_MAX_LENGTH + 1);

      expect(() => getVoiceInboundMessage()).toThrow(ConfigError);
      expect(() => getVoiceInboundMessage()).toThrow(/VOICE_INBOUND_MESSAGE が長すぎます/);
    });
  });

  describe('validateStartupConfig', () => {
    it('既定の環境では起動できるが、全機能 OFF であることを警告する', () => {
      const warnings = validateStartupConfig().join('\n');
      expect(warnings).toContain('すべての機能が無効です');
    });

    // 鍵は送信のたびに読まれる。起動時に確かめないと、パスの誤記でも起動でき、
    // 各呼び出しは**レート枠を消費してから**失敗する（VONAGE_MCP-4）
    it('capability が有効で秘密鍵を読めなければ起動エラー', () => {
      process.env.ENABLE_SMS = 'true';
      process.env.VONAGE_APPLICATION_ID = 'app-id';
      process.env.VONAGE_PRIVATE_KEY_PATH = './does-not-exist.key';

      expect(() => validateStartupConfig()).toThrow(/秘密鍵を読み取れません/);
    });

    it('capability が全 OFF なら秘密鍵の有無は問わない', () => {
      process.env.VONAGE_PRIVATE_KEY_PATH = './does-not-exist.key';

      expect(() => validateStartupConfig()).not.toThrow();
    });

    // 起動時に落とさないと、着信のたびに長い案内が流れてから気づくことになる
    it('長すぎる VOICE_INBOUND_MESSAGE は起動エラーとして拾う', () => {
      process.env.VOICE_INBOUND_MESSAGE = 'あ'.repeat(VOICE_MESSAGE_MAX_LENGTH + 1);

      expect(() => validateStartupConfig()).toThrow(/VOICE_INBOUND_MESSAGE/);
    });

    // 共有シークレットの webhook エンドポイントは公開されていて試行制限も無い
    it('VONAGE_WEBHOOK_SECRET が短く、実際に使われる構成なら起動エラー', () => {
      process.env.VONAGE_WEBHOOK_SECRET = 'x';

      expect(() => validateStartupConfig()).toThrow(/VONAGE_WEBHOOK_SECRET/);
    });

    it('署名検証が優先される構成なら、短い共有シークレットは警告に留める', () => {
      process.env.VONAGE_WEBHOOK_SECRET = 'x';
      process.env.VONAGE_API_SIGNATURE_SECRET = 'signature-secret';

      const warnings = validateStartupConfig().join('\n');
      expect(warnings).toContain('VONAGE_WEBHOOK_SECRET');
      expect(warnings).toContain('署名シークレットを外すと');
    });

    it('十分な長さの共有シークレットは問題にならない', () => {
      process.env.VONAGE_WEBHOOK_SECRET = 'a'.repeat(16);

      const warnings = validateStartupConfig().join('\n');
      expect(() => validateStartupConfig()).not.toThrow();
      expect(warnings).not.toContain('VONAGE_WEBHOOK_SECRET');
    });

    it('capability を1つでも有効にすれば全 OFF 警告は出ない', () => {
      process.env.ENABLE_SMS = 'true';
      process.env.VONAGE_APPLICATION_ID = 'app-id';
      process.env.VONAGE_PRIVATE_KEY_PATH = './private.key';

      expect(validateStartupConfig().join('\n')).not.toContain('すべての機能が無効です');
    });

    it('複数の問題をまとめて報告する', () => {
      process.env.ENABLE_SMS = 'yes';
      process.env.RATE_LIMIT_PER_HOUR = '1.5';
      process.env.SMS_MAX_SEGMENTS = '0';

      try {
        validateStartupConfig();
        expect.unreachable('例外が投げられるべき');
      } catch (error) {
        const problems = (error as ConfigError).problems;
        expect(problems).toHaveLength(3);
        expect(problems.join('\n')).toContain('ENABLE_SMS');
        expect(problems.join('\n')).toContain('RATE_LIMIT_PER_HOUR');
        expect(problems.join('\n')).toContain('SMS_MAX_SEGMENTS');
      }
    });

    it('capability を有効にしたのに VONAGE_APPLICATION_ID が無ければ起動エラー', () => {
      process.env.ENABLE_SMS = 'true';
      expect(() => validateStartupConfig()).toThrow(/VONAGE_APPLICATION_ID/);
    });

    it('ENABLE_VOICE=true で VONAGE_VOICE_FROM が無ければ起動エラー', () => {
      process.env.ENABLE_VOICE = 'true';
      process.env.VONAGE_APPLICATION_ID = 'app-id';
      expect(() => validateStartupConfig()).toThrow(/VONAGE_VOICE_FROM/);
    });

    it('capability が無効なら資格情報が無くても起動できる', () => {
      expect(() => validateStartupConfig()).not.toThrow();
    });

    it('DISABLE_RATE_LIMIT=true は警告を出す', () => {
      process.env.DISABLE_RATE_LIMIT = 'true';
      expect(validateStartupConfig().join('\n')).toContain('DISABLE_RATE_LIMIT');
    });

    it('0 設定は「無制限ではない」ことを警告で明示する', () => {
      process.env.RATE_LIMIT_PER_HOUR = '0';
      const warnings = validateStartupConfig().join('\n');
      expect(warnings).toContain('RATE_LIMIT_PER_HOUR=0');
    });

    it('すべての capability 環境変数を検証対象にしている', () => {
      for (const name of CAPABILITY_ENV_VARS) {
        process.env[name] = 'maybe';
        expect(() => validateStartupConfig()).toThrow(new RegExp(name));
        delete process.env[name];
      }
    });
  });
});

// express.json() の既定 100KB では、トランスポートによって通る入力が変わって
// しまう（VONAGE_MCP-4）。v3.0.0 以降は設定によらず一定の値を返す
describe('getMaxRequestBodyBytes', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('express.json() の既定 100KB より大きい', () => {
    expect(getMaxRequestBodyBytes()).toBeGreaterThan(100 * 1024);
  });

  // かつては BULK_MAX_ROWS から算出していた。環境変数で動かせないことを固定する
  it('環境変数によらず一定', () => {
    process.env.RATE_LIMIT_PER_HOUR = '1000';

    expect(getMaxRequestBodyBytes()).toBe(MIN_REQUEST_BODY_BYTES);
  });
});
