import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  globToRegExp,
  repoRelative,
  countAnchorMatches,
  loadState,
  saveState,
  statePath,
  getExcludes,
  isExcluded,
  matchEntries,
  declarationsPath,
  appendDeclarationStub,
  loadDocMap,
  hashFileNormalized,
  hashFilesNormalized,
  findDoccRoot,
  atomicWrite,
  formatDocRef,
  sharedGatedPath,
  loadSharedGated,
  gatedKey,
} from "../hooks/_shared.mjs";

test("globToRegExp: ** 跨段、* 段内、? 单字符、字面量转义", () => {
  assert.ok(globToRegExp("lib/api/**").test("lib/api/a/b.ts"));
  assert.ok(globToRegExp("**/x.ts").test("x.ts"));
  assert.ok(globToRegExp("**/x.ts").test("a/b/x.ts"));
  assert.ok(globToRegExp("lib/*.ts").test("lib/a.ts"));
  assert.ok(!globToRegExp("lib/*.ts").test("lib/a/b.ts"));
  assert.ok(globToRegExp("a?.ts").test("ab.ts"));
  assert.ok(!globToRegExp("a?.ts").test("a/b.ts"));
  assert.ok(globToRegExp("a.b/c.ts").test("a.b/c.ts"));
  assert.ok(!globToRegExp("a.b/c.ts").test("aXb/c.ts"));
});

test("repoRelative: 归一化与越界拒绝", () => {
  assert.equal(repoRelative("/etc/passwd", "/tmp/proj"), null);
  assert.equal(repoRelative("/tmp/proj/src/a.ts", "/tmp/proj"), "src/a.ts");
  assert.equal(repoRelative("src/a.ts", "/tmp/proj"), "src/a.ts");
  assert.equal(repoRelative("../out.ts", "/tmp/proj"), null);
});

test("state: 往返、损坏回退默认、saveState 返回布尔", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "dc-"));
  assert.equal(saveState(d, "s1", { reminded: ["a.ts"], gated: [], notedCount: 0 }), true);
  assert.deepEqual(loadState(d, "s1").reminded, ["a.ts"]);
  fs.writeFileSync(statePath(d, "s1"), "{broken");
  assert.deepEqual(loadState(d, "s1"), { reminded: [], gated: [], notedCount: 0 });
});

test("saveState: 合并式写入——重读磁盘取并集(保序去重),notedCount 取 max,记录不因后写覆盖而丢失(v0.6.0)", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "dc-"));
  assert.equal(
    saveState(d, "s1", { reminded: [], gated: ["src/b.ts"], notedCount: 5 }),
    true,
  );
  // 模拟并行子 agent:基于更旧的状态(不知道 src/b.ts 已被记录)调用 saveState
  assert.equal(
    saveState(d, "s1", { reminded: [], gated: ["src/a.ts"], notedCount: 2 }),
    true,
  );
  const result = loadState(d, "s1");
  assert.deepEqual(result.gated, ["src/b.ts", "src/a.ts"], "磁盘序在前、内存新增追加,两者都在,谁都没丢");
  assert.equal(result.notedCount, 5, "notedCount 取磁盘与本次传入的较大者,不被较小值覆盖");

  // 重复写入同一成员不产生重复项
  saveState(d, "s1", { reminded: [], gated: ["src/a.ts"], notedCount: 0 });
  assert.deepEqual(loadState(d, "s1").gated, ["src/b.ts", "src/a.ts"], "已存在成员不重复追加");
});

test("countAnchorMatches: 边界匹配与计数", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "dc-"));
  fs.writeFileSync(
    path.join(d, "x.md"),
    "# T\n\n### 2.6 accounts 契约\n正文\n### 2.61 无关章节\n### 2.6:标点紧跟\n### 2.6\n",
  );
  assert.equal(countAnchorMatches(d, "x.md", "### 2.6"), 2); // 带空白后缀 + 精确行;2.61/标点紧跟不算
  assert.equal(countAnchorMatches(d, "x.md", "### 2.61"), 1);
  assert.equal(countAnchorMatches(d, "x.md", "### 9.9"), 0);
  assert.equal(countAnchorMatches(d, "missing.md", "### 2.6"), 0);
});

