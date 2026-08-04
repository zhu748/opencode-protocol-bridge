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
- refusal、旧版 function_call、Responses `cache_write_tokens` 及其它 usage 字段别名与 Chat 分段内容兼容
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

浏览器打开 `http://127.0.0.1:8787`，首次访问会要求设置管理密码。初始化成功后，请立即保存自动生成的客户端访问令牌，再到“连接设置”的 Key 池添加一把或多把 Zen / Go 密钥；每把 Key 可以命名并设置独立代理。

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
| `OPENCODE_ZEN_KEY` / `OPENCODE_GO_KEY` | 空 | 单 Key 兼容变量 |
| `OPENCODE_ZEN_KEY_1...32` / `OPENCODE_GO_KEY_1...32` | 空 | 多 Key 编号变量；按编号轮询使用 |
| `OPENCODE_ZEN_KEYS` / `OPENCODE_GO_KEYS` | 空 | 多 Key 合并变量，支持 JSON 数组、逗号或换行分隔；优先于编号变量 |
| `OPENCODE_PROXY_URL` | 空 | 环境变量引导时写入默认代理 |
| `OPENCODE_ZEN_PROXY_URL` / `OPENCODE_GO_PROXY_URL` | 空 | 环境变量引导时写入每个 Key 的独立代理 |
| `OPENCODE_ZEN_PROXY_URL_1...32` / `OPENCODE_GO_PROXY_URL_1...32` | 空 | 与编号 Key 一一对应的代理；缺省时回退到提供方代理和默认代理 |
| `OPENCODE_ZEN_PROXY_URLS` / `OPENCODE_GO_PROXY_URLS` | 空 | 与 `*_KEYS` 对应的代理列表；需要跳过某项时使用含空字符串的 JSON 数组 |
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

- `OPENCODE_BRIDGE_ADMIN_PASSWORD`：**必填，不可留空**的管理面板密码，至少 6 位，仅使用英文字母或数字。
- `OPENCODE_BRIDGE_CLIENT_TOKEN`：**必填，不可留空**的客户端调用令牌，至少 6 位，仅使用英文字母或数字。
- `OPENCODE_ZEN_KEYS` / `OPENCODE_GO_KEYS`：推荐的批量配置，支持 JSON 数组、逗号或换行分隔，最多 32 把；至少配置一个上游的一把 Key。
- `OPENCODE_ZEN_PROXY_URLS` / `OPENCODE_GO_PROXY_URLS`：与批量 Key 逐项对应的 HTTP(S) 或 SOCKS 代理列表；需要保留空代理槽位时使用 JSON 数组中的空字符串。
- `OPENCODE_ZEN_KEY_1...4` / `OPENCODE_GO_KEY_1...4` 及同编号 `*_PROXY_URL_1...4`：少量 Key 的独立输入方式；未使用的槽位留空。

`CONFIG_ENCRYPTION_KEY` 由 Render 自动生成，`HOST=0.0.0.0`、`OPENCODE_BRIDGE_TRUST_PROXY=true` 和 `OPENCODE_BRIDGE_REQUIRE_ENV_BOOTSTRAP=true` 已在 Blueprint 中设置，`PORT` 由 Render 自动注入。最后一项会在这两项必填 Secret 缺失时拒绝启动，避免首次公网访问者抢先初始化控制台。可信代理开关使登录限速按 Render 提供的真实客户端地址隔离，普通自托管部署默认不信任转发头。批量 `*_KEYS` 非空时优先于编号变量，任一环境变量 Key 池又优先于管理面板保存的 Key 池；Key 按请求轮询，每把使用对应位置或同编号代理。面板 Key 池同样最多支持 32 把，每项可单独命名、测试和设置代理；旧版保存的单 Key 会在首次编辑时自动迁移。401/403 会让对应 Key 立即冷却，429 会优先采用上游 `Retry-After`，并在同一请求内安全切换到下一把健康 Key；响应头 `x-opencode-key-attempts` 会在发生切换时给出尝试次数。网络错误或 5xx 不会自动重放推理请求，以避免重复计费或重复工具调用；幂等的模型发现请求则会安全尝试下一把健康 Key。连续三次网络错误或 5xx 后对应 Key 会进入指数冷却。冷却结束后 Key 自动重新参与轮询，也可在管理面板的 Key 健康表中手动重置。健康状态只保存在当前进程内，替换同一槽位的 Key 或代理不会继承旧状态。环境变量引导仅在配置文件中还没有管理密码时执行，不会覆盖已存在的持久化配置。

