# 验证说明

验证日期：2026-10-26（Asia/Shanghai）。本文件区分自动回归、短时合成增长探针与真实环境探针；不把假模型通过当作公网模型质量验收，也不把短时探针当作长期压测。

## 自动回归

```powershell
npm test
npm run typecheck
docker compose config --quiet
```

自动测试不调用模型、不需要 Docker。覆盖生命周期、并发追加、裂变/退出、消息、共识失效、活动核对、人工命令、报告、schema 迁移、写入所有权、Web 路由、Compose 文件读改写、harness driver 停止竞态、会话尾读、Web 设置、MCP 生命周期和工作台异步竞态。

新增回归集中在：

- `tests/idempotency.test.ts`：发现并发重试、冲突、作者隔离、重启及终止后重放；消息部分/全部失败回执、收件人后来出现不重复发送、旧客户端兼容。
- `tests/ports-readiness.test.ts`：端口占用与配置校验、多任务独立绑定；就绪等待、提前退出和超时拒绝成功。
- `tests/terminal-activity.test.ts`：打开终端持续阻塞、关闭结算、不同进程代次隔离、未知终端核对。
- `tests/api-mcp.test.ts`：未就绪健康检查返回 503；host 端口被其他任务复用时不误判原任务在线。
- `tests/compose-task.test.ts`、`tests/harness-patch.test.ts`：host service、终端及活动插件配置。
- `tests/conversation.test.ts`：8 MiB 尾读、400 条上限、完整/部分/损坏记录的截断原因与持久游标；会话路径越界和同名会话歧义均拒绝猜测。
- `tests/frontend-runtime-behavior.test.ts`、`tests/frontend-settings-behavior.test.ts`：关闭或替换弹窗后隔离迟到响应、暂停/恢复轮询、保留阅读位置、连接参数变化丢弃旧模型结果、快速重复保存只提交一次。这些是 Node `vm` 与最小 DOM stub 测试，不是真实浏览器 E2E 或视觉验收。
- `tests/mcp-protocol.test.ts`、`tests/api-mcp.test.ts`：MCP `2025-11-25` 生命周期、initialize 参数和工具发现、未知版本协商、通知不回包、JSON-RPC 解析/请求/方法/参数错误，以及 DSH `server/discover` 回退。
- `tests/model-test.test.ts`、`tests/web.test.ts`、`tests/backend-docker-launcher.test.ts`：损坏设置与非法环境数值的来源回退；保存的模型上限/思考强度/并发进入新任务 environment；假 Docker 入口验证失败重试、并发守卫、运行中保护和 inspect 瞬态错误。
- `tests/harness-patch.test.ts` 的装载用例：不比对生成文本，而是调用真实 `dsh --profile sdk --patch <file> --dump-config` 合成 profile，断言自建适配器确实出现在合成配置里、原生 Messages 适配器被禁用、且 stderr 不含 `not found`。该用例在“把适配器写回顶层数组”的错误写法下会失败，因此能抓住“patch 条目被 loader 静默丢弃”这类字符串断言无法发现的问题。两个方向（兼容模式、DeepSeek 模式）各一条。

## 短时合成状态增长探针

```powershell
node scripts/probe-state-growth.mjs
```

探针只在 `.scratch/state-growth-probe/run-*` 下创建独立合成任务，使用空操作的测试驱动及生产 `Engine`、`appendFinding`、`sendMessage`、原子状态写入和 `loadState` 路径，不调用模型或 Docker，不访问网络，不写用户 `tasks/`。默认五轮，每轮增加 120 条发现和 60 条消息。每轮记录累计发现/消息数、`state.json` 大小、批次写入耗时、状态读取耗时、RSS 与 heapUsed，并检查重载后的计数、连续 ID、共享版本和采样记录哈希。默认结束后只清理本次创建的目录；`--keep` 保留产物。

这是有限、可重复的短时冒烟基线，不是长期压力测试，也不设置武断性能阈值。文件大小、耗时和内存随主机状态变化；读取耗时只测 `loadState`，不包含 UI 或模型请求。

## 真实 harness 探针

探针在 Linux task 镜像内运行，使用本地假模型服务，不访问外部目标或公网模型。镜像内含脚本，临时数据默认清理，`KEEP_PROBE=1` 可保留诊断文件。

```powershell
docker compose build web
docker run --rm --network host --entrypoint node liebian:latest /app/scripts/probe-real-harness.mjs
docker run --rm --network host --entrypoint node liebian:latest /app/scripts/probe-command-steer.mjs
docker run --rm --network host --entrypoint node liebian:latest /app/scripts/probe-terminal.mjs
```

| 探针 | 检查内容 |
| --- | --- |
| `probe-real-harness.mjs` | 真实 bash 后台 job 登记/结算、完成通知进入上下文、回到 idle |
| `probe-command-steer.mjs` | 命令在同一 turn 的步骤边界进入上下文；持久会话恢复后仍可 steering |
| `probe-terminal.mjs` | 六个 PTY 工具，跨调用变量保持、本地 TCP 交互、SIGINT 返回 shell、关闭清除生命周期阻塞 |

这些测试验证工具和事件链路，不衡量模型是否选择了正确命令。容器重启后的会话恢复不代表真实连接恢复。

## 部署验收

开发宿主可直接执行独立 Compose 演练：

```powershell
node scripts/probe-compose.mjs
```

