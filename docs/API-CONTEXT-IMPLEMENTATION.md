# API 与上下文设置实现说明

本文记录当前代码已经接通的 API 协议、认证、上下文预算和任务容器配置链路。它描述客户端行为，不等同于任何具体模型、量化、GPU 或服务端容量的承诺。

## 协议和认证

Web 设置通过 `modelApiProtocol` 选择两条明确的请求路径：

- `deepseek` 保留 DeepSeek Messages 语义。检测请求发送到 Messages 路径，使用 `x-api-key` 和 `anthropic-version`；官方 DeepSeek 需要非空 API Key。
- `openai-compatible` 使用项目自有 Chat Completions adapter。请求路径为配置 Base URL 下的 `/chat/completions`，模型 ID 原样写入 `model`。非空 Key 才发送 `Authorization: Bearer <key>`，空 Key 完全省略该 header，因此可以连接无鉴权的本地 vLLM、Ollama 或网关。

兼容模式也可请求 `/models`。列表内容只用于选择模型 ID；`/models` 没有上下文字段时，客户端不会根据模型名称或列表条目猜测窗口。旧的 `DEEPSEEK_API_KEY` 只在官方 DeepSeek 配置中作为兼容来源使用，切换到兼容模式后不会转发给新服务。

Chat Completions adapter 支持文本和 reasoning 增量、SSE 结束原因、工具调用参数分片、工具调用结束块，以及下一次请求中的 assistant `tool_calls` 和对应 `tool` 结果消息。DashScope 使用 `enable_thinking`；显式选择 vLLM 时使用 `chat_template_kwargs`。`auto` 只根据已知 DashScope 域名选择 DashScope 字段，未知自建地址不猜测厂商协议。

## 上下文窗口和输出预算

`modelContextWindow` 是输入和输出合计的客户端窗口，`modelMaxTokens` 是单次响应输出预算，`modelSafetyMarginTokens` 是额外预留。启动和保存要求：

```text
modelMaxTokens + modelSafetyMarginTokens < contextWindowEffective
```

自动压缩阈值使用 `min(window × modelAutoCompactRatio, window - output - safetyMargin)`。默认上下文回退是 32,768，但会标记为 `fallback`、`contextWindowKnown=false` 和 `requiresServerConfirmation=true`；这个数值不表示服务端至少支持 32K。默认输出上限为 6,144，默认每任务模型并发为 2。

可信窗口来源按优先级标记为：用户声明的 `declared`、官方 DeepSeek 已知 catalog 的 `deepseek-catalog`，以及 vLLM metrics 中读取到的 `server-metrics`。OpenAI-compatible 的 `/models` 返回模型 ID 不会成为窗口来源。

当显式选择 `modelThinkingAdapter=vllm` 且窗口仍未知时，Web 模型检测会尝试读取 Base URL 对应服务根路径的 `/metrics`，解析 vLLM `cache_config_info` 的 `max_model_len`。这个请求只读取 Prometheus 文本，不发送生成请求，也不读取本机模型目录；没有该指标、访问失败或格式不支持时继续使用 32,768 fallback 和警告。Ollama 不做消耗 token 的窗口探测，必须按服务端 `num_ctx` 或其他实际配置手动确认。

这些设置不会修改 vLLM 的 `--max-model-len`、Ollama 的 `num_ctx` 或其他上游服务参数。它们通过客户端 adapter 和 compaction 配置限制请求预算。修改后由新启动的 runtime 使用；已经运行的任务不会热切换配置。

## Docker 转发

Web 启动任务时会读取同一份有效设置，清理继承环境中的模型变量，重新生成当前 Harness patch，并把协议、Provider、模型、Base URL、Key、输出预算、上下文窗口、压缩比例、安全余量、思考适配和每任务并发写入 Task Compose service。兼容模式只写 provider-neutral 的 `LIEBIAN_*` 路由；DeepSeek 模式另外写入 legacy `DEEPSEEK_*` 名称供官方 SDK 使用。

因此，Web 保存、模型检测和新 Task runtime 使用同一组解析器与校验规则。空 Key 的兼容服务不需要伪造凭据；DeepSeek 的空 Key 会在保存、检测或启动前被拒绝。

## Patch 装载方式

Harness profile patch 的顶层数组条目**只能覆改 profile 已挂载的插件**，不能引入新插件；新增条目必须放在 `insert:` 块内。两种协议因此走不同写法：

- `deepseek`：base profile 已挂载原生 Messages 适配器，patch 按 id 覆写其 `maxTokens`、`defaultContextWindow`、`thinking`、`reasoningEffort`、`baseURL` 与 `retryPolicy`。
- `openai-compatible`：项目自有适配器是新增文件，因此写入 `insert:`；同时显式 `disabled: true` 关闭原生 Messages 适配器，避免留下第二条未配置的 provider 路由。

这一点不能只靠断言生成文本来验证：写在顶层的自建适配器会得到 `patch: entry "... " not found`，loader 随后静默丢弃该条目，请求最终落到从未注册的 provider 上。`tests/harness-patch.test.ts` 因此通过真实 `dsh --profile sdk --patch <file> --dump-config` 装载 profile 来断言：自建适配器出现在合成配置中、原生适配器被禁用、且 stderr 没有 `not found`。该断言在错误写法下会失败，已确认具备回归能力。

## 验证范围和限制

本实现已用本地 fake HTTP/SSE 服务验证 keyless 请求、Bearer Key、任意模型 ID、Chat Completions 路径、文本/reasoning block 结束内容、工具参数分片和工具结果回传；也验证了设置保存、模型检测、Docker service 环境转发和现有专项回归。测试不访问公网。

尚未完成真实自建 Qwen、vLLM 或 Ollama 部署上的生产容量测试。真实模型的 tokenizer、思考 token 计数、KV cache、量化、GPU 显存、`max_model_len`/`num_ctx`、上游并发和 RPM/TPM 限制仍需在目标环境单独测量。
