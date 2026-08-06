# OpenCode Protocol Bridge

一个自托管的 OpenCode Zen / Go 协议中转服务。客户端可使用 Claude Messages、OpenAI Responses 或 Chat Completions 协议；服务会按模型选择 OpenCode 官方端点，并转换请求与响应格式。

## 功能

- `POST /zen/v1/messages|responses|chat/completions`：强制转发到 OpenCode Zen
- `POST /go/v1/messages|responses|chat/completions`：强制转发到 OpenCode Go
- `POST /v1/messages|responses|chat/completions`：兼容入口，按模型路由选择上游
- OpenCode Zen / Go 密钥和模型路由
- 每个 Zen / Go Key 可独立配置 HTTP、HTTPS、SOCKS4、SOCKS4a、SOCKS5、SOCKS5h、Clash/mihomo mixed-port，或由 sing-box 托管的 hy2 / TUIC / VLESS / VMess / Trojan / Shadowsocks / Hysteria 分享链接
- 工具调用、工具结果、并行工具开关、文本消息、图片精度字段，以及 Claude Documents 与 Responses 文件块转换
- Claude thinking、Responses reasoning 摘要与 Chat reasoning_content 转换
- Claude thinking/output effort 到 OpenAI reasoning effort 的模型感知映射
- DeepSeek / Kimi / Moonshot 工具历史 reasoning_content 兼容
- o1/o3/o4 Chat 参数、兼容代理 cache_control 与缓存 token 统计
- refusal、旧版 function_call、Responses `cache_write_tokens` 及其它 usage 字段别名与 Chat 分段内容兼容
- 同协议安全透传 `anthropic-version`、`anthropic-beta` 与 `openai-beta` 功能协商头
- Claude system 提示词精确删除/替换规则与进程内最近请求对比
- 流式事件乱序缓冲、done 内容兜底、Read 参数清理与稳定 JSON 序列化
- 非流式上游响应、错误正文和模型列表均有独立体积上限；模型发现成功响应会校验 `data` 数组、模型数量和 ID；模型发现与推理错误统一转换为目标协议兼容的安全 JSON，只保留受限的消息、类型和错误码，不会把上游 HTML、调试字段、代理错误页或回显凭据直接透传；损坏 JSON 会返回稳定的本地错误并写入元数据日志
- 无代理直连复用连接池并自动择优 IPv4/IPv6，避免高延迟网络被默认 10 秒建连上限过早中断
- 同协议 SSE 实时透传；跨协议 SSE 逐事件实时转换，响应禁止缓存和中间代理内容变换
- `GET /v1/models` 模型发现端点
- 可直接导入的 `/openapi.json` OpenAPI 3.1 描述
- 带首次初始化、密码登录和访问令牌的管理面板
- 管理面板静态资源流式传输，支持 HEAD、ETag 条件缓存并阻止目录外符号链接
- 管理面板按数据源独立刷新，单个日志、状态、统计或提示词接口失败时保留旧数据并持续显示降级告警；并发刷新只提交最新结果并主动取消旧请求，配置保存使用修订号阻止跨页面覆盖，并保护尚未保存的表单草稿
- 可单独停用、撤销和限制并发的命名客户端令牌
- 管理端变更请求具有独立并发上限；设置、Key 池、命名客户端、主令牌和密码等持久化变更均使用配置修订号防止多页面覆盖
- 管理面板的上游模型发现具有独立并发上限并在运行状态中可观测，避免多标签页同时刷新占满连接
- HTTP 层限制总连接数、请求头体积/数量和单连接复用次数，并以 1 秒粒度检查慢头部与慢请求；已建立的 SSE 长响应不设置总时长上限
- 流式推理、超过 64 KiB 的 JSON、远程图片附件和静态文件响应均遵守下游背压；客户端持续停止读取时会在可配置超时后断开并释放上游连接、文件读取租约和并发槽，不会惩罚对应 Key
- 仅记录请求元数据的日志
- 可选的有界请求日志持久化

