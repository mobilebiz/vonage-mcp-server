import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { sendSMS, validatePhoneNumber, sendBulkSMS } from './vonage.js';
import { makeVoiceCall, validateVoiceName, estimateCallDuration, normalizeVoiceName } from './voiceCall.js';
import { parseAndValidateCSV, generateCSVSummary } from './csvUtils.js';

// 環境変数の読み込み
dotenv.config();

export const app = express();
const port = process.env.PORT || 3000;

// ミドルウェアの設定
app.use(cors());
app.use(express.json());

// ツール定義
const tools = [
  {
    name: 'send_sms',
    description: 'Vonageを使用してSMSを送信します。日本の電話番号（0から始まる）は自動的にE.164形式に変換されます。',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: '送信先の電話番号（必須）' },
        message: { type: 'string', description: '送信するメッセージ（必須）' },
        from: { type: 'string', description: '送信元（省略時はVonageMCP）' }
      },
      required: ['to', 'message']
    }
  },
  {
    name: 'make_voice_call',
    description: '指定した番号に発信してメッセージを読み上げます。日本の電話番号（0から始まる）は自動的にE.164形式に変換されます。',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: '発信先電話番号（0ABJ形式）' },
        message: { type: 'string', description: '読み上げるメッセージ' },
        voice: { type: 'string', description: '音声タイプ（デフォルト: 女性）' }
      },
      required: ['to', 'message']
    }
  },
  {
    name: 'bulk_sms_from_csv',
    description: 'CSVファイル（phone,from,message）から一括SMS送信を行います。無効な行はスキップされ、処理結果がまとめて返されます。',
    inputSchema: {
      type: 'object',
      properties: {
        csv_content: { type: 'string', description: 'CSVファイルの内容（phone,from,messageのヘッダー付き）' }
      },
      required: ['csv_content']
    }
  }
];

// Create MCP server instance
const mcpServer = new McpServer({
  name: 'vonage-mcp-server',
  version: '1.1.0'
});

// Register send_sms tool
mcpServer.registerTool('send_sms',
  {
    title: 'SMS送信ツール',
    description: 'Vonageを使用してSMSを送信します。日本の電話番号（0から始まる）は自動的にE.164形式に変換されます。',
    inputSchema: {
      to: z.string().describe('送信先の電話番号（必須）'),
      message: z.string().describe('送信するメッセージ（必須）'),
      from: z.string().optional().describe('送信元（省略時はVonageMCP）')
    }
  },
  async ({ to, message, from }) => {
    if (!validatePhoneNumber(to)) {
      return {
        content: [{
          type: 'text',
          text: 'エラー: 無効な電話番号形式です。正しい形式で入力してください。'
        }]
      };
    }

    const result = await sendSMS({ to, message, from });

    if (result.success) {
      return {
        content: [{
          type: 'text',
          text: `SMS送信成功！\n送信先: ${to}\nメッセージID: ${result.messageId}`
        }]
      };
    } else {
      return {
        content: [{
          type: 'text',
          text: `SMS送信失敗: ${result.error}`
        }]
      };
    }
  }
);

// Register make_voice_call tool
mcpServer.registerTool('make_voice_call',
  {
    title: '音声通話',
    description: '指定した番号に発信してメッセージを読み上げます。日本の電話番号（0から始まる）は自動的にE.164形式に変換されます。',
    inputSchema: {
      to: z.string().describe('発信先電話番号（0ABJ形式）'),
      message: z.string().describe('読み上げるメッセージ'),
      voice: z.string().optional().describe('音声タイプ（デフォルト: 女性）')
    }
  },
  async ({ to, message, voice }) => {
    if (!validatePhoneNumber(to)) {
      return {
        content: [{
          type: 'text',
          text: 'エラー: 無効な電話番号形式です。正しい形式で入力してください。'
        }]
      };
    }

    if (voice && !validateVoiceName(voice)) {
      return {
        content: [{
          type: 'text',
          text: 'エラー: 無効な音声タイプです。利用可能: 女性、男性'
        }]
      };
    }

    const estimatedDuration = estimateCallDuration(message);
    const result = await makeVoiceCall({ to, message, voice });

    if (result.success) {
      const finalVoice = normalizeVoiceName(voice || '女性');
      return {
        content: [{
          type: 'text',
          text: `音声通話を開始しました！\n発信先: ${to}\n通話ID: ${result.callId}\nメッセージ: ${message}\n音声: ${finalVoice}\n推定通話時間: ${estimatedDuration}秒`
        }]
      };
    } else {
      return {
        content: [{
          type: 'text',
          text: `音声通話の発信に失敗しました: ${result.error}`
        }]
      };
    }
  }
);

