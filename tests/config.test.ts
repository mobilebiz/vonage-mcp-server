import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  CAPABILITY_ENV_VARS,
  ConfigError,
  DEFAULT_BULK_MAX_ROWS,
  DEFAULT_RATE_LIMIT_PER_HOUR,
  MAX_BULK_MAX_ROWS,
  MAX_RATE_LIMIT_PER_HOUR,
  getBulkMaxRows,
  getCapabilities,
  getRateLimitPerHour,
  isCapabilityEnabled,
  isRateLimitDisabled,
  parseBooleanEnv,
  parseIntegerEnv,
  validateStartupConfig,
} from '../src/config.js';

/** このモジュールが読む環境変数（テストごとに完全にクリアする） */
const MANAGED_ENV = [
  'ENABLE_SMS',
  'ENABLE_BULK_SMS',
  'ENABLE_VOICE',
  'ENABLE_JWT_TOOL',
  'DISABLE_RATE_LIMIT',
  'RATE_LIMIT_PER_HOUR',
  'BULK_MAX_ROWS',
  'VONAGE_APPLICATION_ID',
  'VONAGE_PRIVATE_KEY_PATH',
  'VONAGE_VOICE_FROM',
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

  describe('getBulkMaxRows', () => {
    it('未設定なら既定値', () => {
      expect(getBulkMaxRows()).toBe(DEFAULT_BULK_MAX_ROWS);
    });

    it('0 は全拒否（無制限ではない）', () => {
      process.env.BULK_MAX_ROWS = '0';
      expect(getBulkMaxRows()).toBe(0);
    });

    it('安全上限を超える値は起動エラー', () => {
      process.env.BULK_MAX_ROWS = String(MAX_BULK_MAX_ROWS + 1);
      expect(() => getBulkMaxRows()).toThrow(ConfigError);
    });
  });

  describe('getCapabilities', () => {
    const allOff = {
      ENABLE_SMS: false,
      ENABLE_BULK_SMS: false,
      ENABLE_VOICE: false,
      ENABLE_JWT_TOOL: false,
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

    it('各トグルは独立している（bulk だけ有効にできる）', () => {
      process.env.ENABLE_BULK_SMS = 'true';
      expect(getCapabilities()).toEqual({ ...allOff, ENABLE_BULK_SMS: true });
    });
  });

  describe('validateStartupConfig', () => {
    it('既定の環境では起動できるが、全機能 OFF であることを警告する', () => {
      const warnings = validateStartupConfig();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('すべての機能が無効です');
    });

    it('capability を1つでも有効にすれば全 OFF 警告は出ない', () => {
      process.env.ENABLE_SMS = 'true';
      process.env.VONAGE_APPLICATION_ID = 'app-id';
      process.env.VONAGE_PRIVATE_KEY_PATH = './private.key';

      expect(validateStartupConfig()).toEqual([]);
    });

    it('複数の問題をまとめて報告する', () => {
      process.env.ENABLE_SMS = 'yes';
      process.env.RATE_LIMIT_PER_HOUR = '1.5';
      process.env.BULK_MAX_ROWS = '-3';

      try {
        validateStartupConfig();
        expect.unreachable('例外が投げられるべき');
      } catch (error) {
        const problems = (error as ConfigError).problems;
        expect(problems).toHaveLength(3);
        expect(problems.join('\n')).toContain('ENABLE_SMS');
        expect(problems.join('\n')).toContain('RATE_LIMIT_PER_HOUR');
        expect(problems.join('\n')).toContain('BULK_MAX_ROWS');
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
      process.env.BULK_MAX_ROWS = '0';
      const warnings = validateStartupConfig().join('\n');
      expect(warnings).toContain('RATE_LIMIT_PER_HOUR=0');
      expect(warnings).toContain('BULK_MAX_ROWS=0');
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
