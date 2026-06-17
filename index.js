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

const getSafePath = (filePath) => path.resolve(filePath);

const readLines = (filePath) => {
  const safePath = getSafePath(filePath);
  if (!fs.existsSync(safePath)) return { error: "File không tồn tại.", path: safePath };
  const content = fs.readFileSync(safePath, "utf-8");
  return { lines: content.split('\n'), content, path: safePath };
};

const findFunctionBounds = (lines, functionName) => {
  const funcRegex = new RegExp(`(function\\s+${functionName}|${functionName}\\s*[:=]\\s*\\(?.*\\)?\\s*=>|${functionName}\\s*\\()`);
  const startIndex = lines.findIndex(line => funcRegex.test(line));
  if (startIndex === -1) return null;

  let openBraces = 0;
  let endIndex = -1;
  let foundStart = false;

  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i];
    openBraces += (line.match(/{/g) || []).length;
    openBraces -= (line.match(/}/g) || []).length;

    if (openBraces > 0) foundStart = true;
    if (foundStart && openBraces === 0) {
      endIndex = i;
      break;
    }
  }
  return endIndex === -1 ? null : { startIndex, endIndex };
};

let currentActiveFile = null;

let safePath = "";

// Thay vì quá nhiều tool rời rạc, hãy tối ưu hóa danh mục:
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "run_script",
        description: "Chạy một file script Node.js hoặc lệnh shell. Hữu ích để khởi động lại server hoặc build dự án.",
        inputSchema: {
          type: "object",
          properties: {
            command: { type: "string", description: "Lệnh cần chạy (ví dụ: 'node src/server.js')" }
          },
          required: ["command"]
        }
      },
      {
        name: "rename_file",
        description: "Đổi tên file hoặc di chuyển file trong hệ thống.",
        inputSchema: {
          type: "object",
          properties: {
            oldPath: { type: "string", description: "Đường dẫn file hiện tại" },
            newPath: { type: "string", description: "Đường dẫn file mới (tên mới)" }
          },
          required: ["oldPath", "newPath"]
        }
      },
      {
        name: "get_workspace_state",
        description: "Kiểm tra file hiện tại đang được Agent tập trung xử lý.",
        inputSchema: { type: "object", properties: {} }
      },
      {
        name: "get_function_context",
        description: "Trích xuất nội dung của một hàm cụ thể. Có thể tùy chọn hiển thị số dòng.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string" },
            functionName: { type: "string" },
            withLineNumbers: { type: "boolean", description: "Hiển thị kèm số dòng" }
          },
          required: ["path", "functionName"]
        }
      },
      {
        name: "replace_code_block",
        description: "Thay thế một khối code cũ bằng code mới. Sử dụng khi biết rõ đoạn code cần thay đổi.",
        inputSchema: {
          type: "object",
          properties: {
            filePath: { type: "string" },
            oldBlock: { type: "string", description: "Đoạn code cũ cần tìm" },
            newBlock: { type: "string", description: "Đoạn code mới để thay thế" }
          },
          required: ["filePath", "oldBlock", "newBlock"]
        }
      },
      {
        name: "read_file_with_numbers",
        description: "Đọc file kèm theo số dòng ở đầu mỗi dòng. Giúp Agent xác định vị trí sửa code chính xác.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string" },
            startLine: { type: "number" },
            endLine: { type: "number" }
          },
          required: ["path"]
        }
      },
      {
        name: "search_and_read",
        description: "Tìm kiếm một chuỗi trong dự án và trả về nội dung tại vị trí đó kèm theo 10 dòng xung quanh để lấy context.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Chuỗi code hoặc từ khóa cần tìm" },
            contextLines: { type: "number", description: "Số dòng xung quanh cần lấy (mặc định 10)" }
          },
          required: ["query"]
        }
      },
      {
        name: "read_file_smart",
        description: "Đọc nội dung file thông minh. Nếu file quá dài (>200 dòng), nó sẽ chỉ đọc 100 dòng đầu và thông báo cho AI biết tổng số dòng để AI yêu cầu đọc phần còn lại.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string" }
          },
          required: ["path"]
        }
      },
      {
        name: "get_file_info",
        description: "Lấy thông tin file bao gồm tổng số dòng, kích thước (bytes) và thời gian sửa đổi gần nhất.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Đường dẫn đến file cần kiểm tra" }
          },
          required: ["path"]
        }
      },
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
      },
      {
        name: "read_lines",
        description: "Đọc một phạm vi dòng cụ thể trong file (giúp tiết kiệm token).",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string" },
            startLine: { type: "number", description: "Dòng bắt đầu (tính từ 0)" },
            endLine: { type: "number", description: "Dòng kết thúc" }
          },
          required: ["path", "startLine", "endLine"]
        }
      }
    ]
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "run_script": {
        const { command } = args;

        // Chạy lệnh và trả về output ngay lập tức
        exec(command, (error, stdout, stderr) => {
          if (error) {
            return { content: [{ type: "text", text: `Lỗi khi chạy lệnh: ${error.message}` }], isError: true };
          }
        });

        // Trả về thông báo thành công cho Agent
        return { content: [{ type: "text", text: `Lệnh đã được thực thi: ${command}` }] };
      }
      
      case "rename_file": {
        const { oldPath, newPath } = args;
        const oldSafePath = getSafePath(oldPath);
        const newSafePath = getSafePath(newPath);

        if (!fs.existsSync(oldSafePath)) {
          return { content: [{ type: "text", text: "Lỗi: File cũ không tồn tại." }], isError: true };
        }

        try {
          fs.renameSync(oldSafePath, newSafePath);
          // Cập nhật lại workspace state nếu file vừa đổi tên chính là file đang làm việc
          if (currentActiveFile === oldSafePath) {
            currentActiveFile = newSafePath;
          }
          return { content: [{ type: "text", text: `Đã đổi tên thành công: ${oldPath} -> ${newPath}` }] };
        } catch (err) {
          return { content: [{ type: "text", text: `Lỗi khi đổi tên: ${err.message}` }], isError: true };
        }
      }

      case "get_workspace_state": {
        return { 
          content: [{ 
            type: "text", 
            text: currentActiveFile ? `Đang làm việc tại: ${currentActiveFile}` : "Chưa có file nào được chọn." 
          }] 
        };
      }

      case "get_function_context": {
        const { path: targetPath, functionName, withLineNumbers = false } = args;
        const { lines, error, path: safe } = readLines(targetPath);
        if (error) return { content: [{ type: "text", text: `Lỗi: ${error}` }], isError: true };
        safePath = safe;

        const bounds = findFunctionBounds(lines, functionName);
        if (!bounds) return { content: [{ type: "text", text: `Không tìm thấy hàm "${functionName}" hoặc không xác định được phạm vi.` }], isError: true };

        const { startIndex, endIndex } = bounds;
        let funcLines = lines.slice(startIndex, endIndex + 1);

        if (withLineNumbers) {
          funcLines = funcLines.map((line, idx) => `${startIndex + idx + 1} | ${line}`);
        }

        return { content: [{ type: "text", text: `Nội dung hàm ${functionName}:\n\n${funcLines.join('\n')}` }] };
      }

      case "replace_code_block": {
        const { filePath, oldBlock, newBlock } = args;
        const { content, error, path: safe } = readLines(filePath);
        if (error) return { content: [{ type: "text", text: `Lỗi: ${error}` }], isError: true };
        safePath = safe;

        if (!content.includes(oldBlock)) {
          return { 
            content: [{ type: "text", text: "Lỗi: Không tìm thấy khối code cần thay thế. Kiểm tra khoảng trắng và thụt lề." }], 
            isError: true 
          };
        }

        fs.writeFileSync(safePath, content.replace(oldBlock, newBlock), "utf-8");
        return { content: [{ type: "text", text: "Thay thế khối code thành công." }] };
      }

      case "read_file_with_numbers": {
        const { path: targetPath, startLine = 0, endLine = 1000 } = args;
        const { lines, error, path: safe } = readLines(targetPath);
        if (error) return { content: [{ type: "text", text: `Lỗi: ${error}` }], isError: true };
        safePath = safe;
        
        const formatted = lines
          .slice(startLine, endLine)
          .map((line, index) => `${startLine + index + 1} | ${line}`)
          .join('\n');
          
        return { content: [{ type: "text", text: formatted }] };
      }

      case "search_and_read": {
        const { query, contextLines = 10 } = args;
        const cmd = `grep -rnC ${contextLines} "${query}" . --exclude-dir=node_modules | head -n 50`;
        
        try {
          const { stdout } = await execAsync(cmd);
          if (!stdout) return { content: [{ type: "text", text: "Không tìm thấy kết quả phù hợp." }] };
          return { content: [{ type: "text", text: stdout }] };
        } catch (err) {
          return { content: [{ type: "text", text: "Lỗi khi tìm kiếm." }], isError: true };
        }
      }

      case "read_file_smart": {
        const { lines, content, error, path: safe } = readLines(args.path);
        if (error) return { content: [{ type: "text", text: `Lỗi: ${error}` }], isError: true };
        safePath = safe;
        const totalLines = lines.length;

        if (totalLines > 200) {
          const preview = lines.slice(0, 100).join('\n');
          return {
            content: [{
              type: "text",
              text: `File quá dài (${totalLines} dòng). 100 dòng đầu:\n\n${preview}\n\n[Hệ thống]: File còn ${totalLines - 100} dòng. Dùng 'read_lines' để đọc thêm.`
            }]
          };
        }

        return { content: [{ type: "text", text: content }] };
      }

      case "get_file_info": {
        const { path: targetPath } = args;
        const safe = getSafePath(targetPath);
        if (!fs.existsSync(safe)) return { content: [{ type: "text", text: "Lỗi: File không tồn tại." }], isError: true };
        safePath = safe;

        const stats = fs.statSync(safePath);
        const { lines } = readLines(targetPath);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              path: targetPath,
              sizeBytes: stats.size,
              lineCount: lines.length,
              lastModified: stats.mtime,
              isFile: stats.isFile()
            }, null, 2)
          }]
        };
      }

      case "read_lines": {
        const { path: targetPath, startLine, endLine } = args;
        const { lines, error, path: safe } = readLines(targetPath);
        if (error) return { content: [{ type: "text", text: `Lỗi: ${error}` }], isError: true };
        safePath = safe;
        
        if (startLine < 0 || endLine >= lines.length || startLine > endLine) {
          return { content: [{ type: "text", text: `Lỗi: Phạm vi dòng không hợp lệ (File có ${lines.length} dòng).` }], isError: true };
        }

        return { content: [{ type: "text", text: lines.slice(startLine, endLine + 1).join('\n') }] };
      }

      case "file_system_operations": {
        const { action, path: targetPath, content } = args;
        const safe = getSafePath(targetPath || ".");
        
        switch (action) {
          case "list":
            const files = fs.readdirSync(safe);
            return { content: [{ type: "text", text: `Danh sách file: ${files.join(", ")}` }] };
            
          case "read":
            const { content: fileContent, error } = readLines(targetPath);
            if (error) return { content: [{ type: "text", text: `Lỗi: ${error}` }], isError: true };
            return { content: [{ type: "text", text: fileContent }] };
            
          case "write":
            fs.writeFileSync(safe, content || "", "utf-8");
            return { content: [{ type: "text", text: `Đã ghi file thành công: ${targetPath}` }] };
          
          default:
            return { content: [{ type: "text", text: "Hành động không hợp lệ." }], isError: true };
        }
      }

      case "apply_patch": {
        const { path: targetPath, oldContent, newContent } = args;
        const { content: fileData, error, path: safe } = readLines(targetPath);
        if (error) return { content: [{ type: "text", text: `Lỗi: ${error}` }], isError: true };
        safePath = safe;

        if (!fileData.includes(oldContent)) {
          return { content: [{ type: "text", text: "Lỗi: Không tìm thấy đoạn code cũ để thay thế." }], isError: true };
        }
        
        fs.writeFileSync(safePath, fileData.replace(oldContent, newContent), "utf-8");
        return { content: [{ type: "text", text: "Patch file thành công." }] };
      }

      case "smart_search": {
        try {
          const { stdout } = await execAsync(`grep -rnI "${args.query}" . --exclude-dir=node_modules`);
          return { content: [{ type: "text", text: stdout || "Không tìm thấy kết quả." }] };
        } catch {
          return { content: [{ type: "text", text: "Không tìm thấy kết quả." }] };
        }
      }

      case "insert_code": {
        const { filePath, content, anchorString, anchorLine } = args;
        const { lines, error, path: safe } = readLines(filePath);
        if (error) return { content: [{ type: "text", text: `Lỗi: ${error}` }], isError: true };
        safePath = safe;

        let insertAt = 0;
        if (anchorString) {
          const foundIndex = lines.findIndex(l => l.includes(anchorString));
          if (foundIndex === -1) return { content: [{ type: "text", text: `Lỗi: Không tìm thấy "${anchorString}"` }], isError: true };
          insertAt = foundIndex + 1;
        } else if (anchorLine !== undefined) {
          insertAt = anchorLine + 1;
        } else {
          return { content: [{ type: "text", text: "Lỗi: Cần anchorLine hoặc anchorString." }], isError: true };
        }

        lines.splice(insertAt, 0, content);
        fs.writeFileSync(safePath, lines.join('\n'), "utf-8");
        return { content: [{ type: "text", text: `Đã chèn thành công sau dòng ${insertAt - 1}.` }] };
      }

      case "execute_code": {
        const { path: targetPath } = args;
        const safe = getSafePath(targetPath);
        if (!fs.existsSync(safe)) return { content: [{ type: "text", text: "Lỗi: File không tồn tại." }], isError: true };
        
        try {
          const { stdout, stderr } = await execAsync(`node "${safe}"`);
          return { content: [{ type: "text", text: `Output:\n${stdout}${stderr ? `\nError:\n${stderr}` : ""}` }] };
        } catch (err) {
          return { content: [{ type: "text", text: `Lỗi thực thi: ${err.message}` }], isError: true };
        }
      }

      default:
        throw new Error(`Công cụ ${name} chưa được triển khai.`);
    }

    currentActiveFile = safePath;

  } catch (error) {
    return { content: [{ type: "text", text: `Hệ thống gặp lỗi: ${error.message}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);