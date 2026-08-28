/**
 * 環境変数の厳格なパースと起動時検証
 *
 * このサーバーは OSS として配布され、利用者が自分の環境にコンテナを立てて動かす。
 * したがって「設定ミス」が最大の failure mode になる。このモジュールは解釈できない
 * 値を黙って既定値に落とすことをせず、起動時にエラーで止める（fail-fast）。
 *
 * とくに次の2つは、黙って通すと課金事故に直結する:
 *   - `ENABLE_X=false` が truthy 判定されて、無効にしたつもりの機能が公開される
 *   - 緊急停止のつもりの `RATE_LIMIT_PER_HOUR=0` が「無制限」に解釈される
 */

import { accessSync, constants } from 'fs';

import { isAssignedCallingCode } from './callingCodes.js';

/** 設定エラー。1度の起動で見つかった問題をまとめて報告する */
export class ConfigError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`環境変数の設定に問題があります:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

/** レートリミットの既定値（1時間あたりのSMS送信・架電の件数） */
export const DEFAULT_RATE_LIMIT_PER_HOUR = 5;

/**
 * コード側の安全上限。これを超える設定は起動エラーにする。
 * 桁を1つ打ち間違えただけで青天井の課金にならないための歯止め。
 */
export const MAX_RATE_LIMIT_PER_HOUR = 10_000;

/**
 * 読み上げメッセージ長の上限（通話時間の暴走を防ぐ）。
 *
 * make_voice_call のスキーマと、着信案内 `VOICE_INBOUND_MESSAGE` の両方に掛ける。
 * 発信側だけ縛っても、**着信は誰でも掛けられる**ため上限にならない。
 *
 * guardrails.ts からも再公開している（既存の import 元を変えないため）。
 */
export const VOICE_MESSAGE_MAX_LENGTH = 1000;

/** capability トグルの環境変数名。 */
export const CAPABILITY_ENV_VARS = ['ENABLE_SMS', 'ENABLE_VOICE'] as const;

/**
 * レートリミットのバケット。
 *
 * `global` が主たる上限で、`sms` / `voice` は必要な組織だけが追加で絞るための層。
 * ツールごとにバケットを分けると、送信手段を変えるだけで上限を素通りできてしまう
 * （VONAGE_MCP-17。当時は単発 SMS で上限まで送ったあと、1行だけの CSV 一括送信を
 * 繰り返すことで実際に起きた）。課金は送信手段ではなく件数で発生するので、
 * バケットも送信手段ではなく件数に対して置く。
 */
export const RATE_LIMIT_BUCKETS = ['global', 'sms', 'voice', 'segments'] as const;

/** レートリミットのバケット名 */
export type RateLimitBucket = (typeof RATE_LIMIT_BUCKETS)[number];

/** バケットごとの上限を指定する環境変数名 */
export const RATE_LIMIT_ENV_VARS: Record<RateLimitBucket, string> = {
  global: 'RATE_LIMIT_PER_HOUR',
  sms: 'SMS_RATE_LIMIT_PER_HOUR',
  voice: 'VOICE_RATE_LIMIT_PER_HOUR',
  segments: 'SMS_SEGMENT_LIMIT_PER_HOUR',
};

/** 1通のSMSに許すセグメント数の既定値 */
export const DEFAULT_SMS_MAX_SEGMENTS = 3;

/** セグメント数の上限に指定できる最大値 */
export const MAX_SMS_MAX_SEGMENTS = 10;

/**
 * MCP_AUTH_TOKEN に要求する最小の長さ。
 * 短い共有シークレットは総当たりで破られるため、設定の時点で弾く。
 */
export const MIN_MCP_AUTH_TOKEN_LENGTH = 16;

/**
 * VONAGE_WEBHOOK_SECRET に要求する最小の長さ。
 *
 * 共有シークレット方式の webhook エンドポイントは公開されていて試行回数の
 * 制限も無いため、短い値はオンライン総当たりで割れる。割られると配信結果を
 * 偽装できる。MCP_AUTH_TOKEN と同じ基準を課す（VONAGE_MCP-4）。
 */
export const MIN_WEBHOOK_SECRET_LENGTH = 16;

/**
 * HTTP のリクエストボディに許すサイズ（バイト）。
 *
 * express.json() の既定（100KB）ではなくこの値を使う。ツールの引数と JSON-RPC の
 * 枠に十分な余裕を持たせつつ、認証済みの相手にメモリを好きなだけ使わせないための
 * 上限でもある。
 */
export const MIN_REQUEST_BODY_BYTES = 1024 * 1024;

/** ループバックとみなすホスト */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', '::1', 'localhost']);

/** 署名付き Webhook を受け付ける時刻のずれの許容幅（秒） */
export const DEFAULT_WEBHOOK_MAX_AGE_SECONDS = 300;

/** ALLOWED_COUNTRY_CODES の既定値。このプロジェクトは日本国内利用を前提とする */
export const DEFAULT_ALLOWED_COUNTRY_CODES = ['81'];

/** ALLOWED_COUNTRY_CODES に指定すると国番号による制限を外す特別な値 */
export const ALLOW_ALL_COUNTRY_CODES = '*';

/** capability を指定する環境変数名 */
export type CapabilityName = (typeof CAPABILITY_ENV_VARS)[number];

/** 有効化されている機能。キーは環境変数名そのもの（命名体系を二重に持たない） */
export type Capabilities = Record<CapabilityName, boolean>;

/**
 * 真偽値の環境変数を厳格に解釈する。
 *
 * 受け付けるのは `true` / `false` の2つだけ（前後の空白は無視する）。未設定と空文字は false。
 * `1` / `yes` / `on` / `True` / `TRUE` はすべて起動エラーにする。
 *
 * 大文字小文字まで区別するのは、曖昧な値を「たぶんこう書きたかったのだろう」と
 * 推測するより、起動時に落として書き直させるほうが安全だから。Helm や
 * docker-compose から文字列として渡ってくる以上、推測は必ずどこかで外れる。
 */
export function parseBooleanEnv(name: string, raw: string | undefined = process.env[name]): boolean {
  if (raw === undefined) {
    return false;
  }

  const value = raw.trim();
  if (value === '' || value === 'false') {
    return false;
  }
  if (value === 'true') {
    return true;
  }

  throw new ConfigError([
    `${name}=${JSON.stringify(raw)} は解釈できません。指定できるのは true / false のみです` +
      `（大文字小文字を区別します。1 / yes / on / True は使えません）。` +
      `無効にしたい場合は false を設定するか、環境変数自体を削除してください。`,
  ]);
}

/** 整数の環境変数を解釈する際の制約 */
export interface IntegerEnvOptions {
  min: number;
  max: number;
  defaultValue: number;
}

/**
 * 整数の環境変数を厳格に解釈する。未設定と空文字は既定値。
 *
 * Number() は `1e3` / `0x10` / `1.5` / `Infinity` をすべて通してしまうため、
 * 10進整数の表記そのものを正規表現で縛る。範囲外・非整数は起動エラー。
 */
export function parseIntegerEnv(
  name: string,
  options: IntegerEnvOptions,
  raw: string | undefined = process.env[name]
): number {
  if (raw === undefined || raw.trim() === '') {
    return options.defaultValue;
  }

  const value = raw.trim();

  if (!/^-?\d+$/.test(value)) {
    throw new ConfigError([
      `${name}=${JSON.stringify(raw)} は整数として解釈できません。` +
        `${options.min} 以上 ${options.max} 以下の10進整数で指定してください（小数・指数表記・16進数は使えません）。`,
    ]);
  }

  const parsed = Number(value);
  if (parsed < options.min || parsed > options.max) {
    throw new ConfigError([
      `${name}=${value} は範囲外です。${options.min} 以上 ${options.max} 以下で指定してください。`,
    ]);
  }

  return parsed;
}

/**
 * レートリミットが明示的に無効化されているか。
 *
 * `RATE_LIMIT_PER_HOUR=0` は「無制限」ではなく「全拒否」を意味する。無制限にしたい
 * 場合は、危険な設定であることが名前から分かる DISABLE_RATE_LIMIT で宣言させる。
 */
export function isRateLimitDisabled(): boolean {
  return parseBooleanEnv('DISABLE_RATE_LIMIT');
}

/**
 * 1時間あたりの送信・架電の上限件数を返す。
 *
 * - 未設定: 既定値 5
 * - `0`: 全拒否（緊急停止）
 * - `DISABLE_RATE_LIMIT=true`: Infinity（無制限）
 */
export function getRateLimitPerHour(): number {
  if (isRateLimitDisabled()) {
    return Infinity;
  }

  return parseIntegerEnv('RATE_LIMIT_PER_HOUR', {
    min: 0,
    max: MAX_RATE_LIMIT_PER_HOUR,
    defaultValue: DEFAULT_RATE_LIMIT_PER_HOUR,
  });
}

/**
 * チャネル別の上限（`sms` / `voice`）を返す。未設定は Infinity＝`global` に委ねる。
 *
 * 既定を Infinity にしているのは、`RATE_LIMIT_PER_HOUR` だけを設定した管理者の
 * 意図（合計で何件まで）をそのまま満たすため。チャネルごとに絞りたい組織だけが
 * 明示的に設定する。
 */
function getChannelRateLimit(bucket: 'sms' | 'voice' | 'segments'): number {
  const name = RATE_LIMIT_ENV_VARS[bucket];
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') {
    return Infinity;
  }

  return parseIntegerEnv(name, { min: 0, max: MAX_RATE_LIMIT_PER_HOUR, defaultValue: Infinity });
}

/**
 * 全バケットの上限を返す。DISABLE_RATE_LIMIT=true ならすべて Infinity。
 */
export function getRateLimits(): Record<RateLimitBucket, number> {
  if (isRateLimitDisabled()) {
    return { global: Infinity, sms: Infinity, voice: Infinity, segments: Infinity };
  }

  return {
    global: getRateLimitPerHour(),
    sms: getChannelRateLimit('sms'),
    voice: getChannelRateLimit('voice'),
    segments: getChannelRateLimit('segments'),
  };
}

/**
 * 1通のSMSに許すセグメント数の上限。
 *
 * 文字数ではなくセグメント数で縛るのは、**課金がセグメント単位**だから。
 * 「160文字まで」は GSM-7 の1通分という意味しか持たず、日本語では3通分に相当する。
 * 上限をセグメント数で書けば、エンコーディングが変わっても意図した費用のまま。
 */
export function getSmsMaxSegments(): number {
  return parseIntegerEnv('SMS_MAX_SEGMENTS', {
    min: 1,
    max: MAX_SMS_MAX_SEGMENTS,
    defaultValue: DEFAULT_SMS_MAX_SEGMENTS,
  });
}

/**
 * HTTP のリクエストボディに許す最大サイズ（バイト）。
 *
 * かつては `BULK_MAX_ROWS` から算出していた。CSV 一括送信を廃止した v3.0.0
 * 以降は、最大の入力が「1通分の本文」になったため固定値で足りる。
 */
export function getMaxRequestBodyBytes(): number {
  return MIN_REQUEST_BODY_BYTES;
}

/**
 * 指定した capability が有効か。既定は OFF（利用者に意識的に有効化させる）。
 *
 * 値は毎回 process.env から読み直す。起動時に検証済みなので、ここで解釈できない
 * 値に当たるのは環境変数が実行中に書き換えられた場合だけであり、その場合は
 * 例外にして機能を有効化しないほうが安全（fail-closed）。
 */
export function isCapabilityEnabled(name: CapabilityName): boolean {
  return parseBooleanEnv(name);
}

/** 有効化されている機能を返す。いずれも既定は OFF。 */
export function getCapabilities(): Capabilities {
  const capabilities = {} as Capabilities;
  for (const name of CAPABILITY_ENV_VARS) {
    capabilities[name] = parseBooleanEnv(name);
  }
  return capabilities;
}

/**
 * 送信・架電を許可する国番号を返す。null は「制限なし」（`*` 指定時）。
 *
 * 既定は日本 (`81`) のみ。海外宛は利用者が意識的に開ける必要がある。
 * 電話は国ごとに規制が違ううえ、IRSF（国際収益分配詐欺）の入り口でもあるため、
 * 「気づかないうちに海外へ送れる状態」を既定にしない。
 */
export function getAllowedCountryCodes(): Set<string> | null {
  const raw = process.env.ALLOWED_COUNTRY_CODES;
  if (raw === undefined || raw.trim() === '') {
    return new Set(DEFAULT_ALLOWED_COUNTRY_CODES);
  }

  if (raw.trim() === ALLOW_ALL_COUNTRY_CODES) {
    return null;
  }

  const codes = new Set<string>();
  const invalid: string[] = [];

  for (const entry of raw.split(',')) {
    // `+81` `81 ` のような表記ゆれは受け入れる。`081` は受け入れない
    // （国内プレフィックスの 0 を国番号と混同している設定ミスのため）。
    const normalized = entry.trim().replace(/^\+/, '');
    if (normalized === '') {
      continue;
    }
    if (isAssignedCallingCode(normalized)) {
      codes.add(normalized);
    } else {
      invalid.push(entry.trim());
    }
  }

  if (invalid.length > 0) {
    throw new ConfigError([
      `ALLOWED_COUNTRY_CODES に実在しない国番号が含まれています: ${invalid.join(', ')}。` +
        '国番号は先頭の 0 や国内プレフィックスを含めない1〜3桁の数字です（日本は 81、米国・カナダは 1）。' +
        `国番号による制限を外す場合は ${ALLOW_ALL_COUNTRY_CODES} を指定してください。`,
    ]);
  }

  if (codes.size === 0) {
    throw new ConfigError([
      'ALLOWED_COUNTRY_CODES が設定されていますが、有効な国番号が1件もありません。' +
        `制限が不要なら環境変数を削除する（既定の ${DEFAULT_ALLOWED_COUNTRY_CODES.join(', ')} に戻る）か、` +
        `${ALLOW_ALL_COUNTRY_CODES} を指定してください。`,
    ]);
  }

  return codes;
}

/**
 * HTTP トランスポートの Bearer トークン。未設定なら null。
 *
 * 以前は `X-API-KEY` を `VONAGE_APPLICATION_ID` と比較していたが、
 * **Application ID は秘密情報ではない**（Vonage に送る JWT の claim に入る公開識別子）。
 * これを認証に使うと、Application ID を知っている者は誰でもデプロイの持ち主の
 * 課金で SMS・架電ができてしまう（VONAGE_MCP-9）。
 */
export function getMcpAuthToken(): string | null {
  const raw = process.env.MCP_AUTH_TOKEN;
  if (raw === undefined || raw.trim() === '') {
    return null;
  }

  const token = raw.trim();
  if (token.length < MIN_MCP_AUTH_TOKEN_LENGTH) {
    throw new ConfigError([
      `MCP_AUTH_TOKEN が短すぎます（${token.length}文字）。${MIN_MCP_AUTH_TOKEN_LENGTH}文字以上のランダムな文字列を指定してください` +
        '（例: openssl rand -hex 32）。',
    ]);
  }

  return token;
}

/** VONAGE_PRIVATE_KEY_PATH が未設定のときに使う既定のパス */
export const DEFAULT_PRIVATE_KEY_PATH = './private.key';

/**
 * 秘密鍵のパス。**空白だけの値は未設定として扱い、既定値へ倒す。**
 *
 * 送信のたびに readFileSync される値なので、起動時の検証と実行時の読み取りが
 * 同じ値を指していなければ意味がない。以前は起動時だけ `.trim()` していたため、
 * `VONAGE_PRIVATE_KEY_PATH="   "` は**起動時は ./private.key を確認して通り、
 * 実行時は "   " を読んで毎回失敗する**という食い違いが起きていた。しかも失敗は
 * レート枠を消費したあとに来る。
 */
export function getPrivateKeyPath(): string {
  return process.env.VONAGE_PRIVATE_KEY_PATH?.trim() || DEFAULT_PRIVATE_KEY_PATH;
}

/**
 * 音声の着信時に読み上げる案内文。未設定なら null（呼び出し側の既定文を使う）。
 *
 * **長さの上限は発信側と同じ `VOICE_MESSAGE_MAX_LENGTH` を掛ける。**
 * make_voice_call はスキーマで縛っているが、こちらは環境変数なので誰も見ていない。
 * 着信番号は公開されていて誰でも掛けられるため、長い案内文を置くと1件ごとに
 * TTS の課金と通話時間が伸び、発信側に掛けた上限が意味を成さなくなる。
 *
 * 起動時に落とす（切り詰めない）。黙って短くすると、運用者は設定したはずの
 * 案内が流れていないことに気づけない。
 */
export function getVoiceInboundMessage(): string | null {
  const raw = process.env.VOICE_INBOUND_MESSAGE;
  if (raw === undefined || raw.trim() === '') {
    return null;
  }

  const message = raw.trim();
  if (message.length > VOICE_MESSAGE_MAX_LENGTH) {
    throw new ConfigError([
      `VOICE_INBOUND_MESSAGE が長すぎます（${message.length}文字）。` +
        `${VOICE_MESSAGE_MAX_LENGTH}文字以内にしてください。` +
        '着信は誰でも掛けられるため、読み上げが長いほど通話時間と音声合成の課金が増えます。',
    ]);
  }

  return message;
}

/**
 * 認証を上流（Cloud Run IAM / API Gateway など）に任せる宣言。
 *
 * これを true にすると、このサーバー自身は Bearer トークンを要求しない。
 * 手前で認証していない環境で有効にすると完全に無防備になるため、既定は false。
 */
export function isUpstreamAuthTrusted(): boolean {
  return parseBooleanEnv('TRUST_UPSTREAM_AUTH');
}

/** HTTP トランスポートの認証が何らかの形で構成されているか */
export function isHttpAuthConfigured(): boolean {
  return getMcpAuthToken() !== null || isUpstreamAuthTrusted();
}

/** ループバックアドレスか */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.trim());
}

/**
 * HTTP サーバーの待ち受けアドレス。
 *
 * 認証が未設定なら**ループバックに固定**する。リクエストごとに接続元が
 * localhost かを判定する方式は採らない。Cloud Run やリバースプロキシ配下では
 * アプリから見た接続元が 127.0.0.1 になり、**外部からのリクエストが全部
 * 「localhost」と判定されて無認証で通る**ためである。bind するアドレスなら
 * プロキシの有無に左右されない。
 */
export function getBindHost(): string {
  const raw = process.env.BIND_HOST;
  if (raw !== undefined && raw.trim() !== '') {
    return raw.trim();
  }

  return isHttpAuthConfigured() ? '0.0.0.0' : '127.0.0.1';
}

/** HTTP サーバーの待ち受けポート */
export function getPort(): number {
  return parseIntegerEnv('PORT', { min: 1, max: 65535, defaultValue: 3000 });
}

/** カンマ区切りの環境変数を、空要素を除いた配列にする */
function parseListEnv(name: string): string[] | null {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') {
    return null;
  }

  const values = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');

  if (values.length === 0) {
    throw new ConfigError([
      `${name} が設定されていますが、有効な値が1件もありません。不要なら環境変数自体を削除してください。`,
    ]);
  }

  return values;
}

/**
 * CORS で許可するオリジン。null は「クロスオリジンを一切許可しない」。
 *
 * 既定で閉じる。ブラウザ上のページがトークンを持っている構成では、開いていると
 * 悪意あるページが /mcp を呼んで**レスポンスまで読める**。MCP クライアントの
 * 多くはブラウザではないので、開ける必要があるのは例外的なケースだけ。
 */
export function getAllowedOrigins(): string[] | null {
  return parseListEnv('ALLOWED_ORIGINS');
}

/**
 * DNS rebinding 対策で許可する Host のホスト名。null は検証しない。
 *
 * ループバックで待ち受ける構成では、攻撃者のドメインを 127.0.0.1 に解決させて
 * ブラウザからローカルのサーバーを叩く手口（DNS rebinding）が成立する。
 * このとき Host ヘッダーは攻撃者のドメインになるので、localhost 系だけを
 * 許可しておけば防げる。
 *
 * ポートは比較に含めない。DNS rebinding で問題になるのは名前の解決先であって
 * ポートではないうえ、リバースプロキシ配下では Host のポートが待ち受けポートと
 * 一致しないのが普通だから。
 */
export function getAllowedHostnames(): string[] | null {
  const configured = parseListEnv('ALLOWED_HOSTS');
  if (configured !== null) {
    return configured.map(extractHostname);
  }

  // ループバック以外に bind する場合、正しい Host は運用者のドメインであり
  // こちらからは分からない。推測して塞ぐと正規のリクエストを落とすので、
  // ALLOWED_HOSTS が明示されるまで検証しない。
  if (!isLoopbackHost(getBindHost())) {
    return null;
  }

  return ['localhost', '127.0.0.1', '::1'];
}

/**
 * `host:port` 形式からホスト名だけを取り出す。IPv6 の `[::1]:3000` にも対応する。
 */
export function extractHostname(hostHeader: string): string {
  const value = hostHeader.trim().toLowerCase();

  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    return end === -1 ? value : value.slice(1, end);
  }

  const colon = value.indexOf(':');
  return colon === -1 ? value : value.slice(0, colon);
}

/**
 * 署名付き Webhook の `iat` / `exp` に許す時刻のずれ（秒）。
 *
 * 短くするほどリプレイ可能な時間窓が縮むが、サーバー間の時刻ずれに弱くなる。
 */
export function getWebhookMaxAgeSeconds(): number {
  return parseIntegerEnv('WEBHOOK_MAX_AGE_SECONDS', {
    min: 1,
    max: 3600,
    defaultValue: DEFAULT_WEBHOOK_MAX_AGE_SECONDS,
  });
}

/**
 * プレミアム番号（0990 など）への送信・架電を許可するか。既定は禁止。
 */
export function arePremiumNumbersAllowed(): boolean {
  return parseBooleanEnv('ALLOW_PREMIUM_NUMBERS');
}

/** 値が実質的に未設定か（空白のみを含む） */
function isBlank(value: string | undefined): boolean {
  return value === undefined || value.trim() === '';
}

/**
 * 起動時にすべての環境変数を検証する。
 *
 * 問題があれば ConfigError を投げる。見つかった問題は**まとめて**報告する。
 * 1つ直すたびに再起動させられるのは、コンテナ運用ではとくに苦痛になるため。
 *
 * @returns 起動を止めるほどではないが利用者に伝えるべき警告
 */
export function validateStartupConfig(): string[] {
  const problems: string[] = [];
  const warnings: string[] = [];

  const collect = (parse: () => unknown): void => {
    try {
      parse();
    } catch (error) {
      if (error instanceof ConfigError) {
        problems.push(...error.problems);
        return;
      }
      throw error;
    }
  };

  // getRateLimitPerHour() 経由ではなく個別にパースする。
  // DISABLE_RATE_LIMIT が不正なときに同じ問題を二重報告しないため。
  collect(() => parseBooleanEnv('DISABLE_RATE_LIMIT'));
  for (const name of CAPABILITY_ENV_VARS) {
    collect(() => parseBooleanEnv(name));
  }
  collect(() =>
    parseIntegerEnv('RATE_LIMIT_PER_HOUR', {
      min: 0,
      max: MAX_RATE_LIMIT_PER_HOUR,
      defaultValue: DEFAULT_RATE_LIMIT_PER_HOUR,
    })
  );
  collect(() => getChannelRateLimit('sms'));
  collect(() => getChannelRateLimit('voice'));
  collect(() => getChannelRateLimit('segments'));
  collect(() => getSmsMaxSegments());
  collect(() => parseBooleanEnv('ALLOW_PREMIUM_NUMBERS'));
  collect(() => getWebhookMaxAgeSeconds());
  collect(() => getMcpAuthToken());
  collect(() => parseBooleanEnv('TRUST_UPSTREAM_AUTH'));
  collect(() => getPort());
  collect(() => getAllowedOrigins());
  collect(() => parseListEnv('ALLOWED_HOSTS'));
  collect(() => getAllowedCountryCodes());
  collect(() => getVoiceInboundMessage());

  // capability と依存する資格情報の突き合わせ。
  // パースに失敗している場合は上で報告済みなので、ここはスキップする。
  let capabilities: Capabilities | null = null;
  try {
    capabilities = getCapabilities();
  } catch {
    capabilities = null;
  }

  const enabled = capabilities === null ? [] : CAPABILITY_ENV_VARS.filter((name) => capabilities[name]);

  if (enabled.length > 0) {
    if (isBlank(process.env.VONAGE_APPLICATION_ID)) {
      problems.push(
        `VONAGE_APPLICATION_ID が未設定です。${enabled.join(' / ')} を有効にする場合は必須です。`
      );
    }
    if (isBlank(process.env.VONAGE_PRIVATE_KEY_PATH)) {
      warnings.push(
        'VONAGE_PRIVATE_KEY_PATH が未設定のため既定値 ./private.key を使用します。意図した鍵か確認してください。'
      );
    }

    // 鍵は送信のたびに readFileSync される（vonage.ts / voiceCall.ts）。存在を
    // 起動時に確かめないと、パスの誤記やマウント漏れでも起動でき、各呼び出しは
    // **レート枠を消費してから**鍵の読み込みで失敗する。
    const privateKeyPath = getPrivateKeyPath();
    try {
      accessSync(privateKeyPath, constants.R_OK);
    } catch {
      problems.push(
        `VONAGE_PRIVATE_KEY_PATH の秘密鍵を読み取れません（${privateKeyPath}）。` +
          `${enabled.join(' / ')} を有効にする場合、このファイルが存在して読み取り可能である必要があります。` +
          'パスはプロセスの作業ディレクトリから解決されます。'
      );
    }
  }

  if (capabilities?.ENABLE_VOICE && isBlank(process.env.VONAGE_VOICE_FROM)) {
    problems.push(
      'ENABLE_VOICE=true ですが VONAGE_VOICE_FROM が未設定です。発信元番号が無いと make_voice_call は必ず失敗します。'
    );
  }

  // 共有シークレット方式は VONAGE_API_SIGNATURE_SECRET が未設定のときだけ使わ
  // れる（ダウングレードを防ぐためフォールバックしない）。実際に使われる構成
  // でだけ起動を止め、使われないなら警告に留める。
  const sharedSecret = process.env.VONAGE_WEBHOOK_SECRET?.trim();
  if (sharedSecret && sharedSecret.length < MIN_WEBHOOK_SECRET_LENGTH) {
    const message =
      `VONAGE_WEBHOOK_SECRET が短すぎます（${sharedSecret.length}文字）。` +
      `${MIN_WEBHOOK_SECRET_LENGTH}文字以上のランダムな文字列を指定してください` +
      '（例: openssl rand -hex 32）。';
    if (isBlank(process.env.VONAGE_API_SIGNATURE_SECRET)) {
      problems.push(
        `${message}この値は webhook 認証に実際に使われており、破られると配信結果を偽装されます。`
      );
    } else {
      warnings.push(
        `${message}現在は VONAGE_API_SIGNATURE_SECRET による署名検証が優先されるため使われていませんが、` +
          '署名シークレットを外すとこの弱い値が有効になります。'
      );
    }
  }

  // 外部インターフェースに bind するなら認証は必須。ここを警告で済ませると、
  // 「動いたから大丈夫」と判断されたまま無認証のサーバーが公開される。
  let httpAuthConfigured = false;
  try {
    httpAuthConfigured = isHttpAuthConfigured();
  } catch {
    // MCP_AUTH_TOKEN のパースエラーは上で報告済み
  }

  const bindHost = process.env.BIND_HOST?.trim();
  if (bindHost !== undefined && bindHost !== '' && !isLoopbackHost(bindHost) && !httpAuthConfigured) {
    problems.push(
      `BIND_HOST=${bindHost} は外部から到達できるアドレスですが、HTTP の認証が設定されていません。` +
        'MCP_AUTH_TOKEN を設定するか、上流で認証している場合は TRUST_UPSTREAM_AUTH=true を明示してください。' +
        '認証を設定しない場合は BIND_HOST を外してください（127.0.0.1 で待ち受けます）。'
    );
  }

  if (problems.length > 0) {
    throw new ConfigError(problems);
  }

  if (getAllowedOrigins() !== null) {
    warnings.push(
      `ALLOWED_ORIGINS が設定されています（${getAllowedOrigins()!.join(', ')}）。` +
        'これらのオリジンのブラウザページから /mcp を呼び出せます。意図した設定か確認してください。'
    );
  }

  if (parseBooleanEnv('TRUST_UPSTREAM_AUTH')) {
    warnings.push(
      'TRUST_UPSTREAM_AUTH=true が設定されています。このサーバー自身は認証しません。' +
        'Cloud Run IAM や API Gateway など、手前の層で必ず認証してください。'
    );
  } else if (!httpAuthConfigured) {
    warnings.push(
      'MCP_AUTH_TOKEN が未設定のため、HTTPサーバーは 127.0.0.1 でのみ待ち受けます。' +
        '外部から利用する場合は MCP_AUTH_TOKEN を設定してください。'
    );
  }

  // 全 OFF は「動くはずのものが動かない」という問い合わせに直結するので明示する
  if (capabilities !== null && enabled.length === 0) {
    warnings.push(
      `すべての機能が無効です。ツールは1つも公開されません。利用する機能を ${CAPABILITY_ENV_VARS.join(' / ')} ` +
        'のいずれかに true を設定して有効化してください（既定はすべて OFF です）。'
    );
  }

  // 危険な設定は、起動のたびに目に入るようにしておく
  if (parseBooleanEnv('DISABLE_RATE_LIMIT')) {
    warnings.push(
      'DISABLE_RATE_LIMIT=true が設定されています。レートリミットは完全に無効です。' +
        'AIエージェントの暴走やプロンプトインジェクションによる大量送信を防ぐ手段がありません。本番環境では外してください。'
    );
  }
  if (process.env.RATE_LIMIT_PER_HOUR?.trim() === '0') {
    warnings.push('RATE_LIMIT_PER_HOUR=0 のため、SMS送信と架電はすべて拒否されます（無制限ではありません）。');
  }
  if (process.env.ALLOWED_COUNTRY_CODES?.trim() === ALLOW_ALL_COUNTRY_CODES) {
    warnings.push(
      `ALLOWED_COUNTRY_CODES=${ALLOW_ALL_COUNTRY_CODES} のため、国番号による宛先制限は無効です。` +
        'IRSF（国際収益分配詐欺）を狙った高額な宛先も許可されます。ALLOWED_NUMBERS の併用と、' +
        'Vonage アカウント側の地域制限・利用額上限の設定を強く推奨します。'
    );
  }
  if (parseBooleanEnv('ALLOW_PREMIUM_NUMBERS')) {
    warnings.push(
      'ALLOW_PREMIUM_NUMBERS=true が設定されています。0990 などの高額課金番号への送信・架電が許可されます。'
    );
  }
  const zeroBucketLabels: Record<'sms' | 'voice' | 'segments', string> = {
    sms: 'SMS送信',
    voice: '架電',
    segments: 'SMS送信',
  };
  for (const bucket of ['sms', 'voice', 'segments'] as const) {
    if (process.env[RATE_LIMIT_ENV_VARS[bucket]]?.trim() === '0') {
      warnings.push(
        `${RATE_LIMIT_ENV_VARS[bucket]}=0 のため、${zeroBucketLabels[bucket]}はすべて拒否されます（無制限ではありません）。`
      );
    }
  }

  return warnings;
}

/**
 * 起動時検証を実行し、問題があればプロセスを終了する。
 * stdio / HTTP の両トランスポートの入口から呼ぶ。
 *
 * ログはすべて stderr に出す（stdio トランスポートでは stdout がプロトコル本体のため）。
 */
export function applyStartupConfig(): void {
  try {
    for (const warning of validateStartupConfig()) {
      console.error(`[WARN] ${warning}`);
    }
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`[FATAL] ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
}
