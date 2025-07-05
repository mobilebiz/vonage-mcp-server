import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// テスト用のモック関数
jest.mock("@modelcontextprotocol/sdk/server/mcp.js");
jest.mock("@modelcontextprotocol/sdk/server/stdio.js");

describe('MCP Server', () => {
  let mockServer: jest.Mocked<McpServer>;
  let mockTransport: jest.Mocked<StdioServerTransport>;

  beforeEach(() => {
    // モックのリセット
    jest.clearAllMocks();
    
    // McpServerのモック
    mockServer = {
      registerTool: jest.fn(),
      registerResource: jest.fn(),
      connect: jest.fn(),
    } as any;
    
    // StdioServerTransportのモック
    mockTransport = {} as any;
    
    // コンストラクタのモック
    (McpServer as jest.MockedClass<typeof McpServer>).mockImplementation(() => mockServer);
    (StdioServerTransport as jest.MockedClass<typeof StdioServerTransport>).mockImplementation(() => mockTransport);
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