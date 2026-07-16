import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "scripts",
  "doc-preflight.mjs",
);

function run(cwd, ...extra) {
  const r = spawnSync("node", [SCRIPT, "--cwd", cwd, ...extra], { encoding: "utf-8" });
  assert.equal(r.status, 0, `preflight 永远 exit 0，实际: ${r.status} ${r.stderr}`);
  return JSON.parse(r.stdout);
}

function git(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
}

function makeRepo() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "dc-repo-"));
  git(d, "init", "-q");
  fs.mkdirSync(path.join(d, "src"), { recursive: true });
  fs.mkdirSync(path.join(d, "docs"), { recursive: true });
  fs.mkdirSync(path.join(d, ".docc"), { recursive: true });
  fs.writeFileSync(path.join(d, "src", "a.ts"), "export const a = 1;\n");
  fs.writeFileSync(path.join(d, "docs", "A.md"), "# A\n\n## 契约\n内容\n");
  fs.writeFileSync(
    path.join(d, ".docc", "map.json"),
    JSON.stringify({
      version: 1,
      entries: [{ pattern: "src/**", docs: [{ file: "docs/A.md", anchor: "## 契约", critical: true }] }],
    }),
  );
  return d;
}

test("首跑无基线：源文件全部为漂移候选(kind:new,docs 关联critical);盖章后归零", () => {
  const d = makeRepo();
  const r1 = run(d);
  assert.deepEqual(r1.driftCandidates, [
    { file: "src/a.ts", kind: "new", docs: [{ file: "docs/A.md", anchor: "## 契约", critical: true }] },
  ]);
  assert.equal(r1.ok, true);
  const r2 = run(d, "--stamp");
  assert.equal(r2.stamped, true);
  const r3 = run(d);
  assert.deepEqual(r3.driftCandidates, []);
  assert.deepEqual(r3.docDrift, []);
});

test("改源文件 → driftCandidates(kind:modified)；改文档 → docDrift（人为篡改暴露）", () => {
  const d = makeRepo();
  run(d, "--stamp");
  fs.appendFileSync(path.join(d, "src", "a.ts"), "export const b = 2;\n");
  const r1 = run(d);
  assert.deepEqual(r1.driftCandidates, [
    { file: "src/a.ts", kind: "modified", docs: [{ file: "docs/A.md", anchor: "## 契约", critical: true }] },
  ]);
  assert.deepEqual(r1.docDrift, []);
  run(d, "--stamp", "--force");
  fs.appendFileSync(path.join(d, "docs", "A.md"), "被人直接改了一行\n");
  const r2 = run(d);
  assert.deepEqual(r2.docDrift, ["docs/A.md"]);
});

test("driftCandidates.docs:note 透出、critical 仅 true 输出、多 entry 命中同文件去重合并(v0.5.0)", () => {
  const d = makeRepo();
  fs.writeFileSync(path.join(d, "README.md"), "# readme\n");
  fs.writeFileSync(
    path.join(d, ".docc", "map.json"),
    JSON.stringify({
      version: 1,
      entries: [
        { pattern: "src/**", docs: [{ file: "docs/A.md", anchor: "## 契约", critical: true, note: "API 契约" }] },
        {
          pattern: "src/*.ts",
          docs: [
            { file: "docs/A.md", anchor: "## 契约", critical: true, note: "API 契约" },
            { file: "README.md" },
          ],
        },
      ],
    }),
  );
  const r = run(d);
  const cand = r.driftCandidates.find((c) => c.file === "src/a.ts");
  assert.ok(cand, JSON.stringify(r.driftCandidates));
  assert.equal(cand.kind, "new");
  assert.deepEqual(
    cand.docs,
    [
      { file: "docs/A.md", anchor: "## 契约", critical: true, note: "API 契约" },
      { file: "README.md" },
    ],
    JSON.stringify(cand.docs),
  );
});

test("docs 合并:同一 file+anchor 先无 critical 后有 → critical 取 OR,不因 first-wins 整体丢弃(v0.5.0 终审修复)", () => {
  const d = makeRepo();
  fs.writeFileSync(
    path.join(d, ".docc", "map.json"),
    JSON.stringify({
      version: 1,
      entries: [
        { pattern: "src/**", docs: [{ file: "docs/A.md", anchor: "## 契约" }] },
        {
          pattern: "src/*.ts",
          docs: [{ file: "docs/A.md", anchor: "## 契约", critical: true, note: "后到的 note" }],
        },
      ],
    }),
  );
  const r = run(d);
  const cand = r.driftCandidates.find((c) => c.file === "src/a.ts");
  assert.ok(cand, JSON.stringify(r.driftCandidates));
  assert.deepEqual(
    cand.docs,
    [{ file: "docs/A.md", anchor: "## 契约", critical: true, note: "后到的 note" }],
    JSON.stringify(cand.docs),
  );
});

test(".docc/map.json 自检：无匹配 pattern 与悬空锚点进 mapIssues 且 ok=false", () => {
  const d = makeRepo();
  fs.writeFileSync(
    path.join(d, ".docc", "map.json"),
    JSON.stringify({
      version: 1,
      entries: [
        { pattern: "nope/**", docs: [{ file: "docs/A.md", anchor: "## 不存在的锚点" }] },
        { pattern: "src/**", docs: [{ file: "docs/MISSING.md", anchor: "## x" }] },
      ],
    }),
  );
  const r = run(d);
  assert.equal(r.ok, false);
  assert.equal(r.mapIssues.length, 3, JSON.stringify(r.mapIssues));
  assert.ok(r.mapIssues.some((m) => m.message.includes("nope/**")));
  assert.ok(r.mapIssues.some((m) => m.message.includes("不存在的锚点")));
  assert.ok(r.mapIssues.some((m) => m.message.includes("MISSING.md")));
});

test("非 git 目录 / 缺 .docc/map.json：ok=false + error，exit 0（fail-open）", () => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "dc-plain-"));
  const r1 = run(plain);
  assert.equal(r1.ok, false);
  assert.ok(r1.error.includes(".docc/map.json"));
  assert.ok(r1.error.includes("/docc:init"));
  fs.mkdirSync(path.join(plain, ".docc"), { recursive: true });
  fs.writeFileSync(
    path.join(plain, ".docc", "map.json"),
    JSON.stringify({ version: 1, entries: [] }),
  );
  const r2 = run(plain);
  assert.equal(r2.ok, false);
  assert.ok(r2.error.includes("git"));
});

