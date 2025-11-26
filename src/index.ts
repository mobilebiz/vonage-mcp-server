// import { config } from 'dotenv';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { sendSMS, validatePhoneNumber, sendBulkSMS } from "./vonage.js";
import { parseAndValidateCSV, generateCSVSummary } from "./csvUtils.js";
import { makeVoiceCall, validateVoiceName, estimateCallDuration, normalizeVoiceName } from "./voiceCall.js";

// dotenvを使用せず、直接Node.jsの--env-fileオプションを使用して環境変数を読み込むことを推奨
// 実行方法: node --env-file=.env dist/index.js
// または: npm run start:env

console.error("DEBUG: src/index.ts is starting...");

// デバッグログ機能（環境変数DEBUG=trueで有効化）
import { appendFileSync } from 'fs';

const isDebugMode = process.env.DEBUG === 'true';
const logFile = process.env.LOG_FILE;

function debugLog(message: string, data?: any) {
  if (isDebugMode) {
    const timestamp = new Date().toISOString();
    const logMessage = `[DEBUG ${timestamp}] ${message}`;
    const logData = data ? JSON.stringify(data, null, 2) : '';
    const fullLog = logData ? `${logMessage}\n${logData}\n` : `${logMessage}\n`;
    
    // コンソール出力（stderr）
    console.error(logMessage);
    if (data) {
      console.error(logData);
    }
    
    // ファイル出力（指定されている場合）
    if (logFile) {
      try {
        appendFileSync(logFile, fullLog);
      } catch (error) {
        console.error(`Failed to write to log file: ${error}`);
      }
    }
  }
}

// Create an MCP server
const server = new McpServer({
  name: "vonage-mcp-server",
  version: "1.1.0"
});

// Add SMS sending tool
server.registerTool("send_sms",
  {
    title: "SMS送信ツール",
    description: "Vonageを使用してSMSを送信します。日本の電話番号（0から始まる）は自動的にE.164形式に変換されます。",
    inputSchema: { 
      to: z.string().describe("送信先の電話番号（必須）"),
      message: z.string().describe("送信するメッセージ（必須）"),
      from: z.string().optional().describe("送信元（省略時は'VonageMCP'）")
    }
  },
  async ({ to, message, from }) => {
    debugLog("SMS送信ツールが呼び出されました", { to, message, from });
    
    // 電話番号の検証
    if (!validatePhoneNumber(to)) {
      return {
        content: [{ 
          type: "text", 
          text: `エラー: 無効な電話番号形式です。正しい形式で入力してください。` 
        }]
      };
    }

    // SMS送信
    const result = await sendSMS({ to, message, from });
    
    if (result.success) {
      return {
        content: [{ 
          type: "text", 
          text: `SMS送信成功！\n送信先: ${to}\nメッセージID: ${result.messageId}` 
        }]
      };
    } else {
      return {
        content: [{ 
          type: "text", 
          text: `SMS送信失敗: ${result.error}` 
        }]
      };
    }
  }
);

// Add CSV bulk SMS sending tool
server.registerTool("bulk_sms_from_csv",
  {
    title: "CSV一括SMS送信",
    description: "CSVファイル（phone,from,message）から一括SMS送信を行います。無効な行はスキップされ、処理結果がまとめて返されます。",
    inputSchema: { 
      csv_content: z.string().describe("CSVファイルの内容（phone,from,messageのヘッダー付き）")
    }
  },
  async ({ csv_content }) => {
    debugLog("CSV一括SMS送信ツールが呼び出されました", { csvContentLength: csv_content.length });
    
    try {
      // CSVを解析・バリデーション
      const parseResult = parseAndValidateCSV(csv_content);
      const summary = generateCSVSummary(parseResult);
      
      // 有効な行が0の場合は送信せずに終了
      if (parseResult.validRows.length === 0) {
        return {
          content: [{ 
            type: "text", 
            text: `エラー: 送信可能な有効な行がありませんでした。\n\n${summary}` 
          }]
        };
      }
      
      // バルクSMS送信用にCSVRowをSMSParamsに変換
      const smsParams = parseResult.validRows.map(row => ({
        to: row.phone,
        message: row.message,
        from: row.from
      }));
      
      const bulkResult = await sendBulkSMS(smsParams);
      
      // 結果をまとめて返却
      let resultText = `CSV一括SMS送信完了！\n\n`;
      resultText += `${summary}\n`;
      resultText += `送信結果:\n`;
      resultText += `- 送信成功: ${bulkResult.successCount}件\n`;
      resultText += `- 送信失敗: ${bulkResult.failureCount}件\n`;
      
      // 失敗した送信の詳細を表示
      const failures = bulkResult.results.filter(r => !r.success);
      if (failures.length > 0) {
        resultText += `\n失敗した送信:\n`;
        failures.forEach(failure => {
          resultText += `- ${failure.to}: ${failure.error}\n`;
        });
      }
      
      return {
        content: [{ 
          type: "text", 
          text: resultText 
        }]
      };
      
    } catch (error) {
      return {
        content: [{ 
          type: "text", 
          text: `CSV一括SMS送信エラー: ${error instanceof Error ? error.message : String(error)}` 
        }]
      };
    }
  }
);

// Add Voice call tool
server.registerTool("make_voice_call",
  {
    title: "音声通話",
    description: "指定した番号に発信してメッセージを読み上げます。日本の電話番号（0から始まる）は自動的にE.164形式に変換されます。",
    inputSchema: { 
      to: z.string().describe("発信先電話番号（0ABJ形式）"),
      message: z.string().describe("読み上げるメッセージ"),
      voice: z.string().optional().describe("音声タイプ（デフォルト: 女性）")
    }
  },
  async ({ to, message, voice }) => {
    debugLog("音声通話ツールが呼び出されました", { to, message, voice });
    
    // 電話番号の検証
    if (!validatePhoneNumber(to)) {
      return {
        content: [{ 
          type: "text", 
          text: `エラー: 無効な電話番号形式です。正しい形式で入力してください。` 
        }]
      };
    }
    
    // 音声タイプの検証（指定された場合）
    if (voice && !validateVoiceName(voice)) {
      return {
        content: [{ 
          type: "text", 
          text: `エラー: 無効な音声タイプです。利用可能: 女性、男性` 
        }]
      };
    }
    
    // 通話時間の見積もり
    const estimatedDuration = estimateCallDuration(message);
    
    // Voice通話を発信
    const result = await makeVoiceCall({ to, message, voice });
    
    if (result.success) {
      const finalVoice = normalizeVoiceName(voice || '女性');
      return {
        content: [{ 
          type: "text", 
          text: `音声通話を開始しました！\n発信先: ${to}\n通話ID: ${result.callId}\nメッセージ: ${message}\n音声: ${finalVoice}\n推定通話時間: ${estimatedDuration}秒` 
        }]
      };
    } else {
      return {
        content: [{ 
          type: "text", 
          text: `音声通話の発信に失敗しました: ${result.error}` 
        }]
      };
    }
  }
);

// Start receiving messages on stdin and sending messages on stdout
const transport = new StdioServerTransport();
await server.connect(transport);