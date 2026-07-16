# doc-companion 插件实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现通用 Claude Code 插件 doc-companion——用一张 DOC-MAP 映射表让 AI 改码时文档始终随行（事前哈希制导对拍 / 事中三档 hook / 事后台账与盖章）。

**Architecture:** 引擎（本仓库：hooks+scripts+skills）与项目数据（各接入仓库的 docs/DOC-MAP.json 等）完全分离；哈希用 `git hash-object`（核心链路零 Node 依赖）；所有 hook fail-open。上游规格：Gateway-Frontend worktree `docs/superpowers/specs/2026-07-09-doc-companion-design.md`。

**Tech Stack:** Node ≥18 内置模块（零 npm 依赖）、node:test、git、Claude Code plugin 机制。

## Global Constraints

- 引擎代码禁止出现任何具体项目路径/框架名；项目特定信息只在各项目 DOC-MAP 数据里。
- 所有 hook 任何异常一律 exit 0 + stderr 前缀 `[doc-companion]` 告警（fail-open）；状态/映射文件损坏视同"无状态"放行；**契约门若状态写入失败必须降级放行**（防死锁）。
- 未接入项目（无 `docs/DOC-MAP.json`）中一切 hook 静默 exit 0（零打扰）。
- 哈希统一 `git hash-object`；hashes sidecar 键排序输出。
- hooks.json 命令用 `if command -v node …; then node "…"; else exit 0; fi`——**禁止 `A && B || exit 0`**（吞掉 gate 的 exit 2）。
- 同会话同文件：remind 只提醒一次、gate 只拦一次（状态按 session_id 分文件）。
- 远程：`https://github.com/Aqrk-Dev/doc-companion`；conventional commits。

---

### Task 1: 脚手架与清单
**Files:** `.claude-plugin/plugin.json`、`.claude-plugin/marketplace.json`、`hooks/hooks.json`、`.gitignore`、`LICENSE`、`README.md`
- [x] Step 1: 文件落盘（内容见仓库实体文件，此计划与实现同步产出）
- [ ] Step 2: `git init -b main && git remote add origin https://github.com/Aqrk-Dev/doc-companion.git`
- [ ] Step 3: `git add -A && git commit -m "chore: 插件仓库脚手架"`

### Task 2: `hooks/_shared.mjs`（共享库）
**Files:** `hooks/_shared.mjs`、`test/shared.test.mjs`
**Interfaces（后续任务依赖）:** `toPosix/repoRelative(→null 越界)/globToRegExp(**,*,?)/readJsonSafe/loadDocMap/matchEntries/gitHashObject/anchorExists(行首前缀)/loadState({reminded,gated,notedCount})/saveState(→boolean)/readStdinJson/warn`；常量 `DOC_MAP_FILE`、`HASHES_FILE`。
- [x] Step 1: 测试与实现落盘（TDD 红绿循环因分类器故障无法即时执行，Bash 恢复后先跑全套确认）
- [ ] Step 2: `node --test test/shared.test.mjs` → PASS
- [ ] Step 3: `git commit -m "feat: _shared 共享库"`

### Task 3: 事中双档 hook
**Files:** `hooks/doc-map-remind.mjs`、`hooks/doc-map-gate.mjs`、`test/hooks.test.mjs`
**契约:** stdin `{session_id,cwd,tool_input:{file_path}}`；remind 输出 `hookSpecificOutput.additionalContext`（每文件每会话一次）；gate 首拦 exit 2 + stderr 指引、重试放行、状态写失败降级放行。
- [x] Step 1: 测试与实现落盘
- [ ] Step 2: `node --test test/hooks.test.mjs` → PASS（含：无 DOC-MAP 零打扰 / remind 去重 / gate 拦一次 / 损坏 JSON fail-open 四组）
- [ ] Step 3: `git commit -m "feat: 事中双档 hook"`

### Task 4: Stop 收尾提醒 + preflight 机检/盖章
**Files:** `hooks/doc-map-stop-remind.mjs`、`scripts/doc-preflight.mjs`、`test/preflight.test.mjs`
**契约:** stop-remind 仅当 `reminded.length > notedCount` 输出 `{"systemMessage":…}`；preflight CLI `[--stamp] [--cwd <dir>]` → 报告 `{ok,driftCandidates,docDrift,mapIssues,stamped}`；文件枚举 `git ls-files --cached --others --exclude-standard`；源侧无记录=候选，文档侧有记录且失配=docDrift。
- [x] Step 1: 测试与实现落盘
- [ ] Step 2: `node --test test/` → 全 PASS（首跑候选 / 盖章后归零 / 改源码→候选 / 改文档→docDrift / 坏 pattern+坏锚点→mapIssues / stop-remind 去重）
- [ ] Step 3: `git commit -m "feat: Stop 收尾提醒 + preflight 机检与双侧盖章"`

### Task 5: 三个 skill + README
**Files:** `skills/init/SKILL.md`、`skills/preflight/SKILL.md`、`skills/postflight/SKILL.md`、`README.md`
- [x] Step 1: 落盘（skill 文本引用的报告字段与 Task 4 一致）
- [ ] Step 2: `claude plugin validate .`（CLI 可用时）
- [ ] Step 3: `git commit -m "feat: init/preflight/postflight skills + README"`

### Task 6: 收尾与远程
- [ ] Step 1: `node --test test/` 全绿
- [ ] Step 2: 冒烟 `claude --plugin-dir <repo>` 确认 `/doc-companion:init` 可见
- [ ] Step 3: `git push -u origin main`（空仓库首推；认证缺失则向用户要授权）

后续独立计划：Gateway-Frontend 接入（init 转换附录 §1.1 生成 DOC-MAP、AGENTS.md 仲裁加行、首次盖章）。

> 执行备注（2026-07-09）：安全分类器故障期间 Bash/仓库外 Write 不可用，实现文件在 Gateway-Frontend worktree `plugin-staging/doc-companion/` 暂存产出（未纳入前端仓库版本控制）；恢复后 `mv` 至 `/home/vscode/project/YunGateway/doc-companion` 执行 Task 1 Step 2 起的全部命令步骤。
