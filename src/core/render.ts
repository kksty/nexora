/**
 * Rendering of the shared Markdown documents.
 *
 * `task.md`, `findings.md` and `works.md` are the agents' primary reading
 * surface. They are derived from the runtime state; only `findings.md` is
 * append-only (the runtime appends missing blocks during recovery instead of
 * rewriting history).
 */

import type {
  FindingRecord,
  MessageRecord,
  ReportRecord,
  RoundRecord,
  RuntimeState,
  WorkRecord,
  VersionRecord,
} from '../types.ts'
import { nowIso } from '../util/time.ts'

const TASK_STATUS_TEXT: Record<RuntimeState['status'], string> = {
  active: 'active（进行中）',
  completed: 'completed（已完成）',
  stopped: 'stopped（已停止）',
}

/** Collapse a value into one table cell without breaking Markdown syntax. */
export function tableCell(value: string, limit = 200): string {
  const flattened = value.replace(/\r?\n/g, ' / ').replace(/\|/g, '\\|').trim()
  if (flattened.length <= limit) return flattened.length === 0 ? '—' : flattened
  return `${flattened.slice(0, limit - 1)}…`
}

function versionSection(version: VersionRecord, currentVersion: number): string {
  const marker = version.version === currentVersion ? '（当前）' : ''
  return `### v${version.version} · ${version.at}${marker}\n\n${version.text.trim()}\n`
}

function historyState(state: RuntimeState, current: number, history: VersionRecord[]): string {
  const ordered = [...history].sort((a, b) => b.version - a.version)
  if (ordered.length === 0) return `### v${current} · ${state.createdAt}（当前）\n`
  return ordered.map((record) => versionSection(record, current)).join('\n')
}

/** Render the task-level human commands for `task.md` and shared reading. */
function commandsSection(state: RuntimeState): string {
  const commands = state.commands ?? []
  if (commands.length === 0) return '## 用户命令\n\n当前没有用户命令。\n'
  const blocks = commands.map((command) => {
    const source = command.source === 'web' ? 'Web UI' : command.source === 'cli' ? 'CLI' : 'API'
    return `### ${command.id} · ${command.createdAt} · ${source}\n\n${command.text.trim()}\n`
  })
  return (
    `## 用户命令\n\n` +
    `以下是用户通过管理入口发来的任务级要求，按时间顺序排列。它们不是其他 work 的消息，也不替代终点信息；` +
    `执行者自行理解并协调。收到新命令会使旧完成意见失效。\n\n` +
    `${blocks.join('\n')}`
  )
}

/** Render the run history (current first) for `task.md`. */
function runsSection(state: RuntimeState): string {
  const current = state.runs.find((run) => run.id === state.currentRunId)
  const lines = [
    '## 运行轮次',
    '',
    `- 当前轮次：${state.currentRunId}${current === undefined ? '' : `（第 ${current.sequence} 轮，${current.status}）`}`,
    `- 累计轮次：${state.runs.length}`,
    '',
  ]
  if (state.runs.length > 1) {
    lines.push('### 历史轮次', '')
    for (const run of state.runs) {
      if (run.id === state.currentRunId) continue
      const ending =
        run.status === 'completed'
          ? `completed${run.completion === null ? '' : `（${run.completion.roundId}，${run.completion.completedAt}）`}`
          : run.status === 'stopped'
            ? `stopped${run.stopReason === undefined ? '' : `（${run.stopReason}）`}`
            : 'active'
      lines.push(`- ${run.id}：${ending}；work：${run.workIds.join(', ') || '（无）'}；目标版本 v${run.targetVersion}`)
    }
    lines.push('')
  }
  lines.push(
    '新一轮不会复用旧轮次的参与集合或表态；发现、证据、当前报告和仍有效的用户命令跨轮次保留。',
    '',
  )
  return lines.join('\n')
}

/** Render the complete `task.md` document. */
export function renderTaskMarkdown(state: RuntimeState): string {
  return (
    `# 任务 ${state.taskId}\n\n` +
    `- 状态：${TASK_STATUS_TEXT[state.status]}\n` +
    `- 目标版本：v${state.targetVersion}\n` +
    `- 共享状态版本：${state.sharedStateVersion}\n` +
    `- 创建时间：${state.createdAt}\n` +
    `- 更新时间：${state.updatedAt}\n` +
    (state.statusReason === undefined ? '' : `- 状态说明：${state.statusReason}\n`) +
    `\n${runsSection(state)}\n` +
    `## 起始信息\n\n${historyState(state, state.startHistory.at(-1)?.version ?? 1, state.startHistory)}\n` +
    `## 终点信息\n\n${historyState(state, state.targetVersion, state.endHistory)}\n` +
    `${commandsSection(state)}`
  )
}

