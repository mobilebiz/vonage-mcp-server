/**
 * `.mcpb`（= ZIP）から、外部コマンドに頼らずファイルを1つ取り出す。
 *
 * **なぜ自前で読むのか。** このリポジトリには CI が無く、バンドルの検証は
 * 手元で `npm test` を走らせたときにしか働かない。`unzip` を呼ぶ形にすると、
 * それが無い環境で**テストがスキップされるか、環境依存で落ちる**。
 * 「stdio E2E がスキップされていたら capability 強制は未検証」と同じ罠を、
 * 配布物の検証で繰り返したくない。
 *
 * 依存も足さない。`mcpb` CLI をグローバル前提にしたのと同じ判断で、
 * リリース前の確認にしか使わないもののために依存ツリーを太らせない。
 *
 * ZIP の全機能は実装しない。**このバンドルが実際に使う範囲**（deflate と
 * 無圧縮、zip64 でないサイズ）だけを読む。範囲外に当たったら黙って
 * 誤読せずに投げる。
 */

import { readFileSync } from 'fs';
import { inflateRawSync } from 'zlib';

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_FILE_HEADER = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;

/** 中央ディレクトリの位置と件数を EOCD から読む */
function readEndOfCentralDirectory(zip: Buffer): { offset: number; count: number } {
  // EOCD は可変長コメントの手前にあるので、末尾から探す
  for (let i = zip.length - 22; i >= 0; i--) {
    if (zip.readUInt32LE(i) === END_OF_CENTRAL_DIRECTORY) {
      const count = zip.readUInt16LE(i + 10);
      const offset = zip.readUInt32LE(i + 16);

      if (offset === 0xffffffff || count === 0xffff) {
        throw new Error('zip64 のアーカイブは読めません');
      }

      return { offset, count };
    }
  }

  throw new Error('ZIP の中央ディレクトリが見つかりません');
}

/**
 * バンドル内の1ファイルを取り出す。見つからなければ null。
 *
 * サイズと圧縮方式は**中央ディレクトリ側の値を使う**。ローカルヘッダーは
 * data descriptor を使う書き方だと 0 が入っていることがあり、そちらを信じると
 * 空のファイルを読んだことにしてしまう。
 */
export function readFileFromMcpb(bundlePath: string, entryName: string): Buffer | null {
  const zip = readFileSync(bundlePath);
  const { offset, count } = readEndOfCentralDirectory(zip);

  let cursor = offset;

  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(cursor) !== CENTRAL_FILE_HEADER) {
      throw new Error(`中央ディレクトリの ${i} 件目が壊れています`);
    }

    const method = zip.readUInt16LE(cursor + 10);
    const compressedSize = zip.readUInt32LE(cursor + 20);
    const nameLength = zip.readUInt16LE(cursor + 28);
    const extraLength = zip.readUInt16LE(cursor + 30);
    const commentLength = zip.readUInt16LE(cursor + 32);
    const localOffset = zip.readUInt32LE(cursor + 42);
    const name = zip.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf-8');

    if (name === entryName) {
      if (zip.readUInt32LE(localOffset) !== LOCAL_FILE_HEADER) {
        throw new Error(`${entryName} のローカルヘッダーが壊れています`);
      }

      // ローカルヘッダーの名前長・extra 長は中央ディレクトリ側と違いうる
      const localNameLength = zip.readUInt16LE(localOffset + 26);
      const localExtraLength = zip.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const data = zip.subarray(dataStart, dataStart + compressedSize);

      if (method === 0) {
        return Buffer.from(data);
      }
      if (method === 8) {
        return inflateRawSync(data);
      }

      throw new Error(`${entryName} の圧縮方式 ${method} には対応していません`);
    }

    cursor += 46 + nameLength + extraLength + commentLength;
  }

  return null;
}
