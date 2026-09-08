import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

import { SERVER_NAME, SERVER_VERSION } from '../src/mcpServer.js';

/**
 * 配布物が名乗るバージョンの固定。
 *
 * `SERVER_VERSION` は手書きの定数で、`/health` と MCP の initialize の両方で名乗る。
 * **版を上げたときにここだけ取り残されると、配布物も稼働中のサーバーも古い版を
 * 名乗り続ける。** v3.1.0 で実際にそれをやった — `package.json` と `manifest.json` は
 * 3.1.0 なのに、本番の `/health` は `3.0.0` を返していた。しかも
 * **デプロイの成否をこの値で確かめる運用をしていた**ので、「反映されていない」と
 * 読み違える一歩手前だった。
 *
 * バージョンは**4か所**に散っている — コード / 配布マニフェスト / パッケージ定義 /
 * **lockfile**。どれか1つを直したら残りも動く、という保証は人間の注意力しかない。
 *
 * **この一覧自体を数え違えた。** v3.1.1 で最初に書いたときは lockfile を数え落としており、
 * その状態で `npm install` を実行すると追跡中の lockfile が書き換わり、
 * **バンドルに焼き込まれる `node_modules/.package-lock.json` は 3.1.0 のままだった。**
 * 「散らばりを縛るテスト」を書くときは、**散らばりの数え上げ自体が漏れる**。
 */
describe('名乗るバージョン', () => {
  function readJson(relativePath: string): { name: string; version: string } {
    const path = fileURLToPath(new URL(relativePath, import.meta.url));
    return JSON.parse(readFileSync(path, 'utf-8'));
  }

  it('SERVER_VERSION が package.json と一致する', () => {
    expect(SERVER_VERSION).toBe(readJson('../package.json').version);
  });

  // MCPB はこの manifest をビルド時点で焼き込む。ずれると、利用者の
  // Claude Desktop に出る版と、サーバーが名乗る版が食い違う
  it('manifest.json のバージョンも一致する', () => {
    expect(readJson('../manifest.json').version).toBe(SERVER_VERSION);
  });

  // 追跡している lockfile がずれていると、`npm install` のたびに作業ツリーが汚れ、
  // **バンドルに焼き込まれる node_modules/.package-lock.json も古い版を名乗る**
  it('package-lock.json のバージョンも一致する', () => {
    const lock = readJson('../package-lock.json') as unknown as {
      version: string;
      packages: Record<string, { version?: string }>;
    };

    expect(lock.version).toBe(SERVER_VERSION);
    expect(lock.packages[''].version).toBe(SERVER_VERSION);
  });

  it('SERVER_NAME が package.json と一致する', () => {
    expect(SERVER_NAME).toBe(readJson('../package.json').name);
  });
});
