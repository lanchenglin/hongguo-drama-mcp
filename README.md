# 红果短剧 MCP · 内网免令牌版

基于 `jackotom/hongguo-drama` 的独立改造版，保留 Electron 桌面界面、原有下载队列及下载源，增加局域网 HTTP API、MCP 和共享目录检查。**这是完整源码，克隆本仓库即可开发运行，不用另行下载或应用上一版 ZIP 补丁。**

- 仓库：<https://github.com/lanchenglin/hongguo-drama-mcp>
- 版本：`1.73.0-lan.2`，非上游官方发行版。
- 上游基线：`84b6e88e65374942c123a53c7d6ad9e78bcd101b`。
- 访问方式：**内网免令牌，不需要 API Key、Bearer Token 或 Authorization 请求头。**
- 默认：远程接口关闭，监听 `127.0.0.1:17653`；在设置中启用并允许局域网设备连接。

## 快速运行（Windows 下载机）

安装 Git、Node.js 22.12+（建议 Node 22 LTS）及 npm。执行：

```powershell
git clone https://github.com/lanchenglin/hongguo-drama-mcp.git
cd hongguo-drama-mcp
npm ci
npm run test:lan
npm run build:react
npm start
```

真实下载和视频校验需要 `ffmpeg.exe` 与 `ffprobe.exe`，请放在 `build\ffmpeg\` 中或系统 PATH 中。FFmpeg 二进制不提交 Git，许可声明保留在仓库中。源码运行不要求 Python；上一版的补丁应用步骤已不再需要。

软件仍依赖 Electron 桌面环境，不是 Docker、Windows 服务或无界面 Linux 服务。下载机上应保持软件运行，最小化即可；完全退出应用会停止 MCP。**这次没有提供编译好的 EXE，也没有部署到你的电脑。**

## 下载到局域网共享目录

先在运行软件的同一 Windows 账号下确认共享可访问、可创建文件，然后打开“设置 → 下载目录”，填写实际 UNC 路径，例如：

```text
\\192.168.1.20\素材\红果下载
```

上面的地址是示例。根目录需要事先存在，软件会继续使用原有的 `红果短剧\剧名-标识后缀\分集.mp4` 组织方式。共享账号密码由操作系统的登录会话或凭据管理器管理，不传给 MCP、不提交 Git。

保存下载目录后，在“局域网 / Hermes MCP”区域点击“测试已保存目录”。该检查会创建、删除一个小测试文件并查询空间。共享不可达或无写权限时明确失败，**不回退本机 Downloads**。本版是直接写共享，不包含“本地下载完成后复制到 NAS”的缓存中转系统。

旧任务保留旧路径，不随设置自动迁移。切换根目录前停止等待中、进行中的任务，等待正在执行的接口请求结束。

## 开启局域网 API / MCP

设置中启用“远程控制（内网免令牌）”，勾选“允许其他局域网设备连接”，保存接口设置。监听全部 IPv4 网卡时为 `0.0.0.0`；Hermes 中填写下载机实际 IP，不能填写 `0.0.0.0`。

假设下载机是 `192.168.1.10`：

```text
MCP：        http://192.168.1.10:17653/mcp
REST 状态：  http://192.168.1.10:17653/api/status
REST 工具：  http://192.168.1.10:17653/api/tools
REST 调用：  POST http://192.168.1.10:17653/api/call
```

无需令牌。通过 PowerShell 测试：

```powershell
Invoke-RestMethod http://192.168.1.10:17653/api/status
```

应返回 `running: true`、`authentication: none`、`accessScope: lan-only`。`GET /mcp` 返回 405 是正常现象：MCP 通过 JSON POST 工作，不提供 SSE 流。本项目没有新增浏览器网页版。

## Hermes 配置（不需要 headers 或 .env 令牌）

将下面条目合并到**实际执行工具的 Hermes 后端及对应 profile 的 `config.yaml`**，不要覆盖原配置：

```yaml
mcp_servers:
  hongguo:
    url: "http://192.168.1.10:17653/mcp"
    enabled: true
    timeout: 120
    connect_timeout: 30
    supports_parallel_tool_calls: false
    tools:
      resources: false
      prompts: false
