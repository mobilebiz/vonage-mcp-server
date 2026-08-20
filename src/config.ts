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

/** bulk_sms_from_csv で一度に処理できる最大行数の既定値 */
export const DEFAULT_BULK_MAX_ROWS = 100;

/**
 * コード側の安全上限。これを超える設定は起動エラーにする。
 * 桁を1つ打ち間違えただけで青天井の課金にならないための歯止め。
 */
export const MAX_RATE_LIMIT_PER_HOUR = 10_000;

/** 同上（bulk の行数） */
export const MAX_BULK_MAX_ROWS = 10_000;

/**
 * capability トグルの環境変数名。
 *
 * bulk と generate_jwt を SMS / Voice から分離しているのは爆発半径が違うため:
 * bulk は1回の呼び出しで数百件を送れ、generate_jwt は Vonage API を直接叩ける
 * 署名済みクレデンシャルを呼び出し側に渡す（＝ガードレールの迂回路になる）。
 */
export const CAPABILITY_ENV_VARS = [
  'ENABLE_SMS',
  'ENABLE_BULK_SMS',
  'ENABLE_VOICE',
  'ENABLE_JWT_TOOL',
] as const;

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
 * bulk_sms_from_csv の最大行数を返す。`0` は全拒否（bulk の停止）。
 */
export function getBulkMaxRows(): number {
  return parseIntegerEnv('BULK_MAX_ROWS', {
    min: 0,
    max: MAX_BULK_MAX_ROWS,
    defaultValue: DEFAULT_BULK_MAX_ROWS,
  });
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
  collect(() =>
    parseIntegerEnv('BULK_MAX_ROWS', {
      min: 0,
      max: MAX_BULK_MAX_ROWS,
      defaultValue: DEFAULT_BULK_MAX_ROWS,
    })
  );
  collect(() => parseBooleanEnv('ALLOW_PREMIUM_NUMBERS'));
  collect(() => getAllowedCountryCodes());

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
  }

  if (capabilities?.ENABLE_VOICE && isBlank(process.env.VONAGE_VOICE_FROM)) {
    problems.push(
      'ENABLE_VOICE=true ですが VONAGE_VOICE_FROM が未設定です。発信元番号が無いと make_voice_call は必ず失敗します。'
    );
  }

  if (problems.length > 0) {
    throw new ConfigError(problems);
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
  if (process.env.BULK_MAX_ROWS?.trim() === '0') {
    warnings.push('BULK_MAX_ROWS=0 のため、bulk_sms_from_csv はすべて拒否されます（無制限ではありません）。');
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
