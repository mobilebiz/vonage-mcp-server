/**
 * OAuth 2.1 リソースサーバー（MCP 仕様 2025-11-25 の Authorization）
 *
 * ## なぜ必要か
 *
 * このサーバーは長らく `MCP_AUTH_TOKEN` の静的 Bearer だけで認証していた。これは
 * **MCP 仕様には存在しない**方式で、基盤側が「任意のヘッダを設定させてくれる」
 * 場合にだけ成立する。実測でも、繋がった基盤は開発者向けのもの（ADK / Dify /
 * AgentCore / n8n / Claude Code）に偏っていた。
 *
 * 一方、エンドユーザーが触る入り口 — ChatGPT のカスタムプラグイン、Gemini
 * Enterprise のカスタムコネクタ — は **「OAuth か認証なし」の2択**しか提示しない。
 * 課金の発生するサーバーに「認証なし」は選べないので、この経路には OAuth でしか
 * 繋がらない。仕様の言い方でいえば:
 *
 * > Authorization is OPTIONAL for MCP implementations. When supported:
 * > Implementations using an HTTP-based transport SHOULD conform to this specification.
 *
 * 認証しないことは許されるが、**HTTP で認証するなら OAuth に従う**のが仕様である。
 *
 * ## このモジュールが実装する範囲
 *
 * 仕様は認可サーバー（AS）の実装を明確にスコープ外としている:
 *
 * > The implementation details of the authorization server are beyond the scope of
 * > this specification.
 *
 * したがってこのサーバーが担うのは**リソースサーバー（RS）だけ**で、AS は外部の
 * IdP に委ねる。RS として必須なのは次の4つ。
 *
 * 1. RFC 9728 の保護リソースメタデータを配ること（仕様上 MUST）
 * 2. 401 の `WWW-Authenticate` にそのメタデータの場所を載せること
 * 3. アクセストークンを検証し、**自分宛に発行されたものであることを確かめる**こと（MUST）
 * 4. 受け取ったトークンを下流へ流さないこと（token passthrough の禁止）
 *
 * 4 について、このサーバーが Vonage を呼ぶときに使うのは**別の資格情報**
 * （アプリケーション ID と秘密鍵で組む JWT）であり、クライアントから受け取った
 * アクセストークンは Vonage には一切渡らない。構造上すでに満たしている。
 */

import {
  createRemoteJWKSet,
  decodeProtectedHeader,
  jwtVerify,
  type JWTVerifyGetKey,
  type JWTPayload,
} from 'jose';

import { getOAuthConfig, type OAuthConfig } from './config.js';

/** OAuth モードの設定、または未設定 */
export type OAuthConfigOrNull = OAuthConfig | null;

/** RFC 9728 が定める保護リソースメタデータの well-known プレフィックス */
export const PROTECTED_RESOURCE_METADATA_PREFIX = '/.well-known/oauth-protected-resource';

/** アクセストークンの検証結果 */
export type AccessTokenResult =
  | {
      ok: true;
      /** トークンの sub。監査ログ用。無いトークンもあるので null を許す */
      subject: string | null;
      /** トークンが持っていた scope */
      scopes: string[];
    }
  | {
      ok: false;
      /** 503 は「トークンが悪い」ではなく「こちらが確かめられない」 */
      status: 401 | 403 | 503;
      /** RFC 6750 の error パラメータ。503 では付けない */
      error: 'invalid_token' | 'insufficient_scope' | undefined;
      /** 人間が読む理由。WWW-Authenticate の error_description とレスポンス本文に使う */
      description: string;
    };

/**
 * JWKS の取得はキャッシュする。
 *
 * `createRemoteJWKSet` が返す関数は鍵の取得結果を内部にキャッシュし、未知の kid が
 * 来たときだけ取りに行く。リクエストごとに作り直すとそのキャッシュが毎回捨てられ、
 * **トークン検証のたびに IdP へ HTTP リクエストが飛ぶ**。IdP 側のレート制限に
 * 当たれば、こちらの認証がまとめて失敗する。
 */
const jwksCache = new Map<string, JWTVerifyGetKey>();

/** テストから鍵解決を差し替えるための口（本番では null のまま） */
let jwksOverride: JWTVerifyGetKey | null = null;

/**
 * テスト用に鍵解決を差し替える。null で解除。
 *
 * ミドルウェアまで含めた経路を、ネットワークに出ずに検証するために置いている。
 * 「定義側のユニットテストでは落ちても気づけない」のはツール注釈で実際に踏んだ罠で、
 * 認証も同じく**ワイヤー上の挙動**を確かめる必要がある。
 */