// Register bulk_sms_from_csv tool
mcpServer.registerTool('bulk_sms_from_csv',
  {
    title: 'CSV一括SMS送信',
    description: 'CSVファイル（phone,from,message）から一括SMS送信を行います。無効な行はスキップされ、処理結果がまとめて返されます。',
    inputSchema: {
      csv_content: z.string().describe('CSVファイルの内容（phone,from,messageのヘッダー付き）')
    }
  },
  async ({ csv_content }) => {
    try {
      const parseResult = parseAndValidateCSV(csv_content);
      const summary = generateCSVSummary(parseResult);

      if (parseResult.validRows.length === 0) {
        return {
          content: [{
            type: 'text',
            text: `エラー: 送信可能な有効な行がありませんでした。\n\n${summary}`
          }]
        };
      }

      const smsParams = parseResult.validRows.map(row => ({
        to: row.phone,
        message: row.message,
        from: row.from
      }));

      const bulkResult = await sendBulkSMS(smsParams);

      let resultText = `CSV一括SMS送信完了！\n\n`;
      resultText += `${summary}\n`;
      resultText += `送信結果:\n`;
      resultText += `- 送信成功: ${bulkResult.successCount}件\n`;
      resultText += `- 送信失敗: ${bulkResult.failureCount}件\n`;

      const failures = bulkResult.results.filter(r => !r.success);
      if (failures.length > 0) {
        resultText += `\n失敗した送信:\n`;
        failures.forEach(failure => {
          resultText += `- ${failure.to}: ${failure.error}\n`;
        });
      }

      return {
        content: [{
          type: 'text',
          text: resultText
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: `CSV一括SMS送信エラー: ${error instanceof Error ? error.message : String(error)}`
        }]
      };
    }
  }
);

/**
 * APIキー認証ミドルウェア
 */
const authenticateApiKey = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const apiKey = req.headers['x-api-key'];
  const validApiKey = process.env.VONAGE_APPLICATION_ID;

  if (!apiKey || apiKey !== validApiKey) {
    res.status(401).json({ error: 'Unauthorized: Invalid or missing API Key' });
    return;
  }
  next();
};

/**
 * ヘルスチェック用エンドポイント
 * GET /health
 * 認証不要
 */
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', connected: true });
});

/**
 * MCP protocol endpoint
 * POST /mcp
 * Handles MCP JSON-RPC requests with authentication
 */
