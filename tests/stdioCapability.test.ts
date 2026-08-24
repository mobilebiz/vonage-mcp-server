import { describe, it, expect, beforeAll } from 'vitest';
import { execSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

/**
 * stdio トランスポートの capability 強制を、実際にプロセスを起動して検証する。
 *
 * ここをユニットテストで代替できない理由: 迂回経路そのものが src/index.ts の
 * 登録ループにあった。以前は toolDefinitions 全件を registerTool し、
 * `tool.handler(args)` を直接呼んでいたため、ENABLE_VOICE=false で起動しても
 * stdio クライアントから make_voice_call を呼べば実際に電話が発信できた。
 * 「登録の時点で除外されている」ことは、プロセスを起動して tools/list と
 * tools/call を実際に叩かないと確認できない。
 *
 * 無効なツールは登録されないので、tools/call は Vonage に到達する前に
 * プロトコルレベルで拒否される（＝このテストは課金を発生させない）。
 */

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const serverPath = resolve(projectRoot, 'dist/index.js');

interface JsonRpcResponse {
  id: number;
  result?: any;
  error?: { code: number; message: string };
}

/**
 * ビルド済みの stdio サーバーを起動し、JSON-RPC リクエストを順に送って
 * すべての応答を集める。プロセスは応答が揃った時点で終了させる。
 */
function talkToServer(
  env: Record<string, string>,
  requests: Array<Record<string, unknown>>
): Promise<{ responses: JsonRpcResponse[]; stderr: string; exitCode: number | null }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [serverPath], {
      // 親プロセスの環境変数を引き継がない。テスト実行環境に ENABLE_* が
      // 設定されていると、検証したい条件が壊れるため。
      env: { PATH: process.env.PATH ?? '', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const expectedIds = requests.filter((r) => r.id !== undefined).map((r) => r.id as number);
    const responses: JsonRpcResponse[] = [];
    let stdoutBuffer = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill('SIGKILL');
        rejectPromise(new Error(`タイムアウト。受信済み: ${JSON.stringify(responses)}\nstderr: ${stderr}`));
      }
    }, 20_000);

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolvePromise({ responses, stderr, exitCode });
    };

    child.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() ?? '';

      for (const line of lines) {
        if (line.trim() === '') continue;
        try {
          const message = JSON.parse(line);
          if (message.id !== undefined) {
            responses.push(message);
          }
        } catch {
          // MCP以外の出力（想定外）は無視して、揃わなければタイムアウトで落とす
        }
      }

      if (expectedIds.every((id) => responses.some((r) => r.id === id))) {
        finish(null);
      }
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        rejectPromise(error);
      }
    });

    // 起動時検証で異常終了した場合（capability の設定ミスなど）
    child.on('exit', (code) => finish(code));

    for (const request of requests) {
      child.stdin.write(JSON.stringify(request) + '\n');
    }
  });
}

/** MCP のハンドシェイクに必要な定型リクエスト */
const handshake = [
  {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'capability-test', version: '1.0.0' },
    },
  },
  { jsonrpc: '2.0', method: 'notifications/initialized' },
];

/** 起動時検証を通過するための最低限の資格情報（実際には使わない） */
const baseEnv = {
  VONAGE_APPLICATION_ID: 'test-app-id',
  VONAGE_PRIVATE_KEY_PATH: './private.key',
  VONAGE_VOICE_FROM: '+815012345678',
};

