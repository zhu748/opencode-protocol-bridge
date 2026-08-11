# OpenCode Protocol Bridge

一个自托管的 OpenCode Zen / Go 协议中转服务。客户端可使用 Claude Messages、OpenAI Responses、Chat Completions 或 Google Gemini GenerateContent 协议；服务会按模型选择 OpenCode 官方端点，并转换请求与响应格式。

## 功能

- `POST /zen/v1/messages|responses|chat/completions`：强制转发到 OpenCode Zen 的 Claude / Responses / Chat 原生端点
- `POST /go/v1/messages|responses|chat/completions`：强制转发到 OpenCode Go
- `POST /v1/messages|responses|chat/completions`：兼容入口，按模型路由选择上游
- `POST /zen/v1/responses/compact`、`/go/v1/responses/compact`、`/v1/responses/compact`：仅向实现该扩展的原生 Responses 上游透传 OpenAI 上下文压缩请求
- `POST /zen/v1/messages/count_tokens`、`/go/v1/messages/count_tokens`、`/v1/messages/count_tokens`：为 Claude Code `/compact` 等流程提供本地保守 token 估算
- `POST /v1beta/models/{model}:generateContent|streamGenerateContent`：Google Gemini 兼容入口；也支持 `/v1`、`/zen/v1`、`/zen/v1beta`、`/go/v1` 与 `/go/v1beta` 前缀，其中 Zen 的 Gemini 模型会直达 OpenCode 原生 GenerateContent 端点
- OpenCode Zen / Go 密钥和模型路由
- 每个 Zen / Go Key 可独立配置 HTTP、HTTPS、SOCKS4、SOCKS4a、SOCKS5、SOCKS5h、Clash/mihomo mixed-port，或由 sing-box 托管的 hy2 / TUIC / VLESS / VMess / Trojan / Shadowsocks / Hysteria 分享链接
- 工具调用、工具结果、并行工具开关、文本消息、图片精度字段，以及 Claude Documents 与 Responses 文件块转换；Codex Responses `namespace` 工具可跨协议桥接到 Chat/Claude；Claude Code 的 typed `web_search_YYYYMMDD` 和内置客户端 `WebSearch` 可在 Chat 路由通过本地 Exa/Parallel MCP 工具循环执行
- Claude thinking、Responses reasoning 摘要与 Chat reasoning_content 转换
- Claude thinking/output effort、Gemini thinkingConfig 与 OpenAI reasoning 的模型感知映射
- Claude `speed: standard|fast` 与 OpenAI/OpenCode `service_tier: default|fast` 双向映射；其它容量层明确拒绝，不冒充速度配置
- Claude 新版 `compaction` 内容块支持非流式与流式转换：摘要可见传递，桥接生成的加密压缩状态可在客户端续轮后逐字恢复
- DeepSeek / Kimi / Moonshot 工具历史 reasoning_content 兼容
- o1/o3/o4 Chat 参数、兼容代理 cache_control 与缓存 token 统计
- refusal 独立内容块及流式增量、旧版 function_call、Responses `cache_write_tokens` 及其它 usage 字段别名与 Chat 分段内容兼容
- 同协议安全透传 `anthropic-version`、`anthropic-beta` 与 `openai-beta` 功能协商头；Claude Beta SDK 的 `/messages?beta=true` 路由标记仅在 Claude → Claude 时重建，跨协议时不会污染 Chat/Responses 上游
- Claude system 提示词精确删除/替换规则与进程内最近请求对比
- 流式事件乱序缓冲、done 内容兜底、Read 参数清理与稳定 JSON 序列化
- 非流式上游响应、错误正文和模型列表均有独立体积上限；模型发现成功响应会校验 `data` 数组、模型数量和 ID；模型发现与推理错误统一转换为目标协议兼容的安全 JSON，只保留受限的消息、类型和错误码，不会把上游 HTML、调试字段、代理错误页或回显凭据直接透传；损坏 JSON 会返回稳定的本地错误并写入元数据日志
- 无代理直连复用连接池并自动择优 IPv4/IPv6，避免高延迟网络被默认 10 秒建连上限过早中断
- 同协议非流式成功 JSON 在体积、UTF-8、复杂度和协议结构校验后复用原始字节，避免二次序列化并保留厂商扩展；同协议 SSE 成功事件实时保留原文，错误过滤、结构限制与用量观察共享同一次增量解析，错误事件经过安全规范化；跨协议 SSE 逐事件实时转换，响应禁止缓存、中间代理内容变换和 Nginx 响应缓冲
- `GET /v1/models` 模型发现端点
- 相同配置与 provider 的并发模型发现只访问一次上游；每个客户端独立等待和取消，仅在全部等待者断开时关闭共享请求，完成后立即释放而不缓存可能过期的模型目录
- 可直接导入的 `/openapi.json` OpenAPI 3.1 描述
- 带首次初始化、密码登录和访问令牌的管理面板
- 管理面板静态资源流式传输，支持 HEAD、ETag 条件缓存并阻止目录外符号链接
- 管理面板按数据源独立刷新，单个日志、状态、统计或提示词接口失败时保留旧数据并持续显示降级告警；并发刷新只提交最新结果并主动取消旧请求，配置保存使用修订号阻止跨页面覆盖，并保护尚未保存的表单草稿
- 可单独停用、撤销和限制并发的命名客户端令牌
- 管理端变更请求具有独立并发上限；设置、Key 池、命名客户端、主令牌和密码等持久化变更均使用配置修订号防止多页面覆盖
- 管理面板的上游模型发现具有独立并发上限并在运行状态中可观测，避免多标签页同时刷新占满连接
- HTTP 层限制总连接数、请求头体积/数量和单连接复用次数，并以 1 秒粒度检查慢头部与慢请求；已建立的 SSE 长响应不设置总时长上限，但会回收长期没有任何上游数据的停滞连接
- 流式推理、超过 64 KiB 的 JSON、远程图片附件和静态文件响应均遵守下游背压；客户端持续停止读取时会在可配置超时后断开并释放上游连接、文件读取租约和并发槽，不会惩罚对应 Key
- 仅记录请求元数据的日志
- 可选的有界请求日志持久化

OpenCode 当前官方端点见 [Zen 文档](https://opencode.ai/docs/zen) 和 [Go 文档](https://opencode.ai/docs/go)。本项目默认使用：

- Zen：`https://opencode.ai/zen/v1`
- Go：`https://opencode.ai/zen/go/v1`

## 快速启动

要求仍受支持的 Node.js 22.20+ 或 24.11+；仓库使用 `.node-version` 固定 Render 和本地默认版本为 Node.js 24.18.1。

```powershell
npm ci --ignore-scripts
npm start
```

浏览器打开 `http://127.0.0.1:8787`，首次访问会要求设置管理密码。初始化成功后，请立即保存自动生成的客户端访问令牌，再到“连接设置”的 Key 池添加一把或多把 Zen / Go 密钥；每把 Key 可以命名并设置独立代理。

如果要直接在代理输入框里填写 hy2/TUIC/VLESS/VMess 等分享链接，本机需要可运行的 sing-box。已经装在系统 `PATH` 中时无需额外配置；也可以让项目下载固定版本到 `vendor/sing-box`：

```powershell
npm run install:sing-box
```

桥接服务会自动发现这个项目内路径；如果你安装在其它目录，再设置 `OPENCODE_BRIDGE_SING_BOX_PATH`。

Windows 本地也可以使用一键启动脚本，不需要编译：

```powershell
.\start-local.ps1
```

或直接双击 `start-local.cmd`。脚本会自动加载 `.env.local`；如果 `.env.local` 不存在，会先从 `.env.example` 复制生成一份再加载。缺少 `node_modules` 时会用 `npm ci --ignore-scripts` 按锁文件恢复依赖，然后启动管理面板。

推荐把本机环境变量写到 `.env.local`：

```powershell
notepad .env.local
.\start-local.ps1
```

`.env.local` 已被 `.gitignore` 排除，不会提交到仓库。也可以只在当前 PowerShell 会话临时设置变量：

```powershell
$env:OPENCODE_BRIDGE_ADMIN_PASSWORD = "abc123"
$env:OPENCODE_BRIDGE_CLIENT_TOKEN = "client123"
$env:OPENCODE_GO_KEYS = '["your-go-key-1","your-go-key-2"]'
npm start
```

可用环境变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | 监听地址；容器或局域网使用时设为 `0.0.0.0` |
| `PORT` | `8787` | 监听端口 |
| `CONFIG_FILE` | `data/config.json` | 配置文件位置 |
| `LOG_FILE` | `data/request-logs.json` | 可选持久化请求日志文件位置 |
| `OPENCODE_ZEN_BASE_URL` | 官方 Zen 地址 | 仅用于开发、测试或私有镜像上游 |
| `OPENCODE_GO_BASE_URL` | 官方 Go 地址 | 仅用于开发、测试或私有镜像上游 |
| `CONFIG_ENCRYPTION_KEY` | 空 | 可选配置加密主密钥，至少 16 个字符 |
| `OPENCODE_BRIDGE_ADMIN_PASSWORD` | 空 | 配置文件不存在时用于首次引导；6–256 位英文字母或数字 |
| `OPENCODE_BRIDGE_CLIENT_TOKEN` | 随机生成 | 环境变量引导时设置主访问令牌；6–256 位英文字母或数字 |
| `OPENCODE_BRIDGE_REQUIRE_ENV_BOOTSTRAP` | `false` | 设为 `true` 时，配置文件不存在且管理密码或主访问令牌缺失会拒绝启动；适合无持久化的公网部署 |
| `OPENCODE_BRIDGE_TRUST_PROXY` | `false` | 设为 `true` 后，登录限速使用 `X-Forwarded-For` 的首个有效 IP；仅应在可信反向代理后启用 |
| `OPENCODE_BRIDGE_MAX_ADMIN_MUTATIONS` | `16` | 同时执行的管理端 POST/PUT/PATCH/DELETE 上限，范围 1–128；超限返回 429，避免模型测试或密码哈希占满进程 |
| `OPENCODE_BRIDGE_MAX_ADMIN_MODEL_DISCOVERIES` | `4` | 管理面板同时拉取上游模型列表的请求上限，范围 1–32；超限返回 429，客户端取消后立即释放名额 |
| `OPENCODE_BRIDGE_MAX_HTTP_CONNECTIONS` | `256` | Node HTTP 服务同时接受的连接数上限，范围 1–10000；包含空闲 Keep-Alive、慢请求和 SSE 连接 |
| `OPENCODE_BRIDGE_STREAM_WRITE_TIMEOUT_MS` | `30000` | 流式推理、大 JSON、图片附件或静态文件遇到下游背压后等待 `drain` 的最长时间，范围 100–300000 毫秒；超时按客户端断开处理并释放上游连接、并发槽或文件读取流 |
| `OPENCODE_BRIDGE_SSE_HEARTBEAT_MS` | `15000` | 上游暂时没有可转发事件时向客户端发送标准 SSE 注释心跳的间隔，范围 1000–60000 毫秒；设为 `0` 禁用 |
| `OPENCODE_BRIDGE_WEB_SEARCH_MCP_URL` | `https://mcp.exa.ai/mcp` | Claude → Chat 本地 Web Search 使用的 Exa 兼容 MCP HTTP(S) 地址；仅用于自建/测试替换端点时修改 |
| `OPENCODE_BRIDGE_WEB_SEARCH_PARALLEL_MCP_URL` | `https://search.parallel.ai/mcp` | Claude → Chat 本地 Web Search 使用的 Parallel 兼容 MCP HTTP(S) 地址；仅用于自建/测试替换端点时修改 |
| `OPENCODE_BRIDGE_WEB_SEARCH_PROVIDER` | 面板设置，默认 `auto` | 可用 `auto`、`exa` 或 `parallel` 覆盖面板选择；`auto` 优先 Exa，失败后回退 Parallel |
| `EXA_API_KEY` | 空 | 可选 Exa API Key；仅使用默认 `mcp.exa.ai` 地址时会以 `exaApiKey` 查询参数附带 |
| `OPENCODE_ZEN_KEY` / `OPENCODE_GO_KEY` | 空 | 单 Key 兼容变量 |
| `OPENCODE_ZEN_KEY_1...32` / `OPENCODE_GO_KEY_1...32` | 空 | 多 Key 编号变量；按编号轮询使用 |
| `OPENCODE_ZEN_KEYS` / `OPENCODE_GO_KEYS` | 空 | 多 Key 合并变量，支持 JSON 数组、逗号或换行分隔；优先于编号变量 |
| `OPENCODE_PROXY_URL` | 空 | 环境变量引导时写入默认代理 |
| `OPENCODE_ZEN_PROXY_URL` / `OPENCODE_GO_PROXY_URL` | 空 | 环境变量引导时写入每个 Key 的独立代理 |
| `OPENCODE_ZEN_PROXY_URL_1...32` / `OPENCODE_GO_PROXY_URL_1...32` | 空 | 与编号 Key 一一对应的代理；缺省时回退到提供方代理和默认代理 |
| `OPENCODE_ZEN_PROXY_URLS` / `OPENCODE_GO_PROXY_URLS` | 空 | 与 `*_KEYS` 对应的代理列表；需要跳过某项时使用含空字符串的 JSON 数组 |
| `OPENCODE_BRIDGE_DEFAULT_PROVIDER` | `zen` | 环境变量引导时的默认提供方：`zen` 或 `go` |
| `OPENCODE_BRIDGE_IMAGE_HANDOFF` | 本机回环监听或 Render Web Service 时开启 | 将设置页所选文本模型从 Claude、Responses、Chat 或 Gemini 收到的 base64/data URL 图片暂存，并把本地路径或短时 HTTPS URL 交给客户端 vision/图片识别工具；设置为 `false` 可关闭 Render 自动启用 |
| `OPENCODE_BRIDGE_IMAGE_HANDOFF_DIR` | 系统临时目录 | 图片交接文件的父目录；每个进程使用独占子目录并在正常退出时清理 |
| `OPENCODE_BRIDGE_IMAGE_HANDOFF_MAX_BYTES` | `268435456` | 图片交接临时文件总容量，范围 1048576–10737418240 字节（1 MiB–10 GiB）；设为 `0` 不限制 |
| `OPENCODE_BRIDGE_IMAGE_HANDOFF_LOCAL_RETENTION_MS` | `86400000` | 本地路径附件最后一次使用后的保留时间，范围 60000–2592000000 毫秒（1 分钟–30 天）；设为 `0` 时保留到进程退出 |
| `OPENCODE_BRIDGE_IMAGE_HANDOFF_PUBLIC_URL` | Render 自动推导，否则为空 | 远程图片交接使用的 HTTPS 公网基址；Render 会从受限的 `RENDER_EXTERNAL_HOSTNAME` 自动推导，也可显式填写自定义域名；生成的随机下载 URL 默认 15 分钟有效 |
| `OPENCODE_BRIDGE_SING_BOX_PATH` | 自动 | 托管 hy2/TUIC/VLESS/VMess/Trojan/SS/Hysteria 分享链接时使用的 sing-box 可执行文件路径；未设置时先找 `vendor/sing-box`，再从 `PATH` 查找 |
| `OPENCODE_BRIDGE_MAX_MANAGED_TUNNELS` | `16` | 同时缓存的托管隧道数，范围 1–64；达到上限时只淘汰空闲隧道，全部忙碌则快速返回错误 |
| `OPENCODE_BRIDGE_MANAGED_TUNNEL_IDLE_MS` | `900000` | 空闲托管隧道自动回收时间，范围 1000–86400000 毫秒；设为 `0` 禁用，活跃请求不受影响 |
| `OPENCODE_BRIDGE_SING_BOX_VERSION` | `1.13.16` | `npm run install:sing-box`、Docker 和 Render 默认下载的 sing-box 版本 |
| `OPENCODE_BRIDGE_SING_BOX_FLAVOR` | 自动 | Linux 下载包类型：`glibc`、`musl` 或 `purego`；默认按运行时自动判断 |
| `OPENCODE_BRIDGE_SING_BOX_SHA256` | 官方摘要 | 自定义 `OPENCODE_BRIDGE_SING_BOX_DOWNLOAD_URL` 时必须填写的发布包 SHA-256；默认官方固定版本会自动校验 |

也可以使用 Docker Compose：

```powershell
docker compose up -d --build
```

Compose 默认只映射到本机 `127.0.0.1:8787`，配置保存在命名卷 `bridge-data` 中。镜像构建时默认会下载 sing-box 到 `/app/vendor/sing-box/sing-box`，因此容器内也能托管 hy2/TUIC/VLESS/VMess 等分享链接；如需禁用下载，可设置构建参数 `INSTALL_SING_BOX=false` 并改为挂载/指定自己的 `OPENCODE_BRIDGE_SING_BOX_PATH`。容器以非 root 用户运行，并通过 `/healthz` 执行健康检查；原 `/health` 路径继续作为兼容别名。
启动 Compose 前可在 PowerShell 中设置 `$env:CONFIG_ENCRYPTION_KEY`，该变量会传入容器用于配置加密。

如需公网访问，建议继续保持服务监听在本机，并使用 Caddy、Nginx 等反向代理提供 HTTPS。SSE 代理必须关闭响应缓冲并设置足够长的读取超时；不要直接将未加密的 `8787` 端口暴露到公网。

## Render 免费部署

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/zhu748/opencode-protocol-bridge)

