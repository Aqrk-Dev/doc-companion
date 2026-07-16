/**
 * doc-companion 共享库。零 npm 依赖，只用 Node 内置模块。
 * 铁律：任何异常都不得让调用方崩溃——本模块所有函数对错误输入返回
 * null/false/默认值，由调用方决定 fail-open 行为。
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export const DOC_MAP_FILE = ".docc/map.json";
export const HASHES_FILE = ".docc/hashes.json";
export const HISTORY_FILE = ".docc/history.jsonl";

/** 生成物/内部目录默认排除(目录前缀,恒生效);config.exclude 可追加自定义前缀 */
export const DEFAULT_EXCLUDES = [".understand-anything/", ".claude/", ".docc/"];

/**
 * 默认排除 ∪ config.exclude。成员含 * 或 ? 走极简 glob 整路径匹配,
 * 否则按目录前缀(归一化:trim、去 ./、补尾 /);坏输入/坏 glob 静默忽略(fail-open)。
 */
export function getExcludes(docMap) {
  const prefixes = [...DEFAULT_EXCLUDES];
  const regexps = [];
  const extra = Array.isArray(docMap?.config?.exclude) ? docMap.config.exclude : [];
  for (const p of extra) {
    if (typeof p !== "string" || !p.trim()) continue;
    let s = p.trim();
    if (s.startsWith("./")) s = s.slice(2);
    if (!s) continue;
    if (/[*?]/.test(s)) {
      try {
        regexps.push(globToRegExp(s));
      } catch {
        // 坏 glob 静默忽略
      }
    } else {
      prefixes.push(s.endsWith("/") ? s : `${s}/`);
    }
  }
  return { prefixes, regexps };
}

export function isExcluded(relPosix, excludes) {
  return (
    excludes.prefixes.some((p) => relPosix.startsWith(p)) ||
    excludes.regexps.some((rx) => rx.test(relPosix))
  );
}

export function warn(msg) {
  process.stderr.write(`[doc-companion] ${msg}\n`);
}

export function readJsonSafe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return null;
  }
}

export function toPosix(p) {
  return p.split(path.sep).join("/");
}

/** 归一化为仓库相对 posix 路径；越出 cwd（含跨盘符）返回 null */
export function repoRelative(filePath, cwd) {
  try {
    const rel = path.relative(cwd, path.resolve(cwd, filePath));
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
    return toPosix(rel);
  } catch {
    return null;
  }
}

/** 极简 glob：`**` 仅在段边界跨路径段(段内视为单星),`*` 段内任意,`?` 单字符,其余字面量 */
export function globToRegExp(pattern) {
  // 连续段边界 **/ 折叠:防嵌套量词灾难回溯;段内 ** 不参与折叠(其语义为单星)
  pattern = pattern.replace(/(^|\/)(?:\*\*\/)+/g, "$1**/");

  let re = "";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "*") {
      const isDouble = pattern[i + 1] === "*";
      const atSegStart = i === 0 || pattern[i - 1] === "/";
      const nextAfter = pattern[i + 2];
      if (isDouble && atSegStart && (nextAfter === "/" || nextAfter === undefined)) {
        // 段边界 **:跨路径段(globstar)
        if (nextAfter === "/") {
          re += "(?:[^/]+/)*";
          i += 3;
        } else {
          re += ".*";
          i += 2;
        }
      } else if (isDouble) {
        // 段内 **:对齐 gitignore,等价单星,不跨 /
        re += "[^/]*";
        i += 2;
      } else {
        re += "[^/]*";
        i += 1;
      }
    } else if (c === "?") {
      re += "[^/]";
      i += 1;
    } else {
      re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      i += 1;
    }
  }
  return new RegExp(`^${re}$`);
}

