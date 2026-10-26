# 验证说明

验证日期：2026-10-25（Asia/Shanghai）。本文件区分自动回归与真实环境探针；不把假模型通过当作公网模型质量验收。

## 自动回归

```powershell
npm test
npm run typecheck
docker compose config --quiet
```

自动测试不调用模型、不需要 Docker。覆盖生命周期、并发追加、裂变/退出、消息、共识失效、活动核对、人工命令、报告、schema 迁移、写入所有权、Web 路由、Compose 文件读改写和 harness driver 停止竞态。

新增回归集中在：

- `tests/idempotency.test.ts`：发现并发重试、冲突、作者隔离、重启及终止后重放；消息部分/全部失败回执、收件人后来出现不重复发送、旧客户端兼容。
- `tests/ports-readiness.test.ts`：端口占用与配置校验、多任务独立绑定；就绪等待、提前退出和超时拒绝成功。
- `tests/terminal-activity.test.ts`：打开终端持续阻塞、关闭结算、不同进程代次隔离、未知终端核对。
- `tests/api-mcp.test.ts`：未就绪健康检查返回 503；host 端口被其他任务复用时不误判原任务在线。
- `tests/compose-task.test.ts`、`tests/harness-patch.test.ts`：host service、终端及活动插件配置。

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

## 本次结果

| 检查 | 结果 |
| --- | --- |
| `npm test` | 179 项：177 通过、0 失败、2 跳过（MCP 客户端包未安装时跳过该两项） |
| `npm run typecheck` | 通过 |
| Compose 配置与镜像构建 | 通过 |
| bash 后台任务探针 | 通过 |
| 步骤边界 steering 与会话恢复探针 | 通过；探针等待真实上下文事件，不再把入队 ack 当作上下文完成 |
| PTY 探针 | 通过：持久变量、本地 TCP 交互、SIGINT、读取/列举/关闭与完成阻塞 |
| 双任务 Compose 演练 | 通过：空 `.dsh` 并发初始化、host、自定义管理端口、真实裂变与命令、幂等、宿主连接任务自选监听端口、停止清理 |
| 启动失败与重试 | 通过：错误端口配置导致提前退出，明确报错，保留 active 任务；改正后同任务启动成功 |
| 当前 Web 部署 | 已更新；host 网络，`http://127.0.0.1:43187/health` 正常，容器 healthy |
| 自定义控制台端口 | 独立测试容器用 `LIEBIAN_WEB_PORT=45187`，宿主健康检查通过，测试后已清理 |

## 极端故障修复与诊断扩展验收（2026-10-25）

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
