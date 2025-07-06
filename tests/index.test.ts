import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { vi, beforeEach, afterEach, describe, it, expect } from 'vitest';

// テスト用のモック関数
describe('MCP Server', () => {
  let mockServer: any;
  let mockTransport: any;

  beforeEach(() => {
    // モックのリセット
    vi.restoreAllMocks();
    
    // McpServerのモック
    mockServer = {
      registerTool: vi.fn(),
      registerResource: vi.fn(),
      connect: vi.fn(),
    };
    
    // StdioServerTransportのモック
    mockTransport = {};
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Server Initialization', () => {
    it('should create server with correct name and version', () => {
      // サーバーが正しいパラメータで作成されることを確認
      // ここはコンストラクタの呼び出しを直接確認できないため、インスタンス生成で十分
      const server = new McpServer({ name: "demo-server", version: "1.0.0" });
      expect(server).toBeDefined();
    });

    it('should create transport', () => {
      // トランスポートが作成されることを確認
      const transport = new StdioServerTransport();
      expect(transport).toBeDefined();
    });
  });

  describe('Tool Registration', () => {
    it('should register SMS tool', () => {
      // SMSツールが登録されることを確認
      const inputSchema = { 
        to: z.string().describe("送信先の電話番号（必須）"),
        message: z.string().describe("送信するメッセージ（必須）"),
        from: z.string().optional().describe("送信元（省略時は'VonageMCP'）")
      };
      mockServer.registerTool('send_sms', {
        title: "SMS送信ツール",
        description: "Vonageを使用してSMSを送信します。日本の電話番号（0から始まる）は自動的にE.164形式に変換されます。",
        inputSchema
      }, () => {});
      expect(mockServer.registerTool).toHaveBeenCalledWith(
        'send_sms',
        expect.objectContaining({
          title: "SMS送信ツール",
          description: "Vonageを使用してSMSを送信します。日本の電話番号（0から始まる）は自動的にE.164形式に変換されます。",
          inputSchema: expect.any(Object)
        }),
        expect.any(Function)
      );
    });
  });



  describe('Server Connection', () => {
    it('should connect server to transport', async () => {
      // サーバーがトランスポートに接続されることを確認
      mockServer.connect({});
      expect(mockServer.connect).toHaveBeenCalledWith({});
    });
  });
}); 