app.post('/mcp', async (req, res) => {
  // Check API key authentication
  const apiKey = req.headers['x-api-key'];
  const validApiKey = process.env.VONAGE_APPLICATION_ID;

  if (!apiKey || apiKey !== validApiKey) {
    res.status(401).json({ 
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: 'Unauthorized: Invalid or missing API Key'
      },
      id: null
    });
    return;
  }

  try {
    const { jsonrpc, id, method, params } = req.body;

    // Validate JSON-RPC 2.0 format
    if (jsonrpc !== '2.0') {
      res.status(400).json({
        jsonrpc: '2.0',
        error: {
          code: -32600,
          message: 'Invalid Request: jsonrpc must be "2.0"'
        },
        id: id ?? null
      });
      return;
    }

    // Handle MCP methods
    let result: any;

    switch (method) {
      case 'initialize':
        result = {
          protocolVersion: '2024-11-05',
          capabilities: {
            tools: {}
          },
          serverInfo: {
            name: 'vonage-mcp-server',
            version: '1.1.0'
          }
        };
        break;

      case 'tools/list':
        result = {
          tools: tools.map(tool => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema
          }))
        };
        break;

      case 'tools/call': {
        const { name, arguments: args } = params;
        
        // Execute the tool directly (same logic as /mcp-invoke)
        try {
          switch (name) {
            case 'send_sms': {
              const { to, message, from } = args;
              if (!validatePhoneNumber(to)) {
                result = {
                  content: [{
                    type: 'text',
                    text: 'エラー: 無効な電話番号形式です。正しい形式で入力してください。'
                  }]
                };
              } else {
                const smsResult = await sendSMS({ to, message, from });
                if (smsResult.success) {
                  result = {
                    content: [{
                      type: 'text',
                      text: `SMS送信成功！\n送信先: ${to}\nメッセージID: ${smsResult.messageId}`
                    }]
                  };
                } else {
                  result = {
                    content: [{
                      type: 'text',
                      text: `SMS送信失敗: ${smsResult.error}`
                    }]
                  };
                }
              }
              break;
            }

            case 'make_voice_call': {
              const { to, message, voice } = args;
              if (!validatePhoneNumber(to)) {
                result = {
                  content: [{
                    type: 'text',
                    text: 'エラー: 無効な電話番号形式です。正しい形式で入力してください。'
                  }]
                };
              } else if (voice && !validateVoiceName(voice)) {
                result = {
                  content: [{
                    type: 'text',
                    text: 'エラー: 無効な音声タイプです。利用可能: 女性、男性'
                  }]
                };
              } else {
                const estimatedDuration = estimateCallDuration(message);
                const callResult = await makeVoiceCall({ to, message, voice });
                if (callResult.success) {
                  const finalVoice = normalizeVoiceName(voice || '女性');
                  result = {
                    content: [{
                      type: 'text',
                      text: `音声通話を開始しました！\n発信先: ${to}\n通話ID: ${callResult.callId}\nメッセージ: ${message}\n音声: ${finalVoice}\n推定通話時間: ${estimatedDuration}秒`
                    }]
                  };
                } else {
                  result = {
                    content: [{
                      type: 'text',
                      text: `音声通話の発信に失敗しました: ${callResult.error}`
                    }]
                  };
                }
              }
              break;
            }

            case 'bulk_sms_from_csv': {
              const { csv_content } = args;
              const parseResult = parseAndValidateCSV(csv_content);
              const summary = generateCSVSummary(parseResult);

              if (parseResult.validRows.length === 0) {
                result = {
                  content: [{
                    type: 'text',
                    text: `エラー: 送信可能な有効な行がありませんでした。\n\n${summary}`
                  }]
                };
              } else {
                const smsParams = parseResult.validRows.map(row => ({
                  to: row.phone,
                  message: row.message,
                  from: row.from
                }));

                const bulkResult = await sendBulkSMS(smsParams);

                let resultText = `CSV一括SMS送信完了！\n\n`;
                resultText += `${summary}\n`;
                resultText += `送信結果:\n`;
                resultText += `- 送信成功: ${bulkResult.successCount}件\n`;
                resultText += `- 送信失敗: ${bulkResult.failureCount}件\n`;

                const failures = bulkResult.results.filter(r => !r.success);
                if (failures.length > 0) {
                  resultText += `\n失敗した送信:\n`;
                  failures.forEach(failure => {
                    resultText += `- ${failure.to}: ${failure.error}\n`;
                  });
                }

                result = {
                  content: [{
                    type: 'text',
                    text: resultText
                  }]
                };
              }
              break;
            }

            default:
              res.json({
                jsonrpc: '2.0',
                error: {
                  code: -32601,
                  message: `Unknown tool: ${name}`
                },
                id: id ?? null
              });
              return;
          }
        } catch (toolError: any) {
          res.json({
            jsonrpc: '2.0',
            error: {
              code: -32603,
              message: toolError.message || 'Tool execution failed'
            },
            id: id ?? null
          });
          return;
        }
        break;
      }

      case 'ping':
        result = {};
        break;

      default:
        res.json({
          jsonrpc: '2.0',
          error: {
            code: -32601,
            message: `Method not found: ${method}`
          },
          id: id ?? null
        });
        return;
    }

    // Return successful response
    res.json({
      jsonrpc: '2.0',
      result,
      id: id ?? null
    });

  } catch (error: any) {
    console.error('MCP endpoint error:', error);
    res.status(500).json({
      jsonrpc: '2.0',
      error: {
        code: -32603,
        message: 'Internal server error',
        data: error.message
      },
      id: null
    });
  }
});

// これ以降のエンドポイントには認証を適用
app.use(authenticateApiKey);

/**
 * MCPツールを実行するためのエンドポイント
 * POST /mcp-invoke
 * Body: { "tool": "tool_name", "params": { ... } }
 */