test("countAnchorMatches: CRLF 行尾不干扰精确行匹配", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "dc-"));
  fs.writeFileSync(path.join(d, "y.md"), "## 状态\r\n内容\r\n");
  assert.equal(countAnchorMatches(d, "y.md", "## 状态"), 1);
});

test("getExcludes: 前缀+glob 混写,返回 {prefixes, regexps}(v0.3.0)", () => {
  const ex = getExcludes({ config: { exclude: ["dist", "./gen/", "**/*_pb.go", 42, "", "  ", "./"] } });
  assert.deepEqual(ex.prefixes, [".understand-anything/", ".claude/", ".docc/", "dist/", "gen/"]);
  assert.equal(ex.regexps.length, 1);
  assert.ok(isExcluded("a/b/x_pb.go", ex), "glob 命中");
  assert.ok(!isExcluded("a/b/x.go", ex));
  assert.ok(isExcluded("dist/y.js", ex), "前缀命中");
  assert.ok(isExcluded(".docc/hashes.json", ex));
});

test("getExcludes: 无 config 时仅默认前缀(v0.3.0 shape)", () => {
  const ex = getExcludes(null);
  assert.deepEqual(ex.prefixes, [".understand-anything/", ".claude/", ".docc/"]);
  assert.deepEqual(ex.regexps, []);
});

test("globToRegExp: 连续 **/ 折叠,深路径毫秒级(v0.3.0)", () => {
  assert.equal(globToRegExp("a/**/**/**/b").source, globToRegExp("a/**/b").source);
  const rx = globToRegExp("**/**/**/**/**/**/**/**/x.ts");
  const deep = `${"d/".repeat(40)}y.ts`;
  const t0 = Date.now();
  rx.test(deep);
  assert.ok(Date.now() - t0 < 200, "折叠后不应灾难性回溯");
});

test("isExcluded / matchEntries: 排除前缀内路径不命中任何条目", () => {
  const docMap = {
    version: 1,
    config: { exclude: ["gen/"] },
    entries: [{ pattern: "**", docs: [{ file: "docs/A.md", anchor: "## x" }] }],
  };
  const ex = getExcludes(docMap);
  assert.ok(isExcluded(".claude/.cache/doc-companion-s.declarations.md", ex));
  assert.ok(isExcluded("gen/out.ts", ex));
  assert.ok(!isExcluded("src/gen.ts", ex), "前缀匹配不误伤同名文件");
  assert.equal(matchEntries(docMap, ".understand-anything/graph.json").length, 0);
  assert.equal(matchEntries(docMap, "gen/out.ts").length, 0);
  assert.equal(matchEntries(docMap, "src/a.ts").length, 1);
});

test("appendDeclarationStub: 建目录、逐段追加、pending 占位;declarationsPath 清洗 sid;失败返回 false", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "dc-"));
  assert.ok(declarationsPath(d, "a/b").endsWith("doc-companion-a_b.declarations.md"));
  assert.equal(appendDeclarationStub(d, "s1", "src/a.ts", ["docs/A.md ## 契约"], 1), true);
  assert.equal(
    appendDeclarationStub(d, "s1", "src/b.ts", ["docs/A.md ## 契约", "README.md ## 状态"], 2),
    true,
  );
  const text = fs.readFileSync(declarationsPath(d, "s1"), "utf-8");
  assert.match(text, /## src\/a\.ts — /);
  assert.match(text, /## src\/b\.ts — /);
  assert.match(text, /docs\/A\.md ## 契约, README\.md ## 状态/);
  assert.equal((text.match(/<!-- pending -->/g) || []).length, 2);
  assert.match(text, /## src\/a\.ts — .+ \[id: s1#1\]/);
  assert.match(text, /## src\/b\.ts — .+ \[id: s1#2\]/);

  const f = path.join(d, "not-a-dir");
  fs.writeFileSync(f, "");
  assert.equal(appendDeclarationStub(f, "s1", "x.ts", [], 1), false, "cwd 不可用时返回 false 不抛");
});

test("loadDocMap: 读 .docc/map.json,旧位置 docs/DOC-MAP.json 不再识别(v0.3.0)", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "dc-"));
  fs.mkdirSync(path.join(d, "docs"), { recursive: true });
  fs.writeFileSync(path.join(d, "docs", "DOC-MAP.json"), JSON.stringify({ version: 1, entries: [] }));
  assert.equal(loadDocMap(d), null, "旧位置必须被忽略(升级=重新 init)");
  fs.mkdirSync(path.join(d, ".docc"), { recursive: true });
  fs.writeFileSync(path.join(d, ".docc", "map.json"), JSON.stringify({ version: 1, entries: [] }));
  assert.ok(loadDocMap(d));
});