/** Render one finding as an append-only Markdown block. */
export function renderFindingBlock(finding: FindingRecord): string {
  const lines: string[] = [`## ${finding.id} · ${finding.authorWorkId} · ${finding.createdAt}`, '']
  if (finding.type !== undefined && finding.type.trim().length > 0) lines.push(`类型：${finding.type.trim()}`)
  if (finding.relatedWork.length > 0) lines.push(`关联 work：${finding.relatedWork.join(', ')}`)
  if (finding.refs.length > 0) lines.push(`关联：${finding.refs.join(', ')}`)
  if (finding.supersedes.length > 0) lines.push(`替代/更正：${finding.supersedes.join(', ')}`)
  lines.push('', finding.text.trim(), '')
  if (finding.evidence.length > 0) lines.push(`证据：${finding.evidence.join(', ')}`, '')
  return lines.join('\n') + '\n'
}

/** Header used when `findings.md` is first materialized. */
export function renderFindingsHeader(state: RuntimeState): string {
  return (
    `# 共享发现\n\n` +
    `任务 ${state.taskId} 的追加式发现文档。每条记录由运行时分配 ID、作者和时间；` +
    `追加不覆盖历史，更正请引用原 ID。本文件是完整追加日志，包含已被替代的历史结论；` +
    `默认的 shared_read / shared_query 只返回当前有效记录。\n`
  )
}

/** Header for the default current-findings view used by agent queries. */
export function renderCurrentFindingsHeader(state: RuntimeState, current: number, total: number): string {
  return (
    `# 当前有效发现\n\n` +
    `任务 ${state.taskId}：当前有效 ${current} 条，历史共 ${total} 条。\n\n` +
    `这里只列出未被替代的当前结论。完整的追加日志（含已被替代的旧结论）在 findings.md；` +
    `需要追溯旧记录时用 findings_get（history=true）或 shared_query（view=history）。\n`
  )
}

/** Render the current report entries plus their published content. */
export function renderReportsSection(
  reports: readonly { report: ReportRecord; content: string | null }[],
): string {
  if (reports.length === 0) {
    return (
      `# 当前报告\n\n` +
      `本任务还没有发布报告。需要报告时，执行者用普通文件工具写草稿，再调用 report_publish 发布到固定入口；` +
      `没有报告要求的任务不因缺少报告被阻塞。\n`
    )
  }
  const blocks = reports.map(({ report, content }) => {
    const body =
      content === null
        ? '（内容文件缺失：固定入口与已登记版本不一致，完成会被阻塞，请用 report_read / report_publish 核对。）'
        : content
    return (
      `## ${report.key} · ${report.path} · r${report.revision}\n\n` +
      `- 状态：${report.entryState}\n` +
      `- 哈希：${report.contentHash}\n` +
      `- 发布者：${report.publishedByWorkId} · ${report.publishedAt}\n` +
      `- 内容文件：${report.contentFile}\n\n` +
      `${body.trim()}\n`
    )
  })
  return (
    `# 当前报告\n\n` +
    `每份报告只有一个固定入口，当前内容如下。发布新版本请先 report_read 取得 revision，再 report_publish。\n\n` +
    `${blocks.join('\n')}`
  )
}

/** Identifier list already present in an existing `findings.md`. */
export function parseFindingIds(markdown: string): string[] {
  const found: string[] = []
  const pattern = /^## (F-\d+) · /gm
  let match: RegExpExecArray | null
  while ((match = pattern.exec(markdown)) !== null) {
    if (match[1] !== undefined) found.push(match[1])
  }
  return found
}

/** Render the active work table. Exited works never appear. */
export function renderWorksMarkdown(state: RuntimeState): string {
  const active = Object.values(state.works)
    .filter(
      (work) =>
        work.runId === state.currentRunId &&
        work.runtimeStatus !== 'exited' &&
        work.runtimeStatus !== 'finished',
    )
    .sort((a, b) => a.id.localeCompare(b.id))

  const rows = active.map(
    (work) =>
      `| ${work.id} | ${tableCell(work.direction)} | ${tableCell(work.selfStatus, 60)} | ` +
      `${work.runtimeStatus} | ${work.updatedAt} |`,
  )

  const emptyNote =
    active.length === 0
      ? state.status === 'completed'
        ? '\n任务已完成，所有执行者已停止。\n'
        : state.status === 'stopped'
          ? '\n任务已被停止。\n'
          : '\n当前没有参与任务的 work。空集合不会被判定为全体同意，任务保持未完成。\n'
      : ''

  return (
    `# 活跃 work\n\n` +
    `- 运行轮次：${state.currentRunId}（第 ${state.runs.find((run) => run.id === state.currentRunId)?.sequence ?? '?'} 轮）\n` +
    `- 更新时间：${nowIso()}\n\n` +
    `当前参与 work：${active.length}\n${emptyNote}\n` +
    `| work_id | 当前工作 | 自述状态 | 运行状态 | 最近更新 |\n` +
    `| --- | --- | --- | --- | --- |\n` +
    `${rows.join('\n')}${rows.length > 0 ? '\n' : ''}\n` +
    `说明：表格中的“当前工作”为摘要；完整文本可用 shared_query（scope=works）查询。` +
    `运行状态由运行时维护，其余两列由执行者维护。\n`
  )
}