脚本使用 `.scratch` 下独立任务、独立 Compose 项目和本地假模型，不修改用户任务或模型配置。检查首次并发初始化、两个任务自定义管理端口、真实裂变、发现/消息幂等、命令上下文回执、容器自行监听后宿主连接、停止清理、启动失败及同任务重试。Docker Desktop 的端口转发可能稍晚于容器监听建立，探针按实际连通等待。

Windows 使用已启用 host networking 的 Docker Desktop；Linux 使用原生 host 网络，配置不按平台分支。建议部署时确认：控制台可访问、两个任务管理端口不同、任务监听端口可从预期网络访问、停止后容器和生成 service 清理、失败启动返回错误并保留可重试状态。

最终执行结果记录在本文件末尾；未执行的部署环境不宣称已验证。公网模型和外部网络可达性需使用部署方自己的凭据与网络条件验证。

## 2026-10-26 本轮结果

以下结果是最终冻结工作区上的实际运行，不代表对 2026-10-25 Docker 记录的重新执行：

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm test` | 214 项：214 通过、0 失败、0 跳过；约 44.5 秒（含新增 2 条真实 loader 装载用例） |
| 前端行为专项 | 7/7 通过；只覆盖 Node `vm`/DOM stub 的事件与状态隔离 |
| MCP 原生协议专项 | 4/4 通过；现有 API-MCP 测试也在全量中通过 |
| 后端会话与 Docker 专项 | 指定五个测试文件 42/42 通过；假 Docker 不启动真实容器 |
| Patch 装载（真实 loader） | 兼容模式与 DeepSeek 模式各 1 条通过；`dsh --dump-config` 无 `not found`，自建适配器实际合成进 profile，原生 Messages 适配器在兼容模式下被禁用 |
| 状态增长探针 | 5 轮通过；600 条发现、300 条消息，最终 `state.json` 1,640,294 字节（1.564 MiB）；批次写入约 0.838–1.514 秒，`loadState` 约 1.589–5.980 毫秒；RSS 采样 119.3–152.7 MiB；完整重载、连续 ID、计数和采样哈希一致 |
| 最终 diff 检查 | `git diff --check` 通过 |

本轮没有运行真实 Docker 镜像、真实 harness/PTY 探针、公网模型或真实浏览器 E2E，因此不宣称这些环境已复验。增长探针没有运行数小时或更长时间，不能据此推算长期吞吐、稳定上限或生产容量。Patch 装载用例只验证 profile 能正确合成，不发送模型请求。

## 极端故障修复与诊断扩展验收（2026-10-25）

以下全部是本文件保留的历史真实 Docker 验收记录。它们来自 2026-10-25 的实际运行，**没有在 2026-10-26 本轮重新执行**，不能当作本轮部署或压力结论。

- Windows 完整回归 176 项通过，类型检查及 Compose 配置检查通过。
- Linux 镜像内原子文件、所有权、诊断、并发与 driver 专项 35 项通过；包括强杀恢复、顽固进程升级 SIGKILL、遗弃流与拒绝关闭的上游。
- 真实 harness 后台 job、步骤边界命令/会话恢复、PTY 探针通过；双任务 Compose 演练通过。
- 双容器文件锁互斥实测：持锁时第二容器返回 TASK_BUSY，强杀持锁容器后立即成功取得锁。
- Docker Desktop 跨 Windows/Linux 的 SQLite 锁实测不互通，现用持久锁域标识拒绝混合写入；跨域请求返回 LOCK_DOMAIN_MISMATCH。Docker 任务的 Windows 宿主离线修改须通过容器 CLI 或 Web。
- 双任务演练验证实际模型调用记录的进程代次、轮次、服务端 token、首文本延迟、worker 内存及零丢失计数；离线摘要已从演练日志成功生成。
- 日志轮转、队列上限、失败与丢弃计数、常见凭据脱敏、崩溃半行恢复和汇总统计均有回归覆盖。
- 新日志与分析方式见 [运行诊断](DIAGNOSTICS.md)。本轮使用本地假模型，不宣称完成真实模型质量验收或长时间压力测试。

本地验证输出保存在 `.scratch/reliability-final-tests.log`、`.scratch/reliability-linux-tests.log`、`.scratch/reliability-final-compose.log` 等文件，属于可清理的诊断材料。

本次真实环境为 Windows Docker Desktop + Linux 容器。没有另外部署 Linux VPS，没有调用公网模型，也没有对外部目标执行反向 shell；网络验收使用本地 TCP 回显服务。VPS 使用同一份 host 配置，外部回连可达性仍取决于实际网络。

历史记录的自动化数量与本轮不同，是因为历史和当前测试集合不同；两行分别保留当时的实际结果。

## 当前剩余验证边界

- 会话视图只读取最多 8 MiB 尾部、最多 400 条记录，尚无更早日志的字节游标；前端统一显示“已截断”，尚未分别提示 `partial`、`corrupt` 等原因。
- MCP 桥接支持 legacy `2025-11-25` 及为 DSH 自动协商保留的 `server/discover` 回退；未实现 2026 modern server/discover、新传输或 resources/prompts 等完整 MCP 表面。
- Docker 启动行为通过受控假 CLI 验证，未在本轮启动真实容器。Windows 假 `.cmd` 入口会出现 Node `DEP0190` 警告，但没有导致测试失败。
- 状态增长只是短时合成基线；尚未覆盖非常长的消息/发现历史、真实会话与诊断日志同时增长、断电恢复、网络文件系统或多主机故障转移。
- 当前工作台异步行为由 Node `vm` 和最小 DOM stub 覆盖；真实浏览器事件循环、原生 datalist 和视觉布局仍需人工验收。
