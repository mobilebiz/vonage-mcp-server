/**
 * MCPツール定義の共通レジストリ
 *
 * stdio版 (src/index.ts) と HTTP版 (src/http-server.ts) の両方がこのモジュールを参照することで、
 * ツールのスキーマ・ハンドラ・ガードレールを1箇所に集約する。
 */

import { z, type ZodRawShape } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

import { sendSMS, sendBulkSMS } from './vonage.js';
import { parseAndValidateCSV } from './csvUtils.js';
import {
  MAX_CALL_DURATION_SECONDS,
  callLengthTimer,
  estimateCallDuration,
  makeVoiceCall,
  normalizeVoiceName,
} from './voiceCall.js';
import { getCallStatus } from './callStatus.js';
import { getMessageStatus, recordSubmitted } from './messageStatusStore.js';
import {
  PHONE_INPUT_PATTERN,
  SMS_INPUT_MAX_LENGTH,
  VOICE_MESSAGE_MAX_LENGTH,
  buildRateLimitError,
  checkDestination,
  isEmergencyNumber,
  getBulkMaxRows,
  toolRateLimiter,
  validateAndNormalizePhoneNumber,
  validateSenderId,
} from './guardrails.js';
import {
  getRateLimits,
  getSmsMaxSegments,
  isCapabilityEnabled,
  type CapabilityName,
  type RateLimitBucket,
} from './config.js';
import { approximateCharsForSegments, estimateSmsSegments } from './smsSegments.js';
import {
  dryRunOutcome,
  errorOutcome,
  partialSuccessOutcome,
  successOutcome,
  unexpectedErrorOutcome,
  type ToolOutcome,
} from './toolResponse.js';

/** 共通の dry_run パラメータ */
const dryRunField = z
  .boolean()
  .optional()
  .default(false)
  .describe(
    'true の場合、Vonage APIへのリクエストは行わずパラメータ検証のみを実行する。実際の送信・架電の前に必ず一度 true で検証すること。'
  );

/** 共通の宛先電話番号パラメータ */
const toField = z
  .string()
  .regex(
    new RegExp(PHONE_INPUT_PATTERN),
    'E.164形式（+819012345678）または日本の国内形式（09012345678）で指定してください'
  )
  .describe(
    '宛先電話番号。E.164形式（例: +819012345678）を推奨。日本の国内形式（例: 09012345678）は自動的に +81 付きのE.164形式へ変換される。'
  );

/**
 * ツールのメタデータ（トランスポートに公開する形）
 *
 * **handler を意図的に含めていない。** stdio 版はかつて `tool.handler(args)` を
 * 直接呼んでおり、capability やレートリミットの判定を素通りできた。
 * ハンドラを型からも実体からも外すことで、トランスポートは runTool() を通る
 * 以外にツールを実行する手段が無くなる（VONAGE_MCP-7）。
 */
export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  /** MCP registerTool に渡す Zod の raw shape */
  schema: ZodRawShape;
  /** このツールを有効化する環境変数 */
  capability: CapabilityName;
}

/** ツール定義 + ハンドラ。このモジュールの外へは出さない */
interface ToolImplementation extends ToolDefinition {
  /** 検証済み引数を受け取り、軽量なペイロードを返すハンドラ */
  handler: (args: any) => Promise<ToolOutcome>;
}

/**
 * 電話番号の検証 → 宛先ガードレール判定 をまとめて行う。
 * 問題があればエラーの ToolOutcome を、問題なければ正規化済み番号を返す。
 */
function guardDestination(to: string): { outcome: ToolOutcome } | { normalized: string } {
  // 緊急番号は形式検証より先に見る。110 は桁数が足りず「無効な電話番号形式です」
  // で弾かれてしまい、エージェントが表記を直して再試行し続けるため。
  if (isEmergencyNumber(to)) {
    const blocked = checkDestination(to, to);
    return { outcome: errorOutcome(blocked.reason!, blocked.suggestion!) };
  }

  const validation = validateAndNormalizePhoneNumber(to);
  if (!validation.valid) {
    return { outcome: errorOutcome(validation.reason!, validation.suggestion!) };
  }

  const destination = checkDestination(to, validation.normalized);
  if (!destination.allowed) {
    return { outcome: errorOutcome(destination.reason!, destination.suggestion!) };
  }

  return { normalized: validation.normalized };
}

