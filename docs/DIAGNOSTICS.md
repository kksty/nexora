# 运行诊断与后续分析

诊断默认开启，从新版本运行时启动后开始采集，不补造历史数据，也不代替真实模型效果验收。日志不会发送到远程服务。

## 数据与关联

每行 JSONL 有 schema、UTC 时间 at、进程内单调时间 monoMs、bootId、seq、pid、taskId、event、data。data 内含 runId；按需带 workId、generation、sessionId、permitId、callId 等。进程重启后 bootId 改变，跨轮次用 runId 区分。

| 数据 | 用途 |
| --- | --- |
| model-queued / model-acquired / model-finished | 排队等待、首块、首文本、流及总耗时；provider/model/purpose；输入消息和工具数量；流块数、文本/推理/工具参数字符数 |
| usage 与 finishReason | 服务端提供的输入、输出、缓存、推理 token；结束类型与错误。字段缺失保持未知，不用字符数伪装 token |
| activity | turn/step、工具调用与结果、后台 job、PTY、命令进入上下文；工具开始/结束时间可关联算耗时 |
| worker-start / worker-exit / work-request-failed | 进程代次、退出原因、回收名额、失败次数、退避和恢复 |
| finding/message/report/command/consensus 事件 | 结合 state、findings、报告和会话，分析重复探索、消息投递、人工介入及过早/过晚完成 |
| state-write | 每次状态落盘大小、耗时、成功或错误 |
| runtime-sample | daemon 内存、CPU 增量、事件循环延迟、状态/历史日志大小、work/消息/发现/回执数、完成阻塞项、模型占用与排队；Linux work 的 PID/RSS/虚拟内存/线程数 |
| api-error / cleanup-failed / model-cleanup-timeout | 拒绝原因、清理失败、上游无法关闭时的进程恢复 |
| dropped / failedWrites | 当前 boot 累计日志丢弃和写失败数；用于判断采样是否完整 |

指标日志不复制提示词、完整回答或工具参数正文，只保存大小、类型和关联 ID；常见凭据字段、Bearer 值和环境中已知密钥会脱敏。原始会话、发现与证据仍可能含任务敏感内容，应按分析需要选取，别把 .env、.dsh、daemon.json 或生成的 Compose 凭据配置混入分享包。

## 默认保留与配置

| 环境变量 | 默认 | 含义 |
| --- | --- | --- |
| LIEBIAN_DIAGNOSTICS_INTERVAL_MS | 30000 | 周期采样间隔；1–3600000 毫秒 |
| LIEBIAN_DIAGNOSTICS_MAX_BYTES | 16777216 | 单个诊断文件上限，默认 16 MiB |
| LIEBIAN_DIAGNOSTICS_FILES | 8 | 每类文件总份数，含当前文件；1–64 |
| LIEBIAN_MODEL_STREAM_IDLE_MS | 120000 | 模型流无进展或消费者停读后的清理阈值；1–86400000 毫秒 |

Web 将这些设置传给随后启动的任务容器。修改 .env 后重建 Web，再启动任务。较慢模型可调高流空闲阈值；持续有数据的长流不会因总时长而触发它。

- 运行日志：runtime/logs/diagnostics.jsonl 及 .1 到 .7，默认合计约 128 MiB。
- 离线修改日志：diagnostics-offline.jsonl，独立使用同样保留设置。
- 诊断写入队列最多 4 MiB；过载丢弃计数、磁盘写失败计数和警告可见。诊断故障不会让任务提交失败。
- 单条文本最多 4096 字符，数组最多 200 项；总体 work 数单独记录。单条超出文件上限会丢弃并计数。
- 旧文件自动轮转淘汰，汇总不是整个任务生命周期的永久总账。长周期实验请定期保存日志快照。
- 原有 sessions、journal、证据、daemon/harness 文本日志不受这套轮转策略裁剪，避免损坏恢复与审计历史；资源采样追踪 state/journal 增长，仍需留意任务目录整体磁盘空间。
- 正常关闭会排空诊断队列；强杀、断电或坏盘可能丢失最后未完成的记录。重启会隔开不完整尾行，汇总统计损坏行。

## 生成摘要

在项目目录运行，无需模型凭据：

```powershell
node scripts/analyze-diagnostics.mjs tasks/<任务ID> .scratch/diagnostics-summary.json
```

也可以传入单独保存的 logs 目录。工具流式读取保留的诊断文件，输出：

- 模型请求数、结束类型、已知 token 用量和缺少完成记录的请求 ID。
- 排队、首块、首文本、流、工具及状态写入耗时的均值、P50/P95/P99。
- 内存、状态大小、work 内存峰值和最近 1000 个资源采样。
- 重试/清理事件计数、错误码、回收名额、丢弃与损坏记录数。
- 最慢的 20 个请求，便于按 work/session 追到原始上下文。

尽量在停止运行后汇总，或先复制完整日志快照；读取正在轮转的文件只能做到尽力而为。没有完成记录不直接等同于卡死，可能是仍在运行、崩溃、进程回收或旧日志淘汰。没有服务端 usage 时不推算成本。

## 交给后续分析

在同一工作区直接告诉我任务 ID 和关注的运行时段即可。可靠性与性能分析使用 diagnostics 和 state；模型行为/结果质量分析还需对应的 runtime/sessions、findings.md、task.md 及报告/必要证据。可重点检查：

1. 实际峰值并发、排队与限流、失败重试、进程重启和清理是否收敛。
2. 状态增长与落盘耗时是否相关；daemon/work 内存是否持续上涨。
3. 工具失败、长时间等待、人工命令何时进入上下文。
4. 各执行者方向是否重复、共享发现是否被使用、共识是否与最终证据一致。

本轮探针只证明日志链路能采集并汇总；真实模型质量、长时间资源趋势、Linux VPS 部署仍待实际运行数据。