test("锚点歧义:边界命中 ≥2 次进 mapIssues;重复条目引用同一文档/锚点只报一次", () => {
  const d = makeRepo();
  fs.writeFileSync(path.join(d, "docs", "A.md"), "# A\n\n## 契约\n内容\n## 契约 副本\n");
  const r1 = run(d);
  assert.equal(r1.ok, false);
  assert.equal(
    r1.mapIssues.filter((m) => m.message.includes("Anchor ambiguous")).length,
    1,
    JSON.stringify(r1.mapIssues),
  );

  fs.writeFileSync(
    path.join(d, ".docc", "map.json"),
    JSON.stringify({
      version: 1,
      entries: [
        { pattern: "src/**", docs: [{ file: "docs/A.md", anchor: "## 不存在" }] },
        { pattern: "src/*.ts", docs: [{ file: "docs/A.md", anchor: "## 不存在" }] },
        { pattern: "src/**", docs: [{ file: "docs/MISSING.md", anchor: "## x" }] },
        { pattern: "src/*.ts", docs: [{ file: "docs/MISSING.md", anchor: "## x" }] },
      ],
    }),
  );
  const r2 = run(d);
  assert.equal(
    r2.mapIssues.filter((m) => m.message.includes("Anchor not found")).length,
    1,
    JSON.stringify(r2.mapIssues),
  );
  assert.equal(
    r2.mapIssues.filter((m) => m.message.includes("Doc does not exist")).length,
    1,
    JSON.stringify(r2.mapIssues),
  );
});

test("排除:默认排除目录与 config.exclude 前缀内文件不进 driftCandidates", () => {
  const d = makeRepo();
  fs.mkdirSync(path.join(d, ".understand-anything"), { recursive: true });
  fs.writeFileSync(path.join(d, ".understand-anything", "g.json"), "{}");
  fs.mkdirSync(path.join(d, "gen"), { recursive: true });
  fs.writeFileSync(path.join(d, "gen", "out.ts"), "generated\n");
  fs.writeFileSync(
    path.join(d, ".docc", "map.json"),
    JSON.stringify({
      version: 1,
      config: { exclude: ["gen/"] },
      entries: [{ pattern: "**", docs: [{ file: "docs/A.md", anchor: "## 契约" }] }],
    }),
  );
  const r = run(d);
  const files = r.driftCandidates.map((c) => c.file);
  assert.ok(!files.includes(".understand-anything/g.json"), JSON.stringify(r.driftCandidates));
  assert.ok(!files.includes("gen/out.ts"));
  assert.ok(files.includes("src/a.ts"));
});

test("自引用恒排除: hashes/history 文件即使被 pattern 覆盖也不进 driftCandidates", () => {
  const d = makeRepo();
  fs.writeFileSync(
    path.join(d, ".docc", "map.json"),
    JSON.stringify({
      version: 1,
      entries: [{ pattern: "**", docs: [{ file: "docs/A.md", anchor: "## 契约" }] }],
    }),
  );
  run(d, "--stamp"); // 盖章会重写 hashes(Task 7 后还会追加 history)
  const r = run(d);
  const files = r.driftCandidates.map((c) => c.file);
  assert.ok(
    !files.includes(".docc/hashes.json"),
    `盖章重写导致的永久自漂移必须被排除: ${JSON.stringify(r.driftCandidates)}`,
  );
  assert.ok(!files.includes(".docc/history.jsonl"));
});

test("verified-by 软校验:本轮新增台账缺标记 → warnings 且不影响 ok;带标记不告警", () => {
  const d = makeRepo();
  fs.mkdirSync(path.join(d, ".docc", "LEDGER"), { recursive: true });
  fs.writeFileSync(
    path.join(d, ".docc", "LEDGER", "2026-07-11-x.md"),
    "# 台账\n\n## 受影响调用方/依赖方\n无\n",
  );
  fs.writeFileSync(path.join(d, ".docc", "LEDGER", "INDEX.md"), "2026-07-11-x.md\n");
  const r0 = run(d);
  assert.deepEqual(r0.warnings, [], "非 --stamp 不做台账校验");
  const r1 = run(d, "--stamp", "--verdict", '{"other":1}');
  assert.deepEqual(r1.warnings, [
    { code: "ledger-verified-by-missing", message: "Ledger missing verified-by marker: .docc/LEDGER/2026-07-11-x.md" },
  ]);
  assert.equal(r1.ok, true, "warnings 不影响 ok");
  assert.equal(r1.stamped, true, "warnings 不阻塞盖章");
  fs.appendFileSync(
    path.join(d, ".docc", "LEDGER", "2026-07-11-x.md"),
    "\n<!-- verified-by: codegraph_impact -->\n",
  );
  const r2 = run(d, "--stamp", "--verdict", "{}");
  assert.deepEqual(r2.warnings, []);
});

test("漂移历史埋点:--stamp 默认追加一行;config.history:false 关闭", () => {
  const d = makeRepo();
  run(d, "--stamp");
  run(d, "--stamp");
  const lines = fs
    .readFileSync(path.join(d, ".docc", "history.jsonl"), "utf-8")
    .trim()
    .split("\n");
  assert.equal(lines.length, 2);
  const rec = JSON.parse(lines[0]);
  assert.ok(typeof rec.ts === "string" && rec.ts.includes("T"), "ISO8601 时间戳");
  assert.equal(rec.stamped, true);
  for (const k of ["driftCandidates", "docDrift", "mapIssues", "warnings"]) {
    assert.equal(typeof rec[k], "number", k);
  }

  const d2 = makeRepo();
  const map = JSON.parse(fs.readFileSync(path.join(d2, ".docc", "map.json"), "utf-8"));
  map.config = { history: false };
  fs.writeFileSync(path.join(d2, ".docc", "map.json"), JSON.stringify(map));
  run(d2, "--stamp");
  assert.ok(!fs.existsSync(path.join(d2, ".docc", "history.jsonl")));
});

test(".docc/ 内文件禁止登记为文档锚点(v0.3.0)", () => {
  const d = makeRepo();
  fs.writeFileSync(
    path.join(d, ".docc", "map.json"),
    JSON.stringify({
      version: 1,
      entries: [
        { pattern: "src/**", docs: [{ file: "docs/A.md", anchor: "## 契约" }, { file: ".docc/hashes.json" }] },
      ],
    }),
  );
  run(d, "--stamp", "--force"); // docc-dir-doc mapIssue 会挡盖章,force 建立基线使 docDrift 断言有效
  const r = run(d);
  assert.ok(
    r.mapIssues.some((m) => m.message.includes("cannot be registered as doc anchors")),
    JSON.stringify(r.mapIssues),
  );
  assert.deepEqual(r.docDrift, []);
});