/**
 * レートリミットを cost 件分消費する。超過していればエラーの ToolOutcome を返す。
 *
 * バケットは**ツール名ではなくチャネル**で分ける。ツール名で分けると、単発 SMS で
 * 上限まで送ったあと1行だけの CSV を繰り返すことで上限を素通りできる
 * （VONAGE_MCP-17）。`global` と該当チャネルの両方を原子的に消費し、
 * どちらか一方でも足りなければ1件も送らない。
 */
function consumeRateLimit(
  toolName: string,
  channel: 'sms' | 'voice',
  cost: { messages: number; segments?: number }
): ToolOutcome | null {
  const limits = getRateLimits();

  const requests: Array<{ bucket: RateLimitBucket; key: string; limit: number; cost: number }> = [
    { bucket: 'global', key: 'global', limit: limits.global, cost: cost.messages },
    { bucket: channel, key: channel, limit: limits[channel], cost: cost.messages },
  ];

  // 課金はセグメント単位なので、費用を直接抑えたい運用者のために
  // セグメント数のバケットも用意する。未設定なら無制限。
  if (cost.segments !== undefined && cost.segments > 0) {
    requests.push({
      bucket: 'segments',
      key: 'segments',
      limit: limits.segments,
      cost: cost.segments,
    });
  }

  const outcome = toolRateLimiter.consumeAll(requests);

  if (outcome.allowed) {
    return null;
  }

  const failedCost = outcome.bucket === 'segments' ? (cost.segments ?? 0) : cost.messages;
  const error = buildRateLimitError(toolName, outcome.result, failedCost, outcome.bucket);
  return errorOutcome(
    error.reason,
    error.suggestion,
    {
      retry_after_seconds: error.retry_after_seconds,
      remaining_quota: error.remaining,
      exceeded_bucket: outcome.bucket,
    },
    'rate_limit'
  );
}

/**
 * 本文のセグメント数を検証する。
 *
 * 上限は文字数ではなくセグメント数で掛ける。課金がセグメント単位であり、
 * 文字数は費用と対応しないため。同じ「160文字」でも、英数字なら1通分、
 * 日本語なら3通分の課金になる。
 */
function guardMessageSegments(
  message: string
): { outcome: ToolOutcome } | { estimate: ReturnType<typeof estimateSmsSegments> } {
  const estimate = estimateSmsSegments(message);
  const maxSegments = getSmsMaxSegments();

  if (estimate.segments <= maxSegments) {
    return { estimate };
  }

  const approxChars = approximateCharsForSegments(estimate.encoding, maxSegments);

  return {
    outcome: errorOutcome(
      `本文が${estimate.segments}セグメントになります（上限${maxSegments}セグメント）。` +
        `SMSは${estimate.segments}通分として課金されます（${estimate.characters}文字 / ${estimate.encoding}）。`,
      `本文を約${approxChars}文字以内に要約して再試行してください。` +
        (estimate.encoding === 'UCS-2'
          ? '日本語などの非ASCII文字が含まれるため1セグメントは70文字（連結時は67文字）です。ASCIIだけにすると1セグメント160文字になります。'
          : '1セグメントは160文字（連結時は153文字）です。') +
        `上限は管理者が環境変数 SMS_MAX_SEGMENTS で変更できます。`,
      {
        segments: estimate.segments,
        max_segments: maxSegments,
        characters: estimate.characters,
        encoding: estimate.encoding,
      }
    ),
  };
}