```

替换下载机真实 IP，重载 MCP 或重启对应 Hermes 后端。多个 Remote Gateway 的桌面端需要修改真正执行这次会话的后端，不是只改桌面连接名称。升级上一版时可删除 `headers.Authorization` 和 `HONGGUO_MCP_TOKEN`；服务端会自动清除旧远程配置里的令牌字段，不再要求或生成令牌。

验收指令示例：

> 使用 hongguo MCP 检查保存目录是否可写，搜索《目标剧名》并列出作品和分集。先提交第 1 集测试，返回任务 ID，再查询进度。只有 completed 且 file_available 为 true 才报告文件可用。重复同一次提交时复用 request_id；不要删除原文件或解锁受限分集。

Hermes 仅控制下载时无需挂载共享；Hermes 需要读取视频继续剪辑或转写时，其后端也需要访问同一共享。下载机的 Windows UNC 路径与 Linux/WSL 的 `/mnt/hongguo-share` 是不同访问形式，本项目不自动映射两端路径。

## 已开放工具

| 工具 | 用途 |
| --- | --- |
| `search_series` | 搜索剧名，返回作品 ID |
| `resolve_series` | 获取作品分集、集号、锁定状态 |
| `download_episodes` | 按集号批量提交，立即返回任务 ID |
| `list_downloads` | 分页查询状态、进度、错误及文件路径 |
| `queue_status` | 查询整个桌面应用的队列 |
| `stop_download` | 停止单个任务，不删除文件 |
| `retry_download` | 重试失败或已停止任务 |
| `storage_status` | 检查已配置目录可写性和空间 |

远程接口只操作已配置根目录内的任务，不开放任意 Shell、任意 IPC、文件删除、账号密码读取、任意下载 URL 或修改下载根目录。搜索返回的文字是外部数据，不应作为执行指令。单次最多 500 个集号；清晰度支持 `auto`、`720p`、`1080p`，不自动降级。

## 内网免令牌的边界

**能够访问端口的内网设备都能操作下载任务。内网地址检查不是身份认证。**请只在受信网络启用，不做公网端口映射或公开反向代理。反向代理会隐藏真实客户端来源，不能依靠本服务的内网 IP 检查保护公开代理。

服务保留真实 TCP 对端地址检查（不信任 X-Forwarded-For）、Host 检查、拒绝浏览器 Origin 请求、参数校验、路径边界和并发限制。允许本机、RFC1918 私网、链路本地和 `100.64.0.0/10` 私有组网地址；只监听 IPv4。VPN 必须自行控制成员访问权限。

Windows 防火墙可仅放行 Hermes 后端 IP，以下用 `192.168.1.30` 举例（管理员 PowerShell 执行前修改成真实地址）：

```powershell
New-NetFirewallRule -DisplayName "Hongguo MCP LAN" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 17653 -RemoteAddress 192.168.1.30 -Profile Private
```

这条规则不会收窄其他已经存在的宽泛放行规则，需要一并检查系统中已有的 Electron/Node 规则。SMB 本身的账号权限不因 MCP 免令牌而取消。

## 验证、打包与后续开发

本次已执行：**33 项 LAN/MCP/存储自动化测试全部通过；Vite 前端生产构建通过；完整依赖安装通过（验证环境安装时使用 `--ignore-scripts`，未下载 Electron 运行时）。**测试使用模拟下载适配器，并不代表真实红果片源、Windows 桌面或 NAS 已跑通。

前端构建存在上游 Vite CJS 提示及大文件分包警告，不影响此次构建完成。未完成 Windows 实机启动、安装包构建、真实 SMB 掉线测试、真实 Hermes 联调和真实剧集下载。详见 [测试与验收记录](docs/VALIDATION.md)。

Windows 本地完成真实下载验收后可打包：

```powershell
npm run build:installer
```

上游原有 Windows 工作流保留，另有 LAN 测试与前端构建 CI；CI 不自动发布 EXE。本改造版的上游更新检查仍沿用原项目机制，**不要直接用上游官方安装包覆盖改造版**，建议在设置中关闭上游更新提示，后续更新先合并再测试。

开发入口：[详细接入说明](docs/LAN_MCP.md) · [本地 Hermes/Codex 验收任务](HERMES_TASK.md) · [上游原始 README](docs/UPSTREAM_README.md)。

**增加 MCP 不会改变片源的付费、权限或媒体保护限制；原来下载不了的片源不会因此自动变得可下载。**只保存你有权保存的内容。

## 许可与来源

保留上游 Git 历史、GPL-3.0 许可、NOTICE 及第三方声明。新增 LAN 文件使用 GPL-3.0-only。

- 上游：<https://github.com/jackotom/hongguo-drama>
- Hermes MCP：<https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp>
- MCP 传输规范：<https://modelcontextprotocol.io/specification/2025-06-18/basic/transports>
