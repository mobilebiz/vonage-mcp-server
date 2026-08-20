/**
 * テスト実行前の共通セットアップ
 */

/**
 * プロキシ関連の環境変数を消す。
 *
 * supertest はプロセス内で一時ポートを開いて `127.0.0.1` に繋ぐだけなので、
 * HTTP プロキシを経由する理由がない。それでも環境にプロキシ変数があると、
 * ループバック宛のリクエストが**ときどき**プロキシに吸われ、アプリからは
 * 返しようのない 407 (Proxy Authentication Required) や
 * "Parse Error: Expected HTTP/" になる。
 *
 * 失敗するテストが毎回違うため一見ランダムなテストの不安定さに見えるが、
 * 原因は環境であってコードではない。プロキシ配下の開発環境や CI で
 * 同じ症状に悩まないよう、ここで確実に無効化しておく。
 */
const PROXY_ENV_VARS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
];

for (const name of PROXY_ENV_VARS) {
  delete process.env[name];
}