app.post('/mcp-invoke', async (req, res) => {
  const { tool, params } = req.body;

  // ツール名が指定されていない場合は400エラーを返す
  if (!tool) {
    res.status(400).json({ error: 'Missing "tool" parameter' });
    return;
  }

  try {
    console.log(`Invoking tool: ${tool} with params:`, params);
    
    // ツールを直接実行
    let result;
    
    switch (tool) {
      case 'send_sms': {
        const { to, message, from } = params;
        if (!validatePhoneNumber(to)) {
          res.status(400).json({ 
            content: [{ type: 'text', text: 'エラー: 無効な電話番号形式です。正しい形式で入力してください。' }]
          });
          return;
        }
        const smsResult = await sendSMS({ to, message, from });
        if (smsResult.success) {
          result = {
            content: [{ 
              type: 'text', 
              text: `SMS送信成功！\n送信先: ${to}\nメッセージID: ${smsResult.messageId}` 
            }]
          };
        } else {
          result = {
            content: [{ type: 'text', text: `SMS送信失敗: ${smsResult.error}` }]
          };
        }
        break;
      }
      
      case 'make_voice_call': {
        const { to, message, voice } = params;
        if (!validatePhoneNumber(to)) {
          res.status(400).json({ 
            content: [{ type: 'text', text: 'エラー: 無効な電話番号形式です。正しい形式で入力してください。' }]
          });
          return;
        }
        if (voice && !validateVoiceName(voice)) {
          res.status(400).json({ 
            content: [{ type: 'text', text: 'エラー: 無効な音声タイプです。利用可能: 女性、男性' }]
          });
          return;
        }
        const estimatedDuration = estimateCallDuration(message);
        const callResult = await makeVoiceCall({ to, message, voice });
        if (callResult.success) {
          const finalVoice = normalizeVoiceName(voice || '女性');
          result = {
            content: [{ 
              type: 'text', 
              text: `音声通話を開始しました！\n発信先: ${to}\n通話ID: ${callResult.callId}\nメッセージ: ${message}\n音声: ${finalVoice}\n推定通話時間: ${estimatedDuration}秒` 
            }]
          };
        } else {
          result = {
            content: [{ type: 'text', text: `音声通話の発信に失敗しました: ${callResult.error}` }]
          };
        }
        break;
      }
      
      case 'bulk_sms_from_csv': {
        const { csv_content } = params;
        const parseResult = parseAndValidateCSV(csv_content);
        const summary = generateCSVSummary(parseResult);
        
        if (parseResult.validRows.length === 0) {
          result = {
            content: [{ type: 'text', text: `エラー: 送信可能な有効な行がありませんでした。\n\n${summary}` }]
          };
        } else {
          const smsParams = parseResult.validRows.map(row => ({
            to: row.phone,
            message: row.message,
            from: row.from
          }));
          
          const bulkResult = await sendBulkSMS(smsParams);
          
          let resultText = `CSV一括SMS送信完了！\n\n`;
          resultText += `${summary}\n`;
          resultText += `送信結果:\n`;
          resultText += `- 送信成功: ${bulkResult.successCount}件\n`;
          resultText += `- 送信失敗: ${bulkResult.failureCount}件\n`;
          
          const failures = bulkResult.results.filter(r => !r.success);
          if (failures.length > 0) {
            resultText += `\n失敗した送信:\n`;
            failures.forEach(failure => {
              resultText += `- ${failure.to}: ${failure.error}\n`;
            });
          }
          
          result = {
            content: [{ type: 'text', text: resultText }]
          };
        }
        break;
      }
      
      default:
        res.status(404).json({ error: `Unknown tool: ${tool}` });
        return;
    }
    
    res.json(result);
  } catch (error: any) {
    console.error(`Error invoking tool ${tool}:`, error);
    res.status(500).json({ 
      error: 'Internal Server Error', 
      details: error.message 
    });
  }
});

/**
 * 利用可能なツールの一覧を取得するエンドポイント
 * GET /mcp-tools
 */
app.get('/mcp-tools', async (_req, res) => {
  res.json({ tools });
});

// メインモジュールとして実行された場合のみサーバーを起動
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // HTTPサーバーの起動
  const server = app.listen(port, () => {
    console.log(`HTTP MCP Wrapper listening on port ${port}`);
  });

  // プロセス終了時のクリーンアップ処理
  process.on('SIGINT', () => {
    console.log('Shutting down...');
    server.close();
    process.exit(0);
  });
}

