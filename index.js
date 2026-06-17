// This file serves as the entry point for the 'coder-agent-tools' server.
// It sets up and exposes various tools (file system operations, code insertion, patching, searching, execution)
// to an external agent via the Model Context Protocol SDK over Stdio transport.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
/* hello */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import fs from "fs";
import path from "path";
import readline from "readline";
import { promisify } from "util";
import { exec } from "child_process";
const execAsync = promisify(exec);

const server = new Server(
  { name: "coder-agent-tools", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

const getSafePath = (filePath) => {
  return path.resolve(filePath);
};

// Thay vì quá nhiều tool rời rạc, hãy tối ưu hóa danh mục:
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "file_system_operations",
        description: "Quản lý file: đọc, ghi (đè/tạo mới), hoặc xem danh sách thư mục.",
        inputSchema: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["read", "write", "list"] },
            path: { type: "string" },
            content: { type: "string", description: "Dùng khi action là 'write'" }
          },
          required: ["action", "path"]
        }
      },
     {
        name: "insert_code",
        description: "Chèn code mới vào một vị trí cụ thể (theo dòng hoặc sau một chuỗi ký tự).",
        inputSchema: {
          type: "object",
          properties: {
            filePath: { type: "string" },
            content: { type: "string", description: "Đoạn code cần chèn" },
            anchorLine: { type: "number", description: "Chèn vào sau dòng này" },
            anchorString: { type: "string", description: "Tìm dòng chứa chuỗi này và chèn vào sau đó" }
          },
          required: ["filePath", "content"]
        }
      },
      {
        name: "apply_patch",
        description: "Chỉnh sửa file bằng cách thay thế nội dung cũ bằng nội dung mới. Tốt cho các file lớn.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string" },
            oldContent: { type: "string" },
            newContent: { type: "string" }
          },
          required: ["path", "oldContent", "newContent"]
        }
      },
      {
        name: "smart_search",
        description: "Tìm kiếm code kèm theo số dòng xung quanh để lấy context.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" }
          },
          required: ["query"]
        }
      },
      {
        name: "execute_code",
        description: "Chạy file JS để kiểm tra kết quả ngay lập tức.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string" }
          },
          required: ["path"]
        }
      }
    ]
  };
});



server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "file_system_operations": {
        const { action, path: targetPath, content } = args;
        
        switch (action) {
          case "list":
            const files = fs.readdirSync(targetPath || ".");
            return { content: [{ type: "text", text: `Danh sách file: ${files.join(", ")}` }] };
            
          case "read":
            if (!fs.existsSync(targetPath)) return { content: [{ type: "text", text: "Lỗi: File không tồn tại." }], isError: true };
            const fileContent = fs.readFileSync(targetPath, "utf-8");
            return { content: [{ type: "text", text: fileContent }] };
            
          case "write":
            fs.writeFileSync(targetPath, content || "", "utf-8");
            return { content: [{ type: "text", text: `Đã ghi file thành công: ${targetPath}` }] };
          
          default:
            return { content: [{ type: "text", text: "Hành động không hợp lệ." }], isError: true };
        }
      }

      case "apply_patch": {
        const { path: targetPath, oldContent, newContent } = args;
        if (!fs.existsSync(targetPath)) return { content: [{ type: "text", text: "Lỗi: File không tồn tại." }], isError: true };
        
        let fileData = fs.readFileSync(targetPath, "utf-8");
        if (!fileData.includes(oldContent)) {
          return { content: [{ type: "text", text: "Lỗi: Không tìm thấy đoạn code cũ để thay thế. Hãy kiểm tra lại chính xác khoảng trắng/dòng." }], isError: true };
        }
        
        fileData = fileData.replace(oldContent, newContent);
        fs.writeFileSync(targetPath, fileData, "utf-8");
        return { content: [{ type: "text", text: "Patch file thành công." }] };
      }

      case "smart_search": {
        // Tìm kiếm sử dụng grep, trả về kết quả kèm dòng (context)
        try {
          const { stdout } = await execAsync(`grep -rnI "${args.query}" . --exclude-dir=node_modules`);
          return { content: [{ type: "text", text: stdout || "Không tìm thấy kết quả." }] };
        } catch {
          return { content: [{ type: "text", text: "Không tìm thấy kết quả hoặc lỗi thực thi tìm kiếm." }] };
        }
      }

      case "insert_code": {
        const safePath = getSafePath(args.filePath);
        if (!fs.existsSync(safePath)) {
          return { content: [{ type: "text", text: `Lỗi: File ${args.filePath} không tồn tại.` }], isError: true };
        }

        const lines = fs.readFileSync(safePath, "utf-8").split('\n');
        let insertAt = 0;

        if (args.anchorString) {
          const foundIndex = lines.findIndex(l => l.includes(args.anchorString));
          if (foundIndex === -1) {
            return { content: [{ type: "text", text: `Lỗi: Không tìm thấy dòng chứa "${args.anchorString}"` }], isError: true };
          }
          insertAt = foundIndex + 1;
        } else if (args.anchorLine !== undefined) {
          insertAt = args.anchorLine + 1;
        } else {
          return { content: [{ type: "text", text: "Lỗi: Phải cung cấp anchorLine hoặc anchorString." }], isError: true };
        }

        lines.splice(insertAt, 0, args.content);
        fs.writeFileSync(safePath, lines.join('\n'), "utf-8");
        return { content: [{ type: "text", text: `Đã chèn thành công tại vị trí sau dòng ${insertAt - 1}.` }] };
      }

      case "execute_code": {
        if (!fs.existsSync(args.path)) return { content: [{ type: "text", text: "Lỗi: File không tồn tại." }], isError: true };
        try {
          const { stdout, stderr } = await execAsync(`node ${args.path}`);
          return { content: [{ type: "text", text: `Output:\n${stdout}\nError:\n${stderr}` }] };
        } catch (err) {
          return { content: [{ type: "text", text: `Lỗi thực thi: ${err.message}` }], isError: true };
        }
      }

      default:
        throw new Error(`Công cụ ${name} chưa được triển khai.`);
    }
  } catch (error) {
    return { content: [{ type: "text", text: `Hệ thống gặp lỗi: ${error.message}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);