test("pattern 仅命中 .docc/ 内文件 → 软告警而非 mapIssues(v0.3.0)", () => {
  const d = makeRepo();
  fs.writeFileSync(
    path.join(d, ".docc", "map.json"),
    JSON.stringify({
      version: 1,
      entries: [
        { pattern: "src/**", docs: [{ file: "docs/A.md", anchor: "## 契约" }] },
        { pattern: ".docc/hashes.json", docs: [{ file: "docs/A.md", anchor: "## 契约" }] },
      ],
    }),
  );
  run(d, "--stamp", "--force"); // 首跑生成 hashes 文件；pattern-no-match mapIssue 存在,本任务后会挡盖章,此处 --force 放行
  const r = run(d);
  assert.equal(r.ok, true, JSON.stringify(r.mapIssues));
  assert.ok(r.warnings.some((m) => m.message.includes("matches only excluded files")), JSON.stringify(r.warnings));
});

test("非 ASCII 台账文件名: verified-by 校验不被 core.quotepath 引号击穿", () => {
  const d = makeRepo();
  fs.mkdirSync(path.join(d, ".docc", "LEDGER"), { recursive: true });
  fs.writeFileSync(path.join(d, ".docc", "LEDGER", "2026-07-11-修复锚点.md"), "# 台账\n无标记\n");
  const r = run(d, "--stamp");
  assert.ok(
    r.warnings.some((m) => m.message.includes("2026-07-11-修复锚点.md")),
    JSON.stringify(r.warnings),
  );
});

test("删除盲区:基线有记录但文件已删 → 进入 driftCandidates(kind:removed,docs 关联)(v0.2.1)", () => {
  const d = makeRepo();
  run(d, "--stamp");
  fs.rmSync(path.join(d, "src", "a.ts"));
  const r = run(d);
  const cand = r.driftCandidates.find((c) => c.file === "src/a.ts");
  assert.ok(cand, JSON.stringify(r.driftCandidates));
  assert.equal(cand.kind, "removed");
  assert.deepEqual(cand.docs, [{ file: "docs/A.md", anchor: "## 契约", critical: true }]);
});

test("不可哈希文件(悬空 symlink)→ warnings 告警而非静默跳过(v0.2.1)", () => {
  const d = makeRepo();
  fs.symlinkSync("no-such-target", path.join(d, "src", "broken.ts"));
  const r = run(d);
  assert.ok(
    r.warnings.some((m) => m.message.includes("Cannot hash") && m.message.includes("src/broken.ts")),
    JSON.stringify(r.warnings),
  );
  assert.ok(!r.driftCandidates.some((c) => c.file === "src/broken.ts"));
});

test("哈希基线文件损坏 → mapIssues 明确告警,不再与无基线同化(v0.2.1)", () => {
  const d = makeRepo();
  run(d, "--stamp");
  fs.writeFileSync(path.join(d, ".docc", "hashes.json"), "{broken");
  const r = run(d);
  assert.equal(r.ok, false);
  assert.ok(r.mapIssues.some((m) => m.message.includes("baseline") && m.message.includes("corrupt")), JSON.stringify(r.mapIssues));
});

test("docs[].file 越出仓库 → mapIssues 拒绝,不读仓库外文件(v0.2.1)", () => {
  const d = makeRepo();
  fs.writeFileSync(
    path.join(d, ".docc", "map.json"),
    JSON.stringify({
      version: 1,
      entries: [
        { pattern: "src/**", docs: [{ file: "../outside.md", anchor: "## x" }] },
      ],
    }),
  );
  const r = run(d);
  assert.ok(r.mapIssues.some((m) => m.message.includes("escapes the repository")), JSON.stringify(r.mapIssues));
  assert.ok(!r.mapIssues.some((m) => m.message.includes("Doc does not exist")), "越界路径不应再走存在性检查");
});

test("core.autocrlf 配置变化不产生幻影漂移(--no-filters)(v0.2.1)", () => {
  const d = makeRepo();
  git(d, "config", "core.autocrlf", "input");
  fs.writeFileSync(path.join(d, "src", "crlf.ts"), "line1\r\nline2\r\n");
  run(d, "--stamp");
  git(d, "config", "core.autocrlf", "false");
  const r = run(d);
  assert.ok(!r.driftCandidates.some((c) => c.file === "src/crlf.ts"), JSON.stringify(r.driftCandidates));
});

test("非 ASCII 源文件名:枚举不被 core.quotepath 引号击穿(v0.2.1)", () => {
  const d = makeRepo();
  fs.writeFileSync(path.join(d, "src", "中文模块.ts"), "export const z = 1;\n");
  const r = run(d);
  assert.ok(r.driftCandidates.some((c) => c.file === "src/中文模块.ts"), JSON.stringify(r.driftCandidates));
});

test("docs[].file 前导 / 视为仓库根相对路径,不误判越界(v0.2.1 复审修复)", () => {
  const d = makeRepo();
  fs.writeFileSync(
    path.join(d, ".docc", "map.json"),
    JSON.stringify({
      version: 1,
      entries: [{ pattern: "src/**", docs: [{ file: "/docs/A.md", anchor: "## 契约" }] }],
    }),
  );
  const r1 = run(d, "--stamp");
  assert.ok(!r1.mapIssues.some((m) => m.message.includes("escapes the repository")), JSON.stringify(r1.mapIssues));
  fs.appendFileSync(path.join(d, "docs", "A.md"), "被直接改了\n");
  const r2 = run(d);
  assert.deepEqual(r2.docDrift, ["docs/A.md"], JSON.stringify(r2));
});

test("模式级排除: **/*_pb.go 不进 driftCandidates(v0.3.0)", () => {
  const d = makeRepo();
  fs.writeFileSync(path.join(d, "src", "svc_pb.go"), "generated\n");
  const map = JSON.parse(fs.readFileSync(path.join(d, ".docc", "map.json"), "utf-8"));
  map.config = { exclude: ["**/*_pb.go"] };
  fs.writeFileSync(path.join(d, ".docc", "map.json"), JSON.stringify(map));
  const r = run(d);
  const files = r.driftCandidates.map((c) => c.file);
  assert.ok(!files.includes("src/svc_pb.go"), JSON.stringify(r.driftCandidates));
  assert.ok(files.includes("src/a.ts"));
});

