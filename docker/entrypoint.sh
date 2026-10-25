#!/usr/bin/env bash
# One container = one Task. The thin runtime and every executor session live in
# this process tree; the task directory is the durable boundary.
set -euo pipefail

readonly LIEBIAN_BIN="/app/bin/liebian.js"
readonly DSH_BIN="/app/node_modules/@deepseek-ai/dsh/lib/bin.js"
readonly TASKS_DIR="${LIEBIAN_TASKS_DIR:-/tasks}"
readonly DSH_HOME="${DSH_HOME:-/dsh-home}"

export LIEBIAN_TASKS_DIR="$TASKS_DIR"
export DSH_HOME

log() {
  printf '[liebian] %s\n' "$*" >&2
}

die() {
  log "$*"
  exit 1
}

require_root() {
  local uid
  uid="$(id -u)"
  if [[ "$uid" != "0" ]]; then
    die "执行者需要容器内 root 权限（当前 uid=$uid）；请移除 --user 并以 root 运行容器"
  fi
}

usage() {
  cat <<'EOF'
Nexora容器入口（一个容器只运行一个任务）

用法：
  <镜像> [命令] [参数...]

命令：
  run [--task 任务ID]       启动或恢复任务（默认命令）
  new --start 文件 --end 文件
                            创建任务；相对路径相对于 /input
  status|works|findings|messages|set-end|set-start|stop
                            转发给 liebian CLI；任务参数可省略
  task list                 列出 /tasks 下的任务
  web [--port 43187]        启动 Web UI（host 网络，无需 -p）
  shell                     进入容器内的 bash
  doctor                    检查 Node、dsh profile、凭据、Docker socket 与任务目录
  help                      显示本帮助

环境变量：
  LIEBIAN_TASK_ID           默认任务 ID（也可传 --task）
  LIEBIAN_TASKS_DIR         任务根目录，默认 /tasks
  DSH_HOME                  harness home，默认 /dsh-home
  DEEPSEEK_API_KEY          模型凭据；未设置时使用 DSH_HOME 中的凭据
  LIEBIAN_PROVIDER          默认 deepseek-official
  LIEBIAN_MODEL             默认 deepseek-flash
  LIEBIAN_WEB_PORT          控制台端口，默认 43187
  LIEBIAN_WEB_HOST          控制台监听地址，默认 127.0.0.1
  LIEBIAN_API_PORT_RANGE    任务管理端口段，默认 43188-43287
  LIEBIAN_CALLBACK_HOST     可选的目标可达回连地址，监听端口由 work 自主选择
  LIEBIAN_MODEL_CONCURRENCY 模型请求合计并发上限，默认 4
  LIEBIAN_WEB_TOKEN         固定 Web UI 访问令牌；留空自动生成
  LIEBIAN_WEB_LAUNCHER      web 的任务编排方式：compose（每个任务一个 compose service）

挂载约定（宿主机数据都放在仓库内）：
  -v <仓库>/tasks/<任务ID>:/tasks/<任务ID>
  -v <仓库>/.dsh:/dsh-home
EOF
}

ensure_profile() (
  # Different Task containers share DSH_HOME. Serialize first initialization
  # before even checking cordis.yml: another writer may only have created it.
  mkdir -p "$DSH_HOME"
  exec 9>"$DSH_HOME/.profile-init.lock"
  flock -w 60 9 || die "等待 harness profile 初始化锁超时"
  if [[ -f "$DSH_HOME/profiles/sdk/cordis.yml" ]]; then
    return 0
  fi
  [[ -f "$DSH_BIN" ]] || die "找不到 dsh：$DSH_BIN"
  node "$DSH_BIN" --profile sdk --dump-config >/dev/null
  log "已初始化 dsh profile：$DSH_HOME/profiles/sdk"
)

