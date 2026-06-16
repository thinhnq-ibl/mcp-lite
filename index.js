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

// 1. Khai báo 4 năng lực cơ bản của Coder Agent với AI
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "list_directory",
        description: "Xem cấu trúc thư mục để biết dự án đang có những file nào.",
        inputSchema: {
          type: "object",
          properties: {
            dirPath: { type: "string", description: "Đường dẫn thư mục (mặc định là '.' - thư mục gốc)" }
          }
        }
      },
      {
        name: "read_file",
        description: "Đọc nội dung của một file có sẵn để hiểu code cũ trước khi sửa.",
        inputSchema: {
          type: "object",
          properties: {
            filePath: { type: "string", description: "Đường dẫn tới file cần đọc" }
          },
          required: ["filePath"]
        }
      },
      {
        name: "write_file",
        description: "Tạo file mới hoặc ghi đè hoàn toàn một file với nội dung mới.",
        inputSchema: {
          type: "object",
          properties: {
            filePath: { type: "string", description: "Đường dẫn file cần tạo" },
            content: { type: "string", description: " Toàn bộ nội dung file" }
          },
          required: ["filePath", "content"]
        }
      },
      {
        name: "patch_file",
        description: "Chỉnh sửa một phần file bằng cách tìm một đoạn code cũ và thay thế bằng đoạn code mới (Tránh ghi đè toàn bộ file lớn).",
        inputSchema: {
          type: "object",
          properties: {
            filePath: { type: "string", description: "Đường dẫn file cần sửa" },
            oldContent: { type: "string", description: "Đoạn code cũ CHÍNH XÁC cần tìm để thay thế" },
            newContent: { type: "string", description: "Đoạn code mới sẽ thay vào vị trí đó" }
          },
          required: ["filePath", "oldContent", "newContent"]
        }
      },
      {
        name: "execute_js_file",
        description: "Thực thi (chạy) một file JavaScript bằng Node.js và trả về kết quả log (stdout/stderr). Rất hữu ích để test code ngay lập tức.",
        inputSchema: {
          type: "object",
          properties: {
            filePath: {
              type: "string",
              description: "Đường dẫn tới file JavaScript cần chạy (ví dụ: 'test.js' hoặc './src/app.js')"
            }
          },
          required: ["filePath"]
        }
      },
      // 1. Tìm kiếm code trên toàn dự án
      {
        name: "search_code",
        description: "Tìm kiếm từ khóa trong toàn bộ dự án. Kết quả trả về gồm tên file và các dòng chứa từ khóa.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Từ khóa hoặc regex cần tìm" }
          },
          required: ["query"]
        }
      },
      // 2. Đọc file theo số dòng (tránh quá tải context)
      {
        name: "read_file_partial",
        description: "Đọc một đoạn cụ thể của file dựa trên số dòng, giúp tiết kiệm context window.",
        inputSchema: {
          type: "object",
          properties: {
            filePath: { type: "string", description: "Đường dẫn file" },
            startLine: { type: "number", description: "Dòng bắt đầu (tính từ 0)" },
            endLine: { type: "number", description: "Dòng kết thúc" }
          },
          required: ["filePath", "startLine", "endLine"]
        }
      },
      {
        name: "summarize_file",
        description: "Tóm tắt cấu trúc và chức năng chính của file (như các hàm, component, props). Hữu ích để hiểu nhanh file trước khi sửa.",
        inputSchema: {
          type: "object",
          properties: {
            filePath: { type: "string", description: "Đường dẫn file cần tóm tắt" }
          },
          required: ["filePath"]
        }
      },
      // Thêm vào schema tools
      {
        name: "append_to_file",
        description: "Thêm đoạn code mới vào cuối file hiện có.",
        inputSchema: {
          type: "object",
          properties: {
            filePath: { type: "string" },
            content: { type: "string", description: "Đoạn code cần thêm vào" }
          },
          required: ["filePath", "content"]
        }
      }
    ]
  };
});



