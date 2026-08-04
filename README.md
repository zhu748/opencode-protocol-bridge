# OpenCode Protocol Bridge

一个自托管的 OpenCode Zen / Go 协议中转服务。客户端可使用 Claude Messages、OpenAI Responses 或 Chat Completions 协议；服务会按模型选择 OpenCode 官方端点，并转换请求与响应格式。

## 功能

- `POST /zen/v1/messages|responses|chat/completions`：强制转发到 OpenCode Zen
- `POST /go/v1/messages|responses|chat/completions`：强制转发到 OpenCode Go
- `POST /v1/messages|responses|chat/completions`：兼容入口，按模型路由选择上游
- OpenCode Zen / Go 密钥和模型路由
- 每个 Zen / Go Key 可独立配置 HTTP、HTTPS、SOCKS4、SOCKS4a、SOCKS5 或 SOCKS5h 上游代理
- 工具调用、工具结果、并行工具开关、文本消息、图片精度字段，以及 Claude Documents 与 Responses 文件块转换
- Claude thinking、Responses reasoning 摘要与 Chat reasoning_content 转换
- Claude thinking/output effort 到 OpenAI reasoning effort 的模型感知映射
- DeepSeek / Kimi / Moonshot 工具历史 reasoning_content 兼容
- o1/o3/o4 Chat 参数、兼容代理 cache_control 与缓存 token 统计
- refusal、旧版 function_call、usage 字段别名与 Chat 分段内容兼容
- 同协议安全透传 `anthropic-version`、`anthropic-beta` 与 `openai-beta` 功能协商头
- Claude system 提示词精确删除/替换规则与进程内最近请求对比
- 流式事件乱序缓冲、done 内容兜底、Read 参数清理与稳定 JSON 序列化
- 非流式上游响应、错误正文和模型列表均有独立体积上限；损坏 JSON 会返回明确的 502 并写入元数据日志
- 同协议 SSE 实时透传；跨协议 SSE 逐事件实时转换
- `GET /v1/models` 模型发现端点
- 可直接导入的 `/openapi.json` OpenAPI 3.1 描述
- 带首次初始化、密码登录和访问令牌的管理面板
- 可单独停用、撤销和限制并发的命名客户端令牌
- 仅记录请求元数据的日志
- 可选的有界请求日志持久化

OpenCode 当前官方端点见 [Zen 文档](https://opencode.ai/docs/zen) 和 [Go 文档](https://opencode.ai/docs/go)。本项目默认使用：

- Zen：`https://opencode.ai/zen/v1`
- Go：`https://opencode.ai/zen/go/v1`

## 快速启动

要求 Node.js 20.18.1–24.x；仓库使用 `.node-version` 固定 Render 和本地版本为 Node.js 24.14.1。

```powershell
npm install
npm start
```

浏览器打开 `http://127.0.0.1:8787`，首次访问会要求设置管理密码。初始化成功后，请立即保存自动生成的客户端访问令牌，再到“连接设置”填写 Zen 或 Go 密钥。

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
| `OPENCODE_BRIDGE_ADMIN_PASSWORD` | 空 | 配置文件不存在时用于首次引导，长度 8–256；适合 Render 等临时文件系统 |
| `OPENCODE_BRIDGE_CLIENT_TOKEN` | 随机生成 | 环境变量引导时设置主访问令牌，至少 24 个字符 |
| `OPENCODE_ZEN_KEY` / `OPENCODE_GO_KEY` | 空 | 环境变量引导时写入对应上游 Key |
| `OPENCODE_PROXY_URL` | 空 | 环境变量引导时写入默认代理 |
| `OPENCODE_ZEN_PROXY_URL` / `OPENCODE_GO_PROXY_URL` | 空 | 环境变量引导时写入每个 Key 的独立代理 |
| `OPENCODE_BRIDGE_DEFAULT_PROVIDER` | `zen` | 环境变量引导时的默认提供方：`zen` 或 `go` |

也可以使用 Docker Compose：

```powershell
docker compose up -d --build
```

Compose 默认只映射到本机 `127.0.0.1:8787`，配置保存在命名卷 `bridge-data` 中。容器以非 root 用户运行，并通过 `/health` 执行健康检查。
启动 Compose 前可在 PowerShell 中设置 `$env:CONFIG_ENCRYPTION_KEY`，该变量会传入容器用于配置加密。

如需公网访问，建议继续保持服务监听在本机，并使用 Caddy、Nginx 等反向代理提供 HTTPS。SSE 代理必须关闭响应缓冲并设置足够长的读取超时；不要直接将未加密的 `8787` 端口暴露到公网。

## Render 免费部署

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/zhu748/opencode-protocol-bridge)

