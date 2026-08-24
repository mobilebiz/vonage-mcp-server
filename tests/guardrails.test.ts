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

    // 以前は + を補っていたが、それは「この数字列は国番号から始まる」という推測。
    // 米国の国内表記 2125551234 に + を補うと +212 = モロッコ宛になり、
    // まったく別の国に SMS が飛ぶ (Codex L-1)。
    it('+ も先頭 0 も無い番号には + を補わない', () => {
      expect(normalizeToE164('819012345678')).toBe('819012345678');
      expect(normalizeToE164('2125551234')).toBe('2125551234');
    });

    it('+ を補わなかった番号は検証で弾かれる', () => {
      const result = validateAndNormalizePhoneNumber('819012345678');
      expect(result.valid).toBe(false);
      expect(result.suggestion).toContain('E.164');
    });

    // スキーマ (PHONE_INPUT_PATTERN) と正規化器の挙動が一致していること
    it('入力スキーマと正規化器の判定が一致する', () => {
      const pattern = new RegExp(PHONE_INPUT_PATTERN);

      for (const input of ['819012345678', '2125551234']) {
        expect(pattern.test(input), `${input} はスキーマで弾かれるべき`).toBe(false);
        expect(
          validateAndNormalizePhoneNumber(input).valid,
          `${input} は正規化後の検証でも弾かれるべき`
        ).toBe(false);
      }

      for (const input of ['09012345678', '+819012345678']) {
        expect(pattern.test(input), `${input} はスキーマを通るべき`).toBe(true);
        expect(
          validateAndNormalizePhoneNumber(input).valid,
          `${input} は正規化後の検証も通るべき`
        ).toBe(true);
      }
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
    const JP = '+819012345678';
    const US = '+12125551234';

    it('公式ルールどおり英数字1〜11文字を許可する', () => {
      for (const good of ['VonageMCP', 'abc', 'Sales12345', 'AB', 'X', 'ABCDEFGHIJK']) {
        expect(validateSenderId(good, JP).valid, `${good} は許可されるべき`).toBe(true);
      }
    });

    // 以前の実装は「3文字以上・先頭は英字」を課しており、これらを弾いていた
    it('数字始まり・2文字以下でも公式ルール上は有効', () => {
      expect(validateSenderId('2FA', JP).valid).toBe(true);
      expect(validateSenderId('365Support', JP).valid).toBe(true);
      expect(validateSenderId('X1', JP).valid).toBe(true);
    });

    it('12文字以上・記号・日本語・空白は拒否する', () => {
      for (const bad of ['ABCDEFGHIJKL', '送信元', 'Vonage MCP', 'Vonage-MCP', '']) {
        const result = validateSenderId(bad, JP);
        expect(result.valid, `${bad} は拒否されるべき`).toBe(false);
        expect(result.suggestion).toBeTruthy();
      }
    });

    // dry_run が承認した送信元と実際に届く送信元が食い違うのを防ぐ
    describe('日本宛の数値送信元', () => {
      it.each(['+819012345678', '09012345678', '0120123456', '81901234'])(
        '%s は拒否され、上書きされることが説明される',
        (from) => {
          const result = validateSenderId(from, JP);
          expect(result.valid).toBe(false);
          expect(result.reason).toContain('上書き');
          expect(result.suggestion).toContain('再試行しても結果は変わりません');
        }
      );

      it('宛先が不明な場合も日本宛として厳しく判定する', () => {
        expect(validateSenderId('09012345678').valid).toBe(false);
      });

      it('日本以外が宛先なら発信元電話番号を送信元にできる', () => {
        expect(validateSenderId('+819012345678', US).valid).toBe(true);
      });
    });

    describe('日本で禁止されている Generic Sender ID', () => {
      // いずれも「英数字11文字以内」を満たすため、書式チェックだけでは素通りする
      it.each(['INFO', 'info', 'Info', 'SMS', 'sms', 'NOTICE', 'notice'])(
        '%s は拒否される',
        (from) => {
          const result = validateSenderId(from, JP);
          expect(result.valid).toBe(false);
          expect(result.reason).toContain('Generic Sender ID');
        }
      );

      it('汎用語を含むだけの送信者IDは拒否しない', () => {
        expect(validateSenderId('InfoDesk', JP).valid).toBe(true);
        expect(validateSenderId('SMSGuide', JP).valid).toBe(true);
      });

      it('日本以外が宛先なら適用しない', () => {
        expect(validateSenderId('INFO', US).valid).toBe(true);
      });
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

  describe('複数バケットの原子的な消費', () => {
    it('すべてのバケットに空きがあれば消費する', () => {
      const limiter = new RateLimiter(60_000);

      const result = limiter.consumeAll(
        [
          { bucket: 'global', key: 'global', limit: 5, cost: 2 },
          { bucket: 'sms', key: 'sms', limit: 5, cost: 2 },
        ],
        1_000_000
      );

      expect(result.allowed).toBe(true);
      expect(limiter.check('global', 5, 1_000_000).remaining).toBe(3);
      expect(limiter.check('sms', 5, 1_000_000).remaining).toBe(3);
    });

    // 順に消費すると global だけ減り、送っていない分の枠が失われる
    it('1つでも足りなければ、どのバケットも消費しない', () => {
      const limiter = new RateLimiter(60_000);

      const result = limiter.consumeAll(
        [
          { bucket: 'global', key: 'global', limit: 10, cost: 3 },
          { bucket: 'sms', key: 'sms', limit: 1, cost: 3 },
        ],
        1_000_000
      );

      expect(result.allowed).toBe(false);
      expect(result.allowed === false && result.bucket).toBe('sms');
      expect(limiter.check('global', 10, 1_000_000).remaining).toBe(10);
      expect(limiter.check('sms', 1, 1_000_000).remaining).toBe(1);
    });

    it('どのバケットで不足したかを返す', () => {
      const limiter = new RateLimiter(60_000);

      const result = limiter.consumeAll(
        [
          { bucket: 'global', key: 'global', limit: 0, cost: 1 },
          { bucket: 'voice', key: 'voice', limit: 100, cost: 1 },
        ],
        1_000_000
      );

      expect(result.allowed === false && result.bucket).toBe('global');
    });
  });

  // retry_after は「最古の1件」ではなく「あと何件空けば足りるか」で決まる。
  // 誤ると、エージェントは案内された時刻に再試行してまた弾かれる（VONAGE_MCP-4）。
  describe('cost > 1 のときの retryAfterSeconds', () => {
    it('要求が上限そのものを超えるなら、待機ではなく分割を案内する', () => {
      const limiter = new RateLimiter(60_000);

      // 上限5・使用0件。枠が全部空いていても10件は通らない
      const result = limiter.check('bulk_sms_from_csv', 5, 1_000_000, 10);

      expect(result.allowed).toBe(false);
      expect(result.unsatisfiable).toBe(true);
      expect(result.retryAfterSeconds).toBeUndefined();
    });

    it('必要な件数が解放される時刻を返す（最古の1件ではない）', () => {
      const limiter = new RateLimiter(60_000);
      const start = 1_000_000;

      // 5件を10秒ずつずらして消費する
      for (let i = 0; i < 5; i++) {
        limiter.consume('send_sms', 5, start + i * 10_000);
      }

      // 現在時刻は最後の消費と同じ。残り0件のところへ3件を要求する
      const now = start + 40_000;
      const result = limiter.check('send_sms', 5, now, 3);

      expect(result.allowed).toBe(false);
      expect(result.unsatisfiable).toBeUndefined();
      // 3件目（start+20_000 に消費）が失効するのは start+80_000 = now+40秒。
      // 最古の1件（start）で答えると now+20秒となり、そこで再試行すると
      // 1件しか空いておらず再び弾かれる
      expect(result.retryAfterSeconds).toBe(40);
    });

    it('分割すれば通る場合は待機時間を案内する', () => {
      const limiter = new RateLimiter(60_000);
      const result = limiter.check('bulk_sms_from_csv', 5, 1_000_000, 5);

      // 使用0件・上限5なのでちょうど通る
      expect(result.allowed).toBe(true);
    });

    it('上限超過のエラー文面は待機を促さない', () => {
      const error = buildRateLimitError(
        'bulk_sms_from_csv',
        { allowed: false, limit: 5, remaining: 5, unsatisfiable: true },
        10,
        'global'
      );

      expect(error.retry_after_seconds).toBe(0);
      expect(error.suggestion).toContain('待っても解決しません');
      expect(error.suggestion).toContain('5行以下');
      expect(error.suggestion).not.toContain('待ってから再試行');
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
