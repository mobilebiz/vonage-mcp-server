import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

import { SERVER_NAME, SERVER_VERSION } from '../src/mcpServer.js';
import { readFileFromMcpb } from './mcpbBundle.js';

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
 *
 * **そして5か所目が `vonage-mcp-server.mcpb` そのものである。** ソース4か所を全部
 * 直しても、`npm run build:mcpb` を忘れれば**追跡されているバンドルは旧版を名乗り続ける**。
 * README が推奨する導入経路はこのバンドルなので、**利用者が受け取るのはそちら**。
 * ソースだけを見るテストは、この一番大事なずれを素通りさせる。
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

  /**
   * **配布物そのものを見る。**
   *
   * ここまでの4件はすべてソース側で、`npm run build:mcpb` を忘れても全部通る。
   * 追跡されているバンドルは**利用者が実際にインストールするもの**なので、
   * これがずれていることが一番まずい（VONAGE_MCP-2 §9「追跡されている生成物」）。
   */
  describe('配布する .mcpb の中身', () => {
    const bundle = fileURLToPath(new URL('../vonage-mcp-server.mcpb', import.meta.url));

    function readBundledJson(entry: string): { version?: string } {
      const content = readFileFromMcpb(bundle, entry);
      expect(content, `${entry} がバンドルに入っていません`).not.toBeNull();
      return JSON.parse(content!.toString('utf-8'));
    }

    it('manifest.json のバージョンが一致する', () => {
      expect(readBundledJson('manifest.json').version).toBe(SERVER_VERSION);
    });

    it('package.json のバージョンが一致する', () => {
      expect(readBundledJson('package.json').version).toBe(SERVER_VERSION);
    });

    it('生成された node_modules/.package-lock.json のバージョンが一致する', () => {
      expect(readBundledJson('node_modules/.package-lock.json').version).toBe(SERVER_VERSION);
    });

    // 名乗る値そのもの。manifest だけ合っていても、動くコードが古ければ
    // クライアントには古い版が見える
    it('同梱された dist/mcpServer.js の SERVER_VERSION が一致する', () => {
      const code = readFileFromMcpb(bundle, 'dist/mcpServer.js');
      expect(code, 'dist/mcpServer.js がバンドルに入っていません').not.toBeNull();
      expect(code!.toString('utf-8')).toContain(`SERVER_VERSION = '${SERVER_VERSION}'`);
    });
  });
});
