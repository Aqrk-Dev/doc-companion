#!/usr/bin/env node
/**
 * 事前机检 + 盖章。用法：node doc-preflight.mjs [--stamp] [--force] [--verdict '<json>'] [--cwd <dir>]
 * 输出 JSON 报告：{ ok, driftCandidates, docDrift, mapIssues, warnings, stampBlocked, stamped }
 * - driftCandidates：结构化候选 { file, kind, docs }，按 file 排序——
 *   kind："modified"(基线有记录且现算哈希失配) | "new"(基线无记录，首次纳管) | "removed"(基线有记录但本次未纳管：已删/改名/移出映射)；
 *   docs：命中该文件的所有 entry 的 docs 合并去重(键 file+anchor)，元素 { file, anchor?, critical?, note? }
 *   （anchor/note 缺省省略，critical 仅在 true 时输出；removed 的 docs 由记录路径对全部合法 pattern 重新匹配求得）
 * - docDrift：文档文件有基线记录且失配 → 文档被直接修改过
 * - mapIssues：DOC-MAP 自检问题（坏 pattern / 无匹配 / 文档缺失或越界 / 锚点悬空 / 基线损坏 / .docc 内文件被登记 / 盖章写入失败），元素为 { code, message }
 * - warnings：软告警(pattern 仅命中被排除文件/无法哈希/台账缺 verified-by 标记/缺 --verdict/历史埋点写失败),不影响 ok，元素为 { code, message }
 * --verdict 接受两种形式(自动识别):聚合 {"formatting":2,...}(键∈四类名/值为非负整数) 或
 *   per-file {"src/a.ts":"docLag",...}(值为四类名字符串之一,粒度到文件；推荐)；识别规则见下方解析段注释。
 * - stampBlocked：盖章拒绝详情 { realDriftCount, docDriftCount, mapDefects, message } | null；非 --stamp 恒为 null，拒绝会向 history 落 stamped:false、verdict:null 行,仅不计入 mapIssues
 * --stamp 把双侧现算哈希写入 HASHES_FILE（键排序）——仅在核对完成后由 skill 调用。
 * 任何环境问题（非 git 仓库等）输出 {ok:false,error} 且 exit 0（fail-open）。
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  loadDocMap,
  globToRegExp,
  hashFilesNormalized,
  GIT_MAX_BUFFER,
  countAnchorMatches,
  readJsonSafe,
  toPosix,
  repoRelative,
  getExcludes,
  isExcluded,
  DOC_MAP_FILE,
  HASHES_FILE,
  HISTORY_FILE,
  findDoccRoot,
  atomicWrite,
  sharedGatedPath,
  loadSharedGated,
} from "../hooks/_shared.mjs";

function listRepoFiles(cwd) {
  try {
    const r = spawnSync(
      "git",
      ["-c", "core.quotepath=false", "ls-files", "--cached", "--others", "--exclude-standard"],
      { cwd, encoding: "utf-8", maxBuffer: GIT_MAX_BUFFER },
    );
    if (r.status !== 0) return null;
    return r.stdout.split(/\r?\n/).filter(Boolean).map(toPosix);
  } catch {
    return null;
  }
}

/** 本轮新增/修改(未提交)的台账 .md 文件,排除 INDEX.md 与删除项;fail-open 返回 [] */
function listDirtyLedgerFiles(cwd, ledgerDir) {
  try {
    const r = spawnSync(
      "git",
      ["-c", "core.quotepath=false", "status", "--porcelain", "-uall", "--", ledgerDir],
      { cwd, encoding: "utf-8", maxBuffer: GIT_MAX_BUFFER },
    );
    if (r.status !== 0) return [];
    return r.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .filter((line) => !line.slice(0, 2).includes("D"))
      .map((line) => {
        let p = line.slice(3).trim();
        // rename/copy 行形如 "R  old -> new":校验目标是新路径
        const arrow = p.indexOf(" -> ");
        if (arrow >= 0) p = p.slice(arrow + 4);
        return toPosix(p);
      })
      .filter((f) => f.endsWith(".md") && !f.endsWith("/INDEX.md") && f !== "INDEX.md");
  } catch {
    return [];
  }
}

const args = process.argv.slice(2);
const stamp = args.includes("--stamp");
const check = args.includes("--check");
const force = args.includes("--force");
const cwdIdx = args.indexOf("--cwd");
let cwd = cwdIdx >= 0 && args[cwdIdx + 1] ? path.resolve(args[cwdIdx + 1]) : process.cwd();
cwd = findDoccRoot(cwd);