OpenCode 当前官方端点见 [Zen 文档](https://opencode.ai/docs/zen) 和 [Go 文档](https://opencode.ai/docs/go)。本项目默认使用：

- Zen：`https://opencode.ai/zen/v1`
- Go：`https://opencode.ai/zen/go/v1`

## 快速启动

要求仍受支持的 Node.js 22.20+ 或 24.11+；仓库使用 `.node-version` 固定 Render 和本地默认版本为 Node.js 24.18.0。

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
| `OPENCODE_ZEN_KEY` / `OPENCODE_GO_KEY` | 空 | 单 Key 兼容变量 |
| `OPENCODE_ZEN_KEY_1...32` / `OPENCODE_GO_KEY_1...32` | 空 | 多 Key 编号变量；按编号轮询使用 |
| `OPENCODE_ZEN_KEYS` / `OPENCODE_GO_KEYS` | 空 | 多 Key 合并变量，支持 JSON 数组、逗号或换行分隔；优先于编号变量 |
| `OPENCODE_PROXY_URL` | 空 | 环境变量引导时写入默认代理 |
| `OPENCODE_ZEN_PROXY_URL` / `OPENCODE_GO_PROXY_URL` | 空 | 环境变量引导时写入每个 Key 的独立代理 |
| `OPENCODE_ZEN_PROXY_URL_1...32` / `OPENCODE_GO_PROXY_URL_1...32` | 空 | 与编号 Key 一一对应的代理；缺省时回退到提供方代理和默认代理 |
| `OPENCODE_ZEN_PROXY_URLS` / `OPENCODE_GO_PROXY_URLS` | 空 | 与 `*_KEYS` 对应的代理列表；需要跳过某项时使用含空字符串的 JSON 数组 |
| `OPENCODE_BRIDGE_DEFAULT_PROVIDER` | `zen` | 环境变量引导时的默认提供方：`zen` 或 `go` |
| `OPENCODE_BRIDGE_IMAGE_HANDOFF` | 本机回环监听时开启 | 将设置页所选 Chat 模型的 Claude base64 图片暂存为本地文件，并把路径交给 Claude Code 的 vision 技能；远程部署默认关闭 |
| `OPENCODE_BRIDGE_IMAGE_HANDOFF_DIR` | 系统临时目录 | 图片交接文件的父目录；每个进程使用独占子目录并在正常退出时清理 |
| `OPENCODE_BRIDGE_IMAGE_HANDOFF_MAX_BYTES` | `268435456` | 图片交接临时文件总容量，范围 1048576–10737418240 字节（1 MiB–10 GiB）；设为 `0` 不限制 |
| `OPENCODE_BRIDGE_IMAGE_HANDOFF_LOCAL_RETENTION_MS` | `86400000` | 本地路径附件最后一次使用后的保留时间，范围 60000–2592000000 毫秒（1 分钟–30 天）；设为 `0` 时保留到进程退出 |
| `OPENCODE_BRIDGE_IMAGE_HANDOFF_PUBLIC_URL` | 空 | 远程图片交接使用的 HTTPS 公网基址，例如 `https://bridge.example.com`；配置后生成默认 15 分钟有效的随机下载 URL |
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
- `OPENCODE_BRIDGE_IMAGE_HANDOFF_PUBLIC_URL`：使用 Claude Code vision 技能处理 DeepSeek 图片附件时填写 Render 服务的完整 HTTPS 地址，例如 `https://opencode-protocol-bridge.onrender.com`；不需要远程图片交接时可留空。
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

托管配置当前覆盖常见 TCP / WebSocket / gRPC / HTTP / HTTPUpgrade / QUIC 传输以及 VLESS Reality/uTLS 常用参数；VMess/VLESS 等 WebSocket 分享链接中的 Xray `?ed=` 约定会自动转换为 sing-box early data 字段，并使用 `Sec-WebSocket-Protocol` 保持兼容。遇到 sing-box 无法表达的传输（例如部分私有或过新的 V2Ray 传输）会返回明确错误。ShadowsocksR (`ssr://`) 暂不托管，仍需先由本地客户端转换为 HTTP/SOCKS 端口。

### 在 OpenCode 中使用

先将客户端访问令牌放到环境变量：

```powershell
$env:OPENCODE_BRIDGE_TOKEN = "管理面板生成的令牌"
```

然后在 `opencode.json` 中分别添加 Zen 和 Go 两个 OpenAI Compatible 自定义提供方。OpenCode 调用本项目的 Chat Completions 入口，本项目再转换到对应上游所需协议：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "bridge-zen/gpt-5.6-terra",
  "provider": {
    "bridge-zen": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "OpenCode Bridge Zen",
      "options": {
        "baseURL": "http://127.0.0.1:8787/zen/v1",
        "apiKey": "{env:OPENCODE_BRIDGE_TOKEN}"
      },
      "models": {
        "gpt-5.6-terra": { "name": "GPT 5.6 Terra" }
      }
    },
    "bridge-go": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "OpenCode Bridge Go",
      "options": {
        "baseURL": "http://127.0.0.1:8787/go/v1",
        "apiKey": "{env:OPENCODE_BRIDGE_TOKEN}"
      },
      "models": {
        "kimi-k2.7-code": { "name": "Kimi K2.7 Code (Go)" }
      }
    }
  }
}
```

模型需要在 `models` 中显式填写；管理面板的“测试连接”可以确认 Zen / Go 密钥能否读取官方模型列表。

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

自动协议判断规则：

| 模型 | Zen | Go |
| --- | --- | --- |
| GPT、o1/o3/o4 | Responses | Responses（如上游提供） |
| Claude、Qwen 3.5/3.6/3.7 | Claude Messages | Claude Messages |
| MiniMax M 系列 | Chat Completions | Claude Messages |
| Kimi、DeepSeek、GLM、Grok 等 | Chat Completions | Chat Completions |

OpenCode 的模型端点会随产品更新。遇到新模型或官方端点变更时，应在管理面板添加精确路由，而不是依赖名称推断。

### 图片附件交接模型

管理面板“连接设置”中的“图片附件交接”用于选择哪些 Chat 上游不能直接接收图片块。选择 Zen 或 Go 后，可以使用项目已经配置的 Key 池自动拉取模型，也可以指定某一把环境 Key 或面板 Key；浏览器只提交安全的 Key 槽位 ID，真实 Key 不会返回页面。勾选结果按 `{ provider, model }` 精确保存，同名模型在另一个上游不会被连带启用。

新配置默认选中 Zen/Go 的 `deepseek-v4-flash` 与 `deepseek-v4-flash-free`，以兼容 Console Go/Zen 当前只接受文本内容块的行为。可以在拉取模型后取消默认项或选择其他已确认存在相同限制的 Chat 模型。选中模型收到 Claude 图片时，本地部署会提供临时绝对路径，配置了 `OPENCODE_BRIDGE_IMAGE_HANDOFF_PUBLIC_URL` 的远程部署会提供短时 HTTPS URL；远程附件会以流式响应发送，令牌过期后撤销访问，正在进行的下载结束后再清理对应文件。如果交接传输关闭，则使用明确的“图片未发送”文本。未选中的模型继续按标准 `image_url` 透传，因此不应为原生支持视觉的模型开启此选项。

相同图片按内容哈希去重，不会重复占用临时存储。临时文件总量默认限制为 256 MiB；超过上限时新附件会返回明确的 HTTP 507，而不会继续写满磁盘。本地路径每次被会话重新使用都会刷新保留期，默认 24 小时未使用后自动删除；远程文件仍按短时 URL 的 15 分钟有效期清理。服务正常退出时会清理该进程创建的全部附件目录。

模型路由使用别名时，匹配的是最终 `upstreamModel` 和实际 provider，而不是客户端传入的别名。图片交接只在目标协议为 Chat 时生效；Claude 或 Responses 上游继续使用各自原生图片格式。

## Claude system 提示词规则

管理面板的“提示词规则”可以在 Claude Messages 请求发送上游前，按顺序执行精确字面量替换。每条规则包含：

- `name`：管理面板显示名称
- `enabled`：是否启用
- `find`：需要匹配的完整文本
- `replace`：替换内容；空字符串表示删除

项目默认启用两条规则：保留开头的 Claude Code 身份说明，删除 Environment 中“最新 Claude 模型 / Claude Code 可用平台 / Fast mode”三行推广，并替换 Claude Code 注入的安全测试限制段。默认规则可以关闭、编辑或恢复；曾保存过旧版错误默认规则的配置会自动迁移到正确片段。

最近一次 Claude 请求中收到的原始 system 和最终发送给上游的 system 只保存在当前 Node.js 进程内，各自最多保留 1 MiB，不进入请求日志或配置文件。控制台会逐条显示该次请求中规则是“已生效”“未命中”还是“已停用”，因此两条内置 Claude 规则是否实际生效可以直接确认。

规则本身会保存到配置。控制台提供可视化的新增、编辑、启停和删除操作；填写查找原文和替换内容即可创建替换规则，替换内容留空即为删除规则。也可以在收到的原始 system 中选中文字快速创建规则，或通过高级 JSON 编辑器批量调整。未保存的规则支持直接预览，另有复制原始/最终内容和清除内存快照功能。

规则采用字面量匹配而非正则表达式，因此不会出现正则回溯或转义差异。最多配置 50 条，单条内容最多 128 KiB，全部规则内容最多 1 MiB；处理后的 system 超过 10 MiB 时请求会以 HTTP 413 拒绝，防止替换规则造成内容放大。

## 流式说明

- 客户端协议与上游协议相同时，正常 SSE 数据实时原样透传；服务通过并行观察流记录 usage。若上游在完成事件前中断，服务会追加目标协议可识别的错误帧，避免客户端把截断内容误判为成功。
- 跨协议时，服务会维护内容块索引和工具调用状态，将上游事件逐条转换为目标协议事件，不再缓存完整响应；SSE 解析兼容 LF、CRLF 和 CR 换行。流式请求要求上游返回标准 `text/event-stream`，避免把 HTTP 200 的普通 JSON 错误误判为空流；同协议 Chat 流也会主动请求 usage，只有上游确实返回 token 字段时才计入面板用量覆盖率，缺失 usage 不会伪记为零 token；客户端断开时，上游请求会被取消。
- 生成的 Responses SSE 从 `0` 开始连续递增 `sequence_number`；文本 `delta`/`done` 带 `logprobs: []`，错误使用顶层 `type`、`code`、`message`、`param` 字段，终态 Response 始终带完整的 usage 明细与 `parallel_tool_calls`、`tool_choice`、`tools` 核心字段。若透传 Responses 流在完成前截断，追加错误会接续上游最后一个序号。
- 跨协议流会保留 `completed`/`incomplete`、token 上限停止原因、缓存读取/写入 token 和推理 token；上游错误会使用目标协议可识别的 SSE 帧返回。单个上游 SSE 事件最多缓冲 8 MiB，超限会终止转换，防止异常上游无限占用内存。
- 流式请求只有在完整结束后才会把对应 Key 记为健康；包括正常关闭连接但缺少完成事件的截断流，都会写入失败日志、返回错误帧并参与连续失败熔断。客户端主动断开记为内部状态 499，但不会惩罚 Key，也不会让冷却后的半开探测槽位永久占用。同协议流的用量观察与字节透传位于同一条背压链路中，不会因统计分支提前读取而在慢客户端一侧无限积压。
- 超过 64 KiB 的非流式 JSON 会按 64 KiB 分块写入，覆盖推理响应、模型列表、日志和提示词预览等路径。慢客户端不会提前释放公开推理或管理模型发现槽位；写入超时或中途断开会结束连接，非流式推理日志记为内部状态 499，而上游已经完整成功的 Key 仍保持健康。

管理面板可以设置 1 秒至 10 分钟的上游超时，默认 120 秒。
还可以设置 1–1000 的并发请求上限，默认 20；达到上限时返回目标协议兼容的 HTTP 429 错误与 `Retry-After` 响应头。

每个进入服务的 HTTP 请求都会获得独立的 128 位 `x-request-id`，包括健康检查、管理 API、模型发现、静态资源和早期错误；推理请求日志使用同一个 ID，便于从客户端响应定位面板记录。最终上游返回的 `Retry-After` 和标准 `RateLimit-*` / `X-RateLimit-*` 配额头会按安全白名单透传；上游的 `x-request-id`、`request-id` 或 `x-trace-id` 会改名为 `x-opencode-upstream-request-id`，避免与本地 ID 混淆。Cookie、认证信息和其它未列入白名单的响应头不会转发。

## 当前边界

- 本项目覆盖 Claude Messages、OpenAI Responses 和 Chat Completions 三个协议族；OpenCode 中使用 Google `generateContent` 原生端点的 Gemini 模型不在当前转换范围内。
- 单个 JSON 请求体上限为 10 MiB，模型 ID 上限为 256 个字符；更大的 PDF 或其他文件应先使用目标服务的 Files API 上传，再通过 file ID 引用。
- HTTP 请求目标只接受 origin-form 路径，不接受 absolute-form、network-path、反斜杠或 URL 片段；长度上限为 8 KiB，查询参数最多 64 项，`provider` 与 `window` 等单值参数不允许重复。请求头总量上限为 16 KiB、字段数上限为 128；认证、Cookie、Host、Origin、消息分帧、配置修订和可信代理相关头不允许重复。请求头最长等待 15 秒，请求体最长等待 30 秒，每条 Keep-Alive 连接最多处理 1000 个请求。响应流本身不受这两个接收超时影响。
- 所有 JSON 请求体只接受 `application/json` 或 `application/*+json`，不接受 gzip/br 等压缩 `Content-Encoding`；错误媒体类型返回 415。HTTP/1.1 必须携带 Host，冲突的 `Content-Length` / `Transfer-Encoding` 会在进入应用前由严格解析器拒绝。
- `/models` 与 `/models/{model}` 仅接受 GET，三个推理端点仅接受 POST；方法错误会返回 HTTP 405、标准 `Allow` 头以及目标协议可识别的错误体。
- 已知管理接口的方法不匹配时同样返回 HTTP 405 和准确的 `Allow`，只有不存在或路径参数格式无效的接口才返回 404；受保护接口仍先执行登录校验。
- 通用 `/v1/models` 的 `provider` 查询参数仅接受 `zen`、`go` 或列表场景的 `all`，非法值会明确返回 400，不会静默回退到默认套餐；带 `/zen/v1`、`/go/v1` 的路径始终以路径为准。
- 同协议请求和成功的非流式响应会在最小结构校验后保留厂商扩展字段；同协议流式响应原样透传。非 2xx 推理响应不会透传任意扩展字段，而会规范化为客户端协议认可的错误结构，并在返回和写日志前脱敏当前上游 Key 与代理地址。跨协议转换覆盖系统提示、文本、拒绝内容、图片及其 `detail`、Claude Documents/Responses 文件块、采样参数、函数工具、工具选择、新旧工具调用、工具结果、推理强度及 usage；Claude 的 `tool_result + 后续用户文本` 转 Chat 时会保持合法的 tool → user 顺序。停止词会在 Claude/Chat 目标间转换；Responses 不支持 stop，收到跨协议停止词时返回明确的 400。Claude 转 Chat 时保留兼容代理使用的 `cache_control`，转 Responses 时会移除该非标准字段；转 Claude 时 metadata 只保留合法的 `user_id`。Responses 内置工具/custom tool、Claude server tool、未知内容块、Chat 文件输入及 Chat 无法表达的图片 `file_id` 在跨协议请求时返回 400；上游响应包含目标协议无法表达的图片、文档或流式媒体块时返回明确的转换错误，避免静默丢失内容。其他非内容类厂商专属字段会被忽略。
- DeepSeek V4 Flash / V4 Flash Free 的 Chat 工具调用在未显式请求推理时会自动设置 `reasoning_effort: "none"`，避免模型默认 Thinking 模式拒绝工具；客户端显式启用 Claude thinking 时不会静默覆盖其选择。Console Go 的这两个模型当前只接受文本内容块：桥接服务监听本机回环地址时，Claude base64 图片会暂存到当前进程的系统临时目录，并把绝对路径作为文本交给 Claude Code 的 vision 技能；本地附件默认在最后使用 24 小时后删除，正常退出会清理全部副本。远程部署可配置 `OPENCODE_BRIDGE_IMAGE_HANDOFF_PUBLIC_URL`，中转会改为生成默认 15 分钟有效的随机附件 URL，提示 Claude Code 下载到本机临时文件后再调用 vision 技能。未配置远程基址时，图片会替换为明确的“图片未发送”文本提示，历史消息中的图片也会处理，以避免上游因 `image_url` 返回 400。短时 URL 是无需额外请求头的能力链接，请只在可信的 HTTPS 部署中启用；如果没有可读取本机文件或下载 URL 的 vision 技能，请改用原生支持视觉输入的模型。
- 请求日志默认仅保存在内存中；管理面板可启用有界持久化，文件为 `data/request-logs.json`。日志不包含提示词、响应正文或密钥，启动时的并发请求只共享一次旧日志加载，写盘会在短时间窗口内合并，并在管理读取或服务正常退出时强制刷新；配置和日志都通过独占临时文件、文件同步与原子重命名落盘，普通写入失败会立即清理临时副本，异常退出遗留的固定副本会在下次加载时清理。临时写盘失败会保留内存中的待写状态供下次刷新重试。关闭持久化会取消尚未执行的延迟写盘，但不会自动删除已有文件；需要删除历史内容时再点击“清空记录”。请求记录列表会直接显示使用的 Key 槽位、面板 Key 名称和自动切换尝试次数，并支持按这些字段筛选，便于把 401/429/代理错误关联到具体 Key。
- 管理面板“用量统计”按全部记录、最近 24 小时或最近 7 天汇总请求数、成功率、自动 Key 切换次数、平均/P95 耗时以及输入、输出、缓存读取、缓存写入和推理 token，并可按上游、实际模型、协议转换、客户端和 Key 槽位拆分；每个分组同时显示总耗时、上游等待和响应体阶段的平均/P95，时间趋势悬浮提示会显示该时段的平均阶段耗时。上游等待累计所有 Key 尝试中的连接、排队与等待响应头时间，响应体阶段从最终响应头到完成响应体读取与转换，流式请求还包含向客户端传输及背压等待。Key 表还展示当前健康状态、连续失败、冷却截止时间、实时剩余时间与最近事件。Key 统计只保存“环境变量编号/面板 Key”等安全标识，不保存密钥内容。请求记录会同时显示本地请求 ID、最终上游请求 ID、限流等待时间和安全错误码；连接超时、响应超时、DNS、拒绝连接、意外断连与 TLS 故障会分开标识，不回显底层 URL 或代理凭据。日志支持按关键词、错误码、时间、上游、成功/4xx/429/5xx 组合筛选，可复制两类请求 ID，并能将当前筛选结果导出为防公式注入的 UTF-8 CSV，便于关联排障。页面提供最近 24 小时、7 天或 14 天的请求/Token 趋势。统计会统一 OpenAI“缓存读取是输入子集、缓存写入为独立指标”和 Claude“缓存创建字段独立于普通输入”的两种 usage 口径：缓存写入不再从 OpenAI 的未缓存输入中重复扣除。跨协议响应和统计会把上游 usage 的数字字符串规范为整数，拒绝负数、非整数与非有限值，并将极端大值钳制到安全整数范围；同协议响应正文仍原样透传。统计只基于当前最多 1000 条保留日志；推理 token 是输出 token 的明细项，不会重复加总。上游没有返回有效 usage 时会计入“缺失用量”的请求数。由于 OpenCode 各模型的缓存价格会变化，面板不估算账单金额，应以 OpenCode 官方账单为准。
- 管理面板只有配置读取是启动强依赖；请求日志、运行状态、客户端列表、用量统计或 Claude 提示词快照短暂失败时，页面会继续显示上一次成功数据，并在顶部列出未更新的数据源。后续刷新成功会自动清除对应告警。

## 安全建议

- 默认只监听 `127.0.0.1`。公网部署应放在带 TLS 的反向代理后面。
- 管理面板使用严格 CSP，配置变更接口校验完整 Origin（协议、主机与端口）并拒绝浏览器标记为 cross-site 的请求；服务端返回的模型名、Key 名称、日志字段和其它动态值在进入 HTML 文本或属性前统一转义，浏览器端不使用 localStorage/sessionStorage 保存密钥。
- 入站 JSON 使用严格 UTF-8 解码并按用途限制体积：普通管理请求 64 KiB、完整配置 2 MiB、提示词预览约 2.1 MiB、推理请求 10 MiB。声明长度和 chunked 实际内容都会执行同一上限，超限时丢弃剩余输入并可靠返回 413；鉴权失败、媒体类型错误等提前响应会对尚未上传完的非只读请求强制关闭连接，避免慢上传在释放应用并发槽后继续占用 Keep-Alive。上传中途断开会静默释放公开或管理并发槽，不会打印误导性的服务器异常。模型发现也绑定客户端取消信号，客户端断开后会立即取消上游读取且不会惩罚对应 Key。
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
```

`npm run check` 会自动发现并语法检查 `src`、`public`、`scripts` 与 `test-fixtures` 下的全部 JavaScript 文件，再运行完整测试；新增源码文件无需手工维护检查名单。默认测试不调用真实 OpenCode 接口，因此不会产生费用。

如需用临时 Go Key 对官方 `deepseek-v4-flash` 做小额度在线冒烟测试，可在当前 PowerShell 会话设置 `OPENCODE_GO_KEY` 后运行 `npm run test:live:go`。默认 `full` 档会通过本地 `/go/v1` 验证模型发现、Responses 非流式正文与标准流事件、Claude 工具名与参数、Claude 工具结果回送后的续答、Chat SSE 正文与 usage，并登录临时管理会话核对五次请求的统计守恒及时间趋势阶段耗时覆盖；只输出状态和 usage，Key 不写入项目配置或日志，临时加密配置会在结束时删除。只需验证 Go 上游与基础 Responses 转换时，可设置 `OPENCODE_LIVE_PROFILE=quick`，它仍会先验证模型权限，然后只发送一次小型 Responses 请求并核对一条统计记录。测试失败时输出会列出已完成阶段和安全错误码，便于区分 Key/模型问题与连接故障。默认单请求超时为 60 秒；若上游临时拥塞，可在当前会话设置 `OPENCODE_LIVE_TIMEOUT_MS`（10000–600000）后重试。仅在模型列表端点拥塞、且已知模型名正确时，可临时设置 `OPENCODE_LIVE_SKIP_MODEL_DISCOVERY=1` 继续验证实际生成协议；该模式会在输出中明确标记跳过了模型发现。测试后可执行 `Remove-Item Env:OPENCODE_GO_KEY` 清除当前会话变量。
