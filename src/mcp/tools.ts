/**
 * MCP tool definitions exposed to every executor under `mcp__liebian__*`.
 * These are the capability surface from docs/ARCHITECTURE.md, expressed as
 * ordinary tool calls; the runtime still enforces identity and state rules.
 */

export interface McpTool {
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
    additionalProperties: boolean
  }
  /** Runtime RPC operation invoked by `/rpc`. */
  op: string
}

const text = (description: string) => ({ type: 'string', description })
const textArray = (description: string) => ({ type: 'array', items: { type: 'string' }, description })
const id = (description: string) => ({ type: 'string', description })

export const MCP_TOOLS: McpTool[] = [
  {
    name: 'shared_read',
    op: 'shared.read',
    description:
      '读取共享状态：任务定义、当前有效发现、当前报告、活跃 work 表。启动时先调用它建立全局认识；findings.md 是完整追加日志，这里默认不返回已被替代的旧结论。输出过长时会截断并提示改用 shared_query。',
    inputSchema: {
      type: 'object',
      properties: {
        section: {
          type: 'string',
          enum: ['all', 'task', 'findings', 'works', 'reports'],
          description: '读取范围，默认 all。',
        },
        max_chars: { type: 'integer', minimum: 1000, description: '输出字符上限，默认 120000。' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'shared_query',
    op: 'shared.query',
    description:
      '查询发现或活跃 work：按关键词、作者、类型过滤。默认只返回当前有效发现；view=history 才包含已被替代的历史记录。since 用作增量游标，结果返回 cursor、hasMore 和增量失效通知。',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['findings', 'works'], description: '查询范围，默认 findings。' },
        view: {
          type: 'string',
          enum: ['current', 'history'],
          description: '发现视图：current（默认，只含未被替代的当前结论）或 history（完整追加记录）。',
        },
        text: text('关键词（不区分大小写），可选。'),
        author: text('按作者 work ID 过滤（scope=findings）或按 work ID 过滤（scope=works）。'),
        type: text('按发现类型过滤，例如 待验证假设、失败尝试、未承接方向。'),
        refs: id('按关联的发现 ID 过滤。'),
        since: id('增量游标：上次结果返回的 cursor，例如 F-0012；只扫描其后的记录。'),
        limit: { type: 'integer', minimum: 1, maximum: 200, description: '返回条数上限，默认 50。' },
        offset: { type: 'integer', minimum: 0, description: '跳过条数，默认 0。' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'findings_get',
    op: 'findings.get',
    description:
      '按 ID 读取发现。当前记录返回正文与关系；旧 ID 默认只返回“已被替代”提示和当前替代项，不展开旧正文。history=true 时返回原记录、完整替代链和当前叶子。',
    inputSchema: {
      type: 'object',
      properties: {
        id: id('发现 ID，例如 F-0018。'),
        history: { type: 'boolean', description: '是否返回旧正文和完整替代链，默认 false。' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'findings_append',
    op: 'findings.append',
    description:
      '原子追加一条共享发现，返回运行时分配的 ID。用于事实、假设、失败尝试、未承接方向、证据和更正。追加不覆盖历史；更正旧结论时用 supersedes 引用原 ID。',
    inputSchema: {
      type: 'object',
      properties: {
        text: text('正文，自然语言。'),
        type: text('可选类型标签，例如 待验证假设 / 已验证事实 / 失败尝试 / 未承接方向 / 更正。'),
        refs: textArray('关联的发现 ID 列表，可选。'),
        evidence: textArray('证据文件路径列表（相对任务目录），例如 evidence/scan.txt。'),
        supersedes: textArray('被本条更正或替代的发现 ID 列表，可选。'),
        related_work: textArray('关联的 work ID 列表，可选。'),
        request_id: text('本次追加的稳定请求 ID。重试复用原 ID 和参数；同 ID 不同内容会冲突。'),
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'report_read',
    op: 'report.read',
    description:
      '读取当前报告的内容、revision、固定入口和内容哈希。报告键默认 report；发布新版本前先用它取得 revision。旧版本内容不会堆叠在这里。',
    inputSchema: {
      type: 'object',
      properties: {
        key: text('报告键，默认 report；例如 report 或 pentest。'),
      },
      additionalProperties: false,
    },
  },
  {
    name: 'report_publish',
    op: 'report.publish',
    description:
      '把普通文件工具写好的草稿发布到报告的固定入口。首次发布提供 path 且 base_revision=0；之后用 report_read 得到的 revision。固定入口被直接修改时，可用 draft_path 指向入口确认发布，或用 restore=true 恢复已登记版本。request_id 用于幂等重试。',
    inputSchema: {
      type: 'object',
      properties: {
        key: text('报告键，默认 report。'),
        path: text('首次发布时的固定入口（任务相对路径，例如 report.md）；已有报告时沿用原入口。'),
        draft_path: text('草稿的任务相对路径，例如 drafts/report-v2.md；restore=true 时可省略。'),
        base_revision: {
          type: 'integer',
          minimum: 0,
          description: '发布所基于的版本；首次发布为 0，之后为 report_read 返回的 revision。',
        },
        restore: { type: 'boolean', description: '用已提交内容恢复固定入口，不创建新版本。' },
        request_id: text('稳定的请求 ID，用于幂等重试。'),
      },
      required: ['request_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'work_update',
    op: 'work.update',
    description:
      '更新你自己在活跃 work 表中的“当前工作”和“自述状态”。方向变化时使用；方向变化会使旧共识轮次失效。',
    inputSchema: {
      type: 'object',
      properties: {
        direction: text('当前正在探索的方向（自然语言）。'),
        self_status: text('自述状态，例如 working / waiting / handing-off。'),
      },
      additionalProperties: false,
    },
  },
  {
    name: 'self_inspect',
    op: 'self.inspect',
    description:
      '查看自己的 work、会话、任务状态、当前共识轮次、未接收消息数，以及实际活动：未结算工具、后台任务、待接收结果和待核对动作。harness 不提供的上下文用量返回未知。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'peer_send',
    op: 'peer.send',
    description:
      '向一个或多个 work 定向发送持久化异步消息。kind 表达意图但不构成固定流程；接收方退出时返回明确状态，不会静默丢弃。',
    inputSchema: {
      type: 'object',
      properties: {
        to: {
          oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
          description: '收件 work ID，可以是一个字符串或字符串数组。',
        },
        kind: { type: 'string', enum: ['hint', 'request', 'reply', 'handoff', 'notice'], description: '消息类型，默认 hint。' },
        body: text('消息正文，自然语言。'),
        refs: textArray('关联的发现 ID 列表，可选。'),
        request_id: text('本次发送的稳定请求 ID。重试复用原 ID 和参数，不重复发送；同 ID 不同内容会冲突。'),
      },
      required: ['to', 'body'],
      additionalProperties: false,
    },
  },
  {
    name: 'peer_inbox',
    op: 'peer.inbox',
    description: '读取发给你的消息（含运行时通知）。读取后标记为已接收。',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 100, description: '最多返回条数，默认 20。' },
        include_delivered: { type: 'boolean', description: '是否包含已投递但未读取的消息，默认 false。' },
        include_system: { type: 'boolean', description: '是否包含运行时通知，默认 true。' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'executor_spawn',
    op: 'executor.spawn',
    description:
      '创建一个全新的执行者：独立 harness 会话、相同接口、同等地位。必须写明理由和起始提示。新 work 会出现在活跃表并参与共识；来源关系不产生指挥权。若调用结果可能丢失、需要安全重试，传入稳定的 request_id；同 ID 重试返回原 work，不重复创建。',
    inputSchema: {
      type: 'object',
      properties: {
        reason: text('为什么需要一个新的执行者。'),
        start_prompt: text('新执行者可以据此开始工作的提示；可包含已有尝试、协作对象和下一步建议。'),
        refs: textArray('相关发现 ID 列表，可选。'),
        request_id: text('可选：本次裂变的稳定请求 ID，用于响应丢失后的幂等重试。'),
      },
      required: ['reason', 'start_prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'executor_wait',
    op: 'executor.wait',
    description:
      '等待与你有关的事件（新消息、共识轮次、其他 work 变化）或超时，避免反复轮询。返回事件列表和游标；下次可把游标作为 after_event_id。',
    inputSchema: {
      type: 'object',
      properties: {
        timeout_seconds: { type: 'integer', minimum: 1, maximum: 240, description: '最长等待秒数，默认 120。' },
        after_event_id: { type: 'integer', minimum: 0, description: '上次返回的游标；省略表示只等待未来的事件。' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'executor_retire',
    op: 'executor.retire',
    description:
      '明确退出。退出前请把仍有价值的内容写入发现文档或直接交接给承接方。退出后你的行从活跃表移除且不再参与共识；退出不代表任务完成。',
    inputSchema: {
      type: 'object',
      properties: { reason: text('退出原因。') },
      required: ['reason'],
      additionalProperties: false,
    },
  },
  {
    name: 'completion_propose',
    op: 'completion.propose',
    description:
      '认为终点目标已经达成时发起完成共识轮次。运行时通知全体参与 work；发起者没有特殊权限，也必须自己表态。理由可选，不影响完成。',
    inputSchema: {
      type: 'object',
      properties: {
        reason: text('为什么认为终点已达成，可选。'),
        refs: textArray('支持判断的发现 ID 列表，可选。'),
      },
      additionalProperties: false,
    },
  },
  {
    name: 'completion_respond',
    op: 'completion.respond',
    description:
      '对当前完成共识轮次独立表态。agree 表示明确认同终点达成；disagree 和 unsure 都不满足完成条件；未回复不等于同意。理由可选，不影响完成。',
    inputSchema: {
      type: 'object',
      properties: {
        round_id: id('轮次 ID，例如 C-0003。'),
        opinion: { type: 'string', enum: ['agree', 'disagree', 'unsure'], description: '你的意见。' },
        reason: text('判断依据，可选。'),
        refs: textArray('引用证据的发现 ID 列表，可选。'),
      },
      required: ['round_id', 'opinion'],
      additionalProperties: false,
    },
  },
  {
    name: 'activity_reconcile',
    op: 'activity.reconcile',
    description:
      '进程恢复后，登记你已经检查过的未知工具调用或后台任务结果。只对结果未知的动作或待接收的后台任务通知有效；仍在运行的动作不能被核对为结束。核对不代表终点达成。',
    inputSchema: {
      type: 'object',
      properties: {
        action_ids: textArray('工具调用 ID 或后台任务 ID 列表。可从 self_inspect / completion_status 的活动中看到。'),
        note: text('核对说明，可选：你检查了什么、看到了什么。'),
      },
      required: ['action_ids'],
      additionalProperties: false,
    },
  },
  {
    name: 'completion_withdraw',
    op: 'completion.withdraw',
    description: '撤回你在某个共识轮次中的表态。撤回会使该轮失效，并重新征询全体。',
    inputSchema: {
      type: 'object',
      properties: {
        round_id: id('轮次 ID。'),
        reason: text('撤回原因，可选。'),
      },
      required: ['round_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'completion_status',
    op: 'completion.status',
    description:
      '查看当前共识轮次、各 work 表态、未表态者、自己的实际活动，以及阻止任务完成的具体原因（包括运行中工具/后台任务和结果未知动作）。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
]

export const MCP_TOOL_BY_NAME = new Map(MCP_TOOLS.map((tool) => [tool.name, tool]))