仓库根目录的 `render.yaml` 会创建一个新加坡区域的免费 Node Web Service，自动执行 `npm ci --omit=dev`、`npm start`，并使用 `/health` 进行健康检查。在 Render 创建 Blueprint 时填写：

- `OPENCODE_BRIDGE_ADMIN_PASSWORD`：管理面板密码，至少 8 个字符。
- `OPENCODE_BRIDGE_CLIENT_TOKEN`：客户端调用本项目使用的令牌，至少 24 个字符。
- `OPENCODE_ZEN_KEY` / `OPENCODE_GO_KEY`：至少填写一个；不使用的可留空。
- 三个代理变量均可留空，需要时填写 HTTP(S) 或 SOCKS 地址。

`CONFIG_ENCRYPTION_KEY` 由 Render 自动生成，`HOST=0.0.0.0` 已在 Blueprint 中设置，`PORT` 由 Render 自动注入。环境变量引导仅在配置文件中还没有管理密码时执行，不会覆盖已存在的持久化配置。

Render 免费 Web Service 的文件系统是临时的，闲置 15 分钟后会休眠，休眠、重启或重新部署会丢失管理面板写入的本地配置。因此免费部署应把长期使用的密码、令牌、Key 和代理保存为 Render Secret；实例恢复时项目会从这些变量重新生成加密配置。面板中临时修改的模型路由、替换规则和客户端列表也会在实例文件系统重置后恢复默认。需要永久保留面板修改时，应升级到支持 Persistent Disk 的付费实例并将磁盘挂载到 `/opt/render/project/src/data`。详见 [Render 免费实例限制](https://render.com/docs/free) 与 [Persistent Disks](https://render.com/docs/disks)。

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

管理面板中的“主访问令牌”用于兼容单用户部署。多人或多设备使用时，建议在“客户端令牌”中为每个调用方创建独立令牌：令牌只在创建或轮换时显示一次，服务端仅保存 SHA-256 摘要；每个客户端可设置独立并发上限，并可随时停用、轮换或撤销。全局并发上限仍对所有客户端请求总数生效。

### Key 独立代理

“连接设置”可以分别为 Zen Key 和 Go Key 指定代理。独立代理优先于默认代理；未配置独立代理时回退到默认代理，默认代理也未配置则直连。代理保存后只向页面返回脱敏地址，输入框留空表示保持原值；需要取消代理时使用对应的“清除代理”按钮。支持以下写法：

```text
http://127.0.0.1:7890
https://user:password@proxy.example:8443
socks4://127.0.0.1:1080
socks4a://user:password@proxy.example:1080
socks5://127.0.0.1:1080
socks5h://user:password@proxy.example:1080
```

省略协议的 `host:port` 会按 HTTP 代理处理。代理用户名或密码包含特殊字符时应使用 URL 百分号编码。管理面板的 Zen / Go“测试连接”会优先使用新填写的独立代理，否则使用服务端已保存的对应代理和默认代理回退。

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

- 客户端协议与上游协议相同时，SSE 数据实时原样透传；服务通过并行观察流记录 usage 和流内错误，不改写客户端收到的字节。
- 跨协议时，服务会维护内容块索引和工具调用状态，将上游事件逐条转换为目标协议事件，不再缓存完整响应。客户端断开时，上游请求会被取消。
- 跨协议流会保留 `completed`/`incomplete`、token 上限停止原因、缓存读取/写入 token 和推理 token；上游错误会使用目标协议可识别的 SSE 帧返回。

管理面板可以设置 1 秒至 10 分钟的上游超时，默认 120 秒。
还可以设置 1–1000 的并发请求上限，默认 20；达到上限时返回目标协议兼容的 HTTP 429 错误与 `Retry-After` 响应头。

## 当前边界

- 本项目覆盖 Claude Messages、OpenAI Responses 和 Chat Completions 三个协议族；OpenCode 中使用 Google `generateContent` 原生端点的 Gemini 模型不在当前转换范围内。
- 单个 JSON 请求体上限为 10 MiB，模型 ID 上限为 256 个字符；更大的 PDF 或其他文件应先使用目标服务的 Files API 上传，再通过 file ID 引用。
- 同协议请求和非流式响应会在最小结构校验后保留厂商扩展字段；同协议流式响应原样透传。跨协议转换覆盖系统提示、文本、拒绝内容、图片及其 `detail`、Claude Documents/Responses 文件块、采样参数、函数工具、工具选择、新旧工具调用、工具结果、推理强度及 usage。停止词会在 Claude/Chat 目标间转换；Responses 不支持 stop，收到跨协议停止词时返回明确的 400。Claude 转 Chat 时保留兼容代理使用的 `cache_control`，转 Responses 时会移除该非标准字段；转 Claude 时 metadata 只保留合法的 `user_id`。Responses 内置工具/custom tool、Claude server tool、未知内容块、Chat 文件输入及 Chat 无法表达的图片 `file_id` 在跨协议时同样返回 400，避免静默丢失内容；其他非内容类厂商专属字段会被忽略。
- 请求日志默认仅保存在内存中；管理面板可启用有界持久化，文件为 `data/request-logs.json`。日志不包含提示词、响应正文或密钥，写盘会在短时间窗口内合并，并在管理读取或服务正常退出时强制刷新。关闭持久化会取消尚未执行的延迟写盘，但不会自动删除已有文件；需要删除历史内容时再点击“清空记录”。

## 安全建议

- 默认只监听 `127.0.0.1`。公网部署应放在带 TLS 的反向代理后面。
- `data/config.json` 包含上游密钥，已被 `.gitignore` 排除；请限制该文件的系统权限并做好安全备份。
- 生产环境建议设置 `CONFIG_ENCRYPTION_KEY`。启用后，Zen/Go 密钥、客户端令牌、会话密钥和含凭据的代理 URL 会使用 AES-256-GCM 保存；主密钥丢失后无法恢复这些字段。
- 轮换配置主密钥前先停止服务，然后执行以下命令。操作前应备份 `data/config.json`：

```powershell
$env:OLD_CONFIG_ENCRYPTION_KEY = "旧主密钥"
$env:CONFIG_ENCRYPTION_KEY = "新主密钥"
npm run rekey
```
- 管理密码使用随机盐的 scrypt 哈希保存；登录 Cookie 为 HttpOnly、SameSite=Strict。
- 命名客户端令牌由高强度随机数生成，配置中仅保存不可逆摘要；主访问令牌仍受 `CONFIG_ENCRYPTION_KEY` 加密保护。
- 请求日志不包含提示词、响应正文或密钥。持久化默认关闭，启用后应像其他运行日志一样限制文件访问权限。
- `/health` 中的 `ready` 只有在管理密码、至少一个可用客户端令牌和至少一个上游密钥均已配置时才为 `true`。

## 验证

```powershell
npm test
npm run check
```

测试不调用真实 OpenCode 接口，因此不会产生费用。
