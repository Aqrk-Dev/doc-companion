#!/usr/bin/env node
/**
 * 事中·提醒档（PostToolUse, matcher: Write|Edit|MultiEdit|NotebookEdit）。
 * 命中 DOC-MAP 的文件被修改时注入一次性提醒（每文件每会话一次），不阻塞。
 */
import path from "node:path";
import {
  loadDocMap,
  matchEntries,
  repoRelative,
  loadState,
  saveState,
  readStdinJson,
  warn,
  findDoccRoot,
  formatDocRef,
} from "./_shared.mjs";

try {
  const payload = readStdinJson();
  const sessionCwd = payload?.cwd || process.cwd();
  const cwd = findDoccRoot(sessionCwd);
  const filePath = payload?.tool_input?.file_path ?? payload?.tool_input?.notebook_path;
  if (!filePath) process.exit(0);

  const docMap = loadDocMap(cwd);
  if (!docMap) process.exit(0); // 未接入项目：零打扰

  // 相对路径先按会话 cwd(而非发现根)解析为绝对路径,再对发现根做越界判定
  const rel = repoRelative(path.resolve(sessionCwd, filePath), cwd);
  if (!rel) process.exit(0);

  const entries = matchEntries(docMap, rel);
  if (!entries.length) process.exit(0);

  const state = loadState(cwd, payload?.session_id);
  if (state.reminded.includes(rel)) process.exit(0);
  state.reminded.push(rel);
  saveState(cwd, payload?.session_id, state);

  const anchors = entries.flatMap((e) => e.docs.map((d) => formatDocRef(d)));
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext:
          `[doc-companion] ${rel} was modified, linked doc anchor(s):\n- ${anchors.join("\n- ")}\n` +
          "If the recorded behavior is affected, sync the change within this task, or note it in a ledger draft first; run /docc:postflight at phase wrap-up.",
      },
    }),
  );
  process.exit(0);
} catch (e) {
  warn(`remind fail-open: ${e?.message}`);
  process.exit(0);
}
