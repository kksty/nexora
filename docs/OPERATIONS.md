# Nexora 运维指南

网络、任务控制、交互终端、持久化与故障恢复的详细说明。首次部署请先阅读 [快速启动](../README.md#快速启动)。

## 网络与端口

Web 和任务 service 都设置 `network_mode: host`，不配置 `ports`。work 按需选择监听端口，不需要修改 Docker 配置或让用户逐个批准端口。

| `.env` 配置 | 默认值 | 用途 |
| --- | --- | --- |
| `LIEBIAN_WEB_HOST` | `127.0.0.1` | 控制台监听地址；局域网/VPS 直接访问可改为 `0.0.0.0` |
| `LIEBIAN_WEB_PORT` | `43187` | 控制台端口 |
| `LIEBIAN_API_PORT_RANGE` | `43188-43287` | 每个任务从中直接绑定一个空闲管理端口，只监听回环地址 |
| `LIEBIAN_TASK_START_TIMEOUT_MS` | `60000` | 容器启动后等待运行时就绪的毫秒数，范围 1000–300000 |
| `LIEBIAN_CALLBACK_HOST` | 空 | 可选的目标可达宿主机 IP/域名，会提供给执行者 |
| `LIEBIAN_WEB_TOKEN` | 随机 | 固定控制台令牌，至少 8 个字符 |
| `LIEBIAN_WEB_PUBLIC_URL` | 空 | 自定义控制台对外入口地址 |
| `LIEBIAN_WEB_ALLOWED_ORIGINS` | 空 | 反向代理等场景允许的额外 Origin，逗号分隔 |

管理端口可以设为一个端口、一段端口（最多 1001 个）或 `0`（系统分配）。多个任务不要共用一个固定管理端口。运行时直接尝试绑定并跳过已占用端口，端口段耗尽会明确失败。

示例：

```dotenv
LIEBIAN_WEB_HOST=0.0.0.0
LIEBIAN_WEB_PORT=45187
LIEBIAN_API_PORT_RANGE=45188-45287
LIEBIAN_CALLBACK_HOST=192.168.1.20
```

修改后执行 `docker compose up -d web` 重建 Web 容器；任务相关配置用于随后启动的任务。旧版已生成的任务 service，需要先停止，再从 Web 启动以重新生成 host 配置。

- 所有 work、所有任务与宿主机共享端口。监听以绑定成功为准，端口占用时换一个；无需中央端口分配器。
- 监听地址和回连地址不同：`0.0.0.0` 表示监听所有可用地址，不能作为目标的回连地址。回连使用目标可达的内网、公网或 VPN 地址。
- host 不替代路由、防火墙或上游 NAT 配置。Docker Desktop host 提供 TCP/UDP 连通，不等同于原生 Linux 的底层网卡能力。
- 任务保留 `NET_RAW` / `NET_ADMIN`。原生 Linux 的 host 模式会共享宿主网络，网络配置操作会影响宿主；执行者提示词要求不要为普通端口冲突修改宿主路由/防火墙。

参考：[Docker host 网络](https://docs.docker.com/engine/network/drivers/host/)。

## 交互式终端

短命令继续使用 `bash`。长连接、监听、交互 shell、REPL 使用 harness 自带的六个工具：

| 工具 | 用途 |
| --- | --- |
| `terminal_open` | 创建持久 PTY，`type: "shell"` |
| `terminal_send` | 发送文本，可选 Enter 或后台执行 |
| `terminal_read` | 分页读取保留输出 |
| `terminal_signal` | 向前台进程组发送 SIGINT 等信号 |
| `terminal_list` | 列出当前 work 的终端 |
| `terminal_close` | 关闭终端并等待进程树结束 |

终端按 work 隔离；同一 work 可以跨多次调用继续操作，其他 work 不能直接输入该终端。后台发送用 `job_output` / `job_kill` 收集或中断。

发送返回 `timeout` / `inferred_idle` 或后台发送 job 结算，均不表示长连接已结束。运行时根据真实终端注册表跟踪生命周期：**打开的终端阻止任务完成，使用完后必须关闭**。重启不会恢复真实 PTY 或 TCP 连接；旧终端会成为待核对活动，执行者确认后通过 `activity_reconcile` 解除阻塞，再按需要重新连接。

## 日常操作

```powershell
docker compose ps
docker compose logs -f web
# 更新 Web，不打断正在运行的任务
docker compose up -d --build web
# 启动所有已登记服务 / 一起停止
docker compose up -d
docker compose down
```

Web 中：

- 运行中“发送命令”：保存后在 harness 的输入步骤边界投递；界面区分已保存、已入队、已进入模型上下文。进入上下文不等于要求已完成。
- “修改起始/终点”：更新任务定义并通知 work，旧共识失效。
- “停止”：明确写入 stopped 并清理运行时。
- 已结束任务点“继续”：同一个 task 下创建新 run、新 work，**不需要填写指令**，执行者启动后自行读取共享状态继续；需要附加要求时用“继续并发送指令”。保留发现和报告，旧轮次意见不参与新轮次。
- active 但没有参与 work 时“恢复工作”：在同一 run 创建承接 work。
- “启动运行时”：故障中断后恢复原 run/会话。启动失败时可重试，不自动判定目标完成。

CLI 入口（把 `<任务ID>` 替换为实际值）：

```powershell
docker exec liebian-<任务ID> liebian status --task <任务ID>
docker exec liebian-<任务ID> liebian command --task <任务ID> --text "补充要求" --request-id cmd-001
docker exec liebian-<任务ID> liebian commands --task <任务ID>
docker exec liebian-<任务ID> liebian stop --task <任务ID> --reason "人工停止"
```

离线 `continue` / `recover` / 修改信息需先确认旧运行时已停止，并取得同一任务写入租约。普通人工命令不做离线暂存：运行时不在时明确返回未保存。

写入权现在由进程生命周期内的系统独占锁保护，心跳过期不会抢走活进程的锁。Docker Desktop 任务须通过 Web 或容器 CLI 做离线修改；Windows 宿主直接修改 Linux 锁域的任务会明确拒绝。升级前停止旧版任务运行时，新运行时会兼容检查旧租约。

新运行时默认记录模型排队/首块/首文本/总耗时、服务端 token 用量、工具事件、失败重试、共识变化、状态写入及每 30 秒资源采样。日志位于 `tasks/<id>/runtime/logs/diagnostics.jsonl`，默认每份 16 MiB、保留 8 份。离线修改写入单独的 `diagnostics-offline.jsonl`。完整对话仍保存在 `runtime/sessions/`。

后续直接提供任务 ID，即可结合日志、状态、发现、报告和会话分析。也可先生成统计摘要：

```powershell
node scripts/analyze-diagnostics.mjs tasks/<任务ID> .scratch/diagnostics-summary.json
```

## 重试幂等

`findings_append` 与 `peer_send` 支持稳定 `request_id`，新执行者提示词要求每次操作携带它。为兼容旧客户端，该参数仍可省略；省略时每次调用都是新操作。

- 幂等范围为“作者 work + 操作类型 + request_id”。同 ID、相同归一化参数返回原结果，不重复追加、通知或投递。
- 同 ID 不同内容返回 `REQUEST_CONFLICT`；新操作使用新 ID，不做正文语义去重。
- 回执与发现/消息在同一次 `state.json` 提交中保存，重启后仍可重放。作者退出或任务结束后，已提交请求仍可重放，但新写入被拒绝。
- 消息部分失败或全部失败的结果也固定下来。收件人后来出现不会让旧请求额外发送；重新发送需用新 ID。
- 命令、继续、恢复、裂变和报告发布也有各自的幂等协议。

## 模型、镜像与数据

模型默认 `deepseek-official/deepseek-flash`，harness 固定 `@deepseek-ai/dsh@0.2.1-rc.2`。`.env` 支持 `LIEBIAN_PROVIDER`、`LIEBIAN_MODEL`、`DEEPSEEK_BASE_URL`、`DEEPSEEK_API_KEY`。Web 保存的 API 配置优先，未保存时回退到环境变量。`LIEBIAN_MODEL_CONCURRENCY` 默认 2，限制每个任务所有 work 合计的在飞模型请求数；工具执行、等待与退避不占名额。

镜像包含 Node 24、harness、bash、curl、git、Python、nmap、masscan、sqlmap、ffuf、tcpdump 等工具；不是全量工具发行版。构建变量：`APT_MIRROR`（默认清华 Debian 源）、`NPM_REGISTRY`、`DOCKER_CLI_IMAGE`。首次 apt 安装证书前使用 http 镜像源。

持久数据均位于仓库：

| 路径 | 内容 |
| --- | --- |
| `tasks/<id>/` | 任务定义、发现、证据、状态、报告、日志与 harness 会话 |
| `.dsh/` | harness profile 与凭据 |
| `compose/tasks.yaml` | Web 生成的 task services，可能含模型密钥；不要手改或发布 |
| `.scratch/` | 本地测试与探针临时数据 |

Task 容器只挂载自己的任务目录和 `.dsh`，没有 Docker socket；Web 管理容器挂载 Docker socket。host 模式共享网络，不共享所有宿主文件。不要手改 `state.json`、`task.md`、`works.md`；报告通过 `report_publish` 发布。

## 开发与验证

开发宿主需要 Node >= 22.18：

```powershell
npm test
npm run typecheck
```

`npm test` 走 `scripts/run-tests.mjs`，它只做一件事：在启动测试进程前关闭宿主注入的
批量删除保护（`CODEBUDDY_SAFE_DELETE_ENABLED=0`）。测试会反复创建并递归删除 `.scratch`
下的任务目录，这类保护会在累计删除量达到阈值后拒绝清理，导致与业务无关的用例在
`t.after` 里报 `SAFE_DELETE_BULK_CONFIRM_REQUIRED`。普通终端里该变量本就不存在，设置它没有副作用。

### 构建期修复 harness 的流式解析

镜像构建时会执行 `docker/patch-harness-llm.mjs`，对 `@deepseek-ai/dsh-llm-deepseek`
做一处定点修改：某些 OpenAI 兼容网关（如当前使用的 Sub2API）会在 `content_block_stop`
之后继续发送该工具调用块的参数分片，且分片本身不是合法 JSON（缺外层花括号、偶尔重复）。
上游客户端把「向已关闭块发 delta」视为致命的 `MALFORMED_RESPONSE`，执行者会耗尽重试、
整轮不干活。

补丁改为忽略这些迟到分片，保留流中已经完整的那个工具调用。补丁以精确源码锚点定位，
锚点对不上会**构建失败**（而不是静默失效），升级 SDK 时会立刻暴露。修改点在
`docker/patch-harness-llm.mjs`，日志关键字：`liebian: tolerate late block deltas`。

真实 harness / 交互终端探针在 Linux 镜像内运行，不调用公网模型：

```powershell
docker compose build web
docker run --rm --network host --entrypoint node liebian:latest /app/scripts/probe-terminal.mjs
```

更多容器演练与验证边界见 [验证说明](VALIDATION.md)。当前范围不包括多用户权限系统、中央调度 agent、预算管理器、跨主机编排或每个 work 一个容器。
