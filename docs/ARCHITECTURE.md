# 架构与协议

本文描述当前实现，不保留阶段计划或历史审查流水账。部署与配置见 [README](../README.md)，验证见 [VALIDATION](VALIDATION.md)。

## 执行模型

一个 task 对应一个 Docker Compose service，所有 service 使用 host 网络。每个 work 对应一个 `dsh --profile sdk` 进程及独立持久会话。work 在同一任务容器共享文件和网络，通过运行时 MCP 工具读写资料、发消息、裂变与表态；进程间没有上下级权限关系。

运行时不判断领域结论、探索充分性或任务价值，不设置固定专家、任务树、裂变深度、work 数量、预算或中央评审者。模型请求并发上限只控制在飞请求，不限制裂变。

| 代码 | 职责 |
| --- | --- |
| `src/core/engine.ts` | 状态变更、会话生命周期、消息、命令、报告、共识与恢复 |
| `src/core/state.ts` | schema v1–v4 到 v5 的备份迁移、附加字段归一化、持久化 |
| `src/core/activity.ts` | 工具、job、PTY 生命周期投影与完成阻塞 |
| `src/harness/sdk-driver.ts` | 启动/恢复/停止 harness，转接事件与持久会话重放 |
| `src/harness/patch.ts` | 精简工具面与运行时插件配置 |
| `src/harness/terminal-activity.ts` | 从 harness 实际终端注册表写入生命周期快照 |
| `src/harness/command-steer.ts` | claim → steer → ack，将人工命令送入步骤边界 |
| `src/harness/llm-concurrency.ts` | 每任务合计模型请求并发控制 |
| `src/api/`、`src/mcp/`、`src/cli.ts` | 同一协议的 HTTP、MCP 和人工 CLI 接口 |
| `src/web/` | 观察/控制台、配置、Compose service 生成与就绪检查 |

## 网络、身份和工具

Web 默认监听 `127.0.0.1:43187`；每个任务从 `LIEBIAN_API_PORT_RANGE` 原子绑定一个空闲回环端口。work 的业务监听端口由自身选择。host 模式下不同任务也共享宿主端口；管理 API 仍验证各任务独立令牌。任务启动后 Web 等待新的 daemon descriptor，并通过鉴权管理调用验证 task ID，不接受旧 descriptor 或 `pid 0`。

健康探针同时核对 task ID，避免旧端口被其他任务复用后误判原任务在线。多个 Task 共享 `.dsh`，容器入口使用文件锁串行化首次 profile 初始化，避免并发读取半写入的配置。

执行者拥有 bash、文件读写/编辑、glob/grep、job_output/list/kill、六个 terminal 工具与 `mcp__liebian__*`。禁用 skill、subagent、workflow、goal 等创建隐藏执行者的路径。HTTP 使用 CLI；任务记忆使用共享发现。模型循环、压缩、持久会话和 PTY 全部复用 harness。

每次 terminal 工具返回后，插件从真实终端注册表记录 `liebian/terminals` 事件。驱动将事件转为运行时快照，投影为 `kind=terminal` 的生命周期记录，沿用既有阻塞、崩溃核对和展示路径。记录 ID 包含进程代次；不同代次的同名 PTY 不互相覆盖。终端空闲或某次发送结束不会清除生命周期记录；关闭/退出经注册表确认后才结算。无需解析 shell 输出猜测存活状态。

## 资料、报告与重试

`state.json` 是权威状态；`task.md` 与 `works.md` 是派生视图。`findings.md` 是追加日志，恢复时按块核对并补齐未完成尾部，保留完整历史块中的人工修改并发出警告。

发现是不可变追加记录。`supersedes` 记录替代关系，默认查询只返回当前叶子；`history` 显式读取历史。增量查询用游标分页并提供失效通知，不把阅读游标当作完成意见。

报告由 `report_publish` 提交：`base_revision` 防止并发覆盖，`request_id` 保证重试，`runtime/reports/<key>/rN.md` 保存不可变内容，固定入口为派生文件。入口与登记哈希不同会阻塞完成；重新发布确认修改或 `restore=true` 恢复。提交后崩溃会在恢复/重试时补齐入口。

发现和消息的回执保存在 schema v5 的 `workRequests` 附加字段，旧文件缺失时初始化为空。键为作者 work、操作和 request ID 的组合；归一化参数哈希用于检测冲突。引用/收件集合的顺序不影响比较。回执及业务记录在同一次状态写入中提交，然后才追加派生文件或通知接收者。重复请求返回保存的原结果，不重复改变共享版本或投递。回执查询先于 active 限制，故已提交请求在作者退出/任务结束后仍可重放；没有回执的新操作仍须通过身份和状态检查。