/**
 * 在当前 git 仓库内(自 startDir 至仓库根,含)向上寻找最近的 .docc/map.json 目录并返回;
 * 非 git 树(向上至文件系统根都无 .git,兼容目录与 worktree/submodule 的 .git 文件)
 * 仅认 startDir 自身,不采信任何祖先——防止共享机器上层目录被植入 .docc/map.json
 * (如 /tmp/.docc/map.json)静默捕获非 git 会话。
 * 走到边界仍无命中、或任何异常,返回 startDir 原值——保"未 init 零打扰":无 .docc/ 时行为与今日完全一致。
 */
export function findDoccRoot(startDir) {
  try {
    const start = path.resolve(startDir);
    // 第一遍:定位 git 仓库根(最近的含 .git 的祖先或自身);无则 null(非 git 树)
    let gitRoot = null;
    let d = start;
    for (;;) {
      if (fs.existsSync(path.join(d, ".git"))) {
        gitRoot = d;
        break;
      }
      const parent = path.dirname(d);
      if (parent === d) break;
      d = parent;
    }
    // 第二遍:自 start 向上至 gitRoot(含)寻找最近 .docc/map.json;非 git 树仅查 start 自身
    let dir = start;
    for (;;) {
      if (fs.existsSync(path.join(dir, DOC_MAP_FILE))) return dir;
      if (gitRoot === null || dir === gitRoot) break; // 非 git:仅 start;git:止于仓库根
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return startDir;
  } catch {
    return startDir;
  }
}

/** 读项目映射;缺失/损坏/形状不对/schema 版本不受支持一律返回 null(调用方零打扰退出) */
export function loadDocMap(cwd) {
  const map = readJsonSafe(path.join(cwd, DOC_MAP_FILE));
  if (!map || !Array.isArray(map.entries)) return null;
  if (map.version !== undefined && map.version !== 1) return null;
  return map;
}

export function matchEntries(docMap, relPosix) {
  if (isExcluded(relPosix, getExcludes(docMap))) return [];
  const out = [];
  for (const entry of docMap.entries) {
    if (typeof entry?.pattern !== "string" || !Array.isArray(entry?.docs)) continue;
    try {
      if (globToRegExp(entry.pattern).test(relPosix)) out.push(entry);
    } catch {
      // 坏 pattern 由 preflight 报告，匹配流程不因此中断
    }
  }
  return out;
}

/**
 * 内容哈希自算(node:crypto 内置,零 npm 依赖),口径对齐 git blob sha1:
 * `sha1("blob " + len + "\0" + content)`,len 为归一化后字节长。不再经 git 子进程——
 * 进程内计算,无 ENOBUFS/maxBuffer 问题,且天然不受本机 git 配置(autocrlf 等)影响。
 * CRLF→LF 归一化(仅文本文件):同一文件在 LF/CRLF 两种行尾下哈希相同,根治跨机(尤其
 * Windows checkout)幻影漂移;二进制文件(前 8000 字节或全文含 0x00,与 git 同款启发式)
 * 不做归一化,原样计算——防止误伤图片/二进制资产。
 * LF 文件与 `git hash-object --no-filters` 逐字节同值;含 CRLF 的文件哈希值与旧版
 * (走 git 子进程,未归一化)不同——这是 v0.6.0 breaking:CRLF 文件基线一次性失效。
 * 快路径:不含 CR(0x0d)字节的文本文件跳过 latin1 字符串往返,直接用原 buffer——
 * 省去大文件的字符串转换开销,也使不含 CR 的文件不再受 V8 字符串长度上限(约 512MiB)制约。
 */
export function hashFileNormalized(cwd, relPosix) {
  try {
    const buf = fs.readFileSync(path.join(cwd, relPosix));
    const sniffLen = Math.min(buf.length, 8000);
    let isBinary = false;
    for (let i = 0; i < sniffLen; i++) {
      if (buf[i] === 0) {
        isBinary = true;
        break;
      }
    }
    let content = buf;
    if (!isBinary && buf.includes(0x0d)) {
      // 无 CR(0x0d)直接跳过字符串往返:纯性能快路径,也让不含 CR 的超大文件
      // (>512MiB 会触及 V8 字符串长度上限,toString/Buffer.from 往返本身会抛出)
      // 不再退化为 unhashable——只有含 CR 的文本才需要走 latin1 替换。
      // latin1 字符串对字节 1:1 往返(不做 UTF-8 解码),CRLF→LF 替换后原样转回 Buffer——
      // 不损伤非 UTF-8 字节序列。仅替换 \r\n,孤立 \r 不动。
      const normalized = buf.toString("latin1").replace(/\r\n/g, "\n");
      content = Buffer.from(normalized, "latin1");
    }
    const hash = createHash("sha1");
    hash.update(`blob ${content.length}\0`);
    hash.update(content);
    return hash.digest("hex");
  } catch {
    return null;
  }
}

/** 批量版 hashFileNormalized:进程内循环,无子进程、无 maxBuffer 问题,单个文件失败不影响其余 */
export function hashFilesNormalized(cwd, rels) {
  const out = {};
  for (const rel of rels) out[rel] = hashFileNormalized(cwd, rel);
  return out;
}

// git 子进程(ls-files/status)输出上限:大仓清单超过 Node 默认 1MB 会被 ENOBUFS 杀死。
// 哈希自 v0.6.0 起不再走 git 子进程,此常量仅服务文件枚举。
export const GIT_MAX_BUFFER = 256 * 1024 * 1024;

/**
 * 锚点边界匹配:行以 anchor 开头,且其后紧跟行尾或空白——
 * 防止"## 状态"被"## 状态更新记录"这类更长标题字面顶替(假阳性)。
 * 返回命中行数;读文件失败返回 0,不抛。
 */
export function countAnchorMatches(cwd, docFile, anchor) {
  try {
    const text = fs.readFileSync(path.join(cwd, docFile), "utf-8");
    return text.split(/\r?\n/).filter((line) => {
      if (!line.startsWith(anchor)) return false;
      const rest = line.slice(anchor.length);
      return rest === "" || /^\s/.test(rest);
    }).length;
  } catch {
    return 0;
  }
}

/**
 * 统一格式化文档引用为人类可读字符串:`file anchor（note）`,anchor/note 缺省则省略对应片段。
 * 供契约门提示与提醒档共用,避免两处格式各写一套、遗漏字段(如 note)。
 */
export function formatDocRef(d) {
  return `${d.file} ${d.anchor ?? ""}${d.note ? `（${d.note}）` : ""}`.trim();
}

/**
 * tmp+rename 原子写:同目录写临时文件再 rename,避免进程被杀/磁盘满时留下半写损坏文件。
 * mkdir 目标父目录(recursive);失败原样抛出,由调用方按各自场景定降级文案与行为。
 * finally 清理残留 tmp——避免 .docc/ 或 .claude/.cache/ 内堆积垃圾文件。
 */
export function atomicWrite(filePath, content) {
  const tmp = `${filePath}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, filePath);
  } finally {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {}
  }
}

/** 清洗 session_id：保留字母、数字、下划线、短横;其余替换为下划线 */
function sanitizeSid(sessionId) {
  return String(sessionId || "default").replace(/[^A-Za-z0-9_-]/g, "_");
}

function cacheFilePath(cwd, sessionId, suffix) {
  return path.join(cwd, ".claude", ".cache", `doc-companion-${sanitizeSid(sessionId)}${suffix}`);
}

/**
 * 跨会话共享去重文件路径(不按 session_id 分文件,发现根下单例)。
 * 用于契约门去重键跨会话共享——键=文件@基线哈希,盖章重写基线后旧键自然失效,零清理逻辑。
 */
export function sharedGatedPath(cwd) {
  return path.join(cwd, ".claude", ".cache", "doc-companion-gated.json");
}

/** 读跨会话共享去重文件;缺失/损坏/非纯对象(null/数组)一律返回 {}(fail-open) */
export function loadSharedGated(cwd) {
  const g = readJsonSafe(sharedGatedPath(cwd));
  if (!g || typeof g !== "object" || Array.isArray(g)) return {};
  return g;
}

/** 契约门跨会话去重键:文件@基线哈希;无基线记录(未盖章过/hashes.json 缺失损坏)回退 "unbaselined" */
export function gatedKey(rel, recSources) {
  return `${rel}@${recSources?.[rel] ?? "unbaselined"}`;
}

export function statePath(cwd, sessionId) {
  return cacheFilePath(cwd, sessionId, ".json");
}

/** 契约门声明草稿路径(与会话状态同目录、同 sid 清洗) */
export function declarationsPath(cwd, sessionId) {
  return cacheFilePath(cwd, sessionId, ".declarations.md");
}

/** 契约门拦截时机写声明 stub;agent 重试前把 pending 替换为声明内容。失败返回 false,不抛。seq 为本会话第几次拦截,与台账对账节勾稽 */
export function appendDeclarationStub(cwd, sessionId, rel, anchors, seq) {
  try {
    const p = declarationsPath(cwd, sessionId);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(
      p,
      `## ${rel} — ${new Date().toISOString()} [id: ${sanitizeSid(sessionId)}#${seq}]\n` +
        `- Contract anchors: ${anchors.join(", ")}\n` +
        `- Declaration: <!-- pending -->\n\n`,
    );
    return true;
  } catch (e) {
    warn(`Declaration stub failed to write (does not affect the interception): ${e?.message}`);
    return false;
  }
}

