import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HOOKS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "hooks");

function runHook(name, payload) {
  return spawnSync("node", [path.join(HOOKS, name)], {
    input: JSON.stringify(payload),
    encoding: "utf-8",
  });
}

const DOC_MAP = {
  version: 1,
  entries: [
    {
      pattern: "src/**",
      docs: [
        { file: "docs/A.md", anchor: "## 契约", note: "契约冻结", critical: true },
        { file: "README.md", anchor: "## 状态" },
      ],
    },
  ],
};

function makeProject(docMapContent = JSON.stringify(DOC_MAP)) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "dc-proj-"));
  fs.mkdirSync(path.join(d, ".docc"), { recursive: true });
  fs.mkdirSync(path.join(d, "docs"), { recursive: true });
  fs.mkdirSync(path.join(d, "src"), { recursive: true });
  if (docMapContent !== null) fs.writeFileSync(path.join(d, ".docc", "map.json"), docMapContent);
  return d;
}

const payloadFor = (cwd, file, sid = "sess1") => ({
  session_id: sid,
  cwd,
  tool_input: { file_path: path.join(cwd, file) },
});

const payloadForNotebook = (cwd, file, sid = "sess1") => ({
  session_id: sid,
  cwd,
  tool_input: { notebook_path: path.join(cwd, file) },
});

test("未接入项目（无 .docc/map.json）：remind/gate 零打扰", () => {
  const d = makeProject(null);
  for (const h of ["doc-map-remind.mjs", "doc-map-gate.mjs"]) {
    const r = runHook(h, payloadFor(d, "src/a.ts"));
    assert.equal(r.status, 0, h);
    assert.equal(r.stdout, "", h);
  }
});