人工命令、继续、恢复、裂变和报告有各自的持久幂等协议。幂等保证的是不重复提交同一操作，不承诺网络层或模型行为的 exactly-once；命令 steering 在未观察到上下文回执时可能至少一次重投。

## 人工介入

人工命令持久保存为任务级记录，每个 work 有独立投递状态：`saved`、`enqueued`、`entered-context` 或 `recipient-exited`。只有观察到对应 `user/message` 才表示进入模型上下文；队列回执不表示已执行。新加入 work 获得仍有效的命令。

长轮次在下一步骤边界接收 steering；不可中断工具执行期间如实保持入队状态。运行时离线时普通命令拒绝且不落盘，避免多个写入者。修改起始/终点使旧共识失效。

## 完成与退出

必须同时满足：当前参与集合非空、全体明确同意同一轮次/目标版本/共享版本、没有未结算工具或 job/PTY、没有待接收结果或待核对活动、没有未完成命令投递、没有报告漂移或在途协议写入。

沉默、失败、进程崩溃不等于同意或退出；全体退出也不算完成。退出 work 的遗留活动仍可能阻塞任务。发现、消息、人工命令、参与集合或实际执行活动发生变化，会使旧轮次失效。理由可选，运行时不审核完成理由的质量。

查询、投票、收信与协议等待不会自己形成无限的失效循环。共识期间仍可工作，真正提交完成时冻结状态并保存记录，再清理进程。

## 故障、继续与持久化

任务状态为 active/completed/stopped，运行历史保存为 `runs`。同一 run 崩溃后优先恢复原 work 和持久会话；会话丢失时创建新会话并告知历史缺失。原进程未确认结束的活动标记未知，必须核对外部事实后 `activity_reconcile`，不能盲目重放可能已执行的操作。PTY、TCP、外部副作用不随会话日志恢复。

已结束任务“继续并发送”创建新的 run/work，保留共享资料和用户命令；旧票、旧终态、旧事件与遗留活动不污染新 run。active 空集合使用人工恢复，在同一 run 创建承接 work。已提交完成的任务重启只做清理，不重新探索。

daemon 在 `runtime/owner.json.lock.sqlite` 上持有 SQLite 的 OS 独占锁，整个写入生命周期内保持事务；进程退出或强杀后由系统释放。`owner.json` 每 2 秒更新的心跳只是可观察元数据，不再凭心跳过期抢占活进程。所有离线修改持有同一把锁，并在释放前排空诊断日志。旧文件租约迁移仍检查原心跳和 daemon；升级时先停止旧运行时。

Docker Desktop 的 Windows 宿主与 Linux 容器不共享 SQLite 锁域。因此持久化 `.lock.sqlite.domain` 校验锁域，不同域明确拒绝写入；Docker 任务的离线修改通过 Web 或容器 CLI 完成。不要删除锁文件或修改域标识来绕过检查。当前只支持单宿主本地文件系统，不承诺网络文件系统锁语义。

状态写入使用临时文件 + fsync + rename；Windows 暂时拒绝替换时有限重试，最终失败保留旧文件，绝不先删除目标。POSIX 还同步父目录。硬件、文件系统或突然断电仍不具备数据库级任务事务保证。删除任务先在锁内登记删除标记并移除权威状态，再释放系统句柄并清理目录，防止迟到写入者重建任务。

模型名额绑定 work 和进程代次，旧进程退出只回收自己的名额；旧代次的新请求被拒绝。流取消、消费者提前退出和插件释放均主动关闭上游。默认 120 秒没有流进展（包括消费者遗弃）触发清理；上游 5 秒内无法关闭时请求运行时停止该进程，确认退出后回收名额，按正常失败流程恢复。停止进程会等待退出，必要时升级 SIGKILL；停止失败不会写成清理完成。

```
tasks/<id>/
  task.md / findings.md / works.md
  evidence/
  runtime/
    state.json / journal.jsonl
    daemon.json / owner.json
    harness.patch.yml
    sessions/        # harness 可恢复历史
    consensus/       # 完成记录
    reports/<key>/   # 不可变报告版本
    logs/            # daemon、harness、容器启动日志及轮转 diagnostics JSONL
```

## 当前边界

- 执行者是同一任务信任域内的进程，能读共享凭据和本任务状态，不能把 work 身份当作抵抗恶意同容器进程的安全边界。host 进一步共享宿主网络，任务容器仍不获得 Docker socket。
- MCP 桥接仍回显客户端请求的协议版本，只验证了当前 harness 使用的基础工具调用；没有完整协议版本协商。
- `state.json` 每次整体序列化；SQLite 仅用于系统锁，不存任务数据。本版没有长期增长压测或跨主机故障转移，新增诊断记录状态大小、落盘耗时和资源变化，见 [运行诊断](DIAGNOSTICS.md)。
- 不提供多用户账户、每个 work 的独立安全隔离、中央调度/验收 agent 或预算管理。