test("glob: 段内 ** 视为单星,不跨 /(对齐 gitignore)(v0.4.0)", () => {
  assert.ok(globToRegExp("a**b").test("axxb"));
  assert.ok(!globToRegExp("a**b").test("a/x/b"));
  assert.ok(globToRegExp("a**").test("axx"));
  assert.ok(!globToRegExp("a**").test("a/x"));
  assert.ok(!globToRegExp("**b").test("a/b"));
  assert.ok(globToRegExp("src/**").test("src/a/b.ts"), "段边界 ** 语义不变");
  assert.ok(globToRegExp("**/x.ts").test("a/b/x.ts"));
  assert.ok(globToRegExp("**").test("a/b/c"), "整串 ** 匹配一切");
});

test("段边界折叠不吞 globstar:a**/**/b 首段单星+次段跨段(v0.4.0)", () => {
  assert.ok(globToRegExp("a**/**/b").test("ax/y/b"));
  assert.ok(globToRegExp("src**/**/x.ts").test("srcfoo/a/b/x.ts"));
  assert.equal(globToRegExp("**/**/x").source, globToRegExp("**/x").source);
  assert.equal(globToRegExp("a/**/**/b").source, globToRegExp("a/**/b").source);
});

function gitHashObjectNoFilters(cwd, relPosix) {
  const r = spawnSync("git", ["hash-object", "--no-filters", "--", relPosix], {
    cwd,
    encoding: "utf-8",
  });
  assert.equal(r.status, 0, `git hash-object 失败: ${r.stderr}`);
  return r.stdout.trim();
}

test("hashFileNormalized: LF 文件与 git hash-object --no-filters 逐字节同值(交叉验证钉)(v0.6.0)", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "dc-"));
  spawnSync("git", ["init", "-q"], { cwd: d });
  fs.writeFileSync(path.join(d, "a.txt"), "line1\nline2\n");
  fs.writeFileSync(path.join(d, "empty.txt"), "");
  fs.writeFileSync(path.join(d, "unicode.txt"), "中文内容\n第二行\n");
  for (const f of ["a.txt", "empty.txt", "unicode.txt"]) {
    assert.equal(hashFileNormalized(d, f), gitHashObjectNoFilters(d, f), `${f} 应与 git hash-object 同值`);
  }
});

test("hashFileNormalized: CRLF 与同内容 LF 版本哈希相等(v0.6.0)", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "dc-"));
  fs.writeFileSync(path.join(d, "lf.txt"), "line1\nline2\nline3\n");
  fs.writeFileSync(path.join(d, "crlf.txt"), "line1\r\nline2\r\nline3\r\n");
  assert.equal(hashFileNormalized(d, "lf.txt"), hashFileNormalized(d, "crlf.txt"));
});

test("hashFileNormalized: 端到端——已盖章文件改为 CRLF 行尾后哈希不变(幻影漂移根治钉)(v0.6.0)", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "dc-"));
  fs.writeFileSync(path.join(d, "a.txt"), "alpha\nbeta\ngamma\n");
  const before = hashFileNormalized(d, "a.txt");
  fs.writeFileSync(path.join(d, "a.txt"), "alpha\r\nbeta\r\ngamma\r\n");
  const after = hashFileNormalized(d, "a.txt");
  assert.equal(before, after, "同内容仅行尾从 LF 改为 CRLF 不应产生哈希差异");
});

