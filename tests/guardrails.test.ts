import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  E164_PATTERN,
  PHONE_INPUT_PATTERN,
  RateLimiter,
  buildRateLimitError,
  checkAllowedNumber,
  getAllowedNumbers,
  getAllowedNumbersConfig,
  getBulkMaxRows,
  getRateLimitPerHour,
  normalizeToE164,
  validateAndNormalizePhoneNumber,
  validateSenderId,
} from '../src/guardrails.js';
import { ConfigError } from '../src/config.js';

describe('guardrails', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.ALLOWED_NUMBERS;
    delete process.env.RATE_LIMIT_PER_HOUR;
    delete process.env.BULK_MAX_ROWS;
    delete process.env.DISABLE_RATE_LIMIT;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('normalizeToE164', () => {
    it('日本の国内形式を +81 付きに変換する', () => {
      expect(normalizeToE164('09012345678')).toBe('+819012345678');
      expect(normalizeToE164('090-1234-5678')).toBe('+819012345678');
      expect(normalizeToE164('090 1234 5678')).toBe('+819012345678');
    });

    it('既にE.164形式のものはそのまま返す', () => {
      expect(normalizeToE164('+819012345678')).toBe('+819012345678');
      expect(normalizeToE164('+81 90 1234 5678')).toBe('+819012345678');
    });

    it('+ が無い国際番号には + を付ける', () => {
      expect(normalizeToE164('819012345678')).toBe('+819012345678');
    });
  });

  describe('validateAndNormalizePhoneNumber', () => {
    it('有効な番号を正規化して返す', () => {
      const result = validateAndNormalizePhoneNumber('09012345678');
      expect(result.valid).toBe(true);
      expect(result.normalized).toBe('+819012345678');
      expect(E164_PATTERN.test(result.normalized)).toBe(true);
    });

    it('無効な番号には reason と suggestion を付けて返す', () => {
      const result = validateAndNormalizePhoneNumber('123');
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('無効な電話番号形式です');
      expect(result.suggestion).toContain('E.164');
    });

    it('空文字を拒否する', () => {
      expect(validateAndNormalizePhoneNumber('').valid).toBe(false);
    });
  });

  describe('PHONE_INPUT_PATTERN', () => {
    const pattern = new RegExp(PHONE_INPUT_PATTERN);

    it('E.164形式と日本の国内形式を受け付ける', () => {
      expect(pattern.test('+819012345678')).toBe(true);
      expect(pattern.test('09012345678')).toBe(true);
      expect(pattern.test('090-1234-5678')).toBe(true);
      expect(pattern.test('+81 90 1234 5678')).toBe(true);
    });

    it('明らかに不正な入力を弾く', () => {
      expect(pattern.test('abc')).toBe(false);
      expect(pattern.test('')).toBe(false);
      expect(pattern.test('+')).toBe(false);
      expect(pattern.test('12')).toBe(false);
      expect(pattern.test('1234')).toBe(false);
    });

    // スキーマで弾くとエラーが「引数が不正です」になり、エージェントが
    // 表記を直して再試行し続ける。ハンドラ側で具体的な理由を返したい。
    it('3桁の短縮番号は通し、ハンドラ側で理由を付けて拒否させる', () => {
      expect(pattern.test('110')).toBe(true);
      expect(pattern.test('119')).toBe(true);
      expect(pattern.test('123')).toBe(true);
    });
  });

  describe('ALLOWED_NUMBERS', () => {
    it('未設定なら制限なし', () => {
      expect(getAllowedNumbers()).toBeNull();
      expect(checkAllowedNumber('+819012345678').allowed).toBe(true);
    });

    it('設定されている番号は許可される（表記ゆれも正規化して比較）', () => {
      process.env.ALLOWED_NUMBERS = '090-1234-5678, +819087654321';
      expect(getAllowedNumbers()).toEqual(['+819012345678', '+819087654321']);
      expect(checkAllowedNumber('+819012345678').allowed).toBe(true);
      expect(checkAllowedNumber('+819087654321').allowed).toBe(true);
    });

    it('設定外の番号はブロックされ、再試行不要である旨を伝える', () => {
      process.env.ALLOWED_NUMBERS = '+819012345678';
      const result = checkAllowedNumber('+819099999999');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('+819099999999');
      expect(result.suggestion).toContain('再試行しても結果は変わりません');
    });

    it('空白のみの場合は未設定として扱う（制限なし）', () => {
      process.env.ALLOWED_NUMBERS = '   ';
      expect(getAllowedNumbers()).toBeNull();
      expect(checkAllowedNumber('+819012345678').allowed).toBe(true);
    });

    it('カンマのみなど有効な番号が1件も無い設定は fail-closed で全拒否する', () => {
      process.env.ALLOWED_NUMBERS = ',';
      expect(getAllowedNumbers()).toEqual([]);

      const result = checkAllowedNumber('+819012345678');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('設定が不正です');
    });

    it('E.164として解釈できない値だけの設定も全拒否し、該当値を報告する', () => {
      process.env.ALLOWED_NUMBERS = 'abc, 123';

      const config = getAllowedNumbersConfig();
      expect(config.configured).toBe(true);
      expect(config.numbers).toEqual([]);
      expect(config.invalid).toEqual(['abc', '123']);

      const result = checkAllowedNumber('+819012345678');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('abc');
    });

    it('有効な値と不正な値が混在する場合、有効な値だけを許可する', () => {
      process.env.ALLOWED_NUMBERS = '+819012345678, abc';

      expect(getAllowedNumbersConfig().invalid).toEqual(['abc']);
      expect(checkAllowedNumber('+819012345678').allowed).toBe(true);
      expect(checkAllowedNumber('+819087654321').allowed).toBe(false);
    });
  });

  describe('validateSenderId', () => {
    it('英数字3〜11文字（先頭は英字）を許可する', () => {
      expect(validateSenderId('VonageMCP').valid).toBe(true);
      expect(validateSenderId('abc').valid).toBe(true);
      expect(validateSenderId('Sales12345').valid).toBe(true);
    });

    it('E.164形式の電話番号も許可する', () => {
      expect(validateSenderId('+819012345678').valid).toBe(true);
      expect(validateSenderId('09012345678').valid).toBe(true);
    });

    it('数字のみの短い文字列・日本語・長すぎる値を拒否する', () => {
      for (const bad of ['123', '送信元', 'ab', 'ABCDEFGHIJKL', '1Sales']) {
        const result = validateSenderId(bad);
        expect(result.valid, `${bad} は拒否されるべき`).toBe(false);
        expect(result.suggestion).toBeTruthy();
      }
    });
  });

  describe('getRateLimitPerHour', () => {
    it('未設定ならデフォルト5', () => {
      expect(getRateLimitPerHour()).toBe(5);
    });

    it('数値を指定できる', () => {
      process.env.RATE_LIMIT_PER_HOUR = '20';
      expect(getRateLimitPerHour()).toBe(20);
    });

    it('0 は無制限ではなく全拒否（VONAGE_MCP-18 の破壊的変更）', () => {
      process.env.RATE_LIMIT_PER_HOUR = '0';
      expect(getRateLimitPerHour()).toBe(0);
    });

    it('無制限にするには DISABLE_RATE_LIMIT=true が必要', () => {
      process.env.DISABLE_RATE_LIMIT = 'true';
      expect(getRateLimitPerHour()).toBe(Infinity);
    });

    it('DISABLE_RATE_LIMIT は RATE_LIMIT_PER_HOUR より優先される', () => {
      process.env.DISABLE_RATE_LIMIT = 'true';
      process.env.RATE_LIMIT_PER_HOUR = '3';
      expect(getRateLimitPerHour()).toBe(Infinity);
    });

    it('数値でない値は黙って既定値に落とさず例外にする', () => {
      process.env.RATE_LIMIT_PER_HOUR = 'abc';
      expect(() => getRateLimitPerHour()).toThrow(ConfigError);
    });
  });

  describe('RateLimiter', () => {
    it('上限まで消費でき、超えると拒否される', () => {
      const limiter = new RateLimiter(60_000);
      const now = 1_000_000;

      for (let i = 0; i < 3; i++) {
        expect(limiter.consume('send_sms', 3, now).allowed).toBe(true);
      }

      const blocked = limiter.consume('send_sms', 3, now);
      expect(blocked.allowed).toBe(false);
      expect(blocked.remaining).toBe(0);
      expect(blocked.retryAfterSeconds).toBe(60);
    });

    it('ウィンドウを過ぎたカウントは解放される', () => {
      const limiter = new RateLimiter(60_000);
      const now = 1_000_000;

      limiter.consume('send_sms', 1, now);
      expect(limiter.consume('send_sms', 1, now).allowed).toBe(false);
      expect(limiter.consume('send_sms', 1, now + 60_001).allowed).toBe(true);
    });

    it('キーごとに独立してカウントする', () => {
      const limiter = new RateLimiter(60_000);
      const now = 1_000_000;

      limiter.consume('send_sms', 1, now);
      expect(limiter.consume('send_sms', 1, now).allowed).toBe(false);
      expect(limiter.consume('make_voice_call', 1, now).allowed).toBe(true);
    });

    it('limit が Infinity なら常に許可する', () => {
      const limiter = new RateLimiter(60_000);
      for (let i = 0; i < 100; i++) {
        expect(limiter.consume('send_sms', Infinity, 1_000_000).allowed).toBe(true);
      }
    });

    it('check は消費しない', () => {
      const limiter = new RateLimiter(60_000);
      const now = 1_000_000;

      expect(limiter.check('send_sms', 1, now).remaining).toBe(1);
      expect(limiter.check('send_sms', 1, now).remaining).toBe(1);
      expect(limiter.consume('send_sms', 1, now).allowed).toBe(true);
    });

    it('cost を指定すると件数分まとめて消費する', () => {
      const limiter = new RateLimiter(60_000);
      const now = 1_000_000;

      const r = limiter.consume('bulk', 10, now, 4);
      expect(r.allowed).toBe(true);
      expect(r.remaining).toBe(6);
      expect(limiter.check('bulk', 10, now, 6).allowed).toBe(true);
      expect(limiter.check('bulk', 10, now, 7).allowed).toBe(false);
    });

    it('残り枠より cost が大きい場合は1件も消費しない', () => {
      const limiter = new RateLimiter(60_000);
      const now = 1_000_000;

      limiter.consume('bulk', 5, now, 3);
      const blocked = limiter.consume('bulk', 5, now, 3);

      expect(blocked.allowed).toBe(false);
      expect(blocked.remaining).toBe(2);
      // 拒否された分は消費されていないので、2件ならまだ通る
      expect(limiter.consume('bulk', 5, now, 2).allowed).toBe(true);
    });

    it('reset でカウントをクリアできる', () => {
      const limiter = new RateLimiter(60_000);
      const now = 1_000_000;

      limiter.consume('send_sms', 1, now);
      limiter.reset('send_sms');
      expect(limiter.consume('send_sms', 1, now).allowed).toBe(true);
    });
  });

  describe('getBulkMaxRows', () => {
    it('未設定ならデフォルト100', () => {
      expect(getBulkMaxRows()).toBe(100);
    });

    it('数値を指定できる', () => {
      process.env.BULK_MAX_ROWS = '250';
      expect(getBulkMaxRows()).toBe(250);
    });

    it('0 は無制限ではなく全拒否（VONAGE_MCP-18 の破壊的変更）', () => {
      process.env.BULK_MAX_ROWS = '0';
      expect(getBulkMaxRows()).toBe(0);
    });

    it('不正な値は例外にする', () => {
      process.env.BULK_MAX_ROWS = '-1';
      expect(() => getBulkMaxRows()).toThrow(ConfigError);
    });
  });

  describe('buildRateLimitError', () => {
    it('待機秒数と再試行方針を含むメッセージを組み立てる', () => {
      const error = buildRateLimitError('send_sms', {
        allowed: false,
        limit: 5,
        remaining: 0,
        retryAfterSeconds: 120,
      });

      expect(error.reason).toContain('レートリミット超過');
      expect(error.reason).toContain('1時間あたり5件');
      expect(error.retry_after_seconds).toBe(120);
      expect(error.suggestion).toContain('120秒');
    });

    it('cost > 1 のときは要求件数と残り枠を伝え、1件も送っていないと明示する', () => {
      const error = buildRateLimitError(
        'bulk_sms_from_csv',
        { allowed: false, limit: 5, remaining: 2, retryAfterSeconds: 300 },
        10
      );

      expect(error.reason).toContain('10件の送信を要求');
      expect(error.reason).toContain('残り枠は2件');
      expect(error.reason).toContain('1件も送信していません');
      expect(error.suggestion).toContain('2行以下に分割');
      expect(error.remaining).toBe(2);
    });

    it('limit=0 は「停止中」として案内し、待機を促さない', () => {
      const error = buildRateLimitError('send_sms', { allowed: false, limit: 0, remaining: 0 });

      expect(error.reason).toContain('停止されています');
      expect(error.reason).toContain('RATE_LIMIT_PER_HOUR=0');
      expect(error.retry_after_seconds).toBe(0);
      expect(error.suggestion).toContain('再試行しても結果は変わりません');
      // 待っても解けないので、待機時間を提示してはいけない
      expect(error.suggestion).not.toContain('待ってから');
    });
  });

  describe('RATE_LIMIT_PER_HOUR=0（全拒否）', () => {
    it('1件目から拒否され、retryAfterSeconds を返さない', () => {
      const limiter = new RateLimiter(60_000);
      const result = limiter.consume('send_sms', 0, 1_000_000, 1);

      expect(result.allowed).toBe(false);
      expect(result.limit).toBe(0);
      expect(result.remaining).toBe(0);
      expect(result.retryAfterSeconds).toBeUndefined();
    });

    it('拒否された呼び出しは枠を消費しない（時間が経っても解けない）', () => {
      const limiter = new RateLimiter(60_000);
      limiter.consume('send_sms', 0, 1_000_000, 1);

      expect(limiter.consume('send_sms', 0, 2_000_000, 1).allowed).toBe(false);
    });
  });
});
