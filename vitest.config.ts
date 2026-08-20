import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // プロキシ環境変数の無効化。理由は tests/setup.ts を参照。
    setupFiles: ['./tests/setup.ts'],
  },
});
