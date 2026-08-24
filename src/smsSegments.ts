/**
 * SMS のエンコーディング判定とセグメント数の見積もり
 *
 * **課金はメッセージ単位ではなくセグメント単位で発生する。** 本文の文字数だけを
 * 見て上限を決めても、実際に発生する費用とは対応しない。日本語は UCS-2 になり
 * 1セグメント70文字なので、160文字の本文は3セグメント＝3通分の課金になる。
 *
 * @see https://developer.vonage.com/en/messaging/sms/guides/concatenation-and-encoding
 */

/** GSM-7 の基本文字集合。ここに無い文字が1つでもあれば UCS-2 になる */
const GSM7_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';

/**
 * GSM-7 の拡張文字。エスケープが必要なため**1文字で2文字分**を消費する。
 */
const GSM7_EXTENDED = '^{}\\[~]|€';

const GSM7_BASIC_SET = new Set(GSM7_BASIC);
const GSM7_EXTENDED_SET = new Set(GSM7_EXTENDED);

/** 1セグメントで送れる文字数（連結しない場合） */
const GSM7_SINGLE = 160;
const UCS2_SINGLE = 70;

/**
 * 連結時の1セグメントあたりの文字数。
 * 連結情報 (UDH) がヘッダーを占めるため、どちらも7文字分減る。
 */
const GSM7_CONCAT = 153;
const UCS2_CONCAT = 67;

/** 日本の Unicode 連結メッセージの上限。Rakuten の 660 が最小なので安全側を採る */
export const JP_MAX_CONCATENATED_CHARS = 660;

/** SMS のエンコーディング */
export type SmsEncoding = 'GSM-7' | 'UCS-2';

/** セグメント見積もりの結果 */
export interface SmsSegmentEstimate {
  encoding: SmsEncoding;
  /** エンコーディング上の長さ。GSM-7 の拡張文字は2として数える */
  units: number;
  /** 課金対象となるセグメント数 */
  segments: number;
  /** 本文の文字数（利用者向けの表示用） */
  characters: number;
}

/** 本文が GSM-7 だけで表現できるか */
export function isGsm7(message: string): boolean {
  for (const char of message) {
    if (!GSM7_BASIC_SET.has(char) && !GSM7_EXTENDED_SET.has(char)) {
      return false;
    }
  }
  return true;
}

/**
 * 本文からエンコーディングとセグメント数を見積もる。
 *
 * UCS-2 の長さは UTF-16 のコードユニット数で数える。絵文字などのサロゲートペアは
 * 2ユニットを占めるため、「見た目の文字数」より多くなる。
 */
export function estimateSmsSegments(message: string): SmsSegmentEstimate {
  const characters = [...message].length;

  if (isGsm7(message)) {
    let units = 0;
    for (const char of message) {
      units += GSM7_EXTENDED_SET.has(char) ? 2 : 1;
    }

    return {
      encoding: 'GSM-7',
      units,
      segments: units <= GSM7_SINGLE ? 1 : Math.ceil(units / GSM7_CONCAT),
      characters,
    };
  }

  // UTF-16 のコードユニット数
  const units = message.length;

  return {
    encoding: 'UCS-2',
    units,
    segments: units <= UCS2_SINGLE ? 1 : Math.ceil(units / UCS2_CONCAT),
    characters,
  };
}

/**
 * 指定したセグメント数に収まる最大文字数の目安を返す（エラーメッセージ用）。
 *
 * GSM-7 の拡張文字を考慮しないおおよその値。「あと何文字削ればよいか」を
 * エージェントに伝えるためのもので、厳密な保証ではない。
 */
export function approximateCharsForSegments(encoding: SmsEncoding, segments: number): number {
  if (segments <= 1) {
    return encoding === 'GSM-7' ? GSM7_SINGLE : UCS2_SINGLE;
  }

  return (encoding === 'GSM-7' ? GSM7_CONCAT : UCS2_CONCAT) * segments;
}