test("盖章门: 真漂移拒绝盖章,证词相符放行,--force 放行,首次纳管不拦(v0.4.0)", () => {
  const d = makeRepo();
  const r0 = run(d, "--stamp");
  assert.equal(r0.stamped, true, "首次纳管全量,天然放行");
  fs.appendFileSync(path.join(d, "src", "a.ts"), "export const b = 2;\n");
  const r1 = run(d, "--stamp");
  assert.equal(r1.stamped, false);
  assert.ok(r1.stampBlocked && r1.stampBlocked.message.includes("Stamp rejected"), JSON.stringify(r1.stampBlocked));
  assert.equal(r1.ok, true, "拒绝不再翻转 ok");
  const r1b = run(d, "--stamp", "--verdict", '{"docLag":1}');
  assert.equal(r1b.stamped, true, "证词相符放行");
  fs.appendFileSync(path.join(d, "src", "a.ts"), "export const c = 3;\n");
  const r2 = run(d, "--stamp", "--force");
  assert.equal(r2.stamped, true);
  const r3 = run(d);
  assert.deepEqual(r3.driftCandidates, [], "force 盖章后基线已更新");
});

test("盖章门: docDrift 与删除同样拒绝(v0.3.0)", () => {
  const d = makeRepo();
  run(d, "--stamp");
  fs.appendFileSync(path.join(d, "docs", "A.md"), "被直接改了\n");
  const r1 = run(d, "--stamp");
  assert.equal(r1.stamped, false, "无 verdict 时拒绝");
  run(d, "--stamp", "--force");
  fs.rmSync(path.join(d, "src", "a.ts"));
  const r2 = run(d, "--stamp");
  assert.equal(r2.stamped, false, "删除属真漂移且无 verdict,拒绝");
});

test("--verdict 写入 history(仅收已知键非负数字);缺失时软告警且 verdict:null(v0.3.0)", () => {
  const d = makeRepo();
  const r1 = run(d, "--stamp", "--verdict", '{"formatting":1,"docLag":2,"bogus":9,"other":-1}');
  assert.equal(r1.stamped, true);
  // v0.5.0:未知键"bogus"现在产生 verdict-unknown-key 警告(新功能)
  assert.ok(r1.warnings.some((w) => w.code === "verdict-unknown-key"), JSON.stringify(r1.warnings));
  assert.ok(!r1.warnings.some((m) => m.code === "verdict-missing"), "有有效键时不告 verdict-missing");
  const rec1 = JSON.parse(
    fs.readFileSync(path.join(d, ".docc", "history.jsonl"), "utf-8").trim().split("\n")[0],
  );
  assert.deepEqual(rec1.verdict, { formatting: 1, docLag: 2 });
  assert.equal(rec1.forced, false);

  const d2 = makeRepo();
  const r2 = run(d2, "--stamp");
  assert.ok(r2.warnings.some((m) => m.message.includes("--verdict")), JSON.stringify(r2.warnings));
  const rec2 = JSON.parse(fs.readFileSync(path.join(d2, ".docc", "history.jsonl"), "utf-8").trim());
  assert.equal(rec2.verdict, null);
});

test("--verdict '{}' 不触发 verdict-missing 类告警(init 场景候选数不符仍可能报 verdict-count-mismatch,与\"--verdict\"字面缺失告警不同);--force 记入 forced(v0.3.0)", () => {
  const d = makeRepo();
  const r = run(d, "--stamp", "--verdict", "{}");
  assert.ok(!r.warnings.some((m) => m.message.includes("--verdict")));
  fs.appendFileSync(path.join(d, "src", "a.ts"), "x\n");
  run(d, "--stamp", "--force", "--verdict", '{"formatting":1}');
  const lines = fs.readFileSync(path.join(d, ".docc", "history.jsonl"), "utf-8").trim().split("\n");
  const last = JSON.parse(lines[lines.length - 1]);
  assert.equal(last.forced, true);
  assert.equal(last.stamped, true);
});

test("有基线记录的文件转为不可哈希 → 计入真漂移并拒绝盖章(补测)", () => {
  const d = makeRepo();
  run(d, "--stamp", "--verdict", "{}");
  fs.rmSync(path.join(d, "src", "a.ts"));
  fs.symlinkSync("no-such-target", path.join(d, "src", "a.ts"));
  const r = run(d, "--stamp");
  assert.equal(r.stamped, false, "不可哈希+有基线记录=真漂移,应拒绝盖章");
  assert.ok(r.warnings.some((m) => m.message.includes("Cannot hash")), JSON.stringify(r.warnings));
});

test("盖章 GC:共享 gated 去重文件——stamp 成功后删除哈希不符/rel 已不在新基线的死键,仅当前有效键存活(v0.6.0)", () => {
  const d = makeRepo();
  run(d, "--stamp");
  const recorded = JSON.parse(fs.readFileSync(path.join(d, ".docc", "hashes.json"), "utf-8"));
  const h = recorded.sources["src/a.ts"];
  fs.mkdirSync(path.join(d, ".claude", ".cache"), { recursive: true });
  const gatedPath = path.join(d, ".claude", ".cache", "doc-companion-gated.json");
  fs.writeFileSync(
    gatedPath,
    JSON.stringify({
      [`src/a.ts@${h}`]: true, // 与即将写入的新基线一致,应存活
      "src/a.ts@stale-hash-0000": true, // 同 rel 但哈希已不符,应清除
      "src/removed.ts@somehash": true, // rel 已不在新基线,应清除
    }),
  );
  const r = run(d, "--stamp"); // 内容未变,无真实漂移,天然放行
  assert.equal(r.stamped, true, JSON.stringify(r));
  const shared = JSON.parse(fs.readFileSync(gatedPath, "utf-8"));
  assert.deepEqual(Object.keys(shared), [`src/a.ts@${h}`], JSON.stringify(shared));
});

test("盖章 GC:盖章被拒绝(stamped:false)时不触碰共享 gated 去重文件(v0.6.0)", () => {
  const d = makeRepo();
  run(d, "--stamp");
  fs.mkdirSync(path.join(d, ".claude", ".cache"), { recursive: true });
  const gatedPath = path.join(d, ".claude", ".cache", "doc-companion-gated.json");
  const before = { "src/a.ts@stale-hash-0000": true };
  fs.writeFileSync(gatedPath, JSON.stringify(before));
  fs.appendFileSync(path.join(d, "src", "a.ts"), "x\n"); // 制造真实漂移且不给证词 → 盖章拒绝
  const r = run(d, "--stamp");
  assert.equal(r.stamped, false, JSON.stringify(r));
  assert.deepEqual(JSON.parse(fs.readFileSync(gatedPath, "utf-8")), before, "拒绝盖章不应 GC 共享去重文件");
});

