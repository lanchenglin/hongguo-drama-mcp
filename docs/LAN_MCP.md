# LAN / MCP 接入与维护说明

版本：1.73.0-lan.2。完整安装步骤见仓库根目录 README。本版本所有接口内网免令牌；不要沿用旧补丁中要求 Bearer Token 的部署步骤。

## 配置与迁移

远程配置单独保存在 Electron userData 目录的 `remote-control.json`，不是放在源码目录中。默认结构：

```json
{
  "enabled": false,
  "host": "127.0.0.1",
  "port": 17653,
  "allowedHosts": [],
  "requireNetworkMount": false
}
```

设置页可启用、指定监听 IPv4/端口、切换局域网监听和测试共享。`allowedHosts` 仅是额外 Host 名称的白名单，不是客户端 IP 授权列表；通常无需配置。配置文件不可读取或损坏会报错，不应删除用户配置来假装恢复。

从 lan.1 升级时只保留已知设置，自动清除旧 token 等无关字段并持久化。不会生成新令牌，不会因旧请求携带 Authorization 而拒绝合法内网请求。只移除 MCP 认证；SMB 凭据仍由操作系统管理。

## 网络与客户端

接口为 Streamable HTTP（JSON POST，无 SSE/会话状态），MCP 路径 `/mcp`。支持协议版本 `2025-03-26`、`2025-06-18`，初始化时协商。客户端 Accept 必须包含 `application/json, text/event-stream`，请求 Content-Type 为 application/json。

`GET /mcp` 为 405；`notifications/initialized` 为 202；工具错误使用 `isError: true`，不应当作成功。普通 JSON API：GET `/api/status`、GET `/api/tools`、POST `/api/call`。调用示例：

```json
{
  "name": "download_episodes",
  "arguments": {
    "series_id": "从搜索结果获取的真实数字ID",
    "episode_numbers": [1, 2],
    "quality": "auto",
    "request_id": "my-first-batch-001"
  }
}
```

真实数字 ID 使用 JSON 字符串避免精度丢失。除红果数字 ID 外，支持原适配器提供的 hema/xifan ID；不接受任意 URL 或自定义来源地址。提交 ID、任务 ID、下载完成是不同概念。下载提交不等待视频完成；通过 list_downloads 轮询。

### 按任务查询（BHSP 等客户端）

`GET /api/tools` 或 MCP `tools/list` 可读取当前运行进程的工具 schema。仍然只有原来的 8 个工具；`list_downloads` 新增可选字符串 `task_id`，不改变省略该字段的调用。

普通 JSON API 使用 `POST /api/call`（`Content-Type: application/json`）：

```json
{
  "name": "list_downloads",
  "arguments": {
    "task_id": "从提交结果 tasks[].id 获取的任务ID",
    "offset": 0,
    "limit": 1
  }
}
```

MCP 使用 `tools/call`，其 `params` 就是上面的对象；检查 `result.isError` 后解析 `result.content[0].text` 中的 JSON。

- `task_id` 是不透明标识符，按原值、区分大小写精确匹配，不做截断、去空格或路径解析。不能用文件路径替代任务 ID，也不支持指定任意读取路径；不匹配的路径字符串只会得到空结果。
- 可与 `series_id` 一起传入，两个条件取交集。未知 ID、系列不匹配或当前保存根目录之外的任务返回 `total: 0, tasks: [], next_offset: null`，不是查询错误。
- `offset` 默认 0，`limit` 默认 50、最大 100；`total` 和 `next_offset` 均基于过滤后的列表。偏移超过匹配列表时返回空 `tasks`，但 `total` 仍是匹配总数。
- 查询不会提交、停止或重试下载。已完成记录仍核验文件和目录边界：只有普通文件且大小大于 100 KiB 才标记 `file_available: true`；文件缺失、异常或符号链接越界时返回 `status: file_unavailable`，保留 `recorded_status: completed`，不改写任务记录。
- 搜索、解析及任务输出中存在的 `series_id` 使用字符串；19 位数字 ID 必须从源头保留字符串，不经 `Number` 转换。历史任务缺少系列元数据时仍可省略或返回 null；若上游已经将长 ID 转成浮点数，本接口无法恢复丢失的精度。