/**
 * 会话状态按 session_id 分文件：startup/clear 产生新 session_id 即天然重置，
 * resume/compact 沿用旧 id 即天然保留——无需 SessionStart hook。
 */
export function loadState(cwd, sessionId) {
  const s = readJsonSafe(statePath(cwd, sessionId));
  if (!s || typeof s !== "object" || Array.isArray(s)) {
    return { reminded: [], gated: [], notedCount: 0 };
  }
  return {
    reminded: Array.isArray(s.reminded) ? s.reminded : [],
    gated: Array.isArray(s.gated) ? s.gated : [],
    notedCount: Number.isInteger(s.notedCount) ? s.notedCount : 0,
  };
}

/** 保序去重合并:base 原序在前,extra 中未出现过的成员按其顺序追加 */
function mergeUnique(base, extra) {
  const out = [...base];
  const seen = new Set(base);
  for (const item of extra) {
    if (!seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
  return out;
}

/**
 * 返回是否写入成功——契约门必须检查返回值，写失败时降级放行（防死锁）。
 * 合并式写入:写前重读磁盘最新状态,与本次传入状态取并集(gated/reminded 保序去重,
 * notedCount 取 max)再 atomicWrite——同会话并行子 agent 各自基于稍旧状态调用时,
 * 后写入者不再整体覆盖先写入者的记录(lost-update 窗口收窄至重读与 rename 之间的
 * 微秒级)。tmp+rename 原子写:并发 hook 进程下绝不产生半写损坏的状态文件。
 */
export function saveState(cwd, sessionId, state) {
  const p = statePath(cwd, sessionId);
  try {
    const disk = loadState(cwd, sessionId);
    const merged = {
      reminded: mergeUnique(disk.reminded, state.reminded ?? []),
      gated: mergeUnique(disk.gated, state.gated ?? []),
      notedCount: Math.max(disk.notedCount, Number.isInteger(state.notedCount) ? state.notedCount : 0),
    };
    atomicWrite(p, JSON.stringify(merged));
    return true;
  } catch (e) {
    warn(`Session state failed to write (only dedup is affected, functionality is unaffected): ${e?.message}`);
    return false;
  }
}

export function readStdinJson() {
  try {
    return JSON.parse(fs.readFileSync(0, "utf-8"));
  } catch {
    return null;
  }
}