test("拒绝盖章的 history 行 verdict 为 null,防统计双计(v0.3.1)", () => {
  const d = makeRepo();
  run(d, "--stamp", "--verdict", "{}");
  fs.appendFileSync(path.join(d, "src", "a.ts"), "x\n");
  run(d, "--stamp"); // 无证词,被盖章门拒绝
  run(d, "--stamp", "--force", "--verdict", '{"docLag":1}'); // 放行
  const lines = fs.readFileSync(path.join(d, ".docc", "history.jsonl"), "utf-8").trim().split("\n");
  assert.equal(lines.length, 3);
  const rejected = JSON.parse(lines[1]);
  const forced = JSON.parse(lines[2]);
  assert.equal(rejected.stamped, false);
  assert.equal(rejected.verdict, null, "拒绝行不携带 verdict");
  assert.deepEqual(forced.verdict, { docLag: 1 });
});

test("stampBlocked 独立字段:拒绝不翻转 ok、不污染 mapIssues/history 计数(v0.4.0)", () => {
  const d = makeRepo();
  run(d, "--stamp", "--verdict", "{}");
  fs.appendFileSync(path.join(d, "src", "a.ts"), "x\n");
  const r = run(d, "--stamp"); // 无证词,才会被拒
  assert.equal(r.stamped, false);
  assert.equal(r.ok, true);
  assert.deepEqual(r.mapIssues, []);
  assert.equal(r.stampBlocked.realDriftCount, 1);
  assert.equal(r.stampBlocked.docDriftCount, 0);
  assert.equal(r.stampBlocked.mapDefects, 0);
  assert.ok(r.stampBlocked.message.includes("--force"));
  const lines = fs.readFileSync(path.join(d, ".docc", "history.jsonl"), "utf-8").trim().split("\n");
  assert.equal(JSON.parse(lines[1]).mapIssues, 0, "拒绝不计入 history mapIssues 计数");
  const rNorm = run(d);
  assert.equal(rNorm.stampBlocked, null, "非 stamp 恒为 null");
});

test("typed 码表:常见 mapIssues/warnings 携带正确 code(v0.4.0)", () => {
  const d = makeRepo();
  fs.writeFileSync(
    path.join(d, ".docc", "map.json"),
    JSON.stringify({
      version: 1,
      entries: [
        { pattern: "nope/**", docs: [{ file: "docs/A.md", anchor: "## 不存在的锚点" }] },
        { pattern: "src/**", docs: [{ file: "docs/MISSING.md", anchor: "## x" }] },
      ],
    }),
  );
  const r = run(d);
  assert.ok(r.mapIssues.some((m) => m.code === "pattern-no-match"), JSON.stringify(r.mapIssues));
  assert.ok(r.mapIssues.some((m) => m.code === "anchor-missing"));
  assert.ok(r.mapIssues.some((m) => m.code === "doc-missing"));
});

test("盖章门扩展:map 缺陷拒绝盖章,baseline-corrupt 豁免(v0.4.0)", () => {
  const d = makeRepo();
  const mp = path.join(d, ".docc", "map.json");
  const good = fs.readFileSync(mp, "utf-8");
  const withBad = JSON.parse(good);
  withBad.entries.push({ pattern: "nope/**", docs: [{ file: "docs/A.md", anchor: "## 契约" }] });
  fs.writeFileSync(mp, JSON.stringify(withBad));
  const r1 = run(d, "--stamp", "--verdict", "{}");
  assert.equal(r1.stamped, false);
  assert.equal(r1.stampBlocked.mapDefects, 1, JSON.stringify(r1.stampBlocked));
  const r2 = run(d, "--stamp", "--force", "--verdict", "{}");
  assert.equal(r2.stamped, true, "--force 跳过 map 缺陷门");

  fs.writeFileSync(mp, good);
  run(d, "--stamp", "--force", "--verdict", "{}");
  fs.writeFileSync(path.join(d, ".docc", "hashes.json"), "{broken");
  const r3 = run(d, "--stamp", "--verdict", "{}");
  assert.equal(r3.stamped, true, "baseline-corrupt 豁免:重新盖章正是修复手段");
  assert.ok(r3.mapIssues.some((m) => m.code === "baseline-corrupt"));
});

test("verdict-count-mismatch:判定计数与候选数不符 → 软告警;相符/未提供不告警(v0.4.0)", () => {
  const d = makeRepo();
  const r1 = run(d, "--stamp", "--verdict", '{"formatting":5}'); // 候选 1,计数 5
  assert.ok(r1.warnings.some((w) => w.code === "verdict-count-mismatch"), JSON.stringify(r1.warnings));
  const d2 = makeRepo();
  const r2 = run(d2, "--stamp", "--verdict", '{"other":1}'); // 候选 1,计数 1
  assert.ok(!r2.warnings.some((w) => w.code === "verdict-count-mismatch"));
  const d3 = makeRepo();
  const r3 = run(d3, "--stamp"); // 未提供:只报 verdict-missing
  assert.ok(r3.warnings.some((w) => w.code === "verdict-missing"));
  assert.ok(!r3.warnings.some((w) => w.code === "verdict-count-mismatch"));
});

test("verdict-count-mismatch:零和证词回退——--verdict '{}' 且存在 kind:new 候选时同样告警(v0.5.0 终审修复,回归 skills/init/SKILL.md:46 记载)", () => {
  const d = makeRepo();
  // 首次纳管:src/a.ts 是 kind:new 候选(候选数 1),--verdict '{}' 计数和为 0,0 !== 1 应告警
  const r = run(d, "--stamp", "--verdict", "{}");
  assert.ok(r.warnings.some((w) => w.code === "verdict-count-mismatch"), JSON.stringify(r.warnings));
  assert.equal(r.stamped, true, "首次纳管无真实漂移,mismatch 仅软告警不阻塞盖章");
});

test("history 轮转:超 historyLimit 保留最新 N 行;0 不限(v0.4.0)", () => {
  const d = makeRepo();
  const mp = path.join(d, ".docc", "map.json");
  const m1 = JSON.parse(fs.readFileSync(mp, "utf-8"));
  m1.config = { historyLimit: 3 };
  fs.writeFileSync(mp, JSON.stringify(m1));
  run(d, "--stamp", "--verdict", '{"other":1}');
  for (let i = 0; i < 4; i++) run(d, "--stamp", "--verdict", "{}");
  const lines = fs.readFileSync(path.join(d, ".docc", "history.jsonl"), "utf-8").trim().split("\n");
  assert.equal(lines.length, 3);
  for (const l of lines) JSON.parse(l);

  const d2 = makeRepo();
  const mp2 = path.join(d2, ".docc", "map.json");
  const m2 = JSON.parse(fs.readFileSync(mp2, "utf-8"));
  m2.config = { historyLimit: 0 };
  fs.writeFileSync(mp2, JSON.stringify(m2));
  run(d2, "--stamp", "--verdict", '{"other":1}');
  for (let i = 0; i < 3; i++) run(d2, "--stamp", "--verdict", "{}");
  assert.equal(
    fs.readFileSync(path.join(d2, ".docc", "history.jsonl"), "utf-8").trim().split("\n").length,
    4,
  );
});

