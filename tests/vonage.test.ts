import { validatePhoneNumber } from '../src/vonage.js';

describe('Vonage SMS Tests', () => {
  describe('validatePhoneNumber', () => {
    test('日本の電話番号（0から始まる）を正しく検証する', () => {
      expect(validatePhoneNumber('09045327751')).toBe(true);
      expect(validatePhoneNumber('08012345678')).toBe(true);
      expect(validatePhoneNumber('07098765432')).toBe(true);
    });

    test('E.164形式の電話番号を正しく検証する', () => {
      expect(validatePhoneNumber('+819045327751')).toBe(true);
      expect(validatePhoneNumber('+1234567890')).toBe(true);
      expect(validatePhoneNumber('+447911123456')).toBe(true);
    });

    test('無効な電話番号を正しく検証する', () => {
      expect(validatePhoneNumber('123')).toBe(false);
      expect(validatePhoneNumber('abc')).toBe(false);
      expect(validatePhoneNumber('')).toBe(false);
      expect(validatePhoneNumber('+')).toBe(false);
    });

    test('ハイフンや空白を含む電話番号を正しく処理する', () => {
      expect(validatePhoneNumber('090-4532-7751')).toBe(true);
      expect(validatePhoneNumber('090 4532 7751')).toBe(true);
      expect(validatePhoneNumber('+81 90 4532 7751')).toBe(true);
    });
  });
}); 