test("hashFileNormalized: 二进制(含 0x00)不做 CRLF 归一化,CRLF/LF 版本哈希不同(v0.6.0)", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "dc-"));
  const lfBin = Buffer.concat([Buffer.from([0x00, 0x01]), Buffer.from("a\nb\n")]);
  const crlfBin = Buffer.concat([Buffer.from([0x00, 0x01]), Buffer.from("a\r\nb\r\n")]);
  fs.writeFileSync(path.join(d, "lf.bin"), lfBin);
  fs.writeFileSync(path.join(d, "crlf.bin"), crlfBin);
  assert.notEqual(
    hashFileNormalized(d, "lf.bin"),
    hashFileNormalized(d, "crlf.bin"),
    "二进制文件的 CRLF 字节序列不应被替换,故与 LF 版本哈希不同",
  );
  // 二进制哈希口径仍与 git 的 blob sha1 对齐(git 对二进制同样不做任何过滤/归一化)
  assert.equal(hashFileNormalized(d, "lf.bin"), gitHashObjectNoFilters(d, "lf.bin"));
});

test("hashFileNormalized: 二进制启发式窗口边界——NUL 在下标 7999(前 8000 字节内)按二进制,CRLF 不归一化(v0.6.0 终审)", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "dc-"));
  const crlf = Buffer.from(`${"a".repeat(7999)}\0\r\n`, "latin1");
  const lf = Buffer.from(`${"a".repeat(7999)}\0\n`, "latin1");
  fs.writeFileSync(path.join(d, "crlf.bin"), crlf);
  fs.writeFileSync(path.join(d, "lf.bin"), lf);
  assert.notEqual(
    hashFileNormalized(d, "crlf.bin"),
    hashFileNormalized(d, "lf.bin"),
    "NUL 落在前 8000 字节扫描窗口内 → 判定二进制,不做 CRLF→LF 归一化,故哈希不同",
  );
});

test("hashFileNormalized: 二进制启发式窗口边界——NUL 在下标 8000(第 8001 字节,窗口外)按文本,CRLF 归一化(v0.6.0 终审)", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "dc-"));
  const crlf = Buffer.from(`${"a".repeat(8000)}\0\r\n`, "latin1");
  const lf = Buffer.from(`${"a".repeat(8000)}\0\n`, "latin1");
  fs.writeFileSync(path.join(d, "crlf2.txt"), crlf);
  fs.writeFileSync(path.join(d, "lf2.txt"), lf);
  assert.equal(
    hashFileNormalized(d, "crlf2.txt"),
    hashFileNormalized(d, "lf2.txt"),
    "NUL 落在第 8000 字节(下标 8000,超出前 8000 字节扫描窗口)→ 判定文本,做 CRLF→LF 归一化,故哈希相等",
  );
});

test("hashFileNormalized: 读失败(文件不存在)返回 null(v0.6.0)", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "dc-"));
  assert.equal(hashFileNormalized(d, "no-such-file.txt"), null);
});

test("hashFilesNormalized: 批量循环与逐文件等价;空数组 {};单文件失败不影响其余(v0.6.0)", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "dc-"));
  fs.writeFileSync(path.join(d, "a.txt"), "aaa\n");
  fs.writeFileSync(path.join(d, "b.txt"), "bbb\n");
  const batch = hashFilesNormalized(d, ["a.txt", "b.txt"]);
  assert.equal(batch["a.txt"], hashFileNormalized(d, "a.txt"));
  assert.equal(batch["b.txt"], hashFileNormalized(d, "b.txt"));
  assert.deepEqual(hashFilesNormalized(d, []), {});
  fs.symlinkSync("no-such", path.join(d, "broken.txt"));
  const withBroken = hashFilesNormalized(d, ["a.txt", "broken.txt"]);
  assert.equal(withBroken["a.txt"], hashFileNormalized(d, "a.txt"), "单文件失败不拖累其余文件");
  assert.equal(withBroken["broken.txt"], null);
});