export function setJwksResolverForTesting(resolver: JWTVerifyGetKey | null): void {
  jwksOverride = resolver;
}

/** JWKS のキャッシュを捨てる（テスト用） */
export function clearJwksCache(): void {
  jwksCache.clear();
}

function jwksFor(config: OAuthConfig): JWTVerifyGetKey {
  if (jwksOverride !== null) {
    return jwksOverride;
  }

  const cached = jwksCache.get(config.jwksUri);
  if (cached !== undefined) {
    return cached;
  }

  const created = createRemoteJWKSet(new URL(config.jwksUri));
  jwksCache.set(config.jwksUri, created);
  return created;
}

/**
 * 保護リソースメタデータを配るパス。
 *
 * RFC 9728 はリソースのパスを well-known の後ろに差し込む形を定める。
 * `https://example.com/mcp` なら `/.well-known/oauth-protected-resource/mcp`。
 * クライアントはこれを先に試し、無ければルートに落とすので、**両方で配る**。
 * 片方だけにすると、落とし方の違うクライアントで discovery が失敗する。
 */
export function protectedResourceMetadataPaths(config: OAuthConfig): string[] {
  const path = new URL(config.resource).pathname.replace(/\/$/, '');
  const paths = [PROTECTED_RESOURCE_METADATA_PREFIX];

  if (path !== '' && path !== '/') {
    paths.unshift(`${PROTECTED_RESOURCE_METADATA_PREFIX}${path}`);
  }

  return paths;
}

/**
 * 401 の WWW-Authenticate に載せるメタデータの URL。
 *
 * **リクエストの Host ヘッダーからは組み立てない。** ALLOWED_HOSTS が未設定なら
 * Host は攻撃者が自由に指定できるため、そこから作った URL を返すと
 * 「クライアントを攻撃者のメタデータへ誘導する 401」を作れてしまう。設定値
 * （OAUTH_RESOURCE）から決めれば、何を送られても指す先は変わらない。
 */
export function resourceMetadataUrl(config: OAuthConfig): string {
  const resource = new URL(config.resource);
  return `${resource.origin}${protectedResourceMetadataPaths(config)[0]}`;
}

/** RFC 9728 の保護リソースメタデータ本体 */
export function protectedResourceMetadata(config: OAuthConfig): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    resource: config.resource,
    authorization_servers: [config.issuer],
    bearer_methods_supported: ['header'],
  };

  if (config.scopesSupported !== null) {
    metadata.scopes_supported = config.scopesSupported;
  }

  return metadata;
}

/**
 * WWW-Authenticate ヘッダーの値を組み立てる。
 *
 * 値は quoted-string に入れるので、`"` と `\` は落とす。scope は運用者が環境変数で
 * 決める値なので、ヘッダーへそのまま入れると改行を混ぜてヘッダーを分割できてしまう。
 *
 * **ASCII 以外も落とす。** Node の `setHeader` はヘッダー値に ISO-8859-1 の範囲外の
 * 文字があると例外を投げる。`OAUTH_REQUIRED_SCOPE` に日本語を書かれただけで、
 * 401 を返そうとしたサーバーが 500 を返すようになる（実際にこれを踏んだ）。
 */
function quote(value: string): string {
  return value.replace(/[^\u0020-\u007e]/g, '').replace(/[\\"]/g, '');
}

/**
 * 401 / 403 に付ける WWW-Authenticate。
 *
 * `resource_metadata` は仕様の discovery 経路そのもので、これが無いとクライアントは
 * どこへ認可を取りに行けばよいか分からない。`scope` は「何を要求すればよいか」を
 * 最初の 401 で伝えるためのもので、無いとクライアントは scopes_supported を
 * 丸ごと要求することになる（最小権限に反する）。
 *
 * `error_description` は載せない。理由の文面は日本語で、ヘッダーには入れられない
 * （上の quote 参照）。**理由はレスポンス本文に入れる**ので情報は失われない。
 * ヘッダーに載せる `error` は機械可読な値で、クライアントが分岐に使うのはこちら。
 */
export function buildWwwAuthenticate(config: OAuthConfig, error?: string): string {
  const params = [`resource_metadata="${quote(resourceMetadataUrl(config))}"`];

  if (config.requiredScope !== null) {
    params.push(`scope="${quote(config.requiredScope)}"`);
  }

  if (error !== undefined) {
    params.push(`error="${quote(error)}"`);
  }

  return `Bearer ${params.join(', ')}`;
}

/**
 * トークンが持つ scope を取り出す。
 *
 * `scope`（空白区切りの文字列）が RFC 8693 以降の標準だが、Entra ID は `scp` を使い、
 * しかも実装によって文字列だったり配列だったりする。**どれか1つだけを見ると、
 * IdP を変えた瞬間に「scope が空」と判定して全部 403 になる。**
 */
export function extractScopes(payload: JWTPayload): string[] {
  const candidates = [payload.scope, (payload as Record<string, unknown>).scp];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') {
      return candidate.trim().split(/\s+/);
    }
    if (Array.isArray(candidate)) {
      const values = candidate.filter((v): v is string => typeof v === 'string' && v.trim() !== '');
      if (values.length > 0) {
        return values;
      }
    }
  }

  return [];
}

