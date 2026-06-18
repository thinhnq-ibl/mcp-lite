import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import fs from "fs";
import path from "path";
import readline from "readline";
import { promisify } from "util";
import { exec } from "child_process";
const execAsync = promisify(exec);

class FileSystemManager {
  getSafePath(filePath) {
    return path.resolve(filePath);
  }

  async createDirectory(dirPath) {
    try {
      const safePath = this.getSafePath(dirPath);
      if (fs.existsSync(safePath)) return { success: false, error: "Thư mục đã tồn tại." };
      fs.mkdirSync(safePath, { recursive: true });
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async createFile(filePath, content = "") {
    try {
      const safePath = this.getSafePath(filePath);
      const dir = path.dirname(safePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(safePath, content, "utf-8");
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async deleteLines(filePath, startLine, endLine) {
    try {
      const safePath = path.resolve(filePath);
      if (!fs.existsSync(safePath)) return { success: false, error: "File không tồn tại." };

      const content = fs.readFileSync(safePath, "utf-8");
      const lines = content.split('\n');

      // Kiểm tra tính hợp lệ của phạm vi dòng
      if (startLine < 0 || endLine >= lines.length || startLine > endLine) {
        return { success: false, error: `Phạm vi dòng không hợp lệ (File có ${lines.length} dòng).` };
      }

      // Xóa các dòng từ startLine đến endLine (tính từ 0)
      lines.splice(startLine, endLine - startLine + 1);

      fs.writeFileSync(safePath, lines.join('\n'), "utf-8");
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }
}

const server = new Server(
  { name: "coder-agent-tools", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

const getSafePath = (filePath) => path.resolve(filePath);

const readLines = (filePath) => {
  const safePath = getSafePath(filePath);
  if (!fs.existsSync(safePath)) return { error: "File không tồn tại.", path: safePath };
  const rawContent = fs.readFileSync(safePath, "utf-8");
  // Chuẩn hóa sang LF để xử lý nội bộ đồng nhất, sau đó có thể join lại theo nhu cầu
  const content = rawContent.replace(/\r\n/g, "\n");
  return { lines: content.split('\n'), content, path: safePath };
};

const findFunctionBounds = (lines, functionName) => {
  // Đảm bảo lines không có \r
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
        "name": "read_all_tools",
        "description": "Liệt kê tất cả các công cụ hiện có trong hệ thống. Điều kiện: Không cần tham số đầu vào.",
        "inputSchema": {
          "type": "object",
          "properties": {}
        }
      },
      {
        name: "delete_lines",
        description: "Xóa một phạm vi dòng. Điều kiện: Cần path và phạm vi dòng (tính từ 1). Hãy dùng read_file_with_numbers trước để xác định chính xác số dòng cần xóa.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Đường dẫn file." },
            startLine: { type: "number", description: "Dòng bắt đầu xóa (1-indexed)." },
            endLine: { type: "number", description: "Dòng kết thúc xóa (1-indexed)." }
          },
          required: ["path", "startLine", "endLine"]
        }
      },
      {
        name: "create_dir",
        description: "Tạo một thư mục mới. Điều kiện: Cần đường dẫn thư mục chưa tồn tại. Hỗ trợ tạo thư mục lồng nhau (recursive).",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Đường dẫn của thư mục cần tạo." }
          },
          required: ["path"]
        }
      },
      {
        name: "create_file",
        description: "Tạo một file mới với nội dung tùy chọn. Điều kiện: Cần đường dẫn file. Nếu thư mục cha chưa tồn tại, nó sẽ tự động tạo.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Đường dẫn file cần tạo." },
            content: { type: "string", description: "Nội dung khởi tạo cho file (mặc định để trống)." }
          },
          required: ["path"]
        }
      },
      {
        name: "run_script",
        description: "Chạy một file script Node.js hoặc lệnh shell. Điều kiện: Cần lệnh hợp lệ với môi trường thực thi (bash/powershell).",
        inputSchema: {
          type: "object",
          properties: {
            command: { type: "string", description: "Lệnh shell cần chạy (ví dụ: 'npm test' hoặc 'node app.js')." }
          },
          required: ["command"]
        }
      },
      {
        name: "rename_file",
        description: "Đổi tên hoặc di chuyển file. Điều kiện: File nguồn (oldPath) phải tồn tại. Đường dẫn mới (newPath) phải hợp lệ.",
        inputSchema: {
          type: "object",
          properties: {
            oldPath: { type: "string", description: "Đường dẫn file hiện tại cần đổi tên/di chuyển." },
            newPath: { type: "string", description: "Đường dẫn đích hoặc tên thư mục/file mới." }
          },
          required: ["oldPath", "newPath"]
        }
      },
      {
        name: "get_workspace_state",
        description: "Kiểm tra file hiện tại đang được Agent tập trung xử lý. Điều kiện: Không cần tham số. Giúp xác định bối cảnh làm việc hiện tại.",
        inputSchema: { type: "object", properties: {} }
      },
      {
        name: "get_function_context",
        description: "Trích xuất nội dung của một hàm cụ thể. Điều kiện: Cần đường dẫn file và tên hàm chính xác. Phụ thuộc vào định dạng code để nhận diện cặp ngoặc.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Đường dẫn đến file chứa hàm." },
            functionName: { type: "string", description: "Tên hàm cần trích xuất code." },
            withLineNumbers: { type: "boolean", description: "Hiển thị kèm số dòng để dễ định vị (mặc định false)." }
          },
          required: ["path", "functionName"]
        }
      },
      {
        name: "replace_code_block",
        description: "Thay thế một khối code cũ bằng code mới. Điều kiện: Cần file, đoạn code cũ (phải khớp chính xác từng dấu cách) và đoạn code mới. KHÔNG bao gồm các dòng context (dòng xung quanh) vào tham số newBlock trừ khi bạn muốn thay đổi cả chúng.",
        inputSchema: {
          type: "object",
          properties: {
            filePath: { type: "string", description: "Đường dẫn file cần sửa." },
            oldBlock: { type: "string", description: "Đoạn code cũ cần tìm để thay thế. Phải khớp chính xác 100%." },
            newBlock: { type: "string", description: "Đoạn mã nguồn mới sẽ thay thế cho oldBlock." }
          },
          required: ["filePath", "oldBlock", "newBlock"]
        }
      },
      {
        name: "read_file_with_numbers",
        description: "Đọc file kèm theo số dòng. Điều kiện: Cần đường dẫn file. Rất hữu ích khi cần xác định dòng cụ thể để xóa hoặc chèn code. Dùng để lấy code chính xác (bao gồm cả khoảng trắng) trước khi dùng replace_code_block.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Đường dẫn file cần đọc." },
            startLine: { type: "number", description: "Dòng bắt đầu đọc (mặc định 0)." },
            endLine: { type: "number", description: "Dòng kết thúc đọc (mặc định 100)." }
          },
          required: ["path"]
        }
      },
      {
        name: "search_and_read",
        description: "Tìm kiếm chuỗi code trong toàn bộ dự án. Điều kiện: Cần từ khóa query. Trả về vị trí và context xung quanh (mặc định 10 dòng).",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Chuỗi code hoặc từ khóa cần tìm kiếm." },
            contextLines: { type: "number", description: "Số dòng mã nguồn hiển thị xung quanh kết quả tìm thấy." }
          },
          required: ["query"]
        }
      },
      {
        name: "read_file_smart",
        description: "Đọc nội dung file thông minh (tự động cắt nếu quá dài). Điều kiện: Cần đường dẫn file. Ưu tiên dùng khi chưa biết độ dài file.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Đường dẫn file cần đọc nội dung." }
          },
          required: ["path"]
        }
      },
      {
        name: "get_file_info",
        description: "Lấy metadata của file. Điều kiện: Cần đường dẫn file. Trả về thông số: size, lineCount, lastModified.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Đường dẫn đến file cần kiểm tra thông tin." }
          },
          required: ["path"]
        }
      },
      {
        name: "file_system_operations",
        description: "Quản lý file hệ thống: đọc, ghi, hoặc liệt kê file. Điều kiện: Cần action ('read', 'write', 'list') và path. 'write' yêu cầu có content.",
        inputSchema: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["read", "write", "list"], description: "Hành động: đọc file, ghi đè/tạo mới, hoặc liệt kê thư mục." },
            path: { type: "string", description: "Đường dẫn file hoặc thư mục." },
            content: { type: "string", description: "Nội dung cần ghi (chỉ dùng khi action='write')." }
          },
          required: ["action", "path"]
        }
      },
      {
        name: "insert_code",
        description: "Chèn mã mới vào vị trí cụ thể. Điều kiện: Cần filePath, content và anchor. LƯU Ý: Chỉ gửi duy nhất đoạn mã cần chèn vào tham số content, KHÔNG bao gồm các dòng mã có sẵn (context) để tránh trùng lặp.",
        inputSchema: {
          type: "object",
          properties: {
            filePath: { type: "string", description: "File cần chèn mã." },
            content: { type: "string", description: "Đoạn mã mới cần chèn." },
            anchorLine: { type: "number", description: "Chèn vào sau dòng này." },
            anchorString: { type: "string", description: "Tìm dòng có chuỗi này và chèn vào phía sau nó." }
          },
          required: ["filePath", "content"]
        }
      },
      {
        name: "apply_patch",
        description: "Sửa file bằng cách thay thế đoạn nội dung cũ bằng mới. Điều kiện: Cần path, oldContent và newContent. Thích hợp cho file dung lượng lớn.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Đường dẫn file cần áp dụng patch." },
            oldContent: { type: "string", description: "Nội dung cũ cần được thay thế." },
            newContent: { type: "string", description: "Nội dung mới sẽ thay thế cho nội dung cũ." }
          },
          required: ["path", "oldContent", "newContent"]
        }
      },
      {
        name: "smart_search",
        description: "Tìm kiếm mã nguồn nhanh. Điều kiện: Cần query (từ khóa). Trả về tên file và số dòng tương ứng.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Từ khóa hoặc đoạn code cần tìm kiếm." }
          },
          required: ["query"]
        }
      },
      {
        name: "execute_code",
        description: "Thực thi file JavaScript ngay lập tức để kiểm tra logic. Điều kiện: Cần đường dẫn file JS hợp lệ.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Đường dẫn file .js cần chạy." }
          },
          required: ["path"]
        }
      },
      {
        name: "read_lines",
        description: "Đọc một phạm vi dòng cụ thể. Điều kiện: Cần path, startLine và endLine. Giúp tối ưu hóa token khi làm việc với file lớn.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Đường dẫn file." },
            startLine: { type: "number", description: "Dòng bắt đầu đọc (0-indexed)." },
            endLine: { type: "number", description: "Dòng kết thúc đọc." }
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
      case "read_all_tools": {
        // Lấy danh sách tool từ schema đã định nghĩa ở trên
        // Cách đơn giản nhất là format lại danh sách công cụ hiện có
        const toolList = [
          "delete_lines", "create_dir", "create_file", "run_script", 
          "rename_file", "get_workspace_state", "get_function_context",
          "replace_code_block", "read_file_with_numbers", "search_and_read",
          "read_file_smart", "get_file_info", "file_system_operations",
          "insert_code", "apply_patch", "smart_search", "execute_code", "read_lines"
        ];
        
        return { 
          content: [{ 
            type: "text", 
            text: `Các công cụ hiện có trong hệ thống:\n- ${toolList.join('\n- ')}` 
          }] 
        };
      }
      
      case "delete_lines": {
        const { path: filePath, startLine, endLine } = args;
        const fsManager = new FileSystemManager();
        // Cập nhật FileSystemManager hoặc dùng readLines ở đây để đồng nhất
        const { lines, error, path: safe } = readLines(filePath);
        if (error) return { content: [{ type: "text", text: `Lỗi: ${error}` }], isError: true };
        safePath = safe;

        if (startLine < 1 || endLine > lines.length || startLine > endLine) {
          return { content: [{ type: "text", text: `Lỗi: Phạm vi dòng không hợp lệ (File có ${lines.length} dòng). Lưu ý: Dòng tính từ 1.` }], isError: true };
        }

        lines.splice(startLine - 1, endLine - startLine + 1);
        fs.writeFileSync(safePath, lines.join('\n'), "utf-8");
        
        return { content: [{ type: "text", text: `Đã xóa thành công các dòng từ ${startLine} đến ${endLine} trong ${filePath}` }] };
      }
      case "create_dir": {
        const { path: dirPath } = args;
        const manager = new FileSystemManager();
        const result = await manager.createDirectory(dirPath);

        if (!result.success) {
          return { content: [{ type: "text", text: `Lỗi: ${result.error}` }], isError: true };
        }
        return { content: [{ type: "text", text: `Đã tạo thư mục thành công tại: ${dirPath}` }] };
      }
      case "create_file": {
        const { path: filePath, content = "" } = args;
        const manager = new FileSystemManager();
        const result = await manager.createFile(filePath, content);

        if (!result.success) {
          return { content: [{ type: "text", text: `Lỗi: ${result.error}` }], isError: true };
        }
        safePath = getSafePath(filePath);
        return { content: [{ type: "text", text: `Đã tạo file thành công tại: ${filePath}` }] };
      }

      case "run_script": {
        const { command } = args;
        try {
          const { stdout, stderr } = await execAsync(command, { cwd: process.cwd() });
          return { content: [{ type: "text", text: `Output:\n${stdout}${stderr ? `\nError:\n${stderr}` : ""}` }] };
        } catch (err) {
          return { content: [{ type: "text", text: `Lỗi thực thi: ${err.message}` }], isError: true };
        }
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
          safePath = newSafePath;
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

        // Tối ưu hóa việc tìm kiếm bằng cách trim khoảng trắng nhưng vẫn giữ cấu trúc
        const normalizedContent = content.replace(/\r\n/g, "\n");
        const normalizedOld = oldBlock.replace(/\r\n/g, "\n");

        if (!normalizedContent.includes(normalizedOld)) {
          return {
            content: [{ 
              type: "text", 
              text: "Lỗi: Không tìm thấy khối code cần thay thế. Hãy đảm bảo bạn không bao gồm các dòng context không cần thiết hoặc kiểm tra kỹ khoảng trắng/thụt lề." 
            }],
            isError: true
          };
        }

        const newContent = normalizedContent.replace(normalizedOld, newBlock.replace(/\r\n/g, "\n"));
        fs.writeFileSync(safePath, newContent, "utf-8");
        return { content: [{ type: "text", text: "Thay thế khối code thành công. Đã loại bỏ các lỗi do sai lệch xuống dòng (CRLF/LF)." }] };
      }

      case "read_file_with_numbers": {
        const { path: targetPath, startLine = 0, endLine = 100 } = args;
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
        // Sử dụng giải pháp tìm kiếm đơn giản hơn hoặc thông báo nếu không hỗ trợ grep
        const isWindows = process.platform === "win32";
        const cmd = isWindows 
          ? `findstr /s /n /i /c:"${query}" *`
          : `grep -rnC ${contextLines} "${query}" . --exclude-dir=node_modules | head -n 50`;

        try {
          const { stdout } = await execAsync(cmd);
          if (!stdout) return { content: [{ type: "text", text: "Không tìm thấy kết quả phù hợp." }] };
          return { content: [{ type: "text", text: stdout }] };
        } catch (err) {
          return { content: [{ type: "text", text: "Lỗi khi tìm kiếm hoặc không tìm thấy kết quả." }], isError: true };
        }
      }

      case "read_file_smart": {
        const { lines, content, error, path: safe } = readLines(args.path);
        if (error) return { content: [{ type: "text", text: `Lỗi: ${error}` }], isError: true };
        safePath = safe;
        const totalLines = lines.length;

        if (totalLines > 100) {
          const preview = lines.slice(0, 50).join('\n');
          return {
            content: [{
              type: "text",
              text: `File quá dài (${totalLines} dòng). 50 dòng đầu:\n\n${preview}\n\n[Hệ thống]: File còn ${totalLines - 50} dòng. Dùng 'read_lines' để đọc thêm.`
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
            const { content: fileContent, error, path: safeReadPath } = readLines(targetPath);
            if (error) return { content: [{ type: "text", text: `Lỗi: ${error}` }], isError: true };
            safePath = safeReadPath;
            return { content: [{ type: "text", text: fileContent }] };

          case "write":
            const safeWritePath = getSafePath(targetPath);
            fs.writeFileSync(safeWritePath, content || "", "utf-8");
            safePath = safeWritePath;
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
          const isWindows = process.platform === "win32";
          const cmd = isWindows 
            ? `findstr /s /n /i /c:"${args.query}" *`
            : `grep -rnI "${args.query}" . --exclude-dir=node_modules`;
          const { stdout } = await execAsync(cmd);
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
          if (foundIndex === -1) return { content: [{ type: "text", text: `Lỗi: Không tìm thấy mốc "${anchorString}"` }], isError: true };
          insertAt = foundIndex + 1;
        } else if (anchorLine !== undefined) {
          insertAt = anchorLine; // anchorLine thường là 1-based từ AI, chuyển sang 0-based index nếu cần. 
          // Tuy nhiên, logic cũ là chèn SAU dòng đó. Giữ nguyên logic cũ nhưng chuẩn hóa:
          insertAt = Math.min(Math.max(0, anchorLine), lines.length);
        } else {
          return { content: [{ type: "text", text: "Lỗi: Cần anchorLine hoặc anchorString." }], isError: true };
        }

        // Loại bỏ context thừa nếu Agent vô tình gửi vào content (ví dụ: lặp lại dòng anchor)
        let cleanContent = content.replace(/\r\n/g, "\n");
        
        lines.splice(insertAt, 0, cleanContent);
        fs.writeFileSync(safePath, lines.join('\n'), "utf-8");
        return { content: [{ type: "text", text: `Đã chèn mã thành công tại vị trí dòng ${insertAt}.` }] };
      }

      case "execute_code": {
        const { path: targetPath } = args;
        const safe = getSafePath(targetPath);
        if (!fs.existsSync(safe)) return { content: [{ type: "text", text: "Lỗi: File không tồn tại." }], isError: true };
        safePath = safe;

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