// --check 与 --stamp 互斥
if (check && stamp) {
  console.log(JSON.stringify({ ok: false, error: "--check and --stamp cannot be used together" }, null, 2));
  process.exit(2);
}

// 解析 --verdict 参数:支持两种形式,自动识别(v0.8.0)——
// 聚合形式(不变):{"formatting":2,...} 键∈四类名、值为非负整数;
// per-file 形式(新):{"src/a.ts":"docLag",...} 值为四类名字符串之一,粒度到文件,供长期统计。
// 识别规则:纯对象且存在任一值为合法四类名字符串 → per-file 形式;空对象 {} 维持聚合语义(候选 0 时天然相符)。
const verdictIdx = args.indexOf("--verdict");
let verdict = null;
let verdictFiles = null; // per-file 形式时:{file: category}(仅合法条目;聚合形式恒为 null)
let verdictParseFailed = false;
let verdictUnknownKeys = [];
let verdictInvalidValueKeys = [];
const knownVerdictKeys = ["formatting", "docLag", "codeViolation", "other"];
if (verdictIdx >= 0 && args[verdictIdx + 1]) {
  try {
    const raw = JSON.parse(args[verdictIdx + 1]);
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const rawKeys = Object.keys(raw);
      const isPerFile = rawKeys.some((k) => typeof raw[k] === "string" && knownVerdictKeys.includes(raw[k]));
      if (isPerFile) {
        // per-file 形式:键=文件路径,值须为四类名字符串之一;非法值条目丢弃(计入 verdictInvalidValueKeys)
        const collected = {};
        for (const k of rawKeys) {
          if (typeof raw[k] === "string" && knownVerdictKeys.includes(raw[k])) {
            collected[k] = raw[k];
          } else {
            verdictInvalidValueKeys.push(k);
          }
        }
        verdictFiles = collected;
        // 聚合计数由 per-file 映射派生,供 history/文案复用
        const tally = {};
        for (const category of Object.values(collected)) {
          tally[category] = (tally[category] || 0) + 1;
        }
        verdict = tally;
      } else {
        const collected = {};
        // 收集未知键
        for (const k of rawKeys) {
          if (!knownVerdictKeys.includes(k)) {
            verdictUnknownKeys.push(k);
          }
        }
        // 仅收已知键且为非负整数的;已知键存在但值非法(如 "1"/-1/1.5)单独记录以便告警,同样忽略不收
        for (const k of knownVerdictKeys) {
          if (!(k in raw)) continue;
          if (Number.isInteger(raw[k]) && raw[k] >= 0) {
            collected[k] = raw[k];
          } else {
            verdictInvalidValueKeys.push(k);
          }
        }
        // 若成功解析且至少有已知键的计数,或者原始对象为空{},则设置 verdict
        // 即:{}(init)与{有效键}都设,但{仅未知键/仅非法值键}不设(按未提供处理)
        if (Object.keys(collected).length > 0 || rawKeys.length === 0) {
          verdict = collected;
        }
      }
    } else {
      // 合法 JSON 但非纯对象(数组/数字/字符串/null)—— 同样按解析失败处理(下面统一告警)
      verdictParseFailed = true;
    }
  } catch {
    // 解析失败按未提供处理(fail-open,下面会软告警)
    verdictParseFailed = true;
  }
}

const report = { ok: false, driftCandidates: [], docDrift: [], mapIssues: [], warnings: [], stampBlocked: null, stamped: false };

const docMap = loadDocMap(cwd);
if (!docMap) {
  const raw = readJsonSafe(path.join(cwd, DOC_MAP_FILE));
  const error =
    raw && Array.isArray(raw.entries) && raw.version !== undefined && raw.version !== 1
      ? `map.json version ${JSON.stringify(raw.version)} is not supported (this engine supports 1)`
      : `Missing or unparsable ${DOC_MAP_FILE} (if not yet set up, run /docc:init first; or start the session inside a subpackage that contains .docc/)`;
  console.log(JSON.stringify({ ...report, error }, null, 2));
  process.exit(check ? 1 : 0);
}
const files = listRepoFiles(cwd);
if (!files) {
  console.log(JSON.stringify({ ...report, error: "git ls-files failed (not a git repo or git unavailable)" }, null, 2));
  process.exit(check ? 1 : 0);
}