/**
 * 鍵の解決中に起きたが、**原因はトークンの側**にあるエラーコード。
 *
 * トークンが名指しした `kid` が JWKS に無い（あるいは複数一致する）のは、こちらの
 * 障害ではない。再試行しても直らないので 401 に倒す。
 */
const TOKEN_CAUSED_KEY_ERROR_CODES: ReadonlySet<string> = new Set([
  'ERR_JWKS_NO_MATCHING_KEY',
  'ERR_JWKS_MULTIPLE_MATCHING_KEYS',
  // 「対応していない」は、常に受け取ったトークンの中身についての話であって、
  // JWKS に到達できたかどうかとは関係がない
  'ERR_JOSE_NOT_SUPPORTED',
]);

/**
 * 受け付ける署名アルゴリズム。
 *
 * **HMAC 系（HS256 など）は入れない。** 検証鍵を JWKS から取る構成で対称鍵を
 * 許すと、公開されている鍵素材で署名したトークンを受け入れる余地ができる。
 * 認可サーバーが使うのは非対称鍵であり、これで十分である。
 *
 * ここで先に弾くのは、`alg` の不一致が **鍵の解決中に** 例外になるためでもある。
 * 落ちた場所で「こちらの障害か、トークンの問題か」を判定しているので、
 * トークンの問題だと分かっているものは鍵を引きに行く前に返す。
 */
const ALLOWED_ALGORITHMS = [
  'RS256',
  'RS384',
  'RS512',
  'PS256',
  'PS384',
  'PS512',
  'ES256',
  'ES384',
  'ES512',
  'EdDSA',
] as const;

/**
 * Authorization ヘッダーの解釈結果。
 *
 * **「送っていない」と「送ったが形式が違う」を区別する。** RFC 6750 は、認証情報が
 * まったく無いリクエストへの 401 には error コードを**載せるべきでない**としている。
 * 未認証は異常ではなく、認可フローの1歩目だからである。エラーを載せると、
 * クライアントによっては「認可を取りに行く」のではなく「失敗した」と扱う。
 */
export type AuthorizationHeader =
  /** ヘッダーが無い */
  | { kind: 'absent' }
  /** Bearer 以外の認証方式。RFC 6750 は「認証情報が無い」のと同じ扱いにする */
  | { kind: 'other-scheme' }
  /** Bearer だが中身が無い。要求そのものが壊れている */
  | { kind: 'malformed' }
  | { kind: 'bearer'; token: string };

/** Authorization ヘッダーを解釈する */
export function parseAuthorizationHeader(header: string | string[] | undefined): AuthorizationHeader {
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== 'string' || value.trim() === '') {
    return { kind: 'absent' };
  }

  const trimmed = value.trim();
  if (!/^Bearer(\s|$)/i.test(trimmed)) {
    // 「クライアントが認証の要否を知らなかった」場合と並べて例示されているのが
    // **未対応の認証方式**である（RFC 6750 3.1）。壊れた Bearer 要求ではないので、
    // エラーを付けずに 401 のチャレンジを返し、認可フローの入口へ案内する。
    return { kind: 'other-scheme' };
  }

  const match = /^Bearer\s+(.+)$/i.exec(trimmed);
  const token = match === null ? '' : match[1].trim();
  return token === '' ? { kind: 'malformed' } : { kind: 'bearer', token };
}

/**
 * アクセストークンを検証する。
 *
 * **audience の検証は仕様上 MUST である。**
 *
 * > MCP servers MUST validate that access tokens were issued specifically for them
 * > as the intended audience
 *
 * ここを省くと、同じ IdP が別のサービス向けに発行したトークンでこのサーバーが
 * 動く。そのトークンの持ち主は「別のサービスを使う」つもりで同意しただけで、
 * **SMS を送る同意はしていない。** jwtVerify に issuer と audience を渡すことで、
 * 署名・有効期限・iss・aud をまとめて検査させる。
 */