const toolImplementations: ToolImplementation[] = [
  {
    name: 'send_sms',
    capability: 'ENABLE_SMS',
    title: 'SMS送信ツール',
    description:
      'VonageのMessages APIでSMSを1件送信する。送信は課金対象のため、実行前に必ず dry_run: true で検証し、宛先と本文をユーザーに提示して承認を得ること。日本の国内形式（0始まり）の番号は自動的にE.164形式へ変換される。',
    schema: {
      to: toField,
      message: z
        .string()
        .min(1)
        .max(SMS_INPUT_MAX_LENGTH)
        .describe(
          '送信するSMS本文。課金は文字数ではなく「セグメント」単位で発生する。' +
            '1セグメントは英数字のみなら160文字、日本語など非ASCIIを含むと70文字（連結時はそれぞれ153文字・67文字）。' +
            '既定では3セグメントまで許可される。費用を抑えたい場合は日本語で67文字以内に収めること。' +
            'dry_run のレスポンスに推定セグメント数が含まれるので、送信前にユーザーへ提示すること。'
        ),
      from: z
        .string()
        .optional()
        .describe(
          '送信元表示名。英数字3〜11文字（先頭は英字、例: VonageMCP）か、E.164形式の電話番号。省略時は VonageMCP。'
        ),
      dry_run: dryRunField,
    },
    handler: async ({ to, message, from, dry_run }) => {
      const guarded = guardDestination(to);
      if ('outcome' in guarded) {
        return guarded.outcome;
      }

      // 送信元は dry_run の時点で検証する。ここで通しておかないと
      // 「Ready to send」と言った後に本実行でVonageに弾かれ、レート枠だけ消費される。
      // 可否は宛先の国で変わる（日本宛では数値の送信元が使えない）ため宛先も渡す。
      if (from !== undefined) {
        const sender = validateSenderId(from, guarded.normalized);
        if (!sender.valid) {
          return errorOutcome(sender.reason!, sender.suggestion!);
        }
      }

      const segments = guardMessageSegments(message);
      if ('outcome' in segments) {
        return segments.outcome;
      }

      if (dry_run) {
        return dryRunOutcome({
          tool: 'send_sms',
          to: guarded.normalized,
          from: from ?? 'VonageMCP',
          characters: segments.estimate.characters,
          // 課金はセグメント単位。承認の材料になるのは文字数ではなくこちら。
          encoding: segments.estimate.encoding,
          segments: segments.estimate.segments,
        });
      }

      const limited = consumeRateLimit('send_sms', 'sms', {
        messages: 1,
        segments: segments.estimate.segments,
      });
      if (limited) {
        return limited;
      }

      const result = await sendSMS({ to: guarded.normalized, message, from });

      if (!result.success) {
        return errorOutcome(
          result.error ?? 'SMS送信に失敗しました',
          '番号のフォーマットと送信元表示名（英数字3〜11文字）を確認してください。認証エラーの場合はサーバー側の環境変数設定に問題があるため、再試行せずユーザーに報告してください。',
          { to: guarded.normalized },
          'upstream'
        );
      }

      if (result.messageId) {
        recordSubmitted(result.messageId, guarded.normalized, from ?? 'VonageMCP');
      }

      return successOutcome({ message_id: result.messageId, to: guarded.normalized });
    },
  },

  {
    name: 'bulk_sms_from_csv',
    capability: 'ENABLE_BULK_SMS',
    title: 'CSV一括SMS送信',
    description:
      'CSV（ヘッダー: phone,from,message）から複数のSMSをまとめて送信する。無効な行はスキップされる。' +
      '課金はセグメント単位で、1行あたり既定3セグメントまで（日本語なら約200文字）。' +
      '多数の課金が発生するため、必ず dry_run: true で件数と推定セグメント数を確認し、ユーザーの承認を得てから実行すること。',
    schema: {
      csv_content: z
        .string()
        .min(1)
        .describe(
          'CSVの内容。1行目は phone,from,message のヘッダーであること。' +
            'message列は1行あたり3セグメント以内（日本語なら約200文字、英数字なら約450文字）に収めること。'
        ),
      dry_run: dryRunField,
    },
    handler: async ({ csv_content, dry_run }) => {
      let parseResult;
      try {
        parseResult = parseAndValidateCSV(csv_content);
      } catch (error) {
        return errorOutcome(
          error instanceof Error ? error.message : String(error),
          'CSVのフォーマットを確認してください。1行目は phone,from,message のヘッダーである必要があります。'
        );
      }

      // 行数上限のチェック。巨大なCSVによる大量課金を防ぐ
      const maxRows = getBulkMaxRows();

      // 0 は「無制限」ではなく「停止」。上限超過と同じ文面だと
      // 「0行以下に分割してください」という無意味な指示になってしまう。
      if (maxRows === 0) {
        return errorOutcome(
          'bulk_sms_from_csv は管理者によって停止されています（BULK_MAX_ROWS=0）。1件も送信していません。',
          '再試行しても結果は変わりません。利用するには、管理者に BULK_MAX_ROWS の設定変更を依頼してください。',
          { total_rows: parseResult.totalRows, max_rows: 0 }
        );
      }

      if (parseResult.totalRows > maxRows) {
        return errorOutcome(
          `CSVの行数が上限を超えています（${parseResult.totalRows}行 > 上限${maxRows}行）。1件も送信していません。`,
          `CSVを${maxRows}行以下に分割して再試行してください。上限は環境変数 BULK_MAX_ROWS で変更できます。`,
          { total_rows: parseResult.totalRows, max_rows: maxRows }
        );
      }

      // ALLOWED_NUMBERS とセグメント数による絞り込み
      const allowed: typeof parseResult.validRows = [];
      const blocked: string[] = [];
      const tooLong: Array<{ to: string; segments: number; characters: number }> = [];
      let totalSegments = 0;

      const maxSegments = getSmsMaxSegments();

      for (const row of parseResult.validRows) {
        // 単発の send_sms と同じ制限を適用する。
        // ここを掛けないと bulk 経由でスキーマの制限を完全に迂回できる。
        const estimate = estimateSmsSegments(row.message);
        if (estimate.segments > maxSegments) {
          tooLong.push({ to: row.phone, segments: estimate.segments, characters: estimate.characters });
          continue;
        }

        const guarded = guardDestination(row.phone);
        if ('outcome' in guarded) {
          blocked.push(row.phone);
        } else {
          allowed.push({ ...row, phone: guarded.normalized });
          totalSegments += estimate.segments;
        }
      }

      const skipCounts = {
        total_rows: parseResult.totalRows,
        invalid_rows: parseResult.invalidRows.length,
        blocked_rows: blocked.length,
        too_long_rows: tooLong.length,
      };

      if (allowed.length === 0) {
        return errorOutcome(
          `送信可能な行がありません（総行数: ${parseResult.totalRows}、無効: ${parseResult.invalidRows.length}、ブロック: ${blocked.length}、セグメント超過: ${tooLong.length}）。`,
          `電話番号・送信者名・本文の各列を見直してください。${maxSegments}セグメントを超える行は要約してください（日本語なら約${approximateCharsForSegments('UCS-2', maxSegments)}文字）。ブロックされた行は ALLOWED_NUMBERS の制限によるものなので、再試行しても結果は変わりません。`,
          skipCounts
        );
      }

      if (dry_run) {
        return dryRunOutcome({
          tool: 'bulk_sms_from_csv',
          sendable_rows: allowed.length,
          rate_limit_cost: allowed.length,
          // 実際に課金されるのは行数ではなくセグメント数の合計。
          // 行数だけを見せると、日本語の長文で費用が数倍になる。
          estimated_segments: totalSegments,
          ...skipCounts,
          ...(tooLong.length > 0 ? { too_long_examples: tooLong.slice(0, 5) } : {}),
        });
      }

      // 送信件数とセグメント数の分だけレート枠を消費する。足りなければ1件も送らない
      const limited = consumeRateLimit('bulk_sms_from_csv', 'sms', {
        messages: allowed.length,
        segments: totalSegments,
      });
      if (limited) {
        return limited;
      }

      const bulkResult = await sendBulkSMS(
        allowed.map((row) => ({ to: row.phone, message: row.message, from: row.from }))
      );

      for (const item of bulkResult.results) {
        if (item.success && item.messageId) {
          recordSubmitted(item.messageId, item.to, item.from);
        }
      }

      // 失敗の詳細は先頭10件までに絞り、コンテキスト消費を抑える
      const failures = bulkResult.results
        .filter((r) => !r.success)
        .map((r) => ({ to: r.to, reason: r.error }));

      const summary = {
        sent: bulkResult.successCount,
        failed: bulkResult.failureCount,
        ...skipCounts,
        failures: failures.slice(0, 10),
        failures_truncated: Math.max(0, failures.length - 10),
      };

      // 全件失敗を success として返すと、AIがトップレベルの status だけを見て
      // 「送信できました」と誤報告するため、結果に応じて状態を分ける
      if (bulkResult.successCount === 0) {
        return errorOutcome(
          `${bulkResult.failureCount}件すべての送信に失敗しました。`,
          'failures の reason を確認してください。認証エラーや設定不備の場合は再試行しても結果は変わらないため、ユーザーに報告してください。',
          summary,
          'upstream'
        );
      }

      if (bulkResult.failureCount > 0) {
        return partialSuccessOutcome(summary);
      }

      return successOutcome(summary);
    },
  },

  {
    name: 'make_voice_call',
    capability: 'ENABLE_VOICE',
    title: '音声通話',
    description:
      '指定した番号へ発信し、テキストを合成音声で読み上げる。課金対象かつ相手を呼び出す行為のため、実行前に必ず dry_run: true で検証し、通話の要件と読み上げ内容をユーザーとすり合わせて承認を得ること。',
    schema: {
      to: toField,
      message: z
        .string()
        .min(1)
        .max(VOICE_MESSAGE_MAX_LENGTH)
        .describe(`読み上げるメッセージ本文（最大${VOICE_MESSAGE_MAX_LENGTH}文字）。`),
      voice: z.enum(['女性', '男性']).optional().describe('読み上げ音声。省略時は「女性」。'),
      dry_run: dryRunField,
    },
    handler: async ({ to, message, voice, dry_run }) => {
      const guarded = guardDestination(to);
      if ('outcome' in guarded) {
        return guarded.outcome;
      }

      const finalVoice = normalizeVoiceName(voice ?? '女性');
      const estimatedDuration = estimateCallDuration(message);

      if (dry_run) {
        return dryRunOutcome({
          tool: 'make_voice_call',
          to: guarded.normalized,
          voice: finalVoice,
          estimated_duration_seconds: estimatedDuration,
          // 実際に Vonage へ渡す強制切断までの秒数。見積もりだけを見せると
          // 「約N秒」で承認したのに実際はもっと課金され得る、という食い違いが起きる。
          max_duration_seconds: callLengthTimer(message),
          duration_cap_seconds: MAX_CALL_DURATION_SECONDS,
        });
      }

      const limited = consumeRateLimit('make_voice_call', 'voice', { messages: 1 });
      if (limited) {
        return limited;
      }

      const result = await makeVoiceCall({ to: guarded.normalized, message, voice });

      if (!result.success) {
        return errorOutcome(
          result.error ?? '音声通話の発信に失敗しました',
          '番号のフォーマットを確認してください。発信元番号（VONAGE_VOICE_FROM）が未設定の場合は再試行せずユーザーに報告してください。',
          { to: guarded.normalized },
          'upstream'
        );
      }

      return successOutcome({
        call_id: result.callId,
        to: guarded.normalized,
        voice: finalVoice,
        estimated_duration_seconds: estimatedDuration,
      });
    },
  },

  {
    name: 'get_call_status',
    capability: 'ENABLE_VOICE',
    title: '通話ステータス取得',
    description:
      'Vonage Voice APIで通話のステータス（completed / busy / failed など）と料金・通話時間を取得する。make_voice_call が返した call_id を指定すること。',
    schema: {
      callId: z.string().optional().describe('取得する通話のCall ID（UUID形式）。call_id と同義。'),
      call_id: z.string().optional().describe('取得する通話のCall ID（UUID形式）。callId の別名。'),
    },
    handler: async ({ callId, call_id }) => {
      const id = callId ?? call_id;
      if (!id) {
        return errorOutcome(
          'Call IDが指定されていません。',
          'make_voice_call の戻り値に含まれる call_id を callId パラメータに指定して再試行してください。'
        );
      }

      const result = await getCallStatus({ callId: id });

      if (!result.success) {
        return errorOutcome(
          result.error ?? '通話ステータスの取得に失敗しました',
          'call_id が正しいか確認してください。発信直後はまだ記録が作成されていない場合があるため、数秒待ってから再試行してください。',
          { call_id: id },
          'upstream'
        );
      }

      return successOutcome({
        call_id: id,
        call_status: result.status,
        start_time: result.startTime,
        duration_seconds: result.duration,
        price: result.price,
        rate: result.rate,
      });
    },
  },

  {
    name: 'get_sms_status',
    capability: 'ENABLE_SMS',
    title: 'SMS配信ステータス取得',
    description:
      'send_sms が返した message_id のSMS配信ステータス（submitted / delivered / failed など）を取得する。Vonage Messages APIはステータスをWebhookで非同期通知する仕様のため、delivered まで進むにはこのサーバーのHTTP版で Status Webhook を受信している必要がある。',
    schema: {
      message_id: z
        .string()
        .min(1)
        .describe('send_sms の戻り値に含まれる message_id（message_uuid）。'),
    },
    handler: async ({ message_id }) => {
      const record = getMessageStatus(message_id);

      if (!record) {
        return errorOutcome(
          `message_id ${message_id} のステータス記録が見つかりませんでした。`,
          'message_id が正しいか確認してください。ステータスはこのサーバーのプロセス内に一時保持される仕様のため、サーバー再起動後や別プロセスで送信したメッセージは参照できません。再試行しても結果は変わらないため、ユーザーに状況を報告してください。',
          { message_id },
          'not_found'
        );
      }

      return successOutcome({
        message_id: record.messageId,
        delivery_status: record.status,
        to: record.to,
        timestamp: record.timestamp,
        ...(record.error ? { error_code: record.error.code, error_reason: record.error.reason } : {}),
        ...(record.status === 'submitted'
          ? {
              note: 'Vonageからの配信通知(DLR)をまだ受信していません。Status Webhookが未設定か、配信結果が未確定です。',
            }
          : {}),
      });
    },
  },

];