test("remind：首次命中输出 additionalContext 列出锚点，同会话第二次静默", () => {
  const d = makeProject();
  const r1 = runHook("doc-map-remind.mjs", payloadFor(d, "src/a.ts"));
  assert.equal(r1.status, 0);
  const out = JSON.parse(r1.stdout);
  const ctx = out.hookSpecificOutput.additionalContext;
  assert.equal(out.hookSpecificOutput.hookEventName, "PostToolUse");
  assert.match(ctx, /src\/a\.ts/);
  assert.match(ctx, /docs\/A\.md ## 契约/);
  assert.match(ctx, /README\.md ## 状态/);
  const r2 = runHook("doc-map-remind.mjs", payloadFor(d, "src/a.ts"));
  assert.equal(r2.status, 0);
  assert.equal(r2.stdout, "");
});

test("gate：critical 文件首拦 exit 2，原样重试放行，非映射文件不拦", () => {
  const d = makeProject();
  const p = payloadFor(d, "src/a.ts");
  const r1 = runHook("doc-map-gate.mjs", p);
  assert.equal(r1.status, 2);
  assert.match(r1.stderr, /contract gate/);
  assert.match(r1.stderr, /Declare/);
  const r2 = runHook("doc-map-gate.mjs", p);
  assert.equal(r2.status, 0, "同会话同文件重试必须放行（回归钉：连续编辑不自拦）");
  const r3 = runHook("doc-map-gate.mjs", p);
  assert.equal(r3.status, 0, "第三次编辑同样放行");
  const r4 = runHook("doc-map-gate.mjs", payloadFor(d, "other/b.ts"));
  assert.equal(r4.status, 0);
});

test(".docc/map.json 损坏 JSON：两 hook 均 fail-open exit 0", () => {
  const d = makeProject("{broken json");
  for (const h of ["doc-map-remind.mjs", "doc-map-gate.mjs"]) {
    const r = runHook(h, payloadFor(d, "src/a.ts"));
    assert.equal(r.status, 0, h);
  }
});

test("stop-remind：有新增 reminded 时输出 systemMessage，一次后静默（水位去重）", () => {
  const d = makeProject();
  runHook("doc-map-remind.mjs", payloadFor(d, "src/a.ts"));
  runHook("doc-map-remind.mjs", payloadFor(d, "src/b.ts"));
  const stop1 = runHook("doc-map-stop-remind.mjs", { session_id: "sess1", cwd: d });
  assert.equal(stop1.status, 0);
  const msg = JSON.parse(stop1.stdout).systemMessage;
  assert.match(msg, /postflight/);
  assert.match(msg, /src\/a\.ts/);
  const stop2 = runHook("doc-map-stop-remind.mjs", { session_id: "sess1", cwd: d });
  assert.equal(stop2.status, 0);
  assert.equal(stop2.stdout, "", "无新增时静默");
  runHook("doc-map-remind.mjs", payloadFor(d, "src/c.ts"));
  const stop3 = runHook("doc-map-stop-remind.mjs", { session_id: "sess1", cwd: d });
  assert.notEqual(stop3.stdout, "", "新增文件后再次提醒");
});

test("gate/remind: .claude/ 下文件默认排除,不拦不提醒", () => {
  const d = makeProject(
    JSON.stringify({
      version: 1,
      entries: [{ pattern: "**", docs: [{ file: "docs/A.md", anchor: "## 契约", critical: true }] }],
    }),
  );
  for (const h of ["doc-map-gate.mjs", "doc-map-remind.mjs"]) {
    const r = runHook(h, payloadFor(d, ".claude/.cache/doc-companion-sess1.declarations.md"));
    assert.equal(r.status, 0, h);
    assert.equal(r.stdout, "", h);
  }
});

test("gate: 拦截时机写声明 stub,重试放行后不再追加", () => {
  const d = makeProject();
  const p = payloadFor(d, "src/a.ts");
  const r1 = runHook("doc-map-gate.mjs", p);
  assert.equal(r1.status, 2);
  assert.match(r1.stderr, /declarations\.md/, "stderr 须给出草稿文件路径");
  const draft = path.join(d, ".claude", ".cache", "doc-companion-sess1.declarations.md");
  const t1 = fs.readFileSync(draft, "utf-8");
  assert.match(t1, /## src\/a\.ts — /);
  assert.match(t1, /docs\/A\.md ## 契约/);
  assert.match(t1, /<!-- pending -->/);
  assert.match(t1, /\[id: sess1#1\]/);
  runHook("doc-map-gate.mjs", p); // 重试放行
  assert.equal(fs.readFileSync(draft, "utf-8"), t1, "放行路径不追加 stub");
});

test("内置自守护: .docc 三数据文件首拦 exit 2、重试放行;LEDGER 不拦;remind 不提醒(v0.3.0)", () => {
  const d = makeProject();
  for (const f of [".docc/map.json", ".docc/hashes.json", ".docc/history.jsonl"]) {
    const p = payloadFor(d, f, `sess-${f.replaceAll("/", "_")}`);
    const r1 = runHook("doc-map-gate.mjs", p);
    assert.equal(r1.status, 2, f);
    assert.match(r1.stderr, /\.docc data file/);
    assert.equal(runHook("doc-map-gate.mjs", p).status, 0, `${f} 重试放行`);
  }
  assert.equal(runHook("doc-map-gate.mjs", payloadFor(d, ".docc/LEDGER/2026-07-11-x.md")).status, 0, "台账不拦");
  const rm = runHook("doc-map-remind.mjs", payloadFor(d, ".docc/map.json"));
  assert.equal(rm.stdout, "", "remind 对 .docc/ 维持排除");
});

test("map.json version≠1:gate/remind 静默零打扰(v0.4.0)", () => {
  const d = makeProject(JSON.stringify({ version: 2, entries: DOC_MAP.entries }));
  for (const h of ["doc-map-gate.mjs", "doc-map-remind.mjs"]) {
    const r = runHook(h, payloadFor(d, "src/a.ts"));
    assert.equal(r.status, 0, h);
    assert.equal(r.stdout, "", h);
  }
});

test("NotebookEdit：critical 锚点 .ipynb 首拦 exit 2，原样重试放行", () => {
  const d = makeProject(
    JSON.stringify({
      version: 1,
      entries: [
        {
          pattern: "notebooks/**",
          docs: [
            { file: "docs/A.md", anchor: "## 契约", note: "契约冻结", critical: true },
          ],
        },
      ],
    }),
  );
  fs.mkdirSync(path.join(d, "notebooks"), { recursive: true });
  const p = payloadForNotebook(d, "notebooks/analysis.ipynb");
  const r1 = runHook("doc-map-gate.mjs", p);
  assert.equal(r1.status, 2, "NotebookEdit 首次应拦截");
  assert.match(r1.stderr, /contract gate/, "stderr 应包含契约门提醒");
  const r2 = runHook("doc-map-gate.mjs", p);
  assert.equal(r2.status, 0, "NotebookEdit 原样重试应放行");
});

test("子目录会话:项目根有 .docc/map.json,payload.cwd 指向子目录,file_path 指向根下 critical 文件 → gate 向上定位并拦截(v0.4.1)", () => {
  const d = makeProject();
  fs.mkdirSync(path.join(d, ".git"), { recursive: true }); // 真实场景:仓库根须有 .git,非 git 树不采信祖先 .docc
  const subdir = path.join(d, "sub", "deep");
  fs.mkdirSync(subdir, { recursive: true });
  const p = {
    session_id: "sess1",
    cwd: subdir,
    tool_input: { file_path: path.join(d, "src", "a.ts") },
  };
  const r1 = runHook("doc-map-gate.mjs", p);
  assert.equal(r1.status, 2, "cwd 是子目录,应向上定位到根 .docc/map.json 并拦截");
  assert.match(r1.stderr, /contract gate/);
  const r2 = runHook("doc-map-gate.mjs", p);
  assert.equal(r2.status, 0, "原样重试放行");
});

test("子目录会话:cwd 及所有祖先均无 .docc/ → gate/remind 仍是零打扰(v0.4.1)", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "dc-nodocc-"));
  const subdir = path.join(d, "sub", "deep");
  fs.mkdirSync(subdir, { recursive: true });
  fs.writeFileSync(path.join(subdir, "a.ts"), "export const a = 1;\n");
  const p = {
    session_id: "sess1",
    cwd: subdir,
    tool_input: { file_path: path.join(subdir, "a.ts") },
  };
  for (const h of ["doc-map-remind.mjs", "doc-map-gate.mjs"]) {
    const r = runHook(h, p);
    assert.equal(r.status, 0, h);
    assert.equal(r.stdout, "", h);
  }
});

test("子目录会话:发现根切换后,file_path 指向发现根之外的绝对路径 → 越界不拦(v0.4.1 加固 B 回归)", () => {
  const d = makeProject();
  const subdir = path.join(d, "sub", "deep");
  fs.mkdirSync(subdir, { recursive: true });
  const outsideFile = fs.mkdtempSync(path.join(os.tmpdir(), "dc-outside-"));
  const p = {
    session_id: "sess1",
    cwd: subdir,
    tool_input: { file_path: path.join(outsideFile, "other.ts") },
  };
  for (const h of ["doc-map-gate.mjs", "doc-map-remind.mjs"]) {
    const r = runHook(h, p);
    assert.equal(r.status, 0, h);
    assert.equal(r.stdout, "", h);
  }
});

test("NotebookEdit：remind 命中映射输出 additionalContext", () => {
  const d = makeProject(
    JSON.stringify({
      version: 1,
      entries: [
        {
          pattern: "notebooks/**",
          docs: [
            { file: "docs/A.md", anchor: "## 分析流程" },
            { file: "README.md", anchor: "## 笔记本" },
          ],
        },
      ],
    }),
  );
  fs.mkdirSync(path.join(d, "notebooks"), { recursive: true });
  const p = payloadForNotebook(d, "notebooks/analysis.ipynb");
  const r = runHook("doc-map-remind.mjs", p);
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  const ctx = out.hookSpecificOutput.additionalContext;
  assert.match(ctx, /notebooks\/analysis\.ipynb/);
  assert.match(ctx, /docs\/A\.md ## 分析流程/);
  assert.match(ctx, /README\.md ## 笔记本/);
});

test("gate: 会话状态不可写(.claude/.cache 被普通文件占用)→ critical 文件降级放行,exit 0 且 stderr 含降级告警(v0.5.0)", () => {
  const d = makeProject();
  fs.mkdirSync(path.join(d, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(d, ".claude", ".cache"), ""); // 占位为普通文件,使 mkdirSync(.claude/.cache/*) 失败
  const p = payloadFor(d, "src/a.ts");
  const r = runHook("doc-map-gate.mjs", p);
  assert.equal(r.status, 0, "saveState 失败必须降级放行,绝不重试死锁");
  assert.match(r.stderr, /degrading to allow/, "stderr 须含降级告警,便于排障与证明红线生效");
});

test("gate: 跨会话去重——sid1 拦截后 sid2 同文件首次编辑放行,不重复写声明 stub(v0.5.0)", () => {
  const d = makeProject();
  const p1 = payloadFor(d, "src/a.ts", "sid1");
  const r1 = runHook("doc-map-gate.mjs", p1);
  assert.equal(r1.status, 2, "sid1 首拦");

  const p2 = payloadFor(d, "src/a.ts", "sid2");
  const r2 = runHook("doc-map-gate.mjs", p2);
  assert.equal(r2.status, 0, "sid2 跨会话命中共享去重键,放行");
  const draft2 = path.join(d, ".claude", ".cache", "doc-companion-sid2.declarations.md");
  assert.ok(!fs.existsSync(draft2), "跨会话命中不应重复写声明 stub");

  // 模拟盖章:重写 .docc/hashes.json 中该文件的基线哈希 → 旧共享键不再命中 → 重新设防
  fs.writeFileSync(
    path.join(d, ".docc", "hashes.json"),
    JSON.stringify({ sources: { "src/a.ts": "newhash123" }, docs: {} }),
  );
  const p3 = payloadFor(d, "src/a.ts", "sid3");
  const r3 = runHook("doc-map-gate.mjs", p3);
  assert.equal(r3.status, 2, "基线哈希变更后旧共享键不再命中,须重新拦截");
});

test("gate: 跨会话共享去重文件损坏 → fail-open 方向为重拦(安全)(v0.5.0)", () => {
  const d = makeProject();
  fs.mkdirSync(path.join(d, ".claude", ".cache"), { recursive: true });
  fs.writeFileSync(path.join(d, ".claude", ".cache", "doc-companion-gated.json"), "{broken");
  const p = payloadFor(d, "src/a.ts", "sidX");
  const r = runHook("doc-map-gate.mjs", p);
  assert.equal(r.status, 2, "共享去重文件损坏时应重新拦截,不得误放行");
});

test("gate: .docc 内置数据文件自守护不参与跨会话去重——sid1 拦截后 sid2 编辑同一内置文件仍须拦截(v0.5.0 终审修复)", () => {
  const d = makeProject();
  const p1 = payloadFor(d, ".docc/map.json", "sid1");
  const r1 = runHook("doc-map-gate.mjs", p1);
  assert.equal(r1.status, 2, "sid1 首拦 .docc/map.json");
  assert.match(r1.stderr, /\.docc data file/);

  // .docc/map.json 恒排除于基线追踪之外,去重键永远落 @unbaselined——
  // 若参与跨会话去重,sid1 写入共享去重文件后,sid2(全新会话状态)会误判"已在其他会话陈述过"而放行,
  // 相当于自守护对象一台机器一生只拦一次。修复后应仍对 sid2 拦截。
  const p2 = payloadFor(d, ".docc/map.json", "sid2");
  const r2 = runHook("doc-map-gate.mjs", p2);
  assert.equal(r2.status, 2, "sid2(新会话)编辑同一 .docc 内置文件仍须拦截,自守护不因跨会话去重解除");
});

test("gate: 写共享 gated 时同一 rel 的旧键(不同基线哈希)先被清除,一文件恒一键(v0.6.0)", () => {
  const d = makeProject();
  fs.mkdirSync(path.join(d, ".claude", ".cache"), { recursive: true });
  const gatedPath = path.join(d, ".claude", ".cache", "doc-companion-gated.json");
  fs.writeFileSync(
    gatedPath,
    JSON.stringify({ "src/a.ts@oldhash123": true, "src/other.ts@somehash": true }),
  );
  const p = payloadFor(d, "src/a.ts", "sidRekey");
  const r1 = runHook("doc-map-gate.mjs", p);
  assert.equal(r1.status, 2, "无基线时首拦(键落 @unbaselined)");
  const shared = JSON.parse(fs.readFileSync(gatedPath, "utf-8"));
  assert.ok(!("src/a.ts@oldhash123" in shared), "同 rel 的旧键应被换键清除");
  assert.ok("src/other.ts@somehash" in shared, "不同 rel 的键不受影响");
  const relKeys = Object.keys(shared).filter((k) => k.startsWith("src/a.ts@"));
  assert.equal(relKeys.length, 1, "同一文件在共享去重文件中恒只有一把钥匙");
});

test("gate: 换键清旧精确匹配 rel,不误删文件名形如 src/a.ts@special 的他文件键(v0.6.0 终审修复)", () => {
  const d = makeProject();
  fs.mkdirSync(path.join(d, ".claude", ".cache"), { recursive: true });
  const gatedPath = path.join(d, ".claude", ".cache", "doc-companion-gated.json");
  // "src/a.ts@h1" 是 rel="src/a.ts" 的旧键;"src/a.ts@x@h2" 是 rel="src/a.ts@x"
  // (文件名字面含 "@")的键——旧的 startsWith(`${rel}@`) 实现会把两者都当作
  // "src/a.ts" 的旧键误删,精确匹配实现只应换掉前者。
  fs.writeFileSync(gatedPath, JSON.stringify({ "src/a.ts@h1": true, "src/a.ts@x@h2": true }));
  const p = payloadFor(d, "src/a.ts", "sidExact");
  const r1 = runHook("doc-map-gate.mjs", p);
  assert.equal(r1.status, 2, "无基线时首拦(键落 @unbaselined)");
  const shared = JSON.parse(fs.readFileSync(gatedPath, "utf-8"));
  assert.ok(!("src/a.ts@h1" in shared), "rel 精确等于 src/a.ts 的旧键应被换掉");
  assert.ok("src/a.ts@x@h2" in shared, "rel 实为 src/a.ts@x 的他文件键不应被误删");
});

test("NotebookEdit：非 critical notebook 文件 → remind 提醒,gate 不拦(v0.4.1)", () => {
  const d = makeProject(
    JSON.stringify({
      version: 1,
      entries: [
        {
          pattern: "notebooks/**",
          docs: [
            { file: "docs/A.md", anchor: "## 分析流程" },
          ],
        },
      ],
    }),
  );
  fs.mkdirSync(path.join(d, "notebooks"), { recursive: true });
  const p = payloadForNotebook(d, "notebooks/data.ipynb");
  const r1 = runHook("doc-map-remind.mjs", p);
  assert.equal(r1.status, 0, "remind 应输出,即使非 critical");
  const out = JSON.parse(r1.stdout);
  const ctx = out.hookSpecificOutput.additionalContext;
  assert.match(ctx, /notebooks\/data\.ipynb/, "remind 应提醒该映射文件");
  const r2 = runHook("doc-map-gate.mjs", p);
  assert.equal(r2.status, 0, "gate 非 critical 不拦");
});

test("hooks.json 形状：三条目为 exec form(跨平台),args 引用对应脚本,无 sh 守卫", () => {
  const hooksJson = JSON.parse(
    fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "hooks", "hooks.json"),
      "utf-8",
    ),
  );
  const hooks = hooksJson.hooks;

  // 断言 PreToolUse 条目
  assert.ok(hooks.PreToolUse, "应有 PreToolUse");
  assert.equal(hooks.PreToolUse.length, 1);
  assert.match(hooks.PreToolUse[0].matcher, /NotebookEdit/, "PreToolUse matcher 应包含 NotebookEdit");
  const preToolHook = hooks.PreToolUse[0].hooks[0];
  assert.equal(preToolHook.type, "command");
  assert.equal(preToolHook.command, "node", "PreToolUse 应为 node 命令");
  assert.ok(Array.isArray(preToolHook.args), "args 应为数组");
  assert.ok(preToolHook.args[0].includes("doc-map-gate.mjs"), "args[0] 应包含 doc-map-gate.mjs");
  assert.ok(preToolHook.args[0].includes("${CLAUDE_PLUGIN_ROOT}"), "args[0] 应包含 ${CLAUDE_PLUGIN_ROOT}");
  assert.ok(!preToolHook.args[0].includes("command -v"), "args 不应含 sh 守卫");
  assert.equal(preToolHook.timeout, 15);

  // 断言 PostToolUse 条目
  assert.ok(hooks.PostToolUse, "应有 PostToolUse");
  assert.equal(hooks.PostToolUse.length, 1);
  assert.match(hooks.PostToolUse[0].matcher, /NotebookEdit/, "PostToolUse matcher 应包含 NotebookEdit");
  const postToolHook = hooks.PostToolUse[0].hooks[0];
  assert.equal(postToolHook.type, "command");
  assert.equal(postToolHook.command, "node", "PostToolUse 应为 node 命令");
  assert.ok(Array.isArray(postToolHook.args), "args 应为数组");
  assert.ok(postToolHook.args[0].includes("doc-map-remind.mjs"), "args[0] 应包含 doc-map-remind.mjs");
  assert.ok(postToolHook.args[0].includes("${CLAUDE_PLUGIN_ROOT}"), "args[0] 应包含 ${CLAUDE_PLUGIN_ROOT}");
  assert.ok(!postToolHook.args[0].includes("command -v"), "args 不应含 sh 守卫");
  assert.equal(postToolHook.timeout, 15);

  // 断言 Stop 条目
  assert.ok(hooks.Stop, "应有 Stop");
  assert.equal(hooks.Stop.length, 1);
  assert.equal(hooks.Stop[0].matcher, undefined, "Stop 不应有 matcher");
  const stopHook = hooks.Stop[0].hooks[0];
  assert.equal(stopHook.type, "command");
  assert.equal(stopHook.command, "node", "Stop 应为 node 命令");
  assert.ok(Array.isArray(stopHook.args), "args 应为数组");
  assert.ok(stopHook.args[0].includes("doc-map-stop-remind.mjs"), "args[0] 应包含 doc-map-stop-remind.mjs");
  assert.ok(stopHook.args[0].includes("${CLAUDE_PLUGIN_ROOT}"), "args[0] 应包含 ${CLAUDE_PLUGIN_ROOT}");
  assert.ok(!stopHook.args[0].includes("command -v"), "args 不应含 sh 守卫");
  assert.equal(stopHook.timeout, 15);
});

test("agents/drift-checker.md: 形状断言——frontmatter 完整、tally 契约与 --verdict 口径一致", () => {
  const p = path.join(HOOKS, "..", "agents", "drift-checker.md");
  // CRLF 检出(如 Windows autocrlf)下断言仍须成立:先归一化行尾
  const text = fs.readFileSync(p, "utf-8").replace(/\r\n/g, "\n");
  assert.match(text, /^---\n/, "应有 YAML frontmatter");
  assert.match(text, /\nname: drift-checker\n/, "name 应为 drift-checker");
  assert.match(text, /\ndescription: Semantic drift verifier/, "description 应为英文定义");
  assert.match(text, /\ntools: Read, Grep, Glob, Bash\n/, "工具面应为只读四件套");
  assert.match(
    text,
    /\{"[^"]+": "(?:formatting|docLag|codeViolation|other)"/,
    "tally 模板应为 per-file 形式 (推荐) 或聚合计数形式 (兼容)",
  );
});