test("map.json version≠1:preflight 报精确 error(fail-open exit 0)(v0.4.0)", () => {
  const d = makeRepo();
  const mp = path.join(d, ".docc", "map.json");
  const m = JSON.parse(fs.readFileSync(mp, "utf-8"));
  m.version = 2;
  fs.writeFileSync(mp, JSON.stringify(m));
  const r = run(d);
  assert.ok(r.error.includes("version 2 is not supported"), JSON.stringify(r));
});

test("INDEX 机检:本轮新台账未入 INDEX.md → ledger-not-indexed 软告警(v0.4.0)", () => {
  const d = makeRepo();
  fs.mkdirSync(path.join(d, ".docc", "LEDGER"), { recursive: true });
  fs.writeFileSync(
    path.join(d, ".docc", "LEDGER", "2026-07-11-y.md"),
    "# 台账\n<!-- verified-by: unverified -->\n",
  );
  const r1 = run(d, "--stamp", "--verdict", '{"other":1}');
  assert.ok(r1.warnings.some((w) => w.code === "ledger-not-indexed"), JSON.stringify(r1.warnings));
  fs.writeFileSync(path.join(d, ".docc", "LEDGER", "INDEX.md"), "2026-07-11 | y | 摘要 2026-07-11-y.md\n");
  const r2 = run(d, "--stamp", "--verdict", "{}");
  assert.ok(!r2.warnings.some((w) => w.code === "ledger-not-indexed"));
});

test("重命名台账仍受 verified-by 校验(R 行取箭头后路径)(v0.4.0)", () => {
  const d = makeRepo();
  fs.mkdirSync(path.join(d, ".docc", "LEDGER"), { recursive: true });
  fs.writeFileSync(path.join(d, ".docc", "LEDGER", "old.md"), "# 台账\n无标记\n");
  git(d, "add", ".");
  git(d, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "x");
  git(d, "mv", ".docc/LEDGER/old.md", ".docc/LEDGER/new.md");
  const r = run(d, "--stamp", "--verdict", '{"other":2}');
  assert.ok(
    r.warnings.some((w) => w.code === "ledger-verified-by-missing" && w.message.includes("new.md")),
    JSON.stringify(r.warnings),
  );
});

test("子目录会话:--cwd 指向仓库根的子目录 → preflight 向上定位到 .docc/map.json 正常出报告(v0.4.1)", () => {
  const d = makeRepo();
  const subdir = path.join(d, "src", "nested");
  fs.mkdirSync(subdir, { recursive: true });
  const r = run(subdir);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.error, undefined, JSON.stringify(r));
  assert.deepEqual(r.driftCandidates, [
    { file: "src/a.ts", kind: "new", docs: [{ file: "docs/A.md", anchor: "## 契约", critical: true }] },
  ]);
});

test("子目录会话对照:同结构但无 .docc/ → 输出含 error 字段(fail-open)(v0.4.1)", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "dc-repo-nodocc-"));
  git(d, "init", "-q");
  fs.mkdirSync(path.join(d, "src", "nested"), { recursive: true });
  fs.writeFileSync(path.join(d, "src", "a.ts"), "export const a = 1;\n");
  const r = run(path.join(d, "src", "nested"));
  assert.equal(r.ok, false);
  assert.ok(r.error.includes(".docc/map.json"), JSON.stringify(r));
});

test("盖章门证词感知:正常收尾周期(改源+改文档+相符 verdict)放行;懒汉盖章仍被拒(v0.4.0)", () => {
  const d = makeRepo();
  run(d, "--stamp", "--verdict", "{}");
  fs.appendFileSync(path.join(d, "src", "a.ts"), "export const b = 2;\n");
  fs.appendFileSync(path.join(d, "docs", "A.md"), "同步:新增 b 常量。\n");
  const lazy = run(d, "--stamp");
  assert.equal(lazy.stamped, false, "无证词拒绝");
  assert.ok(lazy.stampBlocked.message.includes("missing"));
  const dutiful = run(d, "--stamp", "--verdict", '{"docLag":1}');
  assert.equal(dutiful.stamped, true, "证词相符放行——正常周期不依赖 --force");
  assert.equal(dutiful.stampBlocked, null);
  const clean = run(d);
  assert.deepEqual(clean.driftCandidates, []);
  assert.deepEqual(clean.docDrift, []);
});

test("stampBlocked.message:仅映射缺陷、无真实漂移时不含\"对拍证词\"半句(v0.5.0 终审修复)", () => {
  const d = makeRepo();
  run(d, "--stamp", "--verdict", "{}");
  const mp = path.join(d, ".docc", "map.json");
  const map = JSON.parse(fs.readFileSync(mp, "utf-8"));
  map.entries.push({ pattern: "nope/**", docs: [{ file: "docs/A.md", anchor: "## 契约" }] });
  fs.writeFileSync(mp, JSON.stringify(map));
  const r = run(d, "--stamp", "--verdict", "{}");
  assert.equal(r.stampBlocked.mapDefects, 1, JSON.stringify(r.stampBlocked));
  assert.equal(r.stampBlocked.realDriftCount, 0);
  assert.equal(r.stampBlocked.docDriftCount, 0);
  assert.ok(r.stampBlocked.message.includes("fix the mapping"), r.stampBlocked.message);
  assert.ok(!r.stampBlocked.message.includes("provide a matching --verdict as reconciliation attestation"), r.stampBlocked.message);
});

test("stampBlocked.message:仅真实漂移、无映射缺陷时不含\"修映射\"半句(v0.5.0 终审修复)", () => {
  const d = makeRepo();
  run(d, "--stamp", "--verdict", "{}");
  fs.appendFileSync(path.join(d, "src", "a.ts"), "x\n");
  const r = run(d, "--stamp"); // 无 verdict,真实漂移未获证词
  assert.equal(r.stampBlocked.mapDefects, 0, JSON.stringify(r.stampBlocked));
  assert.ok(r.stampBlocked.message.includes("provide a matching --verdict as reconciliation attestation"), r.stampBlocked.message);
  assert.ok(!r.stampBlocked.message.includes("fix the mapping"), r.stampBlocked.message);
});