export async function verifyAccessToken(token: string, config: OAuthConfig): Promise<AccessTokenResult> {
  let payload: JWTPayload;

  // 「鍵を取りに行って失敗した」のか「トークンが正しくない」のかを、**エラー
  // コードの分類ではなく、どこで落ちたかで**判定する。コードで分類しようとして
  // 2周続けて外した — 列挙すれば `ERR_JOSE_NOT_SUPPORTED`（未対応の crit）が
  // 取得失敗側に落ち、接頭辞で判定すれば `ERR_JOSE_GENERIC`（JWKS が 429 や 503 を
  // 返したとき）がトークン側に落ちる。**jose のコード体系はこの2つを区別する
  // ようにはできていない。**
  // alg は鍵を引きに行く前に確かめる（→ ALLOWED_ALGORITHMS）
  try {
    const header = decodeProtectedHeader(token);
    if (typeof header.alg !== 'string' || !(ALLOWED_ALGORITHMS as readonly string[]).includes(header.alg)) {
      return {
        ok: false,
        status: 401,
        error: 'invalid_token',
        description: `アクセストークンの署名アルゴリズム（${header.alg ?? '不明'}）には対応していません。`,
      };
    }
  } catch {
    return {
      ok: false,
      status: 401,
      error: 'invalid_token',
      description: 'アクセストークンの形式が JWT ではありません。',
    };
  }

  const resolveKey = jwksFor(config);
  let keyError: unknown = null;

  const guardedResolveKey: JWTVerifyGetKey = async (header, input) => {
    try {
      return await resolveKey(header, input);
    } catch (error) {
      keyError = error;
      throw error;
    }
  };

  try {
    const verified = await jwtVerify(token, guardedResolveKey, {
      issuer: config.issuer,
      audience: config.audience,
      algorithms: [...ALLOWED_ALGORITHMS],
      // **exp を必須にする。** jwtVerify は「あれば検査する」だけなので、
      // 指定しないと exp を持たないトークンが無期限に通る。漏れた1本を
      // 失効させる手段が無くなり、IdP 側でセッションを切っても効かない。
      requiredClaims: ['exp'],
    });
    payload = verified.payload;
  } catch (error: unknown) {
    const code = (error as { code?: string })?.code ?? '';

    // 鍵の解決で落ちていて、しかもトークン起因でないなら、こちら側の障害。
    // トークンは無効とは限らないので、捨てて取り直させない。
    if (keyError !== null && !TOKEN_CAUSED_KEY_ERROR_CODES.has(code)) {
      return {
        ok: false,
        status: 503,
        error: undefined,
        description:
          '認可サーバーの署名鍵を取得できず、アクセストークンを検証できませんでした。' +
          'トークンが無効とは限りません。時間をおいて再試行してください。',
      };
    }

    // 「なぜ落ちたか」は返す。トークンの中身は返さない。クライアントは自分の
    // トークンについてしか問い合わせできないので、原因の粒度は安全側で足りる。
    const claim = (error as { claim?: string }).claim;

    const description =
      code === 'ERR_JWT_EXPIRED'
        ? 'アクセストークンの有効期限が切れています。'
        : code === 'ERR_JWT_CLAIM_VALIDATION_FAILED' && claim === 'exp'
          ? '有効期限（exp）を持たないアクセストークンは受け付けません。'
          : code === 'ERR_JWT_CLAIM_VALIDATION_FAILED'
            ? `アクセストークンの ${claim ?? 'claim'} がこのサーバー向けではありません。` +
              `期待する issuer は ${config.issuer}、audience は ${config.audience} です。`
            : code === 'ERR_JWKS_NO_MATCHING_KEY'
              ? 'アクセストークンの署名鍵が認可サーバーの JWKS に見つかりません。'
              : 'アクセストークンを検証できませんでした。';

    return { ok: false, status: 401, error: 'invalid_token', description };
  }

  const scopes = extractScopes(payload);

  if (config.requiredScope !== null && !scopes.includes(config.requiredScope)) {
    return {
      ok: false,
      status: 403,
      error: 'insufficient_scope',
      description: `この操作には scope "${config.requiredScope}" が必要です。`,
    };
  }

  return {
    ok: true,
    subject: typeof payload.sub === 'string' ? payload.sub : null,
    scopes,
  };
}

/**
 * 現在の設定で OAuth リソースサーバーモードが有効なら、その設定を返す。
 *
 * **設定エラーを握り潰して null を返してはいけない。** null は「OAuth モードでは
 * ない」を意味し、静的トークンも無ければ認証ミドルウェアは素通りする。つまり
 * `OAUTH_ISSUER` だけ書いて JWKS を書き忘れた状態が、**起動時検証を経ずに
 * app を読み込む経路では無認証のサーバーになる**。壊れた設定は拒否に倒す。
 */
export function activeOAuthConfig(): OAuthConfig | null {
  return getOAuthConfig();
}
