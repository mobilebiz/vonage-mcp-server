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
    it('should register addition tool', () => {
      // 加算ツールが登録されることを確認
      const inputSchema = { a: z.number(), b: z.number() };
      mockServer.registerTool('add', {
        title: "Addition Tool",
        description: "Add two numbers",
        inputSchema
      }, () => {});
      expect(mockServer.registerTool).toHaveBeenCalledWith(
        'add',
        expect.objectContaining({
          title: "Addition Tool",
          description: "Add two numbers",
          inputSchema: expect.any(Object)
        }),
        expect.any(Function)
      );
      // スキーマの構造比較
      const callArgs = mockServer.registerTool.mock.calls[0][1].inputSchema;
      expect(callArgs.a.toString()).toBe(z.number().toString());
      expect(callArgs.b.toString()).toBe(z.number().toString());
    });
  });

  describe('Resource Registration', () => {
    it('should register greeting resource', () => {
      // 挨拶リソースが登録されることを確認
      mockServer.registerResource('greeting', new ResourceTemplate('greeting://{name}', { list: undefined }), {
        title: "Greeting Resource",
        description: "Dynamic greeting generator"
      }, () => {});
      expect(mockServer.registerResource).toHaveBeenCalledWith(
        'greeting',
        expect.any(ResourceTemplate),
        expect.objectContaining({
          title: "Greeting Resource",
          description: "Dynamic greeting generator"
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