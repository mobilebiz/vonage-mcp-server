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
 * バージョンは「コード / 配布マニフェスト / パッケージ定義」の3か所に散っている。
 * どれか1つを直したら残りも動く、という保証は人間の注意力しかない。ここで縛る。
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

  it('SERVER_NAME が package.json と一致する', () => {
    expect(SERVER_NAME).toBe(readJson('../package.json').name);
  });
});