test("findDoccRoot: startDir 自身含 .docc/map.json → 返回自身(v0.4.1)", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "dc-root-"));
  fs.mkdirSync(path.join(d, ".docc"), { recursive: true });
  fs.writeFileSync(path.join(d, ".docc", "map.json"), "{}");
  assert.equal(findDoccRoot(d), d);
});

test("findDoccRoot: 无任何祖先含 .docc/map.json → 返回 startDir 原值(v0.4.1)", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "dc-noroot-"));
  const deep = path.join(d, "x", "y");
  fs.mkdirSync(deep, { recursive: true });
  assert.equal(findDoccRoot(deep), deep);
  assert.equal(findDoccRoot(d), d);
});

test("findDoccRoot: 不存在的路径 → 返回该路径原值,不抛(v0.4.1)", () => {
  const missing = path.join(os.tmpdir(), "dc-findroot-does-not-exist-xyz");
  assert.doesNotThrow(() => findDoccRoot(missing));
  assert.equal(findDoccRoot(missing), missing);
});

test("findDoccRoot: git 仓库根内 .docc/map.json → 返回该 git 根(v0.4.1 加固 A)", () => {
  const repoRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dc-gitroot-")));
  fs.mkdirSync(path.join(repoRoot, ".git"), { recursive: true });
  fs.mkdirSync(path.join(repoRoot, ".docc"), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, ".docc", "map.json"), "{}");
  const deep = path.join(repoRoot, "sub", "deep");
  fs.mkdirSync(deep, { recursive: true });
  assert.equal(findDoccRoot(deep), repoRoot);
  // 仅一层子目录同样生效
  assert.equal(findDoccRoot(path.join(repoRoot, "a")), repoRoot);
});

test("findDoccRoot: git 仓库根内无 .docc,上层(仓库外)有 .docc/map.json → 不越界,返回 startDir 原值(v0.4.1 加固 A)", () => {
  const outer = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dc-outer-")));
  fs.mkdirSync(path.join(outer, ".docc"), { recursive: true });
  fs.writeFileSync(path.join(outer, ".docc", "map.json"), "{}");
  const repo = path.join(outer, "repo");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  const startDir = path.join(repo, "sub");
  fs.mkdirSync(startDir, { recursive: true });
  assert.equal(findDoccRoot(startDir), startDir, "不得越过 .git 仓库边界发现上层植入的 .docc");
});

test("findDoccRoot: 同一层既有 .git 又有 .docc/map.json → 命中返回该层(git 边界判断在 .docc 检查之后)(v0.4.1 加固 A)", () => {
  const repoRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dc-gitdocc-")));
  fs.mkdirSync(path.join(repoRoot, ".git"), { recursive: true });
  fs.mkdirSync(path.join(repoRoot, ".docc"), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, ".docc", "map.json"), "{}");
  assert.equal(findDoccRoot(repoRoot), repoRoot);
});

test("findDoccRoot: git 仓库根用 .git 文件(worktree/submodule 形式)同样封顶(v0.4.1 加固 A)", () => {
  const outer = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dc-outer-file-")));
  fs.mkdirSync(path.join(outer, ".docc"), { recursive: true });
  fs.writeFileSync(path.join(outer, ".docc", "map.json"), "{}");
  const repo = path.join(outer, "repo");
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, ".git"), "gitdir: /somewhere/.git/worktrees/repo\n");
  const startDir = path.join(repo, "sub");
  fs.mkdirSync(startDir, { recursive: true });
  assert.equal(findDoccRoot(startDir), startDir, ".git 为文件(worktree)时同样应封顶,不越界");
});

