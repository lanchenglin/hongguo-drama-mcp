# 本地 Hermes / Codex 运行与验收任务

目标仓库：https://github.com/lanchenglin/hongguo-drama-mcp.git
版本：1.73.0-lan.2，已整合完整源码。不要再应用旧 ZIP 补丁。

## 已有能力

桌面下载器 + 内网免令牌 HTTP/MCP + 共享目录检查。保留原队列；没有远程 Shell、任意 IPC 或文件删除。本次服务器端测试 33/33 通过，Vite 生产构建通过。没有在用户的 Windows、NAS 或 Hermes 实机中验收。

## 执行步骤

1. 读取 README.md、docs/LAN_MCP.md、docs/VALIDATION.md。检查本地项目已有改动，不能直接覆盖。克隆本仓库到独立目录后执行 npm ci、npm run test:lan、npm run build:react。
2. 在下载机 Windows 中运行 Electron（npm start），准备 ffmpeg.exe 和 ffprobe.exe。不得因程序打不开就关闭操作系统安全功能；先报告具体错误。
3. 查明真实下载机 IP、Hermes 实际运行后端和用户授权的共享目录，不把示例 IP 当成真实地址。共享凭据通过操作系统管理，不放入项目、MCP、日志或 Git。
4. 以运行软件的同一账号测试 UNC 目录，保存下载根目录，测试已保存目录。启用内网免令牌接口，按需允许局域网。不要配置访问令牌，不要新增公网映射。
5. 先请求 /api/status，验证 running=true、authentication=none。将 README 中不带 headers 的 mcp_servers.hongguo 配置合并到真正执行会话的 Hermes 后端/profile，再重载 MCP。
6. 依次验收工具发现、storage_status、search_series、resolve_series。作品名称需与用户目标匹配；选择用户有权保存的开放分集，先下载一集，记录 request_id、任务 ID、成功或失败原因。
7. 只有 completed 且 file_available=true 才报告文件可用；用 ffprobe 检查真实输出。然后测试同一 request_id 重复提交不重复排队、停止/重试、应用重启后记录保持。
8. 在没有其他用户业务的测试共享上模拟断线；确认报告错误、不会回退本机目录，恢复后重试。不要断开整台电脑或生产 NAS 来做测试。
9. 验收完成后才执行 npm run build:installer；记录 Node/Windows/Hermes 版本、真实测试项目、未通过项，不能把模拟测试说成真实下载成功。

## 约束

不要新增 DRM 绕过或付费分集解锁；原来源失败应如实报告。不要删除用户文件，不要改共享权限或防火墙全局策略。免令牌只针对 API/MCP；SMB 账户认证保持。最小化可继续运行，退出应用会停止接口；不要声称已经做成后台系统服务。

后续功能需单独开发：远程合并、事件推送、本地中转缓存、多存储目标、无界面服务。保留上游历史和 GPL/NOTICE 声明。