// 排除前缀(.docc/ 数据目录随 DEFAULT_EXCLUDES 恒排除)
const excludes = getExcludes(docMap);
const trackedFiles = files.filter((f) => !isExcluded(f, excludes));

const hashesPath = path.join(cwd, HASHES_FILE);
const recordedRaw = readJsonSafe(hashesPath);
if (recordedRaw === null && fs.existsSync(hashesPath)) {
  // 损坏 ≠ 不存在:静默同化会让 docDrift 防篡改失效,必须显式暴露
  report.mapIssues.push({ code: "baseline-corrupt", message: `Hash baseline file is corrupt, drift comparison skipped (verify and re-stamp): ${HASHES_FILE}` });
}
const recorded = recordedRaw || {};
const recSources = recorded.sources && typeof recorded.sources === "object" ? recorded.sources : {};
const recDocs = recorded.docs && typeof recorded.docs === "object" ? recorded.docs : {};
const newSources = {};
const newDocs = {};
const docFiles = new Set();

// 同一 file / file+anchor 的映射问题只报一次(多条目引用同一文档时不重复)
const seenIssueKeys = new Set();
const makePushOnce = (arr) => (key, code, message) => {
  if (seenIssueKeys.has(key)) return;
  seenIssueKeys.add(key);
  arr.push({ code, message });
};
const pushIssueOnce = makePushOnce(report.mapIssues);
const pushWarningOnce = makePushOnce(report.warnings);

let realSourceDrift = 0;
const matchedSourceFiles = new Set();

// file -> Map<'docFile\u0000anchor', docObj>:命中该源文件的所有 entry 的合法 docs,合并去重
const fileDocs = new Map();
// 通过 pattern 校验的 entry(bad-entry/bad-pattern 已被跳过),供 removed 候选反向匹配复用
const validEntries = [];

function docKey(docObj) {
  return `${docObj.file}\u0000${docObj.anchor ?? ""}`;
}

/**
 * 同一 file+anchor 再次命中时的合并策略(而非整体丢弃先到者):
 * critical 取 OR(任一 entry 标了契约冻结就冻结)、note 取首个非空(先到者的 note 优先)。
 */
function mergeDocObj(existing, incoming) {
  if (!existing) return incoming;
  const merged = { ...existing };
  if (incoming.critical === true) merged.critical = true;
  if (!merged.note && incoming.note) merged.note = incoming.note;
  return merged;
}

function mergeFileDocs(f, entryDocs) {
  if (!entryDocs.length) return;
  let m = fileDocs.get(f);
  if (!m) {
    m = new Map();
    fileDocs.set(f, m);
  }
  for (const docObj of entryDocs) {
    const key = docKey(docObj);
    m.set(key, mergeDocObj(m.get(key), docObj));
  }
}

