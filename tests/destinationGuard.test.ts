import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  ASSIGNED_CALLING_CODES,
  getCallingCode,
  isAssignedCallingCode,
} from '../src/callingCodes.js';
import {
  EMERGENCY_NUMBERS,
  JP_PREMIUM_PREFIXES,
  checkCountryCode,
  checkDestination,
  checkPremiumNumber,
  isEmergencyNumber,
  normalizeToE164,
} from '../src/guardrails.js';
import { ConfigError, getAllowedCountryCodes } from '../src/config.js';

const MANAGED_ENV = ['ALLOWED_COUNTRY_CODES', 'ALLOW_PREMIUM_NUMBERS', 'ALLOWED_NUMBERS'];

describe('発信先ガードレール', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    for (const name of MANAGED_ENV) {
      delete process.env[name];
    }
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('国番号テーブル', () => {
    // この性質が崩れると前方一致による判定が成立しなくなる。
    // 表を編集して壊した場合にここで検知する。
    it('国番号はプレフィックスフリーである（どの番号も他の番号の先頭にならない）', () => {
      const codes = [...ASSIGNED_CALLING_CODES];
      const collisions: string[] = [];

      for (const code of codes) {
        for (const other of codes) {
          if (code !== other && other.startsWith(code)) {
            collisions.push(`${code} は ${other} の先頭部分になっている`);
          }
        }
      }

      expect(collisions).toEqual([]);
    });

    it('すべて1〜3桁の数字で、0で始まらない', () => {
      for (const code of ASSIGNED_CALLING_CODES) {
        expect(code).toMatch(/^[1-9]\d{0,2}$/);
      }
    });

    it.each([
      ['+819012345678', '81'],
      ['+12125551234', '1'],
      ['+886912345678', '886'],
      ['+74951234567', '7'],
      ['+493012345678', '49'],
    ])('%s の国番号は %s', (e164, expected) => {
      expect(getCallingCode(e164)).toBe(expected);
    });

    // 表を持たずに startsWith で判定していると、+81 が 8 に一致してしまう
    it('割り当てのない国番号は認識しない', () => {
      expect(isAssignedCallingCode('8')).toBe(false);
      expect(isAssignedCallingCode('0')).toBe(false);
      expect(isAssignedCallingCode('081')).toBe(false);
      expect(getCallingCode('+999999999999')).toBeNull();
    });

    it('+ で始まらない文字列からは判定しない', () => {
      expect(getCallingCode('819012345678')).toBeNull();
    });
  });

  describe('緊急通報番号', () => {
    it.each([...EMERGENCY_NUMBERS])('%s はブロックされる', (number) => {
      expect(isEmergencyNumber(number)).toBe(true);
    });

    it('表記ゆれ（空白・ハイフン・+81付き）でもブロックされる', () => {
      expect(isEmergencyNumber('1-1-0')).toBe(true);
      expect(isEmergencyNumber(' 119 ')).toBe(true);
      expect(isEmergencyNumber('+81110')).toBe(true);
    });

    // 前方・後方一致で判定すると、これらを誤ってブロックしてしまう
    it('末尾や先頭が緊急番号と同じだけの通常の番号はブロックしない', () => {
      expect(isEmergencyNumber('+819012345119')).toBe(false);
      expect(isEmergencyNumber('+811012345678')).toBe(false);
      expect(isEmergencyNumber('09012345678')).toBe(false);
    });

    it('どんな設定でもブロックされる（環境変数で緩められない）', () => {
      process.env.ALLOWED_COUNTRY_CODES = '*';
      process.env.ALLOW_PREMIUM_NUMBERS = 'true';
      process.env.ALLOWED_NUMBERS = '110';

      const result = checkDestination('110', '+110');

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('緊急通報番号');
    });
  });

  describe('高額課金番号', () => {
    it.each(JP_PREMIUM_PREFIXES.map((entry) => entry.prefix))(
      '%s で始まる番号は既定でブロックされる',
      (prefix) => {
        const result = checkPremiumNumber(normalizeToE164(`${prefix}123456`));
        expect(result.allowed).toBe(false);
        expect(result.suggestion).toContain('ALLOW_PREMIUM_NUMBERS');
      }
    );

    it('通常の携帯番号はブロックされない', () => {
      expect(checkPremiumNumber('+819012345678').allowed).toBe(true);
    });

    it('ALLOW_PREMIUM_NUMBERS=true で解除できる', () => {
      process.env.ALLOW_PREMIUM_NUMBERS = 'true';
      expect(checkPremiumNumber(normalizeToE164('0990123456')).allowed).toBe(true);
    });

    it('日本以外の番号には適用しない', () => {
      // 米国の +1 990... を日本の 0990 と誤認しないこと
      expect(checkPremiumNumber('+19901234567').allowed).toBe(true);
    });
  });

  describe('国番号による宛先制限', () => {
    it('既定では日本宛のみ許可される', () => {
      expect(checkCountryCode('+819012345678').allowed).toBe(true);

      const us = checkCountryCode('+12125551234');
      expect(us.allowed).toBe(false);
      expect(us.reason).toContain('国番号 +1');
      expect(us.suggestion).toContain('ALLOWED_COUNTRY_CODES');
    });

    it('追加した国番号は許可される', () => {
      process.env.ALLOWED_COUNTRY_CODES = '81,1';
      expect(checkCountryCode('+12125551234').allowed).toBe(true);
      expect(checkCountryCode('+819012345678').allowed).toBe(true);
      expect(checkCountryCode('+886912345678').allowed).toBe(false);
    });

    it('+ 付きや空白混じりの表記も受け付ける', () => {
      process.env.ALLOWED_COUNTRY_CODES = ' +81 , 1 ,';
      expect(getAllowedCountryCodes()).toEqual(new Set(['81', '1']));
    });

    it('* を指定すると制限が外れる', () => {
      process.env.ALLOWED_COUNTRY_CODES = '*';
      expect(getAllowedCountryCodes()).toBeNull();
      expect(checkCountryCode('+12125551234').allowed).toBe(true);
    });

    // 桁数の境界（1桁 / 2桁 / 3桁）を実際に踏む
    it.each([
      ['1', '+12125551234', '+819012345678'],
      ['81', '+819012345678', '+12125551234'],
      ['886', '+886912345678', '+819012345678'],
    ])('国番号 %s だけを許可すると、その国だけが通る', (code, allowed, denied) => {
      process.env.ALLOWED_COUNTRY_CODES = code;
      expect(checkCountryCode(allowed).allowed).toBe(true);
      expect(checkCountryCode(denied).allowed).toBe(false);
    });

    // 表を持たない実装だと 8 が +81 に一致してしまう
    it('実在しない国番号は起動エラーになる', () => {
      process.env.ALLOWED_COUNTRY_CODES = '8';
      expect(() => getAllowedCountryCodes()).toThrow(ConfigError);

      process.env.ALLOWED_COUNTRY_CODES = '081';
      expect(() => getAllowedCountryCodes()).toThrow(/081/);
    });

    it('有効な国番号が1件も無い設定は起動エラーになる', () => {
      process.env.ALLOWED_COUNTRY_CODES = ' , ,';
      expect(() => getAllowedCountryCodes()).toThrow(ConfigError);
    });
  });

  describe('checkDestination の適用順', () => {
    it('ALLOWED_NUMBERS に載っていても国番号の制限が優先される', () => {
      process.env.ALLOWED_NUMBERS = '+12125551234';

      const result = checkDestination('+12125551234', '+12125551234');

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('国番号');
    });

    it('国番号を許可しても ALLOWED_NUMBERS の制限は残る（AND で効く）', () => {
      process.env.ALLOWED_COUNTRY_CODES = '81,1';
      process.env.ALLOWED_NUMBERS = '+819012345678';

      expect(checkDestination('+12125551234', '+12125551234').allowed).toBe(false);
      expect(checkDestination('09012345678', '+819012345678').allowed).toBe(true);
    });

    it('すべての制限を通れば許可される', () => {
      expect(checkDestination('09012345678', '+819012345678').allowed).toBe(true);
    });
  });
});