Render 免费 Web Service 的文件系统是临时的，闲置 15 分钟后会休眠，休眠、重启或重新部署会丢失管理面板写入的本地配置。因此免费部署应把长期使用的密码、令牌、Key 和代理保存为 Render Secret；实例恢复时项目会从这些变量重新生成加密配置。面板中临时修改的模型路由、替换规则和客户端列表也会在实例文件系统重置后恢复默认；内存中的请求日志、用量/缓存统计、Key 健康与冷却状态，以及最近 Claude system 快照也会清空。即使启用了持久化日志，免费实例重启后该文件同样不会保留。需要永久保留面板修改时，应升级到支持 Persistent Disk 的付费实例并将磁盘挂载到 `/opt/render/project/src/data`。详见 [Render 免费实例限制](https://render.com/docs/free) 与 [Persistent Disks](https://render.com/docs/disks)。

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

省略协议的 `host:port` 会按 HTTP 代理处理。代理用户名或密码包含特殊字符时应使用 URL 百分号编码。管理面板可以逐项测试 Key；编辑时填写的新代理优先，否则使用该 Key 已保存的代理并回退到默认代理。

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

- 客户端协议与上游协议相同时，正常 SSE 数据实时原样透传；服务通过并行观察流记录 usage。若上游在完成事件前中断，服务会追加目标协议可识别的错误帧，避免客户端把截断内容误判为成功。
- 跨协议时，服务会维护内容块索引和工具调用状态，将上游事件逐条转换为目标协议事件，不再缓存完整响应；SSE 解析兼容 LF、CRLF 和 CR 换行。流式请求要求上游返回标准 `text/event-stream`，避免把 HTTP 200 的普通 JSON 错误误判为空流；同协议 Chat 流也会主动请求 usage，只有上游确实返回 token 字段时才计入面板用量覆盖率，缺失 usage 不会伪记为零 token；客户端断开时，上游请求会被取消。
- 生成的 Responses SSE 从 `0` 开始连续递增 `sequence_number`；文本 `delta`/`done` 带 `logprobs: []`，错误使用顶层 `type`、`code`、`message`、`param` 字段，终态 Response 始终带完整的 usage 明细与 `parallel_tool_calls`、`tool_choice`、`tools` 核心字段。若透传 Responses 流在完成前截断，追加错误会接续上游最后一个序号。
- 跨协议流会保留 `completed`/`incomplete`、token 上限停止原因、缓存读取/写入 token 和推理 token；上游错误会使用目标协议可识别的 SSE 帧返回。单个上游 SSE 事件最多缓冲 8 MiB，超限会终止转换，防止异常上游无限占用内存。
- 流式请求只有在完整结束后才会把对应 Key 记为健康；包括正常关闭连接但缺少完成事件的截断流，都会写入失败日志、返回错误帧并参与连续失败熔断。客户端主动断开记为内部状态 499，但不会惩罚 Key，也不会让冷却后的半开探测槽位永久占用。

管理面板可以设置 1 秒至 10 分钟的上游超时，默认 120 秒。
还可以设置 1–1000 的并发请求上限，默认 20；达到上限时返回目标协议兼容的 HTTP 429 错误与 `Retry-After` 响应头。

最终上游返回的 `Retry-After` 和标准 `RateLimit-*` / `X-RateLimit-*` 配额头会按安全白名单透传；上游的 `x-request-id`、`request-id` 或 `x-trace-id` 会改名为 `x-opencode-upstream-request-id`，与本项目生成的 `x-request-id` 区分。Cookie、认证信息和其它未列入白名单的响应头不会转发。

## 当前边界

- 本项目覆盖 Claude Messages、OpenAI Responses 和 Chat Completions 三个协议族；OpenCode 中使用 Google `generateContent` 原生端点的 Gemini 模型不在当前转换范围内。
- 单个 JSON 请求体上限为 10 MiB，模型 ID 上限为 256 个字符；更大的 PDF 或其他文件应先使用目标服务的 Files API 上传，再通过 file ID 引用。
- `/models` 与 `/models/{model}` 仅接受 GET，三个推理端点仅接受 POST；方法错误会返回 HTTP 405、标准 `Allow` 头以及目标协议可识别的错误体。
- 通用 `/v1/models` 的 `provider` 查询参数仅接受 `zen`、`go` 或列表场景的 `all`，非法值会明确返回 400，不会静默回退到默认套餐；带 `/zen/v1`、`/go/v1` 的路径始终以路径为准。
- 同协议请求和非流式响应会在最小结构校验后保留厂商扩展字段；同协议流式响应原样透传。跨协议转换覆盖系统提示、文本、拒绝内容、图片及其 `detail`、Claude Documents/Responses 文件块、采样参数、函数工具、工具选择、新旧工具调用、工具结果、推理强度及 usage；Claude 的 `tool_result + 后续用户文本` 转 Chat 时会保持合法的 tool → user 顺序。停止词会在 Claude/Chat 目标间转换；Responses 不支持 stop，收到跨协议停止词时返回明确的 400。Claude 转 Chat 时保留兼容代理使用的 `cache_control`，转 Responses 时会移除该非标准字段；转 Claude 时 metadata 只保留合法的 `user_id`。Responses 内置工具/custom tool、Claude server tool、未知内容块、Chat 文件输入及 Chat 无法表达的图片 `file_id` 在跨协议请求时返回 400；上游响应包含目标协议无法表达的图片、文档或流式媒体块时返回明确的转换错误，避免静默丢失内容。其他非内容类厂商专属字段会被忽略。
- DeepSeek V4 Flash / V4 Flash Free 的 Chat 工具调用在未显式请求推理时会自动设置 `reasoning_effort: "none"`，避免模型默认 Thinking 模式拒绝工具；客户端显式启用 Claude thinking 时不会静默覆盖其选择。
- 请求日志默认仅保存在内存中；管理面板可启用有界持久化，文件为 `data/request-logs.json`。日志不包含提示词、响应正文或密钥，启动时的并发请求只共享一次旧日志加载，写盘会在短时间窗口内合并，并在管理读取或服务正常退出时强制刷新；临时写盘失败会保留待写状态供下次刷新重试。关闭持久化会取消尚未执行的延迟写盘，但不会自动删除已有文件；需要删除历史内容时再点击“清空记录”。
- 管理面板“用量统计”按全部记录、最近 24 小时或最近 7 天汇总请求数、成功率、自动 Key 切换次数、平均/P95 耗时以及输入、输出、缓存读取、缓存写入和推理 token，并可按上游、实际模型、协议转换、客户端和 Key 槽位拆分；Key 表还展示当前健康状态、连续失败、冷却截止时间、实时剩余时间与最近事件。Key 统计只保存“环境变量编号/面板 Key”等安全标识，不保存密钥内容。请求记录会同时显示本地请求 ID、最终上游请求 ID 和限流等待时间，支持按关键词、时间、上游、成功/4xx/429/5xx 组合筛选，可复制两类请求 ID，并能将当前筛选结果导出为防公式注入的 UTF-8 CSV，便于关联排障。页面提供最近 24 小时、7 天或 14 天的请求/Token 趋势。统计会统一 OpenAI“缓存读取是输入子集、缓存写入为独立指标”和 Claude“缓存创建字段独立于普通输入”的两种 usage 口径：缓存写入不再从 OpenAI 的未缓存输入中重复扣除。统计只基于当前最多 1000 条保留日志；推理 token 是输出 token 的明细项，不会重复加总。上游没有返回 usage 时会计入“缺失用量”的请求数。由于 OpenCode 各模型的缓存价格会变化，面板不估算账单金额，应以 OpenCode 官方账单为准。

## 安全建议

- 默认只监听 `127.0.0.1`。公网部署应放在带 TLS 的反向代理后面。
- `data/config.json` 包含上游密钥，已被 `.gitignore` 排除；请限制该文件的系统权限并做好安全备份。
- 生产环境建议设置 `CONFIG_ENCRYPTION_KEY`。启用后，Zen/Go Key 池中的每把密钥及其独立代理、客户端令牌、会话密钥和默认代理 URL 都会分别使用 AES-256-GCM 保存；主密钥丢失后无法恢复这些字段。
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

默认测试不调用真实 OpenCode 接口，因此不会产生费用。

如需用临时 Go Key 对官方 `deepseek-v4-flash` 做小额度在线冒烟测试，可在当前 PowerShell 会话设置 `OPENCODE_GO_KEY` 后运行 `npm run test:live:go`。默认 `full` 档会通过本地 `/go/v1` 验证模型发现、Responses 非流式正文与标准流事件、Claude 工具名与参数、Claude 工具结果回送后的续答、Chat SSE 正文与 usage，并登录临时管理会话核对五次请求的统计守恒；只输出状态和 usage，Key 不写入项目配置或日志，临时加密配置会在结束时删除。只需验证 Go 上游与基础 Responses 转换时，可设置 `OPENCODE_LIVE_PROFILE=quick`，它会跳过模型发现和其余协议回归，只发送一次小型 Responses 请求并核对一条统计记录。默认单请求超时为 60 秒；若上游临时拥塞，可在当前会话设置 `OPENCODE_LIVE_TIMEOUT_MS`（10000–600000）后重试。仅在模型列表端点拥塞、且已知模型名正确时，可临时设置 `OPENCODE_LIVE_SKIP_MODEL_DISCOVERY=1` 继续验证五项实际生成协议；该模式会在输出中明确标记跳过了模型发现。测试后可执行 `Remove-Item Env:OPENCODE_GO_KEY` 清除当前会话变量。
