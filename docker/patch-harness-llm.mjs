/**
 * Build-time repair for the harness Messages client.
 *
 * Some OpenAI-compatible gateways that emulate the Anthropic Messages API emit
 * a tool call's argument deltas *after* they already sent `content_block_stop`
 * for that block, and with fragments that cannot be reassembled (no outer
 * braces, sometimes duplicated):
 *
 *   content_block_start index=1 tool_use input={}
 *   content_block_delta index=1 partial_json="{}"
 *   content_block_stop  index=1
 *   content_block_start index=2 text
 *   content_block_delta index=1 partial_json="\"section\": \"all\""   <-- late
 *
 * The upstream client treats a delta for a closed block as a fatal
 * `MALFORMED_RESPONSE`, so the executor burns every retry and the turn dies
 * having done nothing. The first tool call in such a stream is already
 * complete and valid, so the repair keeps it and drops the late fragments:
 * the tool runs with the arguments it was given (an empty object means "no
 * arguments", which the tool either accepts or rejects with a normal error the
 * model can react to). Losing the turn entirely is strictly worse.
 *
 * The patch is anchored on exact upstream source text and fails the build when
 * the anchors move, so an SDK upgrade surfaces immediately instead of silently
 * losing the repair.
 */
import { readFileSync, writeFileSync } from 'node:fs'

const TARGET = '/app/node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js'
const MARKER = 'liebian: tolerate late block deltas'

const ANCHOR =
  'if (block === void 0 || block.closed) return malformed("delta/stop without an open block");'
const REPLACEMENT = `if (block === void 0) return malformed("delta/stop without an open block");
\t\t\tif (block.closed) {
\t\t\t\t// ${MARKER}: the gateway repeats tool arguments after closing the
\t\t\t\t// block, in fragments that are not valid JSON on their own. Keep the
\t\t\t\t// already-complete tool call instead of killing the whole turn.
\t\t\t\tcontinue;
\t\t\t}`

const count = readFileSync(TARGET, 'utf8').split(ANCHOR).length - 1
const source = readFileSync(TARGET, 'utf8')
if (source.includes(MARKER)) {
  console.log('harness LLM patch: already applied')
  process.exit(0)
}
if (count !== 1) {
  throw new Error(
    `harness LLM patch: expected exactly one occurrence of the block guard, found ${count}. ` +
      'The upstream client changed; re-check docker/patch-harness-llm.mjs.',
  )
}

let patched = source.replace(ANCHOR, REPLACEMENT)

// Reasoning that arrives inline in a text block (`<think>...</think>`) is stored
// as ordinary assistant text and then replayed on every later request: the model
// sees its own reasoning in the history and keeps imitating that shape, so the
// whole transcript degrades into reasoning dumps. A gateway content filter that
// splices a warning containing `<think>` into an answer is enough to seed it.
// Strip the tags when the block settles so the history stays a conversation.
//
// The same filter also wraps an answer in `⚠ ... lm-guard回复] ...`, sometimes
// cutting the marker mid-word. Those fragments are gateway noise, not something
// the model said, so they are removed too; whatever real text remains is kept.
const TEXT_END_ANCHOR =
  '\t\t\t\tif (block.content.type === "tool-call" && block.json.length > 0) block.content.arguments = block.json;'
const TEXT_END_REPLACEMENT = `\t\t\t\tif (block.content.type === "text") block.content.text = block.content.text.replace(/<think\\b[^>]*>[\\s\\S]*?<\\/think>/gi, "").replace(/<\\/?think\\b[^>]*>/gi, "").replace(/[\\w-]*guard回复\\][^\\n]*/gi, "").replace(/^\\s*⚠\\s*/, "").trim();
\t\t\t\tif (block.content.type === "tool-call" && block.json.length > 0) block.content.arguments = block.json;`

const textEndCount = patched.split(TEXT_END_ANCHOR).length - 1
if (textEndCount !== 1) {
  throw new Error(
    `harness LLM patch: expected exactly one occurrence of the block-end body, found ${textEndCount}. ` +
      'The upstream client changed; re-check docker/patch-harness-llm.mjs.',
  )
}
patched = patched.replace(TEXT_END_ANCHOR, TEXT_END_REPLACEMENT)

writeFileSync(TARGET, patched)
console.log('harness LLM patch: applied (late block deltas ignored, inline reasoning stripped)')