/**
 * 全ツールのメタデータ。handler は取り除いてあるため、これを受け取った
 * トランスポートがハンドラを直接実行することはできない。
 */
export const toolDefinitions: ToolDefinition[] = toolImplementations.map(
  ({ handler: _handler, ...definition }) => Object.freeze(definition)
);

/** ツール名からメタデータを引く（capability の有効・無効は問わない） */
export function findToolDefinition(name: string): ToolDefinition | undefined {
  return toolDefinitions.find((tool) => tool.name === name);
}

/**
 * 現在の環境変数で有効になっているツールのメタデータを返す。
 * トランスポートはこれを使って registerTool する（無効なツールは登録しない）。
 */
export function enabledToolDefinitions(): ToolDefinition[] {
  return toolDefinitions.filter((tool) => isCapabilityEnabled(tool.capability));
}

/**
 * 無効化されたツールが呼ばれたときのエラー。
 *
 * 登録自体を行わないので通常は到達しないが、登録後に環境変数が変わった場合や
 * トランスポート側の実装ミスに対する最後の砦として runTool でも判定する。
 */
function disabledToolOutcome(tool: ToolDefinition): ToolOutcome {
  return errorOutcome(
    `${tool.name} はサーバー側で無効化されています（環境変数 ${tool.capability} が未設定または false）。`,
    `サーバーの環境変数に ${tool.capability}=true を設定して再起動するよう管理者に依頼してください。` +
      '再試行しても結果は変わりません。',
    { required_capability: tool.capability },
    'disabled'
  );
}