仓库根目录的 `render.yaml` 会创建一个新加坡区域的免费 Node Web Service，自动执行 `npm ci --omit=dev --ignore-scripts`、显式安装固定版本 sing-box、运行 `npm start`，并使用 `/healthz` 进行健康检查。在 Render 创建 Blueprint 时填写：

- `OPENCODE_BRIDGE_ADMIN_PASSWORD`：**必填，不可留空**的管理面板密码，至少 6 位，仅使用英文字母或数字。
- `OPENCODE_BRIDGE_CLIENT_TOKEN`：**必填，不可留空**的客户端调用令牌，至少 6 位，仅使用英文字母或数字。
- `OPENCODE_BRIDGE_IMAGE_HANDOFF_PUBLIC_URL`：Render 的 `*.onrender.com` 地址会从平台提供的 `RENDER_EXTERNAL_HOSTNAME` 自动校验并使用；只有使用自定义域名时才需要显式填写。不需要远程图片交接时设置 `OPENCODE_BRIDGE_IMAGE_HANDOFF=false`。
- `OPENCODE_BRIDGE_KEEP_ALIVE_URL`：填写当前 Render 服务的完整健康检查地址，例如 `https://opencode-protocol-bridge.onrender.com/healthz`；留空则不覆盖管理面板配置。
- `OPENCODE_BRIDGE_KEEP_ALIVE_INTERVAL_SECONDS`：保活间隔，范围 5–86400 秒，Blueprint 默认 60。URL 或间隔由环境变量管理时，面板对应输入会只读显示。
- `OPENCODE_BRIDGE_SING_BOX_PATH`：Blueprint 默认会安装并指向 `/opt/render/project/src/vendor/sing-box/sing-box`；如需使用自带二进制可改为完整路径。
- `OPENCODE_BRIDGE_SING_BOX_VERSION`：默认 `1.13.16`，用于构建阶段下载 sing-box。
- `OPENCODE_ZEN_KEYS` / `OPENCODE_GO_KEYS`：推荐的批量配置，支持 JSON 数组、逗号或换行分隔，最多 32 把；至少配置一个上游的一把 Key。
- `OPENCODE_ZEN_PROXY_URLS` / `OPENCODE_GO_PROXY_URLS`：与批量 Key 逐项对应的 HTTP(S) 或 SOCKS 代理列表；需要保留空代理槽位时使用 JSON 数组中的空字符串。
- `OPENCODE_ZEN_KEY_1...4` / `OPENCODE_GO_KEY_1...4` 及同编号 `*_PROXY_URL_1...4`：少量 Key 的独立输入方式；未使用的槽位留空。

`CONFIG_ENCRYPTION_KEY` 由 Render 自动生成，`HOST=0.0.0.0`、`OPENCODE_BRIDGE_TRUST_PROXY=true` 和 `OPENCODE_BRIDGE_REQUIRE_ENV_BOOTSTRAP=true` 已在 Blueprint 中设置，`PORT` 由 Render 自动注入。最后一项会在这两项必填 Secret 缺失时拒绝启动，避免首次公网访问者抢先初始化控制台。可信代理开关使登录限速按 Render 提供的真实客户端地址隔离，普通自托管部署默认不信任转发头。批量 `*_KEYS` 非空时优先于编号变量，任一环境变量 Key 池又优先于管理面板保存的 Key 池；Key 按请求轮询，每把使用对应位置或同编号代理。面板 Key 池同样最多支持 32 把，每项可单独命名、测试和设置代理；旧版保存的单 Key 会在首次编辑时自动迁移。401/403 会让对应 Key 立即冷却，429 会优先采用上游 `Retry-After`，并在同一请求内安全切换到下一把健康 Key；响应头 `x-opencode-key-attempts` 会在发生切换时给出尝试次数。网络错误或 5xx 不会自动重放推理请求，以避免重复计费或重复工具调用；幂等的模型发现请求在建连、响应头或正文阶段发生网络错误时会安全尝试下一把健康 Key。连续三次网络错误或 5xx 后对应 Key 会进入指数冷却。非流式 2xx 只有在正文完整读取、JSON 解析和响应结构校验全部完成后才标记为成功；正文中途断开计为网络失败，客户端主动取消则保持凭据中性。冷却结束后 Key 自动重新参与轮询，也可在管理面板的 Key 健康表中手动重置。健康状态只保存在当前进程内，替换同一槽位的 Key 或代理不会继承旧状态。除保活运行时覆盖外，环境变量引导仅在配置文件中还没有管理密码时执行，不会覆盖已存在的持久化配置；保活环境变量则在每次启动时生效并优先于面板值。