# Print every initialized task directory under $TASKS_DIR.
find_tasks() {
  local state
  shopt -s nullglob
  for state in "$TASKS_DIR"/*/runtime/state.json; do
    printf '%s\n' "${state%/runtime/state.json}"
  done
}

# Fill TASK_ARGS for commands that accept --task. An explicit --task wins;
# otherwise use LIEBIAN_TASK_ID, and finally the only initialized task in the
# container. Other flags (--provider, --file, ...) do not count as a task.
TASK_ARGS=()
resolve_task_args() {
  TASK_ARGS=()
  local arg
  for arg in "$@"; do
    case "$arg" in
      --task|--task=*) return 0 ;;
    esac
  done
  if [[ -n "${LIEBIAN_TASK_ID:-}" ]]; then
    TASK_ARGS=(--task "$LIEBIAN_TASK_ID")
    return 0
  fi
  local -a found=()
  local task
  while IFS= read -r task; do
    found+=("$task")
  done < <(find_tasks)
  case "${#found[@]}" in
    0) die "在 $TASKS_DIR 下没有已初始化的任务；请挂载任务目录或先运行 new" ;;
    1) TASK_ARGS=(--task "${found[0]}") ;;
    *) die "在 $TASKS_DIR 下发现多个任务，请设置 LIEBIAN_TASK_ID 或传 --task" ;;
  esac
}

doctor() {
  printf 'user:        %s (uid=%s)\n' "$(id -un)" "$(id -u)"
  printf 'node:        %s\n' "$(node --version)"
  printf 'liebian:     %s\n' "$LIEBIAN_BIN"
  printf 'tasks dir:   %s\n' "$TASKS_DIR"
  printf 'dsh home:    %s\n' "$DSH_HOME"
  printf 'llm slots:   %s\n' "${LIEBIAN_MODEL_CONCURRENCY:-4}"
  [[ -f "$DSH_BIN" ]] && printf 'dsh:         %s\n' "$DSH_BIN" || printf 'dsh:         MISSING\n'
  if [[ -S /var/run/docker.sock ]]; then
    printf 'docker:      %s (socket mounted)\n' "$(docker --version 2>/dev/null || echo 'CLI MISSING')"
    printf 'compose:     %s\n' "$(docker compose version 2>/dev/null || echo 'MISSING')"
  else
    printf 'docker:      socket not mounted (compose task launch unavailable)\n'
  fi
  if [[ -n "${DEEPSEEK_API_KEY:-}" ]]; then
    printf 'credential:  DEEPSEEK_API_KEY is set\n'
  else
    printf 'credential:  DEEPSEEK_API_KEY is not set; relying on %s/.credentials.yaml\n' "$DSH_HOME"
  fi
  ensure_profile
  printf 'profile:     %s\n' "$DSH_HOME/profiles/sdk/cordis.yml"
  if [[ -d "$TASKS_DIR" ]]; then
    local count=0 task
    while IFS= read -r task; do
      printf 'task:        %s\n' "$task"
      count=$((count + 1))
    done < <(find_tasks)
    printf 'tasks:       %s initialized\n' "$count"
  else
    printf 'tasks:       %s is missing\n' "$TASKS_DIR"
  fi
  node "$LIEBIAN_BIN" --help >/dev/null
  printf 'cli:         ok\n'
}

# Default to `run`; allow flags such as `--task X` without spelling the
# command, while still accepting `run --task X` and the other subcommands.
command="${1:-run}"
if [[ $# -gt 0 ]]; then
  case "$command" in
    -h|--help) command=help ;;
    --*) command=run ;;
    *) shift ;;
  esac
fi

case "$command" in
  help|-h|--help)
    usage
    ;;
  doctor)
    doctor
    ;;
  shell|bash)
    require_root
    ensure_profile
    exec bash
    ;;
  new)
    require_root
    exec node "$LIEBIAN_BIN" task new "$@" --tasks-dir "$TASKS_DIR"
    ;;
  run)
    require_root
    ensure_profile
    resolve_task_args "$@"
    exec node "$LIEBIAN_BIN" run "$@" "${TASK_ARGS[@]}" --tasks-dir "$TASKS_DIR"
    ;;
  status|stop|set-end|set-start|works|findings|messages)
    resolve_task_args "$@"
    exec node "$LIEBIAN_BIN" "$command" "$@" "${TASK_ARGS[@]}" --tasks-dir "$TASKS_DIR"
    ;;
  task)
    exec node "$LIEBIAN_BIN" "$command" "$@" --tasks-dir "$TASKS_DIR"
    ;;
  web)
    if [[ "${LIEBIAN_WEB_LAUNCHER:-}" == "compose" || "${LIEBIAN_WEB_LAUNCHER:-}" == "docker" ]] && [[ ! -S /var/run/docker.sock ]]; then
      log "警告：LIEBIAN_WEB_LAUNCHER=compose，但没有挂载 /var/run/docker.sock；启动任务会失败"
    fi
    exec node "$LIEBIAN_BIN" web "$@" --tasks-dir "$TASKS_DIR"
    ;;
  *)
    exec node "$LIEBIAN_BIN" "$command" "$@" --tasks-dir "$TASKS_DIR"
    ;;
esac
