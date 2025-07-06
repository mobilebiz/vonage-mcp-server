import { config } from 'dotenv';
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { sendSMS, validatePhoneNumber } from "./vonage.js";

// 環境変数を読み込み
config();

// Create an MCP server
const server = new McpServer({
  name: "demo-server",
  version: "1.0.0"
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

// Start receiving messages on stdin and sending messages on stdout
const transport = new StdioServerTransport();
await server.connect(transport);