/** Render one message for agent context / inbox output. */
export function renderMessage(message: MessageRecord): string {
  const from = message.system ? `运行时` : message.fromWorkId
  const header = `### ${message.id} · ${from} → ${message.toWorkId} · ${message.kind} · ${message.createdAt}`
  const refs = message.refs.length > 0 ? `\n引用：${message.refs.join(', ')}` : ''
  return `${header}\n${message.body.trim()}${refs}\n`
}

/** Render the human-readable consensus record appended on completion. */
export function renderConsensusMarkdown(input: {
  state: RuntimeState
  round: RoundRecord
  completedAt: string
}): string {
  const { state, round, completedAt } = input
  const lines = [
    `# 完成共识 ${round.id}`,
    '',
    `- 任务：${state.taskId}`,
    `- 运行轮次：${round.runId}`,
    `- 完成时间：${completedAt}`,
    `- 目标版本：v${round.targetVersion}`,
    `- 共享状态版本：${round.sharedStateVersion}`,
    `- 发起 work：${round.createdByWorkId}`,
    `- 发起时间：${round.createdAt}`,
    `- 发起理由：${round.reason ?? '（未填写）'}`,
    `- 参与 work：${round.participants.join(', ')}`,
    '',
    '## 终点信息（本次共识所针对的版本）',
    '',
    state.endInformation.trim(),
    '',
    '## 各 work 的表态',
    '',
    '| work_id | 意见 | 判断依据 | 引用 | 时间 |',
    '| --- | --- | --- | --- | --- |',
  ]
  for (const workId of round.participants) {
    const opinion = round.opinions[workId]
    lines.push(
      `| ${workId} | ${opinion?.opinion ?? '未表态'} | ${tableCell(opinion?.reason ?? '—', 80)} | ` +
        `${opinion === undefined || opinion.refs.length === 0 ? '—' : opinion.refs.join(', ')} | ${opinion?.at ?? '—'} |`,
    )
  }
  lines.push('', '### 完整判断依据', '')
  for (const workId of round.participants) {
    const opinion = round.opinions[workId]
    if (opinion === undefined) {
      lines.push(`- ${workId}：未表态`)
      continue
    }
    lines.push(
      `- ${workId}（${opinion.opinion}，${opinion.at}）`,
      '',
      `  ${(opinion.reason ?? '（未填写理由）').replace(/\r?\n/g, '\n  ')}`,
      '',
      opinion.refs.length === 0 ? '' : `  引用：${opinion.refs.join(', ')}`,
      '',
    )
  }
  lines.push(
    `本记录表示上述执行者一致认为终点目标已达成；它是对当前共享状态的共同判断，不是额外的客观正确性证明。`,
    '',
  )
  return lines.join('\n') + '\n'
}

/** Render the current opinion table for a round. */
export function renderRound(round: RoundRecord, works: Record<string, WorkRecord>): string {
  const lines = [
    `## 共识轮次 ${round.id}`,
    '',
    `- 状态：${round.status}`,
    `- 运行轮次：${round.runId}`,
    `- 发起 work：${round.createdByWorkId}`,
    `- 发起时间：${round.createdAt}`,
    `- 目标版本：v${round.targetVersion}`,
    `- 共享状态版本：${round.sharedStateVersion}`,
    `- 参与 work：${round.participants.length === 0 ? '（无）' : round.participants.join(', ')}`,
    `- 发起理由：${round.reason ?? '（未填写）'}`,
    '',
    '| work_id | 运行状态 | 意见 | 理由 | 时间 |',
    '| --- | --- | --- | --- | --- |',
  ]
  for (const workId of round.participants) {
    const opinion = round.opinions[workId]
    const runtimeStatus = works[workId]?.runtimeStatus ?? 'exited'
    lines.push(
      `| ${workId} | ${runtimeStatus} | ${opinion?.opinion ?? '未表态'} | ` +
        `${opinion === undefined ? '—' : tableCell(opinion.reason ?? '（未填写）', 100)} | ${opinion?.at ?? '—'} |`,
    )
  }
  const detailed = round.participants
    .map((workId) => {
      const opinion = round.opinions[workId]
      if (opinion === undefined) return ''
      const refs = opinion.refs.length === 0 ? '' : `\n  引用：${opinion.refs.join(', ')}`
      return `- ${workId}（${opinion.opinion}，${opinion.at}）：${(opinion.reason ?? '（未填写理由）').replace(/\r?\n/g, ' ')}${refs}`
    })
    .filter((line) => line.length > 0)
  if (detailed.length > 0) lines.push('', '### 完整表态', '', ...detailed)
  return lines.join('\n') + '\n'
}