test("atomicWrite: 正常写入往返(v0.5.0)", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "dc-"));
  const p = path.join(d, "nested", "out.json");
  atomicWrite(p, "hello");
  assert.equal(fs.readFileSync(p, "utf-8"), "hello");
  // 无 tmp 残留
  const siblings = fs.readdirSync(path.join(d, "nested"));
  assert.deepEqual(siblings, ["out.json"]);
});

test("atomicWrite: 目标父目录为普通文件时抛错,且不留 tmp 残留(v0.5.0)", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "dc-"));
  const blocker = path.join(d, "blocker");
  fs.writeFileSync(blocker, ""); // 普通文件,不能作为父目录
  const p = path.join(blocker, "out.json");
  assert.throws(() => atomicWrite(p, "x"));
  // tmp 文件应以 pid 命名,写在 blocker 同级(mkdirSync 失败,tmp 从未写入或已清理)
  const siblings = fs.readdirSync(d);
  assert.deepEqual(siblings, ["blocker"], "父目录不可写场景不得残留 tmp 文件");
});

test("formatDocRef: file+anchor+note 组合、缺省省略(v0.5.0)", () => {
  assert.equal(formatDocRef({ file: "docs/A.md" }), "docs/A.md");
  assert.equal(formatDocRef({ file: "docs/A.md", anchor: "## 契约" }), "docs/A.md ## 契约");
  assert.equal(
    formatDocRef({ file: "docs/A.md", anchor: "## 契约", note: "契约冻结" }),
    "docs/A.md ## 契约（契约冻结）",
  );
  // 无 anchor 时模板仍留一个分隔空格(公式未对此特判,行为按公式字面为准)
  assert.equal(
    formatDocRef({ file: "docs/A.md", note: "无锚点场景" }),
    "docs/A.md （无锚点场景）",
  );
});

test("gatedKey: 命中基线哈希拼接键,缺失/无基线回退 unbaselined(v0.5.0)", () => {
  assert.equal(gatedKey("src/a.ts", { "src/a.ts": "abc123" }), "src/a.ts@abc123");
  assert.equal(gatedKey("src/a.ts", { "src/b.ts": "xyz" }), "src/a.ts@unbaselined");
  assert.equal(gatedKey("src/a.ts", {}), "src/a.ts@unbaselined");
  assert.equal(gatedKey("src/a.ts", undefined), "src/a.ts@unbaselined");
});

test("loadSharedGated: 往返、缺失/损坏/非对象(null/数组)→ {}(v0.5.0)", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "dc-"));
  assert.deepEqual(loadSharedGated(d), {}, "文件不存在 → {}");
  fs.mkdirSync(path.join(d, ".claude", ".cache"), { recursive: true });
  fs.writeFileSync(sharedGatedPath(d), JSON.stringify({ "src/a.ts@abc": true }));
  assert.deepEqual(loadSharedGated(d), { "src/a.ts@abc": true });
  fs.writeFileSync(sharedGatedPath(d), "{broken");
  assert.deepEqual(loadSharedGated(d), {}, "损坏 JSON → {}");
  fs.writeFileSync(sharedGatedPath(d), "[1,2,3]");
  assert.deepEqual(loadSharedGated(d), {}, "数组 → {}");
  fs.writeFileSync(sharedGatedPath(d), "null");
  assert.deepEqual(loadSharedGated(d), {}, "null → {}");
});

test("findDoccRoot: 非 git 树不采信任何祖先 .docc(仅认 startDir 自身)(v0.4.1 加固 B)", () => {
  const outer = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dc-nogit-outer-")));
  fs.mkdirSync(path.join(outer, ".docc"), { recursive: true });
  fs.writeFileSync(path.join(outer, ".docc", "map.json"), "{}");
  const sub = path.join(outer, "sub"); // 无任何 .git——outer 到 sub 全程不是 git 树
  fs.mkdirSync(sub, { recursive: true });
  const startDir = path.join(sub, "deep");
  fs.mkdirSync(startDir, { recursive: true });
  assert.equal(
    findDoccRoot(startDir),
    startDir,
    "非 git 树不得采信祖先 .docc/map.json——防共享机器上层植入捕获非 git 会话",
  );
});