**源码更新不会热加载到正在运行的 Electron 主进程。**需要由维护者在安全时机重启软件，才能加载新的筛选逻辑和 schema；重启前通过 `/api/tools` 确认旧进程能力，不要直接发送不受支持的字段。兼容旧进程的客户端可继续按 `series_id` 分页列出，再在客户端按 `tasks[].id` 精确匹配。本次接口修改和测试不要求立即重启或执行真实下载。

同一 request_id 相同参数复用结果，不同参数拒绝；最多保留 500 条成功记录，保存到独立 `.requests.json`。这不是跨所有崩溃场景的永久 exactly-once 保证，结果不确定时先查队列。锁定或缺失分集导致整批拒绝，应明确选择可用集号，不隐式跳过。

## 内网免认证安全约束

不识别用户身份：能访问端口的私网设备均可控制下载。只允许真实 TCP 对端为 IPv4 本机、RFC1918、链路本地或 RFC6598 私有组网地址，拒绝公网地址；不信任 X-Forwarded-For。绑定地址也不能填写公网 IP。默认不启用监听全部网卡，用户在界面主动开启。

保留 Host 校验；拒绝一切包含 Origin 的浏览器请求，不开放 CORS。额外主机名不改变 Origin 或来源 IP 限制。不开放 Shell、任意 IPC、文件删除、原始媒体地址、凭据或远程设置根目录。请求体最多 64KiB，活动工具调用最多 8 个，TCP 连接最多 32 个。

**不要通过公网代理暴露此服务。**代理会使 TCP 对端表现为本机或内网，从而失去对原始公网来源的判断；HTTPS 只加密连接，不会给免令牌接口增加身份认证。使用 VPN 时管理好 VPN 成员。用防火墙限制真实 Hermes 后端 IP，并检查已有的更宽泛允许规则。

## 共享目录语义

根目录必须事先存在、可写。只创建剧集子目录，不在共享失联时另建一个根目录或回退 Downloads。每批提交前及每集开始前检查存储；MCP 查询历史完成任务时再次检查文件，失联返回 `file_unavailable`，保留 `recorded_status: completed`。

停止任务不要求共享在线；重试和提交则需要存储可用。直接写共享，不提供本地缓存中转，不承诺断点按字节续传；SMB 文件系统调用的等待时间由操作系统决定。软件原有下载失败重试策略仍生效。

本机和共享目录都可使用。Windows 优先 UNC；Linux/WSL 下载进程需要先挂载共享，再填本机路径。`requireNetworkMount` 只用于 Linux 上检查 CIFS/SMB/NFS 挂载，避免卸载后误写普通目录；这不等于提供 Linux 无界面版。

根目录切换不会迁移旧文件/旧任务。有等待中或进行中的下载、活动远程调用时拒绝切换。远程列出和操作仅覆盖当前根目录，不操作其他根目录任务。路径检查防止目录穿越和符号链接越界，但操作系统管理员在检查后更换目录仍属于本机权限边界，不应共享给不受信用户修改目录结构。

## 开发入口

- `src/native/remote-control.cjs`：配置迁移、无认证内网限制、HTTP/MCP、8 个工具、幂等记录。
- `src/native/remote-storage.cjs`：目录写入测试、挂载与路径检查。
- `src/components/RemoteControlSettings.jsx`：桌面远程设置；没有令牌输入或轮换按钮。
- `main.js`：注册白名单业务 handler，复用原始下载队列，生命周期启动/关闭。
- `preload.js`：仅为本地窗口提供远程设置 IPC。
- `tests/remote-control.test.cjs`：41 个测试；媒体业务使用模拟适配器，覆盖精确任务筛选、分页、系列 ID 字符串和完成文件核验，不触发真实下载。

修改后运行 `npm run test:lan`、`npm run build:react`。不应把依赖、视频、userData、SMB 凭据、密钥或 `.lan-mcp-backup` 提交到仓库。源码许可与原有媒体限制保持不变。

## 仍未实现

远程合并、事件推送、本地缓存到共享的发布流程、多存储切换、开机启动和无界面服务。新增接口不提供付费分集解锁或媒体保护绕过。Windows 和 NAS/Hermes 的真实验收见 HERMES_TASK.md。