// 2. Hiện thực hóa logic chạy các tác vụ
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "list_directory": {
        const targetDir = args?.dirPath || ".";
        const files = fs.readdirSync(targetDir);
        const details = files.map(file => {
          const stats = fs.statSync(path.join(targetDir, file));
          return `${stats.isDirectory() ? "[Thư mục]" : "[File]"} ${file}`;
        });
        return { content: [{ type: "text", text: `Cấu trúc thư mục tại (${targetDir}):\n${details.join("\n")}` }] };
      }

      case "read_file": {
        if (!fs.existsSync(args.filePath)) {
          return { content: [{ type: "text", text: `Lỗi: File ${args.filePath} không tồn tại.` }], isError: true };
        }
        const fileContent = fs.readFileSync(args.filePath, "utf-8");
        return { content: [{ type: "text", text: `Nội dung file ${args.filePath}:\n\n${fileContent}` }] };
      }

      case "write_file": {
        const dirPath = path.dirname(args.filePath);
        if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
        fs.writeFileSync(args.filePath, args.content, "utf-8");
        return { content: [{ type: "text", text: `Đã tạo/ghi đè file công tại: ${args.filePath}` }] };
      }

      case "patch_file": {
        const safePath = getSafePath(args.filePath);
        let content = fs.readFileSync(safePath, "utf-8");

        // Kiểm tra sự tồn tại của đoạn code cũ
        if (!content.includes(args.oldContent)) {
          return { 
            content: [{ 
              type: "text", 
              text: "Lỗi: Không tìm thấy đoạn code cũ. Hãy dùng 'read_file_partial' để xác nhận lại nội dung file trước khi patch." 
            }], 
            isError: true 
          };
        }

        // Thay thế tất cả các điểm trùng khớp
        const newContent = content.replaceAll(args.oldContent, args.newContent);
        fs.writeFileSync(safePath, newContent, "utf-8");
        return { content: [{ type: "text", text: "Đã cập nhật file thành công." }] };
      }

      case "search_code": {
        const { query } = args;
        // Sử dụng grep để tìm kiếm. 
        // -r: tìm đệ quy, -n: hiện số dòng, -I: bỏ qua file nhị phân
        // Loại trừ node_modules và .git để tăng tốc độ và tránh kết quả rác
        const command = `grep -rnI --exclude-dir=node_modules --exclude-dir=.git "${query}" .`;

        try {
          const { stdout } = await execAsync(command);
          return {
            content: [{
              type: "text",
              text: stdout ? `Kết quả tìm kiếm:\n${stdout}` : "Không tìm thấy từ khóa."
            }]
          };
        } catch (error) {
          // Grep trả về exit code 1 nếu không tìm thấy, nên chúng ta xử lý trường hợp này
          return {
            content: [{ type: "text", text: "Không tìm thấy kết quả hoặc có lỗi khi thực hiện tìm kiếm." }]
          };
        }
      }

      case "read_file_partial": {
        const { filePath, startLine, endLine } = args;

        if (!fs.existsSync(filePath)) {
          return { content: [{ type: "text", text: `Lỗi: File ${filePath} không tồn tại.` }], isError: true };
        }

        // Sử dụng Promise để đợi quá trình đọc stream hoàn tất
        const getFileRange = () => {
          return new Promise((resolve, reject) => {
            const fileStream = fs.createReadStream(filePath);
            const rl = readline.createInterface({
              input: fileStream,
              crlfDelay: Infinity
            });

            let currentLine = 0;
            let resultLines = [];

            rl.on('line', (line) => {
              if (currentLine >= startLine && currentLine < endLine) {
                resultLines.push(line);
              }
              currentLine++;
              // Tối ưu: Dừng đọc ngay khi đã đủ số dòng
              if (currentLine >= endLine) {
                rl.close();
                fileStream.destroy();
              }
            });

            rl.on('close', () => resolve(resultLines.join('\n')));
            rl.on('error', (err) => reject(err));
          });
        };

        try {
          const partialContent = await getFileRange();
          return {
            content: [{
              type: "text",
              text: `Đoạn mã từ dòng ${startLine} đến ${endLine}:\n\n${partialContent}`
            }]
          };
        } catch (error) {
          return { content: [{ type: "text", text: `Lỗi đọc file stream: ${error.message}` }], isError: true };
        }
      }

      case "summarize_file": {
        const safePath = getSafePath(args.filePath);
        const content = fs.readFileSync(safePath, "utf-8");

        // Regex cải tiến để bắt class, interface, type, và export function
        const definitions = content.match(/(export\s+)?(class|interface|type|function|const)\s+(\w+)/g) || [];
        const imports = content.match(/import\s+.*?\s+from\s+['"].*?['"]/g) || [];

        return {
          content: [{
            type: "text",
            text: `Tóm tắt cấu trúc:\n- Tổng số dòng: ${content.split('\n').length}\n- Định nghĩa chính: ${definitions.join(', ')}\n- Số import: ${imports.length}`
          }]
        };
      }

      case "append_to_file": {
        const safePath = getSafePath(args.filePath);
        fs.appendFileSync(safePath, `\n${args.content}`, "utf-8");
        return { content: [{ type: "text", text: "Đã thêm code vào cuối file." }] };
      }
      
      // Logic thực thi
      case "insert_at_line": {
        const safePath = getSafePath(args.filePath);
        const lines = fs.readFileSync(safePath, "utf-8").split('\n');
        const insertIndex = parseInt(args.lineNumber);
        
        lines.splice(insertIndex, 0, args.content);
        fs.writeFileSync(safePath, lines.join('\n'), "utf-8");
        return { content: [{ type: "text", text: `Đã chèn code tại dòng ${insertIndex}.` }] };
      }

      default:
        throw new Error(`Không tìm thấy tác vụ: ${name}`);
    }
  } catch (error) {
    return { content: [{ type: "text", text: `Thực hiện thất bại. Lỗi hệ thống: ${error.message}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);