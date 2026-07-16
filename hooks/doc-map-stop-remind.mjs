#!/usr/bin/env node
/**
 * 事中·收尾提醒（Stop，非阻塞）。
 * 本会话有新的"命中映射但可能未处置"文件时，提示运行 postflight；
 * 同一批文件只提示一次（notedCount 水位），绝不 exit 2。
 */
import { loadDocMap, loadState, saveState, readStdinJson, warn, findDoccRoot } from "./_shared.mjs";

try {
  const payload = readStdinJson();
  const cwd = findDoccRoot(payload?.cwd || process.cwd());
  if (!loadDocMap(cwd)) process.exit(0);

  const state = loadState(cwd, payload?.session_id);
  if (state.reminded.length <= state.notedCount) process.exit(0);
  state.notedCount = state.reminded.length;
  saveState(cwd, payload?.session_id, state);

  const head = state.reminded.slice(0, 5).join(", ");
  const more = state.reminded.length > 5 ? ` and ${state.reminded.length} files total` : "";
  process.stdout.write(
    JSON.stringify({
      systemMessage:
        `[doc-companion] This session has modified file(s) that hit doc anchors: ${head}${more}. ` +
        "Run /docc:postflight at phase wrap-up to complete doc reconciliation, the ledger, and stamping.",
    }),
  );
  process.exit(0);
} catch (e) {
  warn(`stop-remind fail-open: ${e?.message}`);
  process.exit(0);
}