test("stampBlocked.message:映射缺陷+真实漂移并存 → 两半句以半角分号连接(v0.5.0 终审修复)", () => {
  const d = makeRepo();
  run(d, "--stamp", "--verdict", "{}");
  const mp = path.join(d, ".docc", "map.json");
  const map = JSON.parse(fs.readFileSync(mp, "utf-8"));
  map.entries.push({ pattern: "nope/**", docs: [{ file: "docs/A.md", anchor: "## 契约" }] });
  fs.writeFileSync(mp, JSON.stringify(map));
  fs.appendFileSync(path.join(d, "src", "a.ts"), "x\n");
  const r = run(d, "--stamp");
  assert.ok(
    r.stampBlocked.message.includes("fix the mapping; provide a matching --verdict as reconciliation attestation"),
    r.stampBlocked.message,
  );
});

test("verdict 防呆:非法 JSON → verdict-parse-failed 软告警,verdict 仍为 null(v0.5.0)", () => {
  const d = makeRepo();
  const r = run(d, "--stamp", "--verdict", "{broken");
  assert.ok(r.warnings.some((w) => w.code === "verdict-parse-failed"), JSON.stringify(r.warnings));
  assert.ok(
    r.warnings.find((w) => w.code === "verdict-parse-failed")?.message.includes("invalid JSON"),
    JSON.stringify(r.warnings),
  );
  assert.ok(r.warnings.some((w) => w.code === "verdict-missing"), "parse-failed 同时应有 verdict-missing");
});

test("verdict 防呆:未知键 → verdict-unknown-key 软告警,已知键仍被收集(v0.5.0)", () => {
  const d = makeRepo();
  const r = run(d, "--stamp", "--verdict", '{"doclag":1}');
  assert.ok(r.warnings.some((w) => w.code === "verdict-unknown-key"), JSON.stringify(r.warnings));
  const unknownKeyWarn = r.warnings.find((w) => w.code === "verdict-unknown-key");
  assert.ok(unknownKeyWarn?.message.includes("doclag"), JSON.stringify(unknownKeyWarn));
  assert.ok(unknownKeyWarn?.message.includes("formatting"), "应列举合法键");
  // verdict 缺收集的未知键,仍为 null(因为 doclag 非法)
  const histRec = JSON.parse(
    fs.readFileSync(path.join(d, ".docc", "history.jsonl"), "utf-8").trim().split("\n")[0],
  );
  assert.equal(histRec.verdict, null, "未知键未被收集,verdict 为 null");
});

test("verdict 防呆:合法 JSON 但非纯对象(数组/字符串/数字/null)→ 归为 verdict-parse-failed(v0.5.0 终审修复)", () => {
  for (const bad of ['[1,2,3]', '"foo"', "5", "null"]) {
    const d = makeRepo();
    const r = run(d, "--stamp", "--verdict", bad);
    assert.ok(r.warnings.some((w) => w.code === "verdict-parse-failed"), `${bad}: ${JSON.stringify(r.warnings)}`);
    assert.ok(
      r.warnings.find((w) => w.code === "verdict-parse-failed")?.message.includes("not an object"),
      `${bad}: 消息应提示非对象`,
    );
    const rec = JSON.parse(
      fs.readFileSync(path.join(d, ".docc", "history.jsonl"), "utf-8").trim().split("\n")[0],
    );
    assert.equal(rec.verdict, null, `${bad}: 非对象输入不应被当作有效判定,verdict 应为 null`);
  }
});

test("verdict 防呆:已知键存在但值非法(字符串数字/负数/小数)→ verdict-invalid-value 软告警,已忽略(v0.5.0 终审修复)", () => {
  const d = makeRepo();
  const r = run(d, "--stamp", "--verdict", '{"formatting":"1","docLag":-1,"codeViolation":1.5,"other":2}');
  const w = r.warnings.find((x) => x.code === "verdict-invalid-value");
  assert.ok(w, JSON.stringify(r.warnings));
  assert.match(w.message, /formatting/);
  assert.match(w.message, /docLag/);
  assert.match(w.message, /codeViolation/);
  const rec = JSON.parse(
    fs.readFileSync(path.join(d, ".docc", "history.jsonl"), "utf-8").trim().split("\n")[0],
  );
  assert.deepEqual(rec.verdict, { other: 2 }, "仅合法键值被收集,非法值键被忽略");
});

test("--verdict per-file 形式:映射与候选集合相符 → attested,无 verdict 告警,history 落派生计数与 verdictFiles(v0.8.0)", () => {
  const d = makeRepo();
  run(d, "--stamp", "--verdict", "{}"); // 首次纳管建立基线
  fs.appendFileSync(path.join(d, "src", "a.ts"), "export const b = 2;\n"); // modified
  fs.writeFileSync(path.join(d, "src", "b.ts"), "export const b1 = 1;\n"); // new
  const r = run(d, "--stamp", "--verdict", '{"src/a.ts":"docLag","src/b.ts":"formatting"}');
  assert.equal(r.stamped, true, JSON.stringify(r));
  assert.ok(!r.warnings.some((w) => w.code === "verdict-missing"), JSON.stringify(r.warnings));
  assert.ok(!r.warnings.some((w) => w.code === "verdict-count-mismatch"), JSON.stringify(r.warnings));
  assert.ok(!r.warnings.some((w) => w.code === "verdict-file-mismatch"), JSON.stringify(r.warnings));
  assert.ok(!r.warnings.some((w) => w.code === "verdict-invalid-value"), JSON.stringify(r.warnings));
  const lines = fs.readFileSync(path.join(d, ".docc", "history.jsonl"), "utf-8").trim().split("\n");
  const last = JSON.parse(lines[lines.length - 1]);
  assert.equal(last.stamped, true);
  assert.deepEqual(last.verdict, { docLag: 1, formatting: 1 }, "聚合计数由 per-file 映射派生");
  assert.deepEqual(last.verdictFiles, { "src/a.ts": "docLag", "src/b.ts": "formatting" });
});

test("--verdict per-file 形式:候选集不符(缺一/多一)→ verdict-file-mismatch 告警(含文件名),不发 verdict-count-mismatch,真漂移时拒绝盖章(v0.8.0)", () => {
  const d = makeRepo();
  run(d, "--stamp", "--verdict", "{}");
  fs.appendFileSync(path.join(d, "src", "a.ts"), "export const b = 2;\n"); // modified
  fs.writeFileSync(path.join(d, "src", "b.ts"), "export const b1 = 1;\n"); // new
  // 候选是 {src/a.ts, src/b.ts};此处只给 src/a.ts,漏了 src/b.ts,又多给了不相干的 src/c.ts
  const r = run(d, "--stamp", "--verdict", '{"src/a.ts":"docLag","src/c.ts":"other"}');
  const mismatch = r.warnings.find((w) => w.code === "verdict-file-mismatch");
  assert.ok(mismatch, JSON.stringify(r.warnings));
  assert.match(mismatch.message, /src\/b\.ts/, "缺失文件名应出现在告警文案里");
  assert.match(mismatch.message, /src\/c\.ts/, "多余文件名应出现在告警文案里");
  assert.ok(!r.warnings.some((w) => w.code === "verdict-count-mismatch"), "per-file 集合不等时不应重复发计数告警");
  assert.ok(r.stampBlocked, "真实漂移且证词未覆盖候选集,应拒绝盖章");
  assert.equal(r.stamped, false);
});