for (const entry of docMap.entries) {
  if (typeof entry?.pattern !== "string" || !Array.isArray(entry?.docs)) {
    report.mapIssues.push({ code: "bad-entry", message: `Entry missing pattern/docs: ${JSON.stringify(entry).slice(0, 80)}` });
    continue;
  }
  let rx;
  try {
    rx = globToRegExp(entry.pattern);
  } catch {
    report.mapIssues.push({ code: "bad-pattern", message: `Invalid pattern: ${entry.pattern}` });
    continue;
  }
  let matched = 0;
  const matchedFilesForEntry = [];
  for (const f of trackedFiles) {
    if (!rx.test(f)) continue;
    matched += 1;
    matchedSourceFiles.add(f);
    matchedFilesForEntry.push(f);
  }
  if (!matched) {
    if (files.some((f) => rx.test(f))) {
      report.warnings.push({ code: "pattern-only-excluded", message: `Pattern matches only excluded files (not tracked for source-side drift): ${entry.pattern}` });
    } else {
      report.mapIssues.push({ code: "pattern-no-match", message: `Pattern matched no files: ${entry.pattern}` });
    }
  }
  const entryDocs = [];
  for (const d of entry.docs) {
    if (typeof d?.file !== "string") continue;
    // docs[].file 按约定是仓库根相对路径:前导 / 视为根相对(而非文件系统绝对路径),防 0.1.x 写法误判越界
    const rawFile = d.file.startsWith("/") ? d.file.slice(1) : d.file;
    const relDoc = repoRelative(rawFile, cwd);
    if (!relDoc) {
      // hooks 侧编辑目标有 repoRelative 防越界,doc 侧同样不许读仓库外文件
      pushIssueOnce(`escape:${d.file}`, "doc-escape", `Doc path escapes the repository: ${d.file}`);
      continue;
    }
    if (relDoc.startsWith(".docc/")) {
      pushIssueOnce(`docc-dir:${relDoc}`, "docc-dir-doc", `Files inside the .docc data directory cannot be registered as doc anchors: ${relDoc}`);
      continue;
    }
    docFiles.add(relDoc);
    if (!fs.existsSync(path.join(cwd, relDoc))) {
      pushIssueOnce(`missing:${relDoc}`, "doc-missing", `Doc does not exist: ${relDoc}`);
    } else if (d.anchor) {
      const akey = `anchor:${relDoc} ${d.anchor}`;
      if (!seenIssueKeys.has(akey)) {
        seenIssueKeys.add(akey);
        const n = countAnchorMatches(cwd, relDoc, d.anchor);
        if (n === 0) report.mapIssues.push({ code: "anchor-missing", message: `Anchor not found: ${relDoc} ${d.anchor}` });
        else if (n >= 2) report.mapIssues.push({ code: "anchor-ambiguous", message: `Anchor ambiguous (${n} matches): ${relDoc} ${d.anchor}` });
      }
    }
    const docObj = { file: relDoc };
    if (d.anchor) docObj.anchor = d.anchor;
    if (d.critical === true) docObj.critical = true;
    if (d.note) docObj.note = d.note;
    entryDocs.push(docObj);
  }
  for (const f of matchedFilesForEntry) mergeFileDocs(f, entryDocs);
  validEntries.push({ rx, entryDocs });
}

const candidatesByFile = new Map();

const sourceHashes = hashFilesNormalized(cwd, [...matchedSourceFiles].sort());
for (const f of Object.keys(sourceHashes)) {
  const h = sourceHashes[f];
  if (!h) {
    pushWarningOnce(`unhashable:${f}`, "unhashable", `Cannot hash (skipped, not included in drift comparison): ${f}`);
    continue;
  }
  newSources[f] = h;
  if (recSources[f] !== h) {
    const kind = recSources[f] ? "modified" : "new"; // 有基线记录且失配=真漂移;首次纳管不算
    if (kind === "modified") realSourceDrift += 1;
    candidatesByFile.set(f, { file: f, kind, docs: [...(fileDocs.get(f)?.values() ?? [])] });
  }
}

const docHashes = hashFilesNormalized(cwd, [...docFiles].sort());
for (const df of Object.keys(docHashes)) {
  const h = docHashes[df];
  if (!h) continue;
  newDocs[df] = h;
  if (recDocs[df] && recDocs[df] !== h) report.docDrift.push(df);
}

// 反向对账:基线有记录但本次未纳管(删除/改名/移出映射)——文档可能仍在描述已不存在的代码
for (const k of Object.keys(recSources)) {
  if (k in newSources) continue;
  if (isExcluded(k, excludes)) continue;
  realSourceDrift += 1;
  const removedDocs = new Map();
  for (const { rx, entryDocs } of validEntries) {
    if (!rx.test(k)) continue;
    for (const docObj of entryDocs) {
      const key = docKey(docObj);
      removedDocs.set(key, mergeDocObj(removedDocs.get(key), docObj));
    }
  }
  candidatesByFile.set(k, { file: k, kind: "removed", docs: [...removedDocs.values()] });
}

report.driftCandidates = [...candidatesByFile.values()].sort((a, b) =>
  a.file < b.file ? -1 : a.file > b.file ? 1 : 0,
);
report.docDrift.sort();