Render 免费 Web Service 的文件系统是临时的，闲置 15 分钟后会休眠，休眠、重启或重新部署会丢失管理面板写入的本地配置。因此免费部署应把长期使用的密码、令牌、Key 和代理保存为 Render Secret；实例恢复时项目会从这些变量重新生成加密配置。面板中临时修改的模型路由、替换规则和客户端列表也会在实例文件系统重置后恢复默认；内存中的请求日志、用量/缓存统计、Key 健康与冷却状态，以及最近 Claude system 快照也会清空。即使启用了持久化日志，免费实例重启后该文件同样不会保留。需要永久保留面板修改时，应升级到支持 Persistent Disk 的付费实例并将磁盘挂载到 `/opt/render/project/src/data`。详见 [Render 免费实例限制](https://render.com/docs/free) 与 [Persistent Disks](https://render.com/docs/disks)。

管理面板“连接设置”也提供 Render 保活：没有环境变量覆盖时，点击“一键设置当前站点”会填写当前站点的 `/healthz`，保存后服务立即发送一次 GET，此后按 5–86400 秒的配置间隔串行请求；URL 或间隔修改后无需重启，留空保存即禁用。保活请求不跟随重定向、不读取响应正文，最近结果会显示在设置页。该功能不能唤醒已经休眠的进程，也不保证云平台将服务自身发出的请求计作外部流量；需要可靠唤醒时仍应使用符合平台规则的外部健康检查服务。

## 客户端配置

推荐直接通过 Base URL 区分上游：

```text
Zen: http://127.0.0.1:8787/zen/v1
Go:  http://127.0.0.1:8787/go/v1
```

`/zen/v1` 始终使用 Zen 密钥，`/go/v1` 始终使用 Go 密钥，即使模型路由中配置了不同的 provider。原有 `http://127.0.0.1:8787/v1` 保留兼容，会继续依据模型前缀、精确模型路由和默认上游自动选择。

API Key 使用管理面板生成的“客户端访问令牌”，不要填写 OpenCode Zen / Go 的真实密钥。服务同时接受：

```http
Authorization: Bearer YOUR_BRIDGE_TOKEN
```

或 Claude 风格：

```http
x-api-key: YOUR_BRIDGE_TOKEN
```

或 Google Gemini 风格：

```http
x-goog-api-key: YOUR_BRIDGE_TOKEN
```

Gemini SDK/客户端使用模型 URL 调用，模型名不放在请求 JSON 中。例如：

```http
POST /zen/v1/models/gemini-3.6-flash:generateContent
Content-Type: application/json
x-goog-api-key: YOUR_BRIDGE_TOKEN

{"contents":[{"role":"user","parts":[{"text":"你好"}]}]}
```

流式入口为 `/v1beta/models/{model}:streamGenerateContent?alt=sse`。Zen 的 `gemini-3-flash`、`gemini-3.1-pro`、`gemini-3.5-flash`、`gemini-3.5-flash-lite`、`gemini-3.6-flash` 会使用原生 `models/{model}:generateContent` / `streamGenerateContent?alt=sse` 上游；未来新增但尚未进入内置目录的 Zen `gemini-*` 型号也会保守选择原生 Gemini 路由，Go 未经官方确认的同名模型仍保持 Chat 兜底。入口与目标均为 Gemini 时，请求和成功响应原样透传，`safetySettings`、`cachedContent` 及未来厂商扩展不会经过兼容协议重写。其它目标支持 `systemInstruction`、文本、`inlineData`/`fileData` 图片与文件、常用 `generationConfig`、`functionDeclarations`（包括 `parametersJsonSchema`）、`functionCall`/`functionResponse` 和 SSE usage 转换。Google SDK 自动带入但 Responses/Chat 没有等价字段的 `topK` 会被明确移除，并通过 `x-opencode-generation-adaptations: gemini_top_k_dropped` 与请求日志标记；其它无法表达且可能显著改变语义的生成字段仍返回 400。Gemini 函数声明的 `response` / `responseJsonSchema` 在跨到 Responses、Chat 或 Claude 时会以稳定 JSON 写入工具描述，通过 `gemini_response_schema_to_description` 标记。Gemini 的 JSON/JSON Schema 结构化输出会转换为 Responses `text.format`、Chat `response_format` 或 Claude `output_config.format`；反向转换到 Gemini 时会生成 `responseMimeType/responseJsonSchema`。`thinkingConfig.thinkingLevel` 会与 Responses `reasoning.effort`、Claude adaptive thinking 双向映射，近似转换通过 `x-opencode-reasoning-adaptations` 响应头和请求日志显示。Gemini `googleSearch: {}` 和显式的 `searchTypes.webSearch` 在目标路由为原生 Responses 时会转换成托管 `{type:"web_search"}`，并以 `gemini_google_search_to_web_search` 标记；反方向仅对没有额外选项的 Responses `web_search` 转成 `{googleSearch:{}}`，以 `responses_web_search_to_gemini_google_search` 标记。搜索词与 `url_citation` 会在非流式和流式响应中双向转换为 `groundingMetadata`，不会把 Sources 文字混入正文。Gemini 图片搜索、带上下文大小/地域等无法等价映射的 Responses 搜索配置，以及跨协议的 code execution、`cachedContent`、安全策略、多候选或其它专属生成配置会在访问上游前明确返回 400；原生 Gemini 直通不受这些跨协议限制。

Gemini `functionCallingConfig.allowedFunctionNames` 支持官方定义的多函数集合：跨到 Responses、Chat 或 Claude 时只发送允许的函数，`ANY` 保持必须调用，`VALIDATED` 保持可选调用并以 `gemini_validated_best_effort` 明确标记目标模型无法统一保证的 constrained-decoding 语义。过滤通过 `gemini_allowed_functions_filtered` 标记；空名称、重复名称、未声明函数、在 AUTO/NONE 下使用列表以及 ANY 没有可调用函数都会在访问上游前返回 400。Gemini 允许函数名长达 128 字符并可包含 `.`、`:`；超过 OpenAI/Claude 的 64 字符上限或使用目标协议不接受的标点时，会生成不冲突的稳定别名，并同步改写工具定义、`allowedFunctionNames`、历史调用和工具结果。非流式及流式响应会恢复客户端原名，并以 `gemini_function_names_aliased` 标记。`streamGenerateContent` 还支持 `streamFunctionCallArguments: true`：桥接会利用 Responses、Claude 或 Chat 上游的原始 JSON 参数增量，在完整参数对象首次形成时将标量叶节点重编码为 RFC 9535 JSONPath `partialArgs`，并通过 `gemini_stream_function_args_reencoded` 标记；并行调用分别维护状态。Gemini `PartialArg` 不能表示空的嵌套对象或数组时会保留标准完整 `args`，不会为了伪造增量而丢失参数。

Responses `reasoning.summary`（以及已弃用的 `generate_summary`）会转换为 Claude `thinking.display: "summarized"`；Claude 的 summarized display 会转换回 Responses `summary: "auto"`，`thinking: disabled` 会转换为 `effort: "none"`，Claude Code 当前使用的 `effort: "max"` 会原值保留到 Responses。Claude `display: "omitted"` 返回的空 thinking 块不会被伪造成 Responses reasoning 项，但流式和非流式 `thinking_tokens` 仍会保留到 Responses usage 和用量统计。`reasoning.mode: "pro"` 和非 `auto` 的 `reasoning.context` 属于 Responses 独占执行/状态语义，跨到 Claude 或 Chat 时会明确返回 400；上游响应回显的实际 `reasoning.context` 在跨协议时通过 `x-opencode-response-degradations: responses_reasoning_context` 或流式请求日志标记，不再静默消失。Codex CLI 当前默认请求 `summary: "auto"`；跨到 Chat 时只能从上游 `reasoning_content` 最佳努力恢复，并通过 `x-opencode-reasoning-adaptations: reasoning_summary_best_effort_chat` 标记。其它近似映射也使用同一响应头，并完整写入最长 256 字符的请求日志协议字段。

管理面板中的“主访问令牌”用于兼容单用户部署。多人或多设备使用时，建议在“客户端令牌”中为每个调用方创建独立令牌：令牌只在创建或轮换时显示一次，服务端仅保存 SHA-256 摘要；每个客户端可设置独立并发上限，并可随时停用、轮换或撤销。全局并发上限仍对所有客户端请求总数生效，推理、模型列表和单模型查询共享同一套准入计数。

### Key 独立代理

“连接设置”的“代理与托管隧道”区域可以设置默认代理，每把 Zen / Go Key 也可以指定独立代理。填写地址并保存即启用，清除后恢复直连，不需要额外开关。独立代理优先于默认代理；未配置独立代理时回退到默认代理，默认代理也未配置则直连。代理保存后只向页面返回脱敏地址，输入框留空表示保持原值；需要取消代理时使用对应的“清除代理”按钮。“检测代理”会使用当前默认上游的一把可用 Key，经输入框中的代理拉取模型列表，可以在保存前验证新节点。支持以下可被 Node.js 直接使用的 HTTP/SOCKS 写法：

```text
http://127.0.0.1:7890
https://user:password@proxy.example:8443
socks4://127.0.0.1:1080
socks4a://user:password@proxy.example:1080
socks5://127.0.0.1:1080
socks5h://user:password@proxy.example:1080
```

省略协议的 `host:port` 会按 HTTP 代理处理。Clash / mihomo 的 mixed-port 可填写 `mixed://127.0.0.1:7890`，保存时会按 HTTP 代理规范化为 `http://127.0.0.1:7890/`；因为 mixed-port 同时接受 HTTP CONNECT 和 SOCKS，所以本项目会选择 HTTP CONNECT 路径。代理用户名或密码包含特殊字符时应使用 URL 百分号编码。管理面板可以逐项测试 Key；编辑时填写的新代理优先，否则使用该 Key 已保存的代理并回退到默认代理。

hy2 / Hysteria2、TUIC、VLESS、VMess、Trojan、Shadowsocks 与 Hysteria 分享链接可以直接填入默认代理或单把 Key 的独立代理。项目会在第一次调用或测试连接时启动一个本机回环 sing-box 子进程，为该分享链接分配临时 SOCKS5 端口，然后复用现有上游请求逻辑。服务正常退出时会关闭子进程并删除临时配置文件。默认最多缓存 16 条托管隧道；达到上限时按最近使用顺序淘汰空闲实例，不会为新节点中断仍在读取或流式传输的响应。连续空闲 15 分钟的实例会自动关闭，下一次使用时按需重建。

直接填写分享链接要求运行本项目的机器已经安装 sing-box。默认执行 `sing-box`；如果不在 `PATH` 中，请设置：

```powershell
$env:OPENCODE_BRIDGE_SING_BOX_PATH = "C:\Tools\sing-box\sing-box.exe"
```

示例：

```text
hy2://password@example.com:443?sni=example.com&insecure=1
tuic://uuid:password@example.com:443?sni=example.com&congestion_control=bbr
vless://uuid@example.com:443?security=reality&pbk=PUBLIC_KEY&sid=SHORT_ID&type=tcp&flow=xtls-rprx-vision
vmess://BASE64_JSON
trojan://password@example.com:443?sni=example.com&type=ws&path=%2Fws
ss://YWVzLTI1Ni1nY206cGFzcw@example.com:8388
```

托管配置当前覆盖常见 TCP / WebSocket / gRPC / HTTP / HTTPUpgrade / QUIC 传输以及 VLESS Reality/uTLS 常用参数；VMess/VLESS 等 WebSocket 分享链接中的 Xray `?ed=` 约定会自动转换为 sing-box early data 字段，并使用 `Sec-WebSocket-Protocol` 保持兼容。客户端取消和上游请求超时会覆盖 sing-box 隧道启动阶段；最后一个等待者离开时会关闭未就绪进程并清理临时配置，共享同一隧道的其它等待请求则继续运行。遇到 sing-box 无法表达的传输（例如部分私有或过新的 V2Ray 传输）会返回明确错误。ShadowsocksR (`ssr://`) 暂不托管，仍需先由本地客户端转换为 HTTP/SOCKS 端口。

### 在 OpenCode 中使用

先将客户端访问令牌放到环境变量：

```powershell
$env:OPENCODE_BRIDGE_TOKEN = "管理面板生成的令牌"
```

然后在 `opencode.json` 中添加 Bridge 自定义提供方。不要把 Zen 或 Go 全部配置成 OpenAI Compatible：OpenCode 支持在每个模型的 `provider.npm` 中覆盖 AI SDK，因此 Responses 使用 `@ai-sdk/openai`，Claude Messages 使用 `@ai-sdk/anthropic`，Chat Completions 使用 `@ai-sdk/openai-compatible`，Zen 原生 Gemini 使用 `@ai-sdk/google`。同一自定义 Provider 可以按模型混用原生接口；管理页生成的完整配置还会按“默认上游”选择一个目录中确实存在的默认模型：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "bridge-go/gpt-5.6-luna",
  "provider": {
    "bridge-zen": {
      "npm": "@ai-sdk/openai",
      "name": "OpenCode Bridge Zen · Native per model",
      "options": {
        "baseURL": "http://127.0.0.1:8787/zen/v1",
        "apiKey": "{env:OPENCODE_BRIDGE_TOKEN}"
      },
      "models": {
        "gpt-5.6-terra": {
          "name": "GPT 5.6 Terra (Zen)",
          "attachment": true,
          "reasoning": true,
          "temperature": false,
          "tool_call": true,
          "limit": { "context": 1050000, "input": 922000, "output": 128000 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] },
          "provider": { "npm": "@ai-sdk/openai" }
        },
        "gemini-3.6-flash": {
          "name": "gemini-3.6-flash (Zen)",
          "attachment": true,
          "reasoning": true,
          "temperature": true,
          "tool_call": true,
          "limit": { "context": 1048576, "output": 65536 },
          "modalities": { "input": ["text", "image", "video", "audio", "pdf"], "output": ["text"] },
          "provider": { "npm": "@ai-sdk/google" }
        }
      }
    },
    "bridge-go": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "OpenCode Bridge Go · Native per model",
      "options": {
        "baseURL": "http://127.0.0.1:8787/go/v1",
        "apiKey": "{env:OPENCODE_BRIDGE_TOKEN}"
      },
      "models": {
        "gpt-5.6-luna": {
          "name": "gpt-5.6-luna (Go)",
          "attachment": true,
          "reasoning": true,
          "temperature": false,
          "tool_call": true,
          "limit": { "context": 1050000, "input": 922000, "output": 128000 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] },
          "provider": { "npm": "@ai-sdk/openai" }
        },
        "minimax-m3": {
          "name": "minimax-m3 (Go)",
          "attachment": true,
          "reasoning": true,
          "temperature": true,
          "tool_call": true,
          "limit": { "context": 1000000, "output": 131072 },
          "modalities": { "input": ["text", "image", "video"], "output": ["text"] },
          "provider": { "npm": "@ai-sdk/anthropic" }
        },
        "deepseek-v4-flash": {
          "name": "deepseek-v4-flash (Go)",
          "attachment": true,
          "reasoning": true,
          "temperature": true,
          "tool_call": true,
          "limit": { "context": 1000000, "output": 384000 },
          "modalities": { "input": ["text", "image"], "output": ["text"] },
          "provider": { "npm": "@ai-sdk/openai-compatible" }
        }
      }
    }
  }
}
```

模型需要在 `models` 中显式填写；管理面板“接入指南”会根据当前内置能力表生成 Go 的 25 个模型和 Zen 的完整目录，并同步写入每个模型的原生 SDK、推理、工具调用、温度、文本/图片/音频/视频/PDF 输入模态和上下文上限。文本模型只有在“图片附件交接”中已选中且运行时传输状态为 `local` 或 `remote` 时，才会声明 `attachment: true` 并额外加入图片输入，此时 Bridge 会把附件转成短时路径/URL，提示客户端调用图片识别 skill；传输状态为 `disabled` 时会恢复纯文本模态。上面的 DeepSeek 项展示的是交接已开启的结果。

`gpt-5.6-luna` 会从 OpenCode 直接调用 Bridge 的 `/go/v1/responses`，`minimax-m3` 调用 `/go/v1/messages`，`deepseek-v4-flash` 调用 `/go/v1/chat/completions`；Zen 的 `gemini-3.6-flash` 则调用 `/zen/v1/models/gemini-3.6-flash:generateContent`。入口和模型原生协议一致时 Bridge 直接透传；从 Claude、Responses、Chat 或 Gemini 其它入口调用时才做必要的双向转换。Go 当前没有官方原生 Gemini 上游，但 Zen 有五个原生 Gemini 模型。

模型发现支持 `GET /zen/v1/models` 和 `GET /go/v1/models`。兼容入口仍支持 `GET /v1/models?provider=zen|go|all`；`all` 会聚合所有已配置提供方，并自动为 Go 模型添加 `opencode-go/` 前缀。
单个模型信息可通过 `GET /zen/v1/models/{model-id}`、`GET /go/v1/models/{model-id}` 或兼容入口 `GET /v1/models/{model-id}` 获取；包含 `/` 的模型 ID 应进行 URL 编码。

Go 模型可直接使用 `opencode-go/<model-id>`，Zen 模型可使用 `opencode/<model-id>`。前缀会在发送上游前自动移除。也可在管理面板添加精确模型映射：

```json
{
  "my-model": {
    "provider": "go",
    "protocol": "claude",
    "upstreamModel": "qwen3.7-plus"
  }
}
```

部分模型不支持命名工具选择或 `required`。可在精确模型路由中显式设置 `"toolChoiceFallback": "auto"`，将非 `none`/`auto` 的工具选择降级为 `auto`：

```json
{
  "deepseek-free": {
    "provider": "zen",
    "protocol": "chat",
    "upstreamModel": "deepseek-v4-flash-free",
    "toolChoiceFallback": "auto"
  }
}
```

该选项默认关闭，并可能让模型选择不调用工具。仅应对已确认不支持标准 `tool_choice` 的模型启用；启用后请求日志的协议转换字段会附带兼容标记。

自动协议判断会先按实际 provider 查询 OpenCode Zen / Go 的精确能力表，再只对未知新模型使用名称推断。同名模型在两个产品中的端点可以不同，例如 `grok-4.5` 在 Zen 是 Responses，在 Go 是 Chat。Go 当前原生端点如下：

| 原生上游协议 | OpenCode Go 模型 |
| --- | --- |
| Responses | `gpt-5.6-luna` |
| Claude Messages | `minimax-m3`、`minimax-m2.7`、`minimax-m2.5`、`qwen3.8-max`、`qwen3.7-max`、`qwen3.7-plus`、`qwen3.6-plus`；模型端点仍可发现的兼容型号 `qwen3.5-plus` 也按 Claude 路由 |
| Chat Completions | `grok-4.5`、`glm-5.2`、`glm-5.1`、`kimi-k3`、`kimi-k2.7-code`、`kimi-k2.6`、`deepseek-v4-pro`、`deepseek-v4-flash`、`mimo-v2.5`、`mimo-v2.5-pro`、`hy3`；兼容/预览型号 `glm-5`、`kimi-k2.5`、`mimo-v2-pro`、`mimo-v2-omni`、`hy3-preview` 同样按 Chat 路由 |

Zen 当前原生端点按官方端点表分为四类：

| 原生上游协议 | OpenCode Zen 模型概况 |
| --- | --- |
| Gemini GenerateContent | `gemini-3-flash`、`gemini-3.1-pro`、`gemini-3.5-flash`、`gemini-3.5-flash-lite`、`gemini-3.6-flash` |
| Responses | GPT 5/5.1/5.2/5.3/5.4/5.5/5.6 系列、`grok-4.5`、`grok-build-0.1` |
| Claude Messages | Claude 4.5–5 系列，以及 Qwen3.5/3.6/3.7 系列 |
| Chat Completions | DeepSeek V4、MiniMax、GLM、Kimi，以及 Zen 的 free 模型 |

因此入口协议并不限定转换方向：Claude、Responses、Chat 或 Gemini 请求都会转换到模型自己的原生上游协议；入口已经与目标一致时，请求与响应保留厂商扩展字段并直接透传。精确模型路由中的 `protocol` 支持 `auto / claude / responses / chat / gemini` 并始终优先，可用于覆盖官方调整或私有镜像差异。`npm run check:catalogs` 会只读核对 Zen/Go 在线 `/models`、官方端点表和 models.dev 模态/限制，发现新增模型或能力漂移时失败。

### 图片附件交接模型

管理面板“连接设置”中的“图片附件交接”用于选择哪些上游模型不能直接接收图片块，不再限制目标必须是 Chat。选择 Zen 或 Go 后，可以使用项目已经配置的 Key 池自动拉取模型，也可以指定某一把环境 Key 或面板 Key；浏览器只提交安全的 Key 槽位 ID，真实 Key 不会返回页面。勾选结果按 `{ provider, model }` 精确保存，同名模型在另一个上游不会被连带启用。

新配置会根据 OpenCode 使用的 models.dev 输入模态，默认选中两边能力表确认的纯文本模型。Go 包括 DeepSeek V4、GLM、Hy3、MiMo Pro、MiniMax M2.x 和 `qwen3.7-max`；已不在当前 Go `/models` 与能力表中的历史型号（例如 `deepseek-v4-flash-free`）不会继续占用默认项。Zen 包括 `big-pickle`、DeepSeek V4、GLM、`gpt-5.3-codex-spark`、Laguna/Ling/LongCat/Nemotron/North free 模型、MiniMax M2.x 和 `qwen3.7-max`。原生图片输入模型不会默认开启，包括五个 Zen Gemini、GPT 视觉型号、Claude、Grok、Kimi、MiMo Omni/多模态型号、MiniMax M3 和多模态 Qwen。

仍保持旧四项或上一版 15 项内置默认值、且没有加入自定义选择的配置会在加载时自动迁移；已经自定义或清空的选择不会被覆盖。拉取 Zen 或 Go 模型后，面板都会标出原生协议以及“原生视觉”或“文本 · 建议交接”，并可一键添加当前结果中的建议文本模型；“选择当前结果”仍保留用于尚未进入能力表的自定义模型。

可以在拉取模型后取消默认项或选择其他已确认存在相同限制的模型。选中模型从 Claude、Responses、Chat 或 Gemini 入口收到 base64/data URL 图片时，本地部署会提供临时绝对路径，Render Web Service 默认从平台外部主机名生成短时 HTTPS URL，其它远程部署可配置 `OPENCODE_BRIDGE_IMAGE_HANDOFF_PUBLIC_URL`；相同内容会跨协议按哈希去重。原请求已经提供 HTTP(S) 图片 URL 时则保留该地址，并转换成下载后调用 vision/图片识别 skill 的明确指令，不会再丢成笼统提示。这一处理会在请求进入目标 Responses、Claude Messages、Chat 或原生 Gemini 协议前完成；客户端在准备期间断开时会取消排队或进行中的附件写入并释放待发布引用，不会继续制造无用临时文件。远程附件会以流式响应发送，令牌过期后撤销访问，正在进行的下载结束后再清理对应文件。如果 base64 交接传输关闭且没有可用 URL，则使用明确的“图片未发送”文本。未选中的模型继续按目标协议的原生图片块透传，因此不应为原生支持视觉的模型开启此选项。

相同图片按内容哈希去重，不会重复占用临时存储。临时文件总量默认限制为 256 MiB；超过上限时新附件会返回明确的 HTTP 507，而不会继续写满磁盘。本地路径每次被会话重新使用都会刷新保留期，默认 24 小时未使用后自动删除；远程文件仍按短时 URL 的 15 分钟有效期清理。服务正常退出时会清理该进程创建的全部附件目录。

模型路由使用别名时，匹配的是最终 `upstreamModel` 和实际 provider，而不是客户端传入的别名。图片交接对 Claude Code 发来的 Claude 图片生效，与目标是 Responses、Claude Messages、Chat 还是 Gemini 无关；未勾选的模型继续使用目标协议的原生图片格式。

## Claude system 提示词规则

管理面板的“提示词规则”可以在 Claude Messages 请求发送上游前，按顺序执行精确字面量替换。每条规则包含：

- `name`：管理面板显示名称
- `enabled`：是否启用
- `find`：需要匹配的完整文本
- `replace`：替换内容；空字符串表示删除

项目默认启用三条规则：保留开头的 Claude Code 身份说明，删除 Environment 中“最新 Claude 模型 / Claude Code 可用平台 / Fast mode”三行推广和 Fable/Mythos 产品定位与官网导流段，并替换 Claude Code 注入的安全测试限制段。默认规则可以关闭、编辑或恢复；仍在使用内置规则的旧配置会自动迁移旧版推广文本并补充 Fable/Mythos 删除规则，完全自定义或已清空默认规则的配置不会被强制添加。

最近一次 Claude 请求中收到的原始 system 和最终发送给上游的 system 只保存在当前 Node.js 进程内，各自最多保留 1 MiB，不进入请求日志或配置文件。快照左右两侧使用相同口径，均包含顶层 `system` 以及 Claude 新版协议允许的会话中途 `messages[].role=system`；提示词规则也会处理这两类系统文本并保留原有内容块属性。兼容输入中的 `developer` 角色按同等系统优先级处理。控制台会显示本次包含的中途 system 数量，并逐条标记规则是“已生效”“未命中”还是“已停用”，因此三条内置 Claude 规则是否实际生效可以直接确认。

规则本身会保存到配置。控制台提供可视化的新增、编辑、启停和删除操作；填写查找原文和替换内容即可创建替换规则，替换内容留空即为删除规则。也可以在收到的原始 system 中选中文字快速创建规则，或通过高级 JSON 编辑器批量调整。未保存的规则支持直接预览，另有复制原始/最终内容和清除内存快照功能。

规则采用字面量匹配而非正则表达式，因此不会出现正则回溯或转义差异。最多配置 50 条，单条内容最多 128 KiB，全部规则内容最多 1 MiB；处理后的 system 超过 10 MiB 时请求会以 HTTP 413 拒绝，防止替换规则造成内容放大。

## 流式说明

- 客户端协议与上游协议相同时，正常 SSE 数据实时原样透传；服务通过并行观察流记录 usage。若上游在完成事件前中断，服务会追加目标协议可识别的错误帧，避免客户端把截断内容误判为成功。
- 跨协议时，服务会维护内容块索引和工具调用状态，将上游事件逐条转换为目标协议事件，不再缓存完整响应；SSE 解析兼容 LF、CRLF 和 CR 换行。流式请求要求上游返回标准 `text/event-stream`，避免把 HTTP 200 的普通 JSON 错误误判为空流；确认上游成功后会立即向客户端刷新 SSE 响应头，不必等待首个模型事件。同协议 Chat 流也会主动请求 usage，只有上游确实返回 token 字段时才计入面板用量覆盖率，缺失 usage 不会伪记为零 token；客户端即使在首个事件前断开，上游请求也会被取消。
- 生成的 Responses SSE 从 `0` 开始连续递增 `sequence_number`；文本 `delta`/`done` 带 `logprobs: []`，错误使用顶层 `type`、`code`、`message`、`param` 字段，终态 Response 始终带完整的 usage 明细与 `parallel_tool_calls`、`tool_choice`、`tools` 核心字段。若透传 Responses 流在完成前截断，追加错误会接续上游最后一个序号。
- 生成的 Gemini SSE 每个成功数据块都带同一个 `responseId` 和实际服务模型 `modelVersion`；终态 usage 按 Google 的独立候选/思考口径输出，`candidatesTokenCount + thoughtsTokenCount` 等于内部总输出 token。非流式 Gemini 因 `promptFeedback.blockReason` 没有候选内容时，会转换为目标协议的内容过滤终态，而不是误报响应结构损坏。
- 跨协议流会保留 `completed`/`incomplete`、token 上限停止原因、缓存读取/写入 token 和推理 token；上游在 HTTP 200 SSE 内发送的 `error` / `response.failed` 会先移除调试字段、清理控制字符、限制为 1000 字符并脱敏当前 Key/代理，再使用客户端协议可识别的错误帧返回和写入日志。同协议流也只对终态错误执行这项安全改写，之前的成功事件仍保持原文，错误后的尾随数据不再继续转发。单个上游 SSE 事件最多缓冲 8 MiB，超限会终止转换，防止异常上游无限占用内存。
- 成功 SSE 使用独立的上游流空闲超时：每收到一个上游原始数据块（包括上游心跳）都会重新计时，因此持续输出的长任务没有总时长限制；连续无数据达到阈值时会取消上游正文、发送客户端协议可识别的 `upstream_stream_idle_timeout` 错误帧、写入 504 日志并参与 Key 熔断。该设置默认 300000 毫秒，可在管理面板设为 1000–3600000 毫秒，或设为 `0` 禁用。
- Bridge 默认每 15 秒在没有可转发事件时向客户端输出 `: opencode-bridge keep-alive` SSE 注释，防止 Render 或反向代理把仍在思考的静默连接当成闲置连接关闭。成功 SSE 同时返回 `X-Accel-Buffering: no`，显式要求 Nginx 类代理不要攒包。心跳与真实事件使用同一条串行背压链路，不会并发写入或无限排队，也不会进入模型事件转换、usage 统计或上游空闲计时；客户端持续不读取时仍会触发现有下游写入超时。消费者提前结束迭代时，包装器会先中止上游请求再等待来源清理，避免挂起的上游读取拖延连接和并发槽释放。
- `/api/status` 和面板运行摘要会聚合显示当前推理数、流式请求数、等待上游数、已建立流数、正在写入数、最长上游静默时间和活跃流已成功写入下游的心跳数；生成后遇到客户端断开或写入失败的心跳不会提前计数。运行态只保存阶段、时间戳和计数，并在请求结束的 `finally` 中删除，不记录模型、客户端、提示词、响应正文、Key 或代理。
- 流式请求只有在完整结束后才会把对应 Key 记为健康；包括正常关闭连接但缺少完成事件的截断流，都会写入失败日志、返回错误帧并参与连续失败熔断。客户端主动断开记为内部状态 499，但不会惩罚 Key，也不会让冷却后的半开探测槽位永久占用。同协议流的用量观察与字节透传位于同一条背压链路中，不会因统计分支提前读取而在慢客户端一侧无限积压。
- 超过 64 KiB 的非流式 JSON 会按 64 KiB 分块写入，覆盖推理响应、模型列表、日志和提示词预览等路径。慢客户端不会提前释放公开推理或管理模型发现槽位；写入超时或中途断开会结束连接，非流式推理日志记为内部状态 499，而上游已经完整成功的 Key 仍保持健康。

管理面板可以设置 1 秒至 10 分钟的上游请求超时，默认 120 秒。非流式请求、模型发现和流式请求的非 2xx 错误正文会把它应用到完整上游正文；非流式/模型发现正文和流式错误正文读取结束、失败或因 Key 切换被丢弃后会立即释放对应定时器。成功的流式推理只用它限制建立连接及等待响应头。收到成功 SSE 响应头后不再设置总时长上限，改由默认 5 分钟、逐数据块重置的独立流空闲超时识别停滞连接；客户端断开、下游写入超时和上游主动断流仍会立即结束读取并释放连接。上游 JSON 与 SSE 均按 UTF-8 严格解码；非法字节会得到明确的 `upstream_invalid_utf8` 错误，不会被静默替换成 `�` 后继续转换。

未完成的 SSE 事件使用增量边界扫描和增量 UTF-8 字节计数，极端小分片不会反复扫描整个缓冲区；单事件仍受 8 MiB 上限保护。配置文件和持久化日志同样按 UTF-8 严格读取，损坏编码会被明确报告而不会污染运行状态。
还可以设置 1–1000 的并发请求上限，默认 20；达到上限时返回目标协议兼容的 HTTP 429 错误与 `Retry-After` 响应头。

每个进入服务的 HTTP 请求都会获得独立的 128 位 `x-request-id`，包括健康检查、管理 API、模型发现、静态资源和早期错误；推理请求日志使用同一个 ID，便于从客户端响应定位面板记录。最终上游返回的 `Retry-After` 和标准 `RateLimit-*` / `X-RateLimit-*` 配额头会按安全白名单透传；上游的 `x-request-id`、`request-id` 或 `x-trace-id` 会改名为 `x-opencode-upstream-request-id`，避免与本地 ID 混淆。Cookie、认证信息和其它未列入白名单的响应头不会转发。

## 当前边界

- 跨协议非流式转换会逐项校验 Responses output（包括 item 类型/ID 与 reasoning `encrypted_content`）、Chat/Claude 工具调用、工具参数 JSON 和 Gemini/Chat 候选数量；损坏输出或意外多候选会作为 502 上游结构错误返回，不会落成普通运行时异常，也不会只取第一项后静默丢弃其余结果。同协议成功响应仍保留厂商扩展字段。
- 跨协议 Chat SSE 同样只接受单个 `index=0` 候选，并严格校验 choices、delta、分段文本、reasoning details、旧式 function_call 与 tool_calls 增量的形状；多候选、非零索引和损坏增量会返回目标协议错误帧，不会被重编号、跳过或转成空内容。同协议 Chat SSE 仍保持字节级透传和宽松用量观察，不会因新增厂商扩展而中断。
- Chat、Responses 或 Claude 上游的流式工具参数会在工具块结束时统一解析并确认是 JSON 对象；损坏 JSON、数组、`null` 或其它标量不会再以成功工具调用结束。该校验对 Claude、Responses、Chat 和 Gemini 四种客户端输出都生效，并保留 `UPSTREAM_INVALID_TOOL_ARGUMENTS` 错误码及原有稳定错误文案。
- Responses 上游的非流式 `failed`、`cancelled`、`queued`、`in_progress`、携带 `error` 的伪完成响应，以及未知 `incomplete_details.reason`，不会再跨协议降级成正常结束；流式终态同样校验事件类型、`response.status`、`error` 和截断原因的一致性。同协议 Responses 路由仍原样透传厂商状态和扩展字段。
- Claude、Chat 与 Gemini 上游跨协议转换会校验官方停止原因枚举；缺失或厂商自定义的 `stop_reason` / `finish_reason` / `finishReason`、Gemini 的未终止及故障类原因，以及“声明工具结束但没有工具调用”或“正常结束却携带工具调用”的矛盾终态都会明确失败。Chat 流在终止 chunk 后继续输出候选内容也会被识别为损坏序列；同协议观察器仍不干预厂商扩展值和原始字节流。
- 跨协议成功响应还会校验输出身份与子终态：Claude/Chat 只能返回 assistant，Gemini 候选只能返回 model；Claude 的 `stop_sequence` 必须只在 `stop_reason: stop_sequence` 时携带非空命中值；Responses 的 message/function_call/reasoning 输出项不能在完成响应中仍标记为 `in_progress` 或 `incomplete`，流式 added/done 事件也必须与各自阶段一致。这样不会再把错误角色或半成品输出静默重编码为正常 assistant 完成；同协议透传不受影响。
- 跨协议响应的顶层 `id`、模型名和 `object` 类型也会在重编码前校验，流式身份字段在同一响应内不得漂移；Responses 输出事件必须位于唯一的 `response.created` 之后，非错误事件必须带非空字符串 `data.type`，显式 SSE `event:`（通用 `message` 除外）必须与其匹配；可选的 `sequence_number` 必须是严格递增的非负安全整数，但允许任意起点、间隔或完全省略。其文本、拒答、reasoning、函数参数及 content part 完整值必须使用协议定义的字符串类型。重复的 item/part added 或 done、字段 done 后继续发送同块 delta、item done 后继续输出内容，以及响应终态后的任何追加事件都会作为损坏序列拒绝；官方正常的字段 done、part done、item done 和 response completed 多层结束顺序不受影响。为兼容只在完成事件给出正文的上游，单独的 done-only 兜底和终态 `response.output` 补全仍受支持。Claude SSE 同样要求 typed event 及显式 `event:` 一致，匹配的未知未来事件则按 Anthropic 版本策略安全忽略；工具调用 ID/名称、初始文本、thinking/signature、redacted thinking 和四类内容增量会严格校验字符串或对象类型，损坏标量不会再被 `|| ""` 静默改为空内容。同协议成功响应和 SSE 仍原样透传这些厂商字段。
- 本项目覆盖 Claude Messages、OpenAI Responses、Chat Completions 和 Google Gemini `generateContent` 四个协议族；Gemini 同时接受 `/v1` 与 `/v1beta` 路径，并可使用 `x-goog-api-key`、`x-api-key` 或 Bearer 令牌。模型路由的目标协议也支持四类：Go 使用 Claude / Responses / Chat，Zen 另有原生 Gemini。Gemini 3 `functionCall/functionResponse` 会按官方唯一 ID 关联，支持并行结果乱序返回；旧版省略 ID 的同名并行调用会获得请求内唯一 ID，并按调用顺序匹配无 ID 结果。
- 单个 JSON 请求体上限为 10 MiB，模型 ID 会统一修剪首尾空白、拒绝控制字符并限制为 256 个字符，避免空白导致能力表或显式路由未命中；更大的 PDF 或其他文件应先使用目标服务的 Files API 上传，再通过 file ID 引用。
- HTTP 请求目标只接受 origin-form 路径，不接受 absolute-form、network-path、反斜杠或 URL 片段；长度上限为 8 KiB，查询参数最多 64 项，`provider` 与 `window` 等单值参数不允许重复。请求头总量上限为 16 KiB、字段数上限为 128；认证、Cookie、Host、Origin、消息分帧、配置修订和可信代理相关头不允许重复。请求头最长等待 15 秒，请求体最长等待 30 秒，每条 Keep-Alive 连接最多处理 1000 个请求。响应流本身不受这两个接收超时影响。
- 所有 JSON 请求体只接受 `application/json` 或 `application/*+json`，不接受 gzip/br 等压缩 `Content-Encoding`；错误媒体类型返回 415。HTTP/1.1 必须携带 Host，冲突的 `Content-Length` / `Transfer-Encoding` 会在进入应用前由严格解析器拒绝。
- `/models` 与 `/models/{model}` 仅接受 GET，三个推理端点仅接受 POST；方法错误会返回 HTTP 405、标准 `Allow` 头以及目标协议可识别的错误体。
- 已知管理接口的方法不匹配时同样返回 HTTP 405 和准确的 `Allow`，只有不存在或路径参数格式无效的接口才返回 404；受保护接口仍先执行登录校验。
- 通用 `/v1/models` 的 `provider` 查询参数仅接受 `zen`、`go` 或列表场景的 `all`，非法值会明确返回 400，不会静默回退到默认套餐；带 `/zen/v1`、`/go/v1` 的路径始终以路径为准。
- 同协议请求和成功的非流式响应会在最小结构校验后保留厂商扩展字段；同协议流式成功事件原样透传，错误既按 `data.type/data.error` 也按显式 `event: error` / `event: response.failed` 识别、脱敏并终止，避免非标准错误载荷绕过安全规范化。非 2xx 推理响应不会透传任意扩展字段，而会规范化为客户端协议认可的错误结构，并在返回和写日志前脱敏当前上游 Key 与代理地址。跨协议转换覆盖系统提示、文本、拒绝内容、图片及其 `detail`、Claude Documents/Responses/Chat 文件块、采样参数、函数工具、工具选择、新旧工具调用、工具结果、推理强度及 usage；目标为 Responses 或 Chat 时会保留开头 `system` / `developer` 的原始角色层级，Responses 顶层 `instructions` 按 `developer` 指令处理，Claude/Gemini 的 system 转 Responses 时使用 `system` input；只有目标为 Claude 时才合并到顶层 `system`。会话中途的 system/developer 同样保留原始时序和系统优先级，不会被提升后与整段上下文混合。Claude 的纯文本 Documents 转普通 Chat 模型时会保留附件名、context、块顺序与兼容代理使用的 `cache_control` 并内联到用户消息，只有可验证的文本、自定义文本块或 UTF-8 文本 MIME base64 会使用该降级；GPT-5.6 Chat 则可直接接收 base64/file_id `file` 内容块。Claude 的 `tool_result + 后续用户文本` 转 Chat 时会保持合法的 tool → user 顺序。停止词会在 Claude/Chat 目标间转换；Responses 不支持 stop，收到跨协议停止词时返回明确的 400。Responses 的 `previous_response_id`、`conversation`、`background:true`、`store:true`、自动截断、服务端 `prompt` 模板、`max_tool_calls`、`context_management` 压缩和消息 `phase` 依赖 Responses 服务端状态或执行器，跨到 Chat/Claude 时会在调用上游前返回明确的 400，而不会只发送当前 input 造成失忆、漏压缩或行为漂移；Codex CLI 当前使用的 `store:false`、`background:false`、`truncation:disabled`、空 `context_management` 和 `include:["reasoning.encrypted_content"]` 属于可安全转换的无状态组合。 Codex 0.147+ 的 Responses `client_metadata` 是字符串键值形式的客户端遥测，不属于模型上下文；跨到 Claude/Chat 时会先限制键数量、键名和单值大小，再移除并通过 `x-opencode-input-degradations: responses_client_metadata` 与请求日志标记，同协议 Responses 仍原样透传。Responses 与 Chat 之间还会双向保留 `service_tier`（包括 OpenCode Fast mode 扩展的 `fast`）、`safety_identifier`、`user`、moderation 和输出 verbosity。Claude 的 `speed:standard|fast` 会分别映射为 OpenAI/OpenCode 的 `service_tier:default|fast`，反向同理，并通过 `x-opencode-service-adaptations` 与请求日志公开标记；`auto`、`flex`、`scale`、`priority` 等容量层不能等价表示 Claude 速度，转 Claude 时明确拒绝。其余没有 Claude 等价表示的服务控制字段也仍会明确拒绝。Claude 转 GPT-5.6 Responses 或 Chat 时，顶层自动缓存映射为 `prompt_cache_options.mode=implicit`，system、文本、图片和文件等受支持缓存点映射为显式 `prompt_cache_breakpoint`。OpenAI 当前只提供请求级 30 分钟 TTL，Claude 的 5 分钟/1 小时 TTL 因而会标记为 `claude_cache_ttl_to_30m`；工具定义、无法承载断点的工具调用等缓存点或不支持原生缓存字段的目标无法精确映射时标记 `claude_cache_control_dropped`。Responses 与 GPT-5.6 Chat 的 `prompt_cache_options`、`prompt_cache_key` 和受支持内容块断点可以双向转换；OpenCode Chat 消息包装上的 Anthropic 风格 `cache_control` 会映射到该消息最后一个可缓存内容块：转 Claude 时保留 5m/1h TTL，转 GPT-5.6 Responses 时转换为显式断点并标记 30 分钟 TTL 适配；Chat 工具定义和历史 `tool_calls[]` 包装上的 `cache_control` 转 Claude 时会分别保留到对应工具定义与 `tool_use` 块，转 Responses 时因 `function_call` 没有等价字段而标记 `responses_cache_control_dropped`。转 Claude 时自动/显式缓存会转换为顶层或块级 `cache_control`，并以保守的 5 分钟 TTL 执行。无法映射的 OpenAI 缓存 key、旧式 retention 或目标模型不支持缓存字段时分别明确标记。所有状态通过 `x-opencode-cache-adaptations` 与请求日志显示，不再静默丢字段。转 Claude 时 metadata 只保留合法的 `user_id`。Codex CLI 的 Responses `namespace` 工具在转往 Chat/Claude 时会生成稳定、可读且避免冲突的函数别名，历史工具调用和非流式/流式响应会自动还原原始 `namespace` 与工具名；重复的直接函数名、namespace 名或 namespace 子函数名会在请求上游前明确拒绝。Responses `custom` 工具会包装成带单个字符串 `input` 字段的普通函数，原始 grammar 会附在描述中，回传时恢复为自由文本 `custom_tool_call`；客户端 `tool_search` 会包装为普通函数，`tool_search_output.tools` 中动态加载的工具会加入后续上游工具集，调用与输出 ID 保持不变；托管 `tool_search` 所管理的延迟工具会在跨协议时直接展开。响应头 `x-opencode-tool-adaptations` 和请求日志协议字段会明确列出这些适配。Responses 托管型 `web_search` 在原生 Responses 路由中会连同全部配置原样透传。非 Responses 上游无法实际执行该托管工具，跨协议时会保留客户端响应中的原始工具声明、移除发往上游的托管工具并向模型注入明确的能力限制提示；响应头 `x-opencode-tool-degradations: web_search` 和请求日志协议字段会标记这次降级。若原请求用 `required` 同时开放搜索和普通函数，降级后会改为 `auto`，避免强迫模型误调用无关函数。如果必须使用真实托管搜索，请将该模型路由到原生 Responses 上游。Responses 历史 `reasoning` 项跨到 Chat 时会保留为 `reasoning_content`，跨到 Claude 时作为历史助手文本保留；目标协议无法使用的 `encrypted_content` 会被忽略，并通过 `x-opencode-input-degradations: encrypted_reasoning` 与日志协议字段明确标记。如果必须保留加密推理状态，请将模型路由到原生 Responses 上游。Gemini 3 历史 Part 的 `thoughtSignature`（同时兼容 `thought_signature`）会校验并在内部规范化模型中保留；由于它是必须原样回传给 Gemini 的不透明供应商状态，跨到 Responses、Claude 或 Chat 时不会伪造为其他 thinking 字段，而会通过 `x-opencode-input-degradations: gemini_thought_signature` 和日志明确标记。需要完整延续原生 Gemini 思考状态时，必须使用原生 Gemini 上游；桥接不会伪造 `skip_thought_signature_validator`。其他 Responses 内置工具、Claude server tool、非法消息角色、未知内容块、普通 Chat 非文本文件输入及 Chat 无法表达的图片 `file_id` 在跨协议请求时返回 400；上游响应包含目标协议无法表达的图片、文档、未知输出项或流式媒体块时返回明确的转换错误，避免静默丢失内容。跨协议的顶层请求字段、消息/input item、内容块、工具调用/定义、Responses `text` 与结构化输出对象中的未知字段会在访问上游前返回 400；同协议路由继续原样保留厂商扩展。只有文档明确列为最佳努力转换的扩展字段才允许忽略，并会通过响应头和请求日志公开标记。
- Responses `web_search` 跨协议通常按上条降级，但目标是 Zen 原生 Gemini 时有一个严格例外：只有不带额外选项的单个搜索工具可映射为 `googleSearch:{}`；强制搜索、`allowed_tools` 搜索子集、上下文大小、地域或其它 Responses 专属配置都会返回 400，而不会假装等价。原生 Gemini 返回的 grounding chunks/supports 会转换为 Responses URL citations 和搜索词，流式引用保证在文本块完成事件之前发出。
- 上一条所述不透明状态降级只适用于客户端自行带入、并非本桥接生成的模型绑定状态。桥接在客户端输出协议允许时会用经过校验的可逆封装保留 Claude `thinking.signature`/`redacted_thinking`、Responses `encrypted_content` 和结构化 Chat `reasoning_details`，下一轮回到原上游协议时再逐字还原；封装在解码时会严格核对协议、状态种类、字段白名单及原始块结构，夹带未知供应商字段的伪造封装不会绕过正常协议校验。流式与非流式 Gemini 客户端工具轮次会把一个或多个状态封装到首个 functionCall Part 的 `thoughtSignature`，并行的后续调用不重复携带；没有工具调用时则绑定到最后一个可读 thought Part，必要时使用不可见状态 Part。回流时先拆开并移除桥接封装，并且只消除与封装状态数量相同的可读 thought 副本，因此不会误删内容相同的独立思考块，也不会把其它供应商密文发给 Google 上游。发往原生 Gemini 上游时只回传真正来自 Gemini 的 Part 和 `thoughtSignature`，其它供应商的密文会按降级标记移除，绝不伪造 Google 签名。对于会丢弃 `reasoning_details` 或 provider metadata 的 OpenCode 交叉配置，服务还会使用最长 10 分钟、最多 1024 项/32 MiB 的进程内缓存补回状态；缓存作用域使用无歧义编码同时包含客户端、请求模型、实际 provider、实际上游模型和目标协议，缓存键再加入工具调用 ID、工具名及规范化参数，避免同名 Zen/Go 模型、路由切换或并发会话串入其它供应商状态。缓存仅是短时兼容兜底，跨实例、重启或超时后不能代替客户端回传。
- Responses 历史项的 `id/status` 会在跨协议前严格校验；由于 Chat/Claude 没有等价的项级元数据字段，转换时通过 `x-opencode-input-degradations: responses_item_metadata` 与请求日志明确标记。消息正文、工具 `call_id`、工具名称、参数和历史顺序仍完整保留；非法状态不会被静默接受。
- Chat 跨协议只接受单候选 `n=1` 和纯文本输出 `modalities:["text"]`；多候选、音频输出、predicted output、`logit_bias` 与 Chat 托管 `web_search_options` 无法由目标协议和返回结构完整表达时会明确返回 400。旧式 `functions`/`function_call` 会转换成目标协议的现代函数工具和强制工具选择，不需要客户端先升级请求格式。
- 跨协议配置不会再依赖 JavaScript 真值转换：Claude `tool_choice.disable_parallel_tool_use` 与 Responses/Chat `parallel_tool_calls` 必须是布尔值，错误的字符串或数字会在访问上游前返回 400。三种协议的 `tool_choice` 会按各自官方形状和枚举解析，强制函数必须引用本轮实际定义的工具；未知对象、空函数名和缺失工具不会再变成未设置或无效的目标选择。Chat `logprobs`、Chat/Responses `top_logprobs`（0–20）、函数工具和 JSON Schema 的 `strict` 也按官方类型校验。Claude/Chat 的 `messages`、三种协议的 `tools`、Responses 的数组式 `input`、Claude 的块式 `system` 及 Chat 历史 `tool_calls` 都必须使用官方容器形状，不再把单对象自动包成数组；metadata 必须是对象，发往 Responses/Chat 时进一步限制为最多 16 个、键名最长 64 字符、值最长 512 字符的字符串键值对，转 Claude 时 `user_id` 会校验为最长 512 字符的非空字符串。停止词同样按来源和目标协议校验：Claude 只接受字符串数组，Chat 接受字符串或最多 4 项的字符串数组，超过 Chat 上限或包含非字符串时会在访问上游前返回 400。三种协议的输出 token 上限、`temperature`、`top_p`，以及 Chat 的 seed/惩罚项会校验安全整数、有限数字和官方范围；Chat 同时设置 `max_tokens` 与 `max_completion_tokens` 会明确拒绝，不会把 `0` 或错误字符串丢成默认 8192。OpenAI/Gemini 的 `temperature > 1` 虽可由来源协议接受，但转 Claude 时会在上游前提示不兼容；同协议请求仍完整透传给原生上游处理厂商扩展。
- Chat `tool_calls`/旧式 `function_call` 与 Responses `function_call`、`custom_tool_call`、客户端 `tool_search_call` 的历史调用在跨协议时会严格校验调用对象、非空 ID、非空名称和 JSON 对象参数；对应的 tool/function/custom/search 结果必须携带非空关联 ID，要求输出的类型也不能缺少 `output`。对象形式的兼容参数会继续接受并按稳定键序编码，损坏 JSON、标量参数、空调用项、同时携带新旧 Chat 调用字段或缺少关联字段时会在访问上游前返回 400，不再生成缺字段请求、把损坏参数二次编码成字符串或泄漏为内部 500。
- Claude、Responses、Chat 与内部规范化的 Gemini 请求都严格要求 `stream` 为布尔值，不会把字符串、数字、`null` 或对象按 JavaScript 真值静默改成流式模式。Gemini 的模型和流式模式由 URL 路径决定，因此客户端正文中的 `model`、`stream` 会被明确拒绝而不是覆盖。Responses 与 Chat 跨协议流还会严格校验 `stream_options`，并要求同时设置 `stream:true`。`include_obfuscation` 默认启用时，Bridge 会给重编码后的 OpenAI delta 添加随机 `obfuscation`，并把 JSON 数据填充到 256 字节边界；显式设为 `false` 时不添加。Chat 的 `include_usage:true` 会按标准为普通 chunk 填入 `usage:null`，并在 `[DONE]` 前生成独立的 `choices:[]` 用量 chunk，不再把 usage 混进 finish chunk。跨协议生成的 Responses 对象还会回显 instructions、metadata、采样、工具选择、持久化、文本格式、截断和推理等客户端配置，并区分 `completed_at`、`error` 与 `incomplete_details`。模型主动拒答会作为 Responses `refusal` 内容块或 Chat `message/delta.refusal` 保留，转换到 Claude 时使用文本内容配合 `stop_reason: refusal`，转换到 Gemini 时使用 `SAFETY`；它与没有拒答正文的内容过滤终止分开处理，不会被混入普通 assistant 文本。内容过滤会映射为 Responses `content_filter`、Chat `content_filter`、Claude `refusal` 或 Gemini `SAFETY`，上下文/输出上限映射为各协议的截断状态；即使响应里已有工具调用，过滤或截断也优先于工具完成状态，避免客户端执行不完整参数。流式 Responses 的 `output_item.done` 会等最终状态已知后再发，并把截断项标记为 `incomplete`。非流式与流式 Responses/Chat 互转会保留上游创建时间和实际 `service_tier`；Chat 专属的 `system_fingerprint` 不会伪装成 Responses 字段。
- Responses 流式 message 使用 `output_index + content_index` 独立维护每个 `output_text`/`refusal` 内容块；同一 output item 包含多段内容、增量先于 added 到达，或只有 `content_part.done`/`output_item.done` 完整值时都会逐块恢复，不再拼接、覆盖或重复输出。Responses reasoning item 的合法 `reasoning_text` content part 也会与摘要增量共用独立推理状态并从完整事件补齐。相同 `content_index` 中途改变内容类型会作为损坏的上游事件明确失败。
- Responses `output_text.annotations` 及流式 `response.output_text.annotation.added` 会严格校验 URL、文件、容器文件和生成文件引用；URL 引用转 Gemini 时使用原生 `groundingMetadata`，相同文本区间的多个来源会合并为一个 support，重复来源只生成一个 chunk。Claude、Chat 以及 Gemini 无原生对应结构的文件引用仍在文本块末尾追加去重后的 `Sources` 列表。Responses 历史 assistant 消息转其它协议时使用相同策略，转回 Responses 时仍保留原生 annotations 数组；越界的 URL 引用索引不会被伪造成 Gemini grounding support。
- 可读的历史推理文本不会在跨协议时静默消失：DeepSeek 等支持 `reasoning_content` 的 Chat 模型使用该字段，Responses 与 Claude 目标保守转换为历史 assistant 文本，Gemini 目标使用 `thought:true` 文本；响应头与请求日志分别标记 `reasoning_history_to_chat_reasoning_content`、`reasoning_history_to_assistant_text` 或 `reasoning_history_to_gemini_thought`。该策略覆盖 Gemini `thought: true`、Claude `thinking`、Responses reasoning 的多段 `summary_text`/`reasoning_text` 和 Chat reasoning 历史；Responses 历史推理的数组、块类型、文本与 `encrypted_content` 会严格校验，不再把对象转换为 `[object Object]` 或忽略畸形状态。客户端自行带入的外部不透明签名或加密状态仍按上一条单独标记，绝不伪造为其他供应商状态。
- 跨协议请求不会再把空消息悄悄删掉：Claude/Responses 的消息内容，以及 Chat 的 system/developer/user/tool 普通消息，必须包含非空文本或非空内容块；Chat assistant 只有在携带合法工具调用、拒答、可读推理或 reasoning state 时才允许 `content:null`。三种协议还会按 role 校验内容块，例如 `tool_use` 只能位于 Claude assistant、`tool_result` 只能位于 Claude user，system/developer 不能夹带图片，Responses/Chat user 不能伪装 `output_text`/`refusal`，避免合法容器中的局部块被丢弃或发成目标协议非法结构。Chat 历史消息的 `name` 和 `audio` 没有等价目标字段，因此会在访问上游前明确返回 400；`refusal`、`reasoning_content`、`reasoning`、角色专属工具字段及其冲突组合也会严格校验。Chat `reasoning_details` 中可读的 text/summary 会转成历史推理文本，外部签名或加密状态通过 `x-opencode-input-degradations: chat_reasoning_state` 标记，未知 detail 类型不再静默忽略。
- Claude 原生续轮仍会完整透传普通 `thinking` 块（包括空的 `thinking` 文本及其 `signature`）和 `redacted_thinking.data`。转往 Responses/Chat/Gemini 时，可读 thinking 按上一条保留，但模型绑定的签名与安全脱敏密文会在校验后移除，并分别通过 `x-opencode-input-degradations: claude_thinking_signature`、`claude_redacted_thinking` 和请求日志标记；这样既不会把密文伪装成其他协议内容，也不会因为安全脱敏块而丢弃整个工具续轮。
- Claude Code 会把运行中收到的新用户消息包装为中途 `system` 消息；跨到 Chat/Responses/Gemini 时桥接会识别该固定包装并恢复为 `user` 角色，避免非 Claude 上游忽略引导，同时这类消息不会进入系统提示词改写和预览统计。`messages/count_tokens` 使用本地、无上游计费的保守估算并通过 `x-opencode-token-count: estimated` 标明口径，主要用于保证 Claude Code `/compact` 等客户端流程可用，不应把结果当作供应商账单的精确 token 数。估算器按 Claude 的实际上下文装载方式排除尚未被 `tool_reference` 加载的 `defer_loading: true` 工具和已经结束轮次的 thinking，工具一经加载则计入完整定义，同时保留当前工具调用链 thinking；base64/URL 图片按当前高分辨率档的每图 4784 visual-token 上限估算，不再把编码后的图片字节误当成文本 token。
- Claude Code 旧式手动 `/compact` 会先调用 `messages/count_tokens`，再发送一条要求模型生成摘要且禁止工具的普通消息；桥接继续按普通对话转换。Anthropic 新版服务端自动压缩则返回 `type: "compaction"` 内容块和流式 `compaction_delta`：跨协议响应会把可读 `content` 映射为 reasoning 摘要，并把 `encrypted_content` 放入经过结构校验的可逆状态封装，客户端把该响应带回后可恢复原始 Claude 块。若客户端直接把 Claude 专属加密压缩状态发往非 Claude 上游，摘要正文仍会保留，但密文不能伪装成其它厂商状态，因此通过 `x-opencode-input-degradations: claude_compaction_encrypted_content` 与请求日志明确标记。
- OpenAI Responses 的 `/responses/compact` 不会被伪装成 Chat/Claude/Gemini 的“等价压缩”：只有路由协议为 `responses` 时才会把请求原样发往上游。OpenCode 当前公开的 Zen/Go 模型表只承诺各模型的 `/responses`、`/messages` 或 `/chat/completions` 主端点，没有单独承诺 `/responses/compact`；因此该入口面向实际实现此扩展的上游，若 OpenCode 未开放会保留其规范化错误。其 `type: "compaction"` 输出项没有可读摘要，跨协议响应时会放入经过类型、ID、密文与来源字段校验的可逆状态封装；Claude、Chat 或 Gemini 客户端把该状态带回原 Responses 模型后，会恢复为原始 compaction 输入项。客户端直接把原生 Responses compaction 发往其它协议时，密文会被移除，并通过 `x-opencode-input-degradations: responses_compaction_state` 明确标记。
- Claude Code 当前请求中的 `context_management.edits: [{"type":"clear_thinking_20251015","keep":"all"}]` 在 Claude 原生路由保持透传，跨到 Responses/Chat 时由桥接以“保留全部历史 thinking”精确执行，并通过 `x-opencode-context-adaptations: claude_keep_all_thinking_local` 标记。其它会实际删除历史或触发服务端压缩的 context-management 策略无法由非 Claude 上游等价执行，因此明确返回 400。Claude `defer_loading: true` 工具在跨协议时不再错误暴露给模型：尚未加载的定义会隐藏并标记 `deferred_tools_hidden`，由标准 `tool_reference` 加载后则携带完整 schema 发往上游并标记 `deferred_tools_loaded`；Claude Code 当前使用的 `ToolSearch` + 文本 `<functions>` 路径保持原样。若全部工具都延迟加载、强制选择未加载工具，或引用不存在/非延迟工具则明确拒绝。Claude、Responses 与 Chat 函数工具间的 `strict` 标记也会双向保留。
- Claude 自定义工具的 `input_examples` 跨协议时会以稳定 JSON 附加到 function 描述；`allowed_callers` 只有 `direct` 时与普通 function 默认语义等价，同时包含 code-execution 调用方时仅保留 direct 并标记 `allowed_callers_direct_only`，完全不允许 direct 时明确拒绝；`eager_input_streaming: true` 使用现有流式参数增量做最佳努力适配。这些转换均通过 `x-opencode-tool-adaptations` 和请求日志标记。除下一条的 Web Search 特例外，带 `type` 的 Claude server tool 或 Anthropic-schema tool 依赖 Claude 服务端执行和专属响应块，不能被伪装成普通客户端 function，因此跨协议返回 400；路由到 Claude 原生上游时仍完整透传。
- Claude → Chat 的 typed `web_search_YYYYMMDD` 与 Claude Code 固定结构的客户端 `WebSearch` 是受限特例：管理面板默认开启“为 Claude Code 启用本地 Web Search”后，Bridge 会移除原工具，向 Chat 模型注入内部小写 `web_search` function；这同时规避 DeepSeek V4 Flash 偶尔把 `WebSearch` 输出成 DSML 文本而非标准工具调用的问题。模型调用后由 Bridge 请求最新版 OpenCode CLI 使用的 Exa/Parallel MCP 搜索后端，将受限长度的结果作为 Chat tool result 送回模型并继续到最终回答；同一轮多个搜索会并发执行、按原调用顺序回填并共同受 `max_uses` 限制。面板可选择自动、仅 Exa 或仅 Parallel；自动模式优先 Exa，并在普通搜索失败时回退 Parallel。Claude 的裸域名 allow/block 列表和两位国家定位会通过 Exa Advanced 原样执行；路径/通配符域名因后端语义不同而明确拒绝。搜索结果会移除明显的 WAF/验证码片段，并附加“不可信外部资料”边界，模型仍须核对权威来源并提供 URL。`web_search_20260209` 及更高版本默认依赖 Claude code execution，跨到 Chat 时必须显式包含 `allowed_callers:["direct"]`；旧版默认 direct。流式 Claude 请求会在内部完成工具循环后重编码为 Claude SSE，因此首个 token 需等待搜索和最终模型响应。typed 工具每请求最多执行声明的 `max_uses`（桥接上限 8），客户端 `WebSearch` 默认最多 5 次；查询会发送给选中的搜索服务。Bridge 会把每次实际 MCP 尝试编码为 Claude 可识别的 `server_tool_use` / `web_search_tool_result` 块，并在 `usage.server_tool_use.web_search_requests` 中返回同一计数，因此 Claude Code 的 `Did N searches` 与管理日志的 `bridgeWebSearchCalls` 可以交叉核对；结果块中的标题和 URL 来自 MCP 返回内容，`encrypted_content` 是仅供 Bridge 回环兼容的本地不透明标记，并非 Anthropic 搜索密文，后续 Claude → Chat 历史会将它安全降级为可读来源。响应头和请求日志会标记 `claude_web_search_to_mcp`，并记录实际 `bridgeWebSearchCalls`。
- Claude `tool_result.is_error` 会严格校验为布尔值；转 Responses/Chat 时，目标协议没有独立失败状态字段，Bridge 会在结果正文前加入稳定的 `[Claude tool_result is_error=true]` 标记，并通过 `x-opencode-tool-adaptations: claude_tool_error_to_content` 与请求日志公开这次适配。转 Gemini 时使用原生 `functionResponse.response.error` 对象，不需要正文标记；Claude 原生路由仍原样透传。
- Claude 新版响应中的 `container`、`context_management`、`diagnostics`、结构化 `stop_details`，以及 usage 的缓存 TTL 明细、fallback credit、推理地域、迭代明细、服务端工具计数和独立容量层级都不是 Responses/Chat/Gemini 的等价字段。跨协议非流式成功响应会通过 `x-opencode-response-degradations` 精确列出实际出现但无法表达的字段；流式响应因 HTTP 响应头已在首个事件前发送，会把同一列表写入请求日志。缓存写入总量继续映射到目标 usage，Claude 的 5 分钟/1 小时写入 Token 还会分别保存在日志、管理面板和 CSV 中，不会只剩一个无法审计的合计值。同协议 Claude 路由仍原样透传全部元数据。
- Responses/Chat function 的 `description` 必须是字符串，`parameters` 必须是 JSON Schema 对象；跨协议前即拒绝错误定义，不会把对象 description 或字符串/数组 schema 发送给上游。Chat tool 消息的文本块会按顺序拼成真实结果文本，并严格校验每个 `text`，不再把整组内容块 JSON 序列化成模型可见的伪结果。
- GPT-5.6 Responses Programmatic Tool Calling 在 Responses 原生路由中完整透传，包括 `programmatic_tool_calling`、`allowed_callers`、`output_schema`、`program`、`program_output` 以及 `caller` 关联。跨到 Claude/Chat/Gemini 时不会伪造托管 JavaScript 运行时：同时允许 `direct` 的工具会保留 direct 调用、移除程序调用入口并通过 `programmatic_tool_calling_disabled`/`allowed_callers_direct_only` 标记，`output_schema` 会稳定附加到工具描述并标记 `output_schema_to_description`；仅允许 `programmatic`、强制选择 PTC、或已经包含程序运行历史的请求会返回明确的 400，提示改用 Responses 原生路由。
- Responses `tool_choice.allowed_tools` 跨协议时会按完整工具表解析 function/namespace 别名，但只把本轮允许的工具定义发送给 Claude/Chat 上游；`mode: auto|required` 分别映射为目标协议的自动/必须调用模式，并通过 `allowed_tools_filtered` 标记。这样既不会把禁止调用的写操作暴露给目标模型，也不会因未选择工具的名称冲突改变已选择 namespace 工具的回传身份。空列表、重复项、未定义工具、非法 mode，以及 `required` 仅选择不可执行托管工具时会明确返回 400；Responses 原生路由仍保留完整工具表，以继续享受提示缓存。
- DeepSeek V4 Flash / V4 Flash Free 的 Chat 工具调用在未显式请求推理时会自动设置 `reasoning_effort: "none"`，避免模型默认 Thinking 模式拒绝工具；客户端显式启用 Claude thinking 时不会静默覆盖其选择。DeepSeek V4 Flash / Pro 支持的 `high` / `max` 强度会从 Claude Code `output_config.effort` 转成顶层 `reasoning_effort` 原样发给 Chat 上游；真实 Claude Code 隔离探针会强制验证 `max` 不被丢弃。对配置中选中的文本模型，桥接服务监听本机回环地址时会将 Claude base64 图片暂存到当前进程的系统临时目录，并把绝对路径作为文本交给 Claude Code 的 vision 技能；本地附件默认在最后使用 24 小时后删除，正常退出会清理全部副本。Render Web Service 会校验平台提供的 `RENDER_EXTERNAL_HOSTNAME` 并默认生成 15 分钟有效的随机附件 URL，其它远程部署或自定义域名可配置 `OPENCODE_BRIDGE_IMAGE_HANDOFF_PUBLIC_URL`，提示客户端先下载到本机临时文件再调用 vision 技能。远程基址不可用或显式关闭交接时，图片会替换为明确的“图片未发送”文本提示，历史消息中的图片也会处理，以避免文本上游因图片内容块返回 400。短时 URL 是无需额外请求头的能力链接，请只在可信的 HTTPS 部署中启用；如果没有可读取本机文件或下载 URL 的 vision 技能，请改用原生支持视觉输入的模型。
- 请求日志默认仅保存在内存中；管理面板可启用有界持久化，文件为 `data/request-logs.json`。日志不包含提示词、响应正文或密钥，启动时的并发请求只共享一次旧日志加载，写盘会在短时间窗口内合并，并在管理读取或服务正常退出时强制刷新；配置和日志都通过独占临时文件、文件同步与原子重命名落盘，普通写入失败会立即清理临时副本，异常退出遗留的固定副本会在下次加载时清理。临时写盘失败会保留内存中的待写状态供下次刷新重试。关闭持久化会取消尚未执行的延迟写盘，但不会自动删除已有文件；需要删除历史内容时再点击“清空记录”。请求记录列表会直接显示使用的 Key 槽位、面板 Key 名称和自动切换尝试次数，并支持按这些字段筛选，便于把 401/429/代理错误关联到具体 Key。
- 管理面板“用量统计”按全部记录、最近 24 小时或最近 7 天汇总请求数、成功率、自动 Key 切换次数、平均/P95 耗时以及输入、输出、缓存读取、缓存写入和推理 token，并可按上游、实际模型、协议转换、客户端和 Key 槽位拆分；每个分组同时显示总耗时、上游等待和响应体阶段的平均/P95，时间趋势悬浮提示会显示该时段的平均阶段耗时。上游等待累计所有 Key 尝试中的连接、排队与等待响应头时间，响应体阶段从最终响应头到完成响应体读取与转换，流式请求还包含向客户端传输及背压等待。Key 表还展示当前健康状态、连续失败、冷却截止时间、实时剩余时间与最近事件。Key 统计只保存“环境变量编号/面板 Key”等安全标识，不保存密钥内容。请求记录会同时显示本地请求 ID、最终上游请求 ID、限流等待时间和安全错误码；连接超时、响应超时、DNS、拒绝连接、意外断连与 TLS 故障会分开标识，不回显底层 URL 或代理凭据。日志支持按关键词、错误码、时间、上游、成功/4xx/429/5xx 组合筛选，可复制两类请求 ID，并能将当前筛选结果导出为防公式注入的 UTF-8 CSV，便于关联排障。页面提供最近 24 小时、7 天或 14 天的请求/Token 趋势。统计会统一 OpenAI“缓存读取是输入子集、缓存写入为独立指标”和 Claude“缓存创建字段独立于普通输入”的两种 usage 口径：缓存写入不再从 OpenAI 的未缓存输入中重复扣除。跨协议响应和统计会把上游 usage 的数字字符串规范为整数，拒绝负数、非整数与非有限值，并将极端大值钳制到安全整数范围；同协议响应正文仍原样透传。统计只基于当前最多 1000 条保留日志；推理 token 是输出 token 的明细项，不会重复加总。上游没有返回有效 usage 时会计入“缺失用量”的请求数。由于 OpenCode 各模型的缓存价格会变化，面板不估算账单金额，应以 OpenCode 官方账单为准。
- 管理面板只有配置读取是启动强依赖；请求日志、运行状态、客户端列表、用量统计或 Claude 提示词快照短暂失败时，页面会继续显示上一次成功数据，并在顶部列出未更新的数据源。后续刷新成功会自动清除对应告警。

## 安全建议

- 默认只监听 `127.0.0.1`。公网部署应放在带 TLS 的反向代理后面。
- 管理面板使用严格 CSP，配置变更接口校验完整 Origin（协议、主机与端口）并拒绝浏览器标记为 cross-site 的请求；服务端返回的模型名、Key 名称、日志字段和其它动态值在进入 HTML 文本或属性前统一转义，浏览器端不使用 localStorage/sessionStorage 保存密钥。
- 入站 JSON 使用严格 UTF-8 解码并按用途限制体积：普通管理请求 64 KiB、完整配置 2 MiB、提示词预览约 2.1 MiB、推理请求 10 MiB。解析后还会用非递归遍历限制为最多 256 层容器和 250000 个 JSON 值，大文本或 base64 只计一个值；深度或节点数超限会在协议适配前返回 400/413。声明长度和 chunked 实际内容都会执行同一上限，超限时丢弃剩余输入并可靠返回 413；鉴权失败、媒体类型错误等提前响应会对尚未上传完的非只读请求强制关闭连接，避免慢上传在释放应用并发槽后继续占用 Keep-Alive。上传中途断开会静默释放公开或管理并发槽，不会打印误导性的服务器异常。推理请求从入口就绑定客户端取消信号，因此在图片交接或协议转换期间断开也不会继续发起孤立的上游请求；模型发现同样会立即取消上游读取且不会惩罚对应 Key。
- 上游非流式 JSON、模型目录、每个 SSE `data` 事件以及字符串形式的工具参数也执行相同的 256 层/250000 值非递归复杂度检查。异常上游内容会在进入递归协议适配前停止，非流式返回安全 502，流式返回当前客户端协议的安全错误帧；不会因单个异常响应惩罚或熔断对应 Key。
- `data/config.json` 包含上游密钥，已被 `.gitignore` 排除；请限制该文件的系统权限并做好安全备份。配置加载有 2 MiB 安全上限，并在启动、保存和局部更新时统一校验全部字段。旧配置缺少的字段会补默认值，旧 Key 池与提示词规则会迁移；未知字段会丢弃，错误类型、越界数值和不支持的配置版本会明确拒绝启动，避免损坏配置静默绕过并发或超时限制。
- 生产环境建议设置 `CONFIG_ENCRYPTION_KEY`。启用后，Zen/Go Key 池中的每把密钥及其独立代理、客户端令牌、会话密钥和默认代理 URL 都会分别使用 AES-256-GCM 保存；主密钥丢失后无法恢复这些字段。
- 轮换配置主密钥前先停止服务，然后执行以下命令。操作前应备份 `data/config.json`：

```powershell
$env:OLD_CONFIG_ENCRYPTION_KEY = "旧主密钥"
$env:CONFIG_ENCRYPTION_KEY = "新主密钥"
npm run rekey
```
- 首次初始化采用单飞写入并在保存前重新读取最新配置；并发或延迟到达的初始化请求不能覆盖已经设置的管理密码。所有持久化管理操作都会绑定请求开始时的配置修订，即使 API 调用方省略 `If-Match`，并发旧快照也会返回 412 而不是覆盖较新的设置；显式携带管理 API 返回的 ETag 仍是跨请求更新的推荐方式。管理密码使用随机盐的 scrypt 哈希保存；登录 Cookie 为 HttpOnly、SameSite=Strict，可信 HTTPS 反向代理下同时启用 Secure 与 HSTS。
- 命名客户端令牌由高强度随机数生成，配置中仅保存不可逆摘要；主访问令牌仍受 `CONFIG_ENCRYPTION_KEY` 加密保护。
- 请求日志不包含提示词、响应正文或密钥。持久化默认关闭，启用后应像其他运行日志一样限制文件访问权限。
- 依赖安装默认关闭第三方生命周期脚本并使用 `package-lock.json`；CI 固定第三方 Action 的完整提交 SHA，执行生产依赖漏洞与 npm 注册表签名审计，并为 Node 24 构建生成保留 14 天的 CycloneDX SBOM。也可在本地运行 `npm run --silent sbom:prod` 输出依赖清单。
- `/healthz`（兼容别名 `/health`）中的 `ready` 只有在管理密码、至少一个可用客户端令牌和至少一个上游密钥均已配置时才为 `true`。

## 验证

```powershell
npm test
npm run check
npm run check:catalogs
npm run test:cli:installed
```

`npm run check` 会自动发现并语法检查 `src`、`public`、`scripts` 与 `test-fixtures` 下的全部 JavaScript 文件，再运行完整测试；新增源码文件无需手工维护检查名单。默认测试不调用真实 OpenCode 接口，因此不会产生费用。

`npm run check:catalogs` 不读取任何 Key，也不发送推理请求；它会在线对比 OpenCode Zen/Go 当前 `/models`、官方文档端点表和 models.dev 输入模态/限制。发现新模型、原生协议变化、视觉能力或上下文限制漂移时会以非零状态退出；单独检查时可使用 `npm run check:zen-catalog` 或 `npm run check:go-catalog`。

`npm run test:cli:installed` 会调用当前 `PATH` 中已安装的 Codex CLI、Claude Code 和 OpenCode。在系统临时目录中，Codex/Claude Code 会先对隔离的原生 Responses/Messages 模拟端点完成工具调用闭环，再经过本项目 Bridge 转到模拟 Chat 上游；OpenCode 则加载管理面板生成器同款配置，验证 Go 的 Responses、Claude Messages、Chat Completions 以及 Zen 的 Gemini 模型分别请求 `/go/v1/responses`、`/go/v1/messages`、`/go/v1/chat/completions` 和 `/zen/v1/models/{model}:streamGenerateContent?alt=sse`。四种原生 SDK 都会执行一次临时文件 `read`，核对续轮带回各自的工具结果；Gemini 还会核对 `thoughtSignature` 原样回传。随后探针让真实 OpenCode 经过 Bridge 完成 Responses、Claude、Chat、Gemini 四者之间全部 12 个有向跨协议流式工具调用闭环，并逐字核对 Responses `encrypted_content`、Claude thinking/redacted thinking、Gemini `thoughtSignature` 等不透明状态。整个过程不会连接真实模型接口，也不会读取或输出真实上游 Key；报告只列出协议角色、输入项类型、工具名称和模拟路径等结构摘要。

如需用临时 Go Key 对官方 `deepseek-v4-flash` 做小额度在线冒烟测试，可在当前 PowerShell 会话设置 `OPENCODE_GO_KEY` 后运行 `npm run test:live:go`。默认 `full` 档会通过本地 `/go/v1` 验证模型发现、Responses 非流式正文与标准流事件、Claude 工具名与参数、Claude 工具结果回送后的续答、Chat SSE 正文与 usage，并登录临时管理会话核对五次请求的统计守恒及时间趋势阶段耗时覆盖；只输出状态和 usage，Key 不写入项目配置或日志，临时加密配置和元数据日志只写入独立的系统临时目录并在结束时整体删除，不会短暂污染仓库 `data` 目录。只需验证 Go 上游与基础 Responses 转换时，可设置 `OPENCODE_LIVE_PROFILE=quick`，它仍会先验证模型权限，然后只发送一次小型 Responses 请求并核对一条统计记录。测试失败时输出会列出已完成阶段和安全错误码，便于区分 Key/模型问题与连接故障。默认单请求超时为 60 秒；若上游临时拥塞，可在当前会话设置 `OPENCODE_LIVE_TIMEOUT_MS`（10000–600000）后重试。仅在模型列表端点拥塞、且已知模型名正确时，可临时设置 `OPENCODE_LIVE_SKIP_MODEL_DISCOVERY=1` 继续验证实际生成协议；该模式会在输出中明确标记跳过了模型发现。测试后可执行 `Remove-Item Env:OPENCODE_GO_KEY` 清除当前会话变量。