test("--verdict per-file 形式:非法类名值条目被丢弃(verdict-invalid-value),集合因此不等 → 不 attested(v0.8.0)", () => {
  const d = makeRepo();
  run(d, "--stamp", "--verdict", "{}");
  fs.appendFileSync(path.join(d, "src", "a.ts"), "export const b = 2;\n"); // modified
  fs.writeFileSync(path.join(d, "src", "b.ts"), "export const b1 = 1;\n"); // new
  // src/a.ts 的值 "doclag" 不是合法四类名(大小写不符),应被丢弃;src/b.ts 触发 per-file 形式识别
  const r = run(d, "--stamp", "--verdict", '{"src/a.ts":"doclag","src/b.ts":"formatting"}');
  assert.ok(r.warnings.some((w) => w.code === "verdict-invalid-value"), JSON.stringify(r.warnings));
  assert.equal(r.stamped, false, "被丢弃的条目使集合不等,不应 attested");
  assert.ok(r.stampBlocked, JSON.stringify(r.stampBlocked));
});

test("--verdict per-file 形式:空对象{}维持聚合语义,不被误判为 per-file(v0.8.0 回归)", () => {
  const d = makeRepo();
  const r = run(d, "--stamp", "--verdict", "{}");
  assert.equal(r.stamped, true, "首次纳管候选 1,{} 计数和 0 !== 1 但仅软告警不阻塞");
  assert.ok(r.warnings.some((w) => w.code === "verdict-count-mismatch"), JSON.stringify(r.warnings));
  const lines = fs.readFileSync(path.join(d, ".docc", "history.jsonl"), "utf-8").trim().split("\n");
  const last = JSON.parse(lines[lines.length - 1]);
  assert.ok(!("verdictFiles" in last), "聚合形式(含空对象)history 行不应出现 verdictFiles 键");
});

test("--verdict 聚合形式:history 行不携带 verdictFiles 键(v0.8.0 回归)", () => {
  const d = makeRepo();
  const r = run(d, "--stamp", "--verdict", '{"formatting":1}');
  assert.equal(r.stamped, true);
  const lines = fs.readFileSync(path.join(d, ".docc", "history.jsonl"), "utf-8").trim().split("\n");
  const last = JSON.parse(lines[lines.length - 1]);
  assert.ok(!("verdictFiles" in last), "聚合形式 history 行不应出现 verdictFiles 键");
});

function checkRun(cwd, ...extra) {
  const r = spawnSync("node", [SCRIPT, "--cwd", cwd, ...extra], { encoding: "utf-8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

test("--check 模式:干净已盖章仓库 → exit 0", () => {
  const d = makeRepo();
  run(d, "--stamp", "--verdict", "{}");
  const result = checkRun(d, "--check");
  assert.equal(result.status, 0, `预期 exit 0，实际: ${result.status}`);
});

test("--check 模式:有漂移候选 → exit 1", () => {
  const d = makeRepo();
  run(d, "--stamp", "--verdict", "{}");
  fs.appendFileSync(path.join(d, "src", "a.ts"), "export const b = 2;\n");
  const result = checkRun(d, "--check");
  assert.equal(result.status, 1, `预期 exit 1，实际: ${result.status}`);
});

test("--check 模式:有文档被改(docDrift) → exit 1", () => {
  const d = makeRepo();
  run(d, "--stamp", "--verdict", "{}");
  fs.appendFileSync(path.join(d, "docs", "A.md"), "被直接改了\n");
  const result = checkRun(d, "--check");
  assert.equal(result.status, 1, `预期 exit 1，实际: ${result.status}`);
});

test("--check 模式:有映射问题 → exit 1", () => {
  const d = makeRepo();
  fs.writeFileSync(
    path.join(d, ".docc", "map.json"),
    JSON.stringify({
      version: 1,
      entries: [{ pattern: "nope/**", docs: [{ file: "docs/A.md", anchor: "## 契约" }] }],
    }),
  );
  const result = checkRun(d, "--check");
  assert.equal(result.status, 1, `预期 exit 1，实际: ${result.status}`);
});

test("--check --stamp 并用 → exit 2 且 stdout 含 error", () => {
  const d = makeRepo();
  const result = checkRun(d, "--check", "--stamp");
  assert.equal(result.status, 2, `预期 exit 2，实际: ${result.status}`);
  const json = JSON.parse(result.stdout);
  assert.ok(json.error && json.error.includes("--check"), `error 字段应包含"--check": ${json.error}`);
  assert.ok(json.error.includes("--stamp"), `error 字段应包含"--stamp": ${json.error}`);
});

test("无 --check 有候选仍 exit 0(fail-open 红线回归钉)(v0.6.0)", () => {
  const d = makeRepo();
  run(d, "--stamp", "--verdict", "{}");
  fs.appendFileSync(path.join(d, "src", "a.ts"), "export const b = 2;\n");
  const result = checkRun(d); // 不带 --check
  assert.equal(result.status, 0, `无 --check 时默认 exit 0,实际: ${result.status}`);
  // 但报告中应有候选
  const json = JSON.parse(result.stdout);
  assert.equal(json.driftCandidates.length, 1, "报告应反映有候选");
});

test("缺 map + --check → exit 1(环境缺陷拒绝 CI 流程)(v0.6.0)", () => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "dc-plain-"));
  git(plain, "init", "-q");
  // 故意不创建 map.json，测试缺 map 时 --check 的行为
  const result = checkRun(plain, "--check");
  assert.equal(result.status, 1, `缺 map 时 --check 应 exit 1,实际: ${result.status}`);
});

test("非 git 仓库 + --check → exit 1(v0.6.0)", () => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "dc-plain-"));
  fs.mkdirSync(path.join(plain, ".docc"), { recursive: true });
  fs.writeFileSync(
    path.join(plain, ".docc", "map.json"),
    JSON.stringify({ version: 1, entries: [] }),
  );
  const result = checkRun(plain, "--check");
  assert.equal(result.status, 1, `非 git 仓库时 --check 应 exit 1,实际: ${result.status}`);
});