if (stamp) {
  const ledgerDir =
    typeof docMap.config?.ledgerDir === "string" && docMap.config.ledgerDir
      ? docMap.config.ledgerDir
      : ".docc/LEDGER";

  // 盖章门:映射缺陷,或存在真实漂移而缺少对拍证词时拒绝。
  // 证词感知:带相符 verdict 盖章 = "对拍已完成"的机器可读凭证,正常收尾周期不再依赖 --force。
  // 聚合形式:--verdict 四类计数总和与候选数相符即视为 attested;
  // per-file 形式:证词粒度到文件,attested 升级为集合相等——verdictFiles 的键集合须与 driftCandidates 的 file 集合完全一致
  // (非法值条目已在解析阶段被丢弃,天然破坏相等,方向正确)。
  const mapDefects = report.mapIssues.filter((m) => m.code !== "baseline-corrupt").length;
  const hasRealDrift = realSourceDrift > 0 || report.docDrift.length > 0;
  const verdictSum = verdict === null ? null : Object.values(verdict).reduce((a, b) => a + b, 0);
  let attested;
  let verdictFileMismatch = null; // { missing: string[], extra: string[] } | null(仅 per-file 形式使用)
  if (verdictFiles !== null) {
    const candidateFileSet = new Set(report.driftCandidates.map((c) => c.file));
    const verdictFileSet = new Set(Object.keys(verdictFiles));
    const missing = [...candidateFileSet].filter((f) => !verdictFileSet.has(f)).sort();
    const extra = [...verdictFileSet].filter((f) => !candidateFileSet.has(f)).sort();
    attested = missing.length === 0 && extra.length === 0;
    if (!attested) verdictFileMismatch = { missing, extra };
  } else {
    attested = verdictSum !== null && verdictSum === report.driftCandidates.length;
  }
  if (!force && (mapDefects > 0 || (hasRealDrift && !attested))) {
    const actionParts = [];
    if (mapDefects > 0) actionParts.push("fix the mapping");
    if (hasRealDrift && !attested) actionParts.push("provide a matching --verdict as reconciliation attestation");
    report.stampBlocked = {
      realDriftCount: realSourceDrift,
      docDriftCount: report.docDrift.length,
      mapDefects,
      message: `Stamp rejected (mapping defects ${mapDefects}; real drift ${realSourceDrift} source files + ${report.docDrift.length} docs; reconciliation attestation ${verdict === null ? "missing" : attested ? "valid" : "count mismatch"}) — ${actionParts.join("; ")}; use --force for exception cases`,
    };
  }

  const dirtyLedgers = listDirtyLedgerFiles(cwd, ledgerDir);
  for (const f of dirtyLedgers) {
    try {
      const text = fs.readFileSync(path.join(cwd, f), "utf-8");
      if (!/<!--\s*verified-by:\s*\S[^>]*-->/.test(text)) {
        report.warnings.push({ code: "ledger-verified-by-missing", message: `Ledger missing verified-by marker: ${f}` });
      }
    } catch {
      // 读不到就不校验(fail-open)
    }
  }

  // INDEX 机检:本轮新增/修改台账应已登记进 INDEX.md
  if (dirtyLedgers.length) {
    let indexText = "";
    try {
      indexText = fs.readFileSync(path.join(cwd, ledgerDir, "INDEX.md"), "utf-8");
    } catch {
      // INDEX.md 缺失同样按未登记告警
    }
    for (const f of dirtyLedgers) {
      const base = f.split("/").pop();
      if (!indexText.includes(base)) {
        report.warnings.push({ code: "ledger-not-indexed", message: `Ledger not registered in INDEX.md: ${f}` });
      }
    }
  }

  // verdict 防呆:记录解析过程中的错误、未知键与非法值
  if (verdictParseFailed) {
    report.warnings.push({
      code: "verdict-parse-failed",
      message: "--verdict argument failed to parse (invalid JSON or not an object; treated as not provided; watch shell quote escaping, wrapping in single quotes is recommended)",
    });
  }
  if (verdictUnknownKeys.length > 0) {
    report.warnings.push({
      code: "verdict-unknown-key",
      message: `--verdict contains unknown key(s) (ignored): ${verdictUnknownKeys.join(", ")} (valid keys: formatting/docLag/codeViolation/other)`,
    });
  }
  if (verdictInvalidValueKeys.length > 0) {
    report.warnings.push({
      code: "verdict-invalid-value",
      message:
        verdictFiles !== null
          ? `--verdict per-file value invalid (must be one of formatting/docLag/codeViolation/other; entry discarded): ${verdictInvalidValueKeys.join(", ")}`
          : `--verdict key value invalid (must be a non-negative integer; ignored): ${verdictInvalidValueKeys.join(", ")} (valid keys: formatting/docLag/codeViolation/other)`,
    });
  }

  // --verdict 交叉核验:
  // 聚合形式:判定计数总和应与候选数一致(零和证词自证);{} 且候选 0 天然相符(0===0)
  // per-file 形式:改核验键集合(见上方 attested/verdictFileMismatch),集合相等时计数必然相等,故不重复发 count-mismatch
  if (verdict === null) {
    report.warnings.push({ code: "verdict-missing", message: "Stamp submitted without a reconciliation verdict (--verdict); history observation gap" });
  } else if (verdictFiles !== null) {
    if (verdictFileMismatch) {
      const missingStr = verdictFileMismatch.missing.length ? verdictFileMismatch.missing.join(", ") : "none";
      const extraStr = verdictFileMismatch.extra.length ? verdictFileMismatch.extra.join(", ") : "none";
      report.warnings.push({
        code: "verdict-file-mismatch",
        message: `--verdict per-file keys do not match the candidate set — missing: ${missingStr}; extra: ${extraStr}`,
      });
    }
  } else if (verdictSum !== report.driftCandidates.length) {
    report.warnings.push({
      code: "verdict-count-mismatch",
      message: `Reconciliation verdict count (${verdictSum}) does not match candidate count (${report.driftCandidates.length})`,
    });
  }

  if (!report.stampBlocked) {
    // tmp+rename 原子写(atomicWrite):进程被杀/磁盘满不再留下半写基线(半写基线会让 docDrift 静默失效)
    try {
      const sortObj = (o) =>
        Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
      const out = { sources: sortObj(newSources), docs: sortObj(newDocs) };
      atomicWrite(hashesPath, `${JSON.stringify(out, null, 1)}\n`);
      report.stamped = true;
    } catch (e) {
      report.mapIssues.push({ code: "stamp-write-failed", message: `Stamp write failed: ${e?.message}` });
    }
  }

  if (report.stamped) {
    // 盖章成功后 GC 共享 gated 去重文件:键中哈希已不等于新基线该 rel 的哈希(含 rel 已
    // 不在新基线中)即为死键,删除之——键=`${rel}@${hash}`,rel 本身可能含 "@",故从
    // 最后一个 "@" 切分取 hash,不误伤路径含 @ 的文件。共享文件是本地易失数据,GC 失败
    // 不影响盖章本身,整段静默(fail-open)。
    try {
      const shared = loadSharedGated(cwd);
      let changed = false;
      for (const key of Object.keys(shared)) {
        const at = key.lastIndexOf("@");
        const rel = at >= 0 ? key.slice(0, at) : key;
        const hash = at >= 0 ? key.slice(at + 1) : "";
        if (newSources[rel] !== hash) {
          delete shared[key];
          changed = true;
        }
      }
      if (changed) atomicWrite(sharedGatedPath(cwd), JSON.stringify(shared));
    } catch {
      // 静默:GC 失败不影响本次盖章结果
    }
  }

  if (docMap.config?.history !== false) {
    try {
      const lineObj = {
        ts: new Date().toISOString(),
        driftCandidates: report.driftCandidates.length,
        docDrift: report.docDrift.length,
        mapIssues: report.mapIssues.length,
        warnings: report.warnings.length,
        stamped: report.stamped,
        forced: force,
        // verdict 只随成功盖章落行:拒绝行记 null,消费方统计无需过滤即无双计
        verdict: report.stamped ? verdict : null,
      };
      // per-file 形式且成功盖章时额外携带 verdictFiles(文件级证词);其余情形省略该键,行保持精简
      if (report.stamped && verdictFiles !== null) {
        lineObj.verdictFiles = verdictFiles;
      }
      const line = JSON.stringify(lineObj);
      fs.appendFileSync(path.join(cwd, HISTORY_FILE), `${line}\n`);

      // 轮转:超过 historyLimit(缺省 500,0=不限)只保留最新 N 行;atomicWrite 补 finally 清理(此前缺失)
      const limitRaw = docMap.config?.historyLimit;
      const limit = Number.isInteger(limitRaw) && limitRaw >= 0 ? limitRaw : 500;
      if (limit > 0) {
        const histPath = path.join(cwd, HISTORY_FILE);
        const all = fs.readFileSync(histPath, "utf-8").split("\n").filter(Boolean);
        if (all.length > limit) {
          atomicWrite(histPath, `${all.slice(-limit).join("\n")}\n`);
        }
      }
    } catch (e) {
      report.warnings.push({ code: "history-write-failed", message: `History write failed: ${e?.message}` });
    }
  }
}

report.ok = report.mapIssues.length === 0;
console.log(JSON.stringify(report, null, 2));

// --check 模式：有漂移/映射问题/文档改动则 exit 1
if (check) {
  process.exit(
    report.mapIssues.length || report.driftCandidates.length || report.docDrift.length ? 1 : 0,
  );
}