describe('stdio トランスポートの capability 強制', () => {
  beforeAll(() => {
    // dist が古いと検証にならないので、必ずビルドしてから起動する。
    //
    // ビルドが落ちると、このスイートの7件は「失敗」ではなく「スキップ」として
    // 計上される（スイート自体は FAIL になるが、サマリ行だけを読むと
    // capability 強制の検証が走らなかったことを見落とす）。
    // stdio を捨てると原因も出ないので、出力を握って例外に載せる。
    try {
      execSync('npm run build', { cwd: projectRoot, stdio: 'pipe' });
    } catch (error) {
      const detail = error as { stdout?: Buffer; stderr?: Buffer };
      throw new Error(
        'ビルドに失敗したため、stdio の capability 強制を検証できませんでした。\n' +
          'このスイートがスキップされている場合、ガードレールは未検証です。\n' +
          `${detail.stdout?.toString() ?? ''}${detail.stderr?.toString() ?? ''}`
      );
    }
  }, 180_000);

  it('SMS のみ有効なら tools/list に SMS 系だけが現れる', async () => {
    const { responses } = await talkToServer({ ...baseEnv, ENABLE_SMS: 'true' }, [
      ...handshake,
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    ]);

    const names = responses.find((r) => r.id === 2)!.result.tools.map((t: any) => t.name).sort();
    expect(names).toEqual(['get_sms_status', 'send_sms']);
  });

  // 注釈は SDK の registerTool に渡してから tools/list に載るまでに1段
  // 挟まっている。定義側だけをユニットテストで確認しても、SDK が落として
  // いれば確認UIは出ない。実際にワイヤーへ出ることを確かめる（VONAGE_MCP-4）。
  it('tools/list の応答にツール注釈が載る', async () => {
    const { responses } = await talkToServer(
      { ...baseEnv, ENABLE_SMS: 'true', ENABLE_VOICE: 'true' },
      [...handshake, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }]
    );

    const tools: any[] = responses.find((r) => r.id === 2)!.result.tools;
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

    // 送信系: 確認UIを持つ基盤に対して、こちらから確認を要求する
    for (const name of ['send_sms', 'make_voice_call']) {
      expect(byName[name].annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      });
    }

    // 参照系: 確認UIを省いてよい
    for (const name of ['get_sms_status', 'get_call_status']) {
      expect(byName[name].annotations).toMatchObject({ readOnlyHint: true });
      expect(byName[name].annotations.destructiveHint).toBeUndefined();
    }
  });

  it('全 OFF（既定）ならツールが1つも公開されない', async () => {
    const { responses } = await talkToServer({ ...baseEnv }, [
      ...handshake,
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    ]);

    expect(responses.find((r) => r.id === 2)!.result.tools).toEqual([]);
  });

  // このテストが VONAGE_MCP-7 の本命。以前の実装ではここで実際に発信できた。
  it('ENABLE_VOICE が無効なら stdio から make_voice_call を実行できない', async () => {
    const { responses } = await talkToServer({ ...baseEnv, ENABLE_SMS: 'true' }, [
      ...handshake,
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'make_voice_call', arguments: { to: '09012345678', message: 'テスト' } },
      },
    ]);

    const response = responses.find((r) => r.id === 2)!;
    // ツールとして登録されていないので、Vonage に到達する前に拒否される
    expect(response.error ?? response.result?.isError).toBeTruthy();
    expect(JSON.stringify(response)).not.toContain('call_id');
  });

  it('bulk は SMS とは独立したトグルで制御される', async () => {
    const { responses } = await talkToServer({ ...baseEnv, ENABLE_SMS: 'true' }, [
      ...handshake,
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'bulk_sms_from_csv',
          arguments: { csv_content: 'phone,from,message\n09012345678,VonageMCP,hi\n', dry_run: true },
        },
      },
    ]);

    const response = responses.find((r) => r.id === 2)!;
    expect(response.error ?? response.result?.isError).toBeTruthy();
  });

  it('有効にしたツールは stdio から実行できる（dry_run で確認）', async () => {
    const { responses } = await talkToServer({ ...baseEnv, ENABLE_SMS: 'true' }, [
      ...handshake,
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'send_sms',
          arguments: { to: '09012345678', message: 'テスト', dry_run: true },
        },
      },
    ]);

    const response = responses.find((r) => r.id === 2)!;
    expect(response.error).toBeUndefined();
    expect(response.result.content[0].text).toContain('dry_run_success');
  });

  it('不正な capability 値ではプロセスが起動しない', async () => {
    const { stderr, exitCode } = await talkToServer({ ...baseEnv, ENABLE_SMS: 'yes' }, [
      ...handshake,
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    ]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain('ENABLE_SMS');
  });
});
