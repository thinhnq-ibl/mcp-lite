import { Server } from "@modelcontextprotocol/sdk/server/index.js";
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