/** ツールのJSON Schema（MCPの inputSchema 形式）を生成する */
export function toolInputJsonSchema(tool: ToolDefinition): Record<string, unknown> {
  const schema = zodToJsonSchema(z.object(tool.schema), { $refStrategy: 'none' }) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}

/**
 * tools/list 用のツール一覧を生成する。
 *
 * 無効なツールは含めない。理由は2つで、(a) エージェントが存在しないツールを
 * 呼ぼうとして迷走しない (b) 使わないツール定義がコンテキストを食わない。
 */
export function listTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  return enabledToolDefinitions().map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: toolInputJsonSchema(tool),
  }));
}

/**
 * 未検証の引数を受け取ってツールを実行する（HTTP経由の呼び出し用）。
 * Zodによる検証に失敗した場合も、AIが自己修復できるエラーレスポンスを返す。
 */
export async function runTool(name: string, args: unknown): Promise<ToolOutcome> {
  const tool = toolImplementations.find((t) => t.name === name);
  if (!tool) {
    const available = enabledToolDefinitions().map((t) => t.name);
    return errorOutcome(
      `未知のツールです: ${name}`,
      available.length > 0
        ? `利用可能なツール: ${available.join(', ')}`
        : 'このサーバーでは現在どのツールも有効になっていません。管理者に capability の有効化を依頼してください。'
    );
  }

  // capability の判定は引数の検証より先に行う。無効な機能について
  // 「引数が不正です」と返すと、エージェントが引数を直して再試行し続けてしまう。
  if (!isCapabilityEnabled(tool.capability)) {
    return disabledToolOutcome(tool);
  }

  const parsed = z.object(tool.schema).safeParse(args ?? {});
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    return errorOutcome(
      `${name} の引数が不正です: ${details}`,
      'エラー内容に従って引数を修正し、再試行してください。'
    );
  }

  try {
    return await tool.handler(parsed.data);
  } catch (error) {
    return unexpectedErrorOutcome(name, error);
  }
}
