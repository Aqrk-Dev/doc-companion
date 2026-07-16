#!/usr/bin/env node
/**
 * 事中·契约门(PreToolUse, matcher: Write|Edit|MultiEdit|NotebookEdit)。
 * 仅拦 critical 锚点关联文件的首次编辑:deny 一次、机写声明 stub 草稿,
 * 要求在消息中声明文档影响并把草稿中 pending 占位替换为同一声明,
 * 原样重试即放行;同会话同文件不再拦。
 * 去重键跨会话共享(文件@基线哈希):其他会话已陈述过同一基线下的同一文件,
 * 本会话直接放行且不重复写 stub;盖章重写基线后旧键自然失效,重新设防。
 * 状态写入失败必须降级放行——宁可少拦一次,绝不造成重试死锁。
 * .docc 三个内置数据文件恒受门禁(无需登记)。
 */
import path from "node:path";
import {
  DOC_MAP_FILE,
  HASHES_FILE,
  HISTORY_FILE,
  loadDocMap,
  matchEntries,
  repoRelative,
  loadState,
  saveState,
  declarationsPath,
  appendDeclarationStub,
  readStdinJson,
  toPosix,
  warn,
  findDoccRoot,
  formatDocRef,
  readJsonSafe,
  atomicWrite,
  sharedGatedPath,
  loadSharedGated,
  gatedKey,
} from "./_shared.mjs";

try {
  const payload = readStdinJson();
  const sessionCwd = payload?.cwd || process.cwd();
  const cwd = findDoccRoot(sessionCwd);
  const filePath = payload?.tool_input?.file_path ?? payload?.tool_input?.notebook_path;
  if (!filePath) process.exit(0);

  const docMap = loadDocMap(cwd);
  if (!docMap) process.exit(0);

  // 相对路径先按会话 cwd(而非发现根)解析为绝对路径,再对发现根做越界判定——
  // 否则 Claude 传入的相对 file_path 会被发现根错误解释,判错真实编辑目标。
  const rel = repoRelative(path.resolve(sessionCwd, filePath), cwd);
  if (!rel) process.exit(0);

  // 内置自守护:.docc 三个数据文件恒为契约级,无需登记(必须先于 matchEntries——.docc/ 目录排除会返回空匹配)
  const isDoccSelfGuard = [DOC_MAP_FILE, HASHES_FILE, HISTORY_FILE].includes(rel);
  const criticalAnchors = isDoccSelfGuard
    ? [`${rel} (.docc data file)`]
    : matchEntries(docMap, rel).flatMap((e) =>
        e.docs.filter((d) => d.critical).map((d) => formatDocRef(d)),
      );
  if (!criticalAnchors.length) process.exit(0);

  const state = loadState(cwd, payload?.session_id);
  if (state.gated.includes(rel)) process.exit(0); // 会话内快路径:已陈述过,不读盘

  // .docc 三个内置数据文件恒排除于基线追踪之外(DEFAULT_EXCLUDES 含 .docc/),
  // 于是 recSources[rel] 永远取不到值、去重键永远落 @unbaselined——
  // 若让它们也走跨会话共享去重,第一次拦截后 shared[key]=true 就此永久生效,
  // 后续所有会话都会跳过这三个自守护文件的拦截(自守护被跨会话去重永久解除)。
  // 三个内置文件必须只走会话内去重(=v0.4.1 行为):不查、也不写共享去重文件。
  let key = null;
  let shared = null;
  if (!isDoccSelfGuard) {
    const recSources = readJsonSafe(path.join(cwd, HASHES_FILE))?.sources;
    key = gatedKey(rel, recSources);
    shared = loadSharedGated(cwd);
    if (shared[key]) {
      // 跨会话已在其他会话陈述过同一基线下的同一文件:放行,不重复写 stub;
      // 补进本会话状态使后续同文件编辑走会话内快路径(best-effort,失败不影响放行)
      state.gated.push(rel);
      saveState(cwd, payload?.session_id, state);
      process.exit(0);
    }
  }

  state.gated.push(rel);
  if (!saveState(cwd, payload?.session_id, state)) {
    warn("Contract gate state is not writable, degrading to allow this time");
    process.exit(0);
  }

  if (!isDoccSelfGuard) {
    // 换键清旧:一文件恒一键——同一 rel 的旧基线哈希键(盖章前的陈旧记录)先清除,
    // 防止同一文件在共享文件里累积多把从未失效的旧钥匙(无界增长的一环)。
    // 与盖章 GC(doc-preflight.mjs)对称:键=`${rel}@${hash}`,rel 本身可能含 "@",
    // 故从最后一个 "@" 切分取 rel 部分,精确等值才删——startsWith 前缀匹配会误删
    // 文件名形如 "src/a.ts@special" 的他文件键(其键 "src/a.ts@special@<hash>" 恰以
    // "src/a.ts@" 开头,但真实 rel 并非 "src/a.ts")。
    for (const k of Object.keys(shared)) {
      if (k === key) continue;
      const at = k.lastIndexOf("@");
      const kRel = at >= 0 ? k.slice(0, at) : k;
      if (kRel === rel) delete shared[k];
    }
    shared[key] = true;
    try {
      atomicWrite(sharedGatedPath(cwd), JSON.stringify(shared));
    } catch (e) {
      warn(`Cross-session dedup file failed to write (falling back to session-only dedup, this interception is unaffected): ${e?.message}`);
    }
  }

  const stubWritten = appendDeclarationStub(cwd, payload?.session_id, rel, criticalAnchors, state.gated.length);
  const draftRel = toPosix(path.relative(cwd, declarationsPath(cwd, payload?.session_id)));
  const draftStep = stubWritten
    ? `and replace the <!-- pending --> placeholder for this file's entry in the declaration draft ${draftRel} with that same declaration (postflight will reconcile it into the ledger), `
    : "";
  process.stderr.write(
    `[doc-companion contract gate] ${rel} is linked to contract-level doc anchor(s): ${criticalAnchors.join(", ")}.\n` +
      "Declare in your message text the impact of this change on the anchor(s) above (if any → which section you will sync; if none → why), " +
      draftStep +
      "then retry this exact edit to proceed; this file will not be gated again this session.",
  );
  process.exit(2);
} catch (e) {
  warn(`gate fail-open: ${e?.message}`);
  process.exit(0);
}
