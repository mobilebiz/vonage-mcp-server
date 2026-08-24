import { describe, it, expect } from 'vitest';
import {
  JP_MAX_CONCATENATED_CHARS,
  approximateCharsForSegments,
  estimateSmsSegments,
  isGsm7,
} from '../src/smsSegments.js';

describe('SMS のセグメント見積もり', () => {
  describe('エンコーディングの判定', () => {
    it('GSM-7 の基本文字だけなら GSM-7', () => {
      expect(isGsm7('Hello, World! 12345')).toBe(true);
      expect(isGsm7('@$&*()+-./:;<=>?')).toBe(true);
    });

    // これが1文字でも混ざると全体が UCS-2 になり、1セグメント70文字に落ちる
    it('非ASCIIが1文字でも混ざれば UCS-2', () => {
      expect(isGsm7('Hello、World')).toBe(false);
      expect(isGsm7('a'.repeat(159) + 'あ')).toBe(false);
      expect(isGsm7('見積もり')).toBe(false);
    });

    it('絵文字は UCS-2', () => {
      expect(isGsm7('OK👍')).toBe(false);
    });
  });

  describe('GSM-7', () => {
    it('160文字までは1セグメント', () => {
      expect(estimateSmsSegments('a'.repeat(160)).segments).toBe(1);
      expect(estimateSmsSegments('a'.repeat(160)).encoding).toBe('GSM-7');
    });

    // 連結すると UDH のぶん1セグメント7文字減って153文字になる
    it('161文字からは連結され、1セグメント153文字になる', () => {
      expect(estimateSmsSegments('a'.repeat(161)).segments).toBe(2);
      expect(estimateSmsSegments('a'.repeat(306)).segments).toBe(2);
      expect(estimateSmsSegments('a'.repeat(307)).segments).toBe(3);
    });

    // 拡張文字はエスケープが必要で2文字分を消費する
    it('拡張文字は2文字分として数える', () => {
      expect(estimateSmsSegments('€').units).toBe(2);
      expect(estimateSmsSegments('a'.repeat(159) + '€').segments).toBe(2);
    });
  });

  describe('UCS-2 (日本語)', () => {
    it('70文字までは1セグメント', () => {
      expect(estimateSmsSegments('あ'.repeat(70)).segments).toBe(1);
      expect(estimateSmsSegments('あ'.repeat(70)).encoding).toBe('UCS-2');
    });

    it('71文字からは連結され、1セグメント67文字になる', () => {
      expect(estimateSmsSegments('あ'.repeat(71)).segments).toBe(2);
      expect(estimateSmsSegments('あ'.repeat(134)).segments).toBe(2);
      expect(estimateSmsSegments('あ'.repeat(135)).segments).toBe(3);
    });

    // 従来の「160文字まで」は、日本語では3通分の課金を許していた
    it('日本語160文字は3セグメント（＝3通分の課金）', () => {
      expect(estimateSmsSegments('あ'.repeat(160)).segments).toBe(3);
    });

    // サロゲートペアは UTF-16 で2ユニットを占める
    it('絵文字は2ユニットとして数える', () => {
      const estimate = estimateSmsSegments('👍');
      expect(estimate.units).toBe(2);
      expect(estimate.characters).toBe(1);
    });
  });

  describe('characters', () => {
    it('利用者向けの文字数はコードポイント単位で数える', () => {
      expect(estimateSmsSegments('あいう').characters).toBe(3);
      expect(estimateSmsSegments('👍👍').characters).toBe(2);
    });
  });

  describe('approximateCharsForSegments', () => {
    it('1セグメントは連結しないぶん多く入る', () => {
      expect(approximateCharsForSegments('GSM-7', 1)).toBe(160);
      expect(approximateCharsForSegments('UCS-2', 1)).toBe(70);
    });

    it('2セグメント以上は連結時の文字数で計算する', () => {
      expect(approximateCharsForSegments('GSM-7', 3)).toBe(459);
      expect(approximateCharsForSegments('UCS-2', 3)).toBe(201);
    });
  });

  it('日本の連結上限は安全側の 660 を採る（Rakuten が最小）', () => {
    expect(JP_MAX_CONCATENATED_CHARS).toBe(660);
  });
});
