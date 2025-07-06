import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { vi, beforeEach, afterEach, describe, it, expect } from 'vitest';

// テスト用のモック関数
vi.mock("@modelcontextprotocol/sdk/server/mcp.js");
vi.mock("@modelcontextprotocol/sdk/server/stdio.js");

describe('MCP Server', () => {
  let mockServer: any;
  let mockTransport: any;

  beforeEach(() => {
    // モックのリセット
    vi.clearAllMocks();
    
    // McpServerのモック
    mockServer = {
      registerTool: vi.fn(),
      registerResource: vi.fn(),
      connect: vi.fn(),
    };
    
    // StdioServerTransportのモック
    mockTransport = {};
    
    // コンストラクタのモック
    vi.mocked(McpServer).mockImplementation(() => mockServer);
    vi.mocked(StdioServerTransport).mockImplementation(() => mockTransport);
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('Server Initialization', () => {
    it('should create server with correct name and version', () => {
      // サーバーが正しいパラメータで作成されることを確認
      expect(McpServer).toHaveBeenCalledWith({
        name: "demo-server",
        version: "1.0.0"
      });
    });

    it('should create transport', () => {
      // トランスポートが作成されることを確認
      expect(StdioServerTransport).toHaveBeenCalled();
    });
  });

  describe('Tool Registration', () => {
    it('should register addition tool', () => {
      // 加算ツールが登録されることを確認
      expect(mockServer.registerTool).toHaveBeenCalledWith(
        "add",
        {
          title: "Addition Tool",
          description: "Add two numbers",
          inputSchema: { a: z.number(), b: z.number() }
        },
        expect.any(Function)
      );
    });
  });

  describe('Resource Registration', () => {
    it('should register greeting resource', () => {
      // 挨拶リソースが登録されることを確認
      expect(mockServer.registerResource).toHaveBeenCalledWith(
        "greeting",
        expect.any(ResourceTemplate),
        {
          title: "Greeting Resource",
          description: "Dynamic greeting generator"
        },
        expect.any(Function)
      );
    });
  });

  describe('Server Connection', () => {
    it('should connect server to transport', async () => {
      // サーバーがトランスポートに接続されることを確認
      expect(mockServer.connect).toHaveBeenCalledWith(mockTransport);
    });
  });
}); 