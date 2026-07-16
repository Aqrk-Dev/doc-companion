# docc（doc-companion）缺陷清单、优化点与外部参考点

- **日期**：2026-07-11
- **依据**：直接读取本仓库 v0.1.0 实现本体（`hooks/_shared.mjs`、`hooks/doc-map-*.mjs`、`scripts/doc-preflight.mjs`、三个 `skills/*/SKILL.md`、`README.md`、`docs/superpowers/plans/2026-07-09-doc-companion-implementation.md`），不凭描述推断——遵循本项目"裁决工具去留必须读实现本体"的纪律。
- **配套背景**：YunGateway/Meta `docs/superpowers/specs/2026-07-10-seven-role-agent-workflow.md` §9 已对 docc 做过一轮可替代性查证（P0–P4 路线图）；本文在其基础上做两件事——(1) 逐条核对该路线图在当前代码里是否已经动手，(2) 补充一批读代码后新发现、原路线图未覆盖的缺陷点；并新增一节"该参考的外部插件功能点"，把 2026-07-10~11 两次插件市场审计（ruflo 37 插件 + claude-plugins-official ~290 插件）里筛出的、真正对 docc 有参考价值的具体实现点收敛到这里。

---

## 1. 现状复述（一句话）

docc 是一个"引擎与项目数据分离"的 Claude Code 插件：核心链路（`_shared.mjs` + `doc-preflight.mjs`）零 npm 依赖、只用 `git hash-object` 做双侧（源码+文档）内容哈希比对，配合三档 hook（PreToolUse 契约门 / PostToolUse 提醒 / Stop 收尾提醒）与三个 skill（init/preflight/postflight），围绕一张 `docs/DOC-MAP.json` 锚点映射表运作。设计红线是 fail-open、同会话同文件只拦一次、未接入项目零打扰。这套骨架是扎实的，下面的缺陷都是在这个骨架**之上**的精细化问题，不是推翻骨架。

---

## 2. 缺陷清单（读代码确认，非推测）

### 2.1 哈希粒度过粗：格式化改动会被误判为漂移（P0，路线图已列但代码未动）

`hooks/_shared.mjs:gitHashObject` 直接对整份文件调用 `git hash-object`，`scripts/doc-preflight.mjs` 用它同时算源码侧 `driftCandidates` 和文档侧 `docDrift`。任何纯格式化改动——`gofmt`/`prettier` 重排、注释增删、行尾空白、字段重排——都会让哈希变化，从而：
- 源码侧：产生 `driftCandidates`，preflight 派 subagent 去做"语义对拍"，但对拍结论必然是"无实质变化"——每次格式化都白跑一次语义核对，长期积累会让"漂移候选"这个信号失真、逐渐被忽视（狼来了）。
- 文档侧：文档本身被 Prettier/markdownlint 格式化一次，就会被判定为"`docDrift`——文档被直接修改过"，触发不必要的复核。

**现状确认**：截至本次读码，`gitHashObject` 实现未变，此项仍是路线图 P0 里唯一"格式化误报"场景，且是最容易在真实项目里第一次踩坑的点（YAGNI 原则下路线图把它列为"误报实际出现后立即做"，但目前没有触发记录/埋点能告诉维护者"误报出现了没有"——见 2.6）。

### 2.2 锚点匹配是裸前缀匹配，无法排除"字面近似但语义不同"的标题（新发现，未在原路线图出现）

`hooks/_shared.mjs:anchorExists`：

```js
return text.split(/\r?\n/).some((line) => line.startsWith(anchor));
```

这是纯字符串 `startsWith`，没有要求前缀之后是空白/换行/字符串结尾。后果：
- 若 DOC-MAP 里登记的锚点是 `"## 状态"`，而文档里存在标题 `"## 状态更新记录"`（另一个不相关章节），`anchorExists` 会返回 `true`——**假阳性**：preflight/postflight 会认为锚点存在且完好，实际上真正想指向的那个 `## 状态` 标题可能已被改名或删除，只是恰好有另一个以相同前缀开头的标题顶替。这是一个能被真实项目踩到的正确性 bug，不是风格问题。
- 反过来也没有"唯一性"校验：同一 anchor 前缀在文档里出现两次（编号重复、章节复制粘贴忘改标题），`anchorExists` 同样返回 `true`，但实际引用的是哪一个是歧义的，postflight 第 3 步"逐锚点核对并更新文档"时可能改错地方。

**建议修法**：锚点存在性判断改为——该行去除前缀后，下一个字符必须是行尾或空白（即“锚点是这一行标题的完整前缀，而不是任意更长标题的字面前缀”），并且在 preflight 的 `mapIssues` 里新增一类检查：锚点在目标文档中命中 ≥2 次时报"锚点歧义"（而不是静默取第一个）。

### 2.3 契约门的"声明"是纯对话文本，不进台账，缺证据链闭环（新发现，削弱 docc 的核心卖点）

`hooks/doc-map-gate.mjs` 拦截后要求"在消息文本中声明本次改动对上述锚点的影响"，但：
- 这句声明只出现在当轮对话里，**没有任何机制把它写进 `docs/LEDGER/` 或任何持久存储**；
- `state.gated` 只记录"这个文件本会话已经被拦过一次"（布尔去重），不记录"当时声明的内容是什么"；
- postflight 第 4 步的五字段台账是**事后**独立重新整理的，与 gate 时刻的即时声明之间没有任何数据勾连或一致性校验。

结果是：七角色体系文档里给 docc 的定位是"审查证据链 = docc 台账，唯一能答'动了哪些契约'"（该文档 42 项裁决表 #27），但契约门这一环节本身产生的"即时声明"其实是**凭空对话文本，未被审计**——如果 agent 在 gate 时敷衍一句话就重试通过，而 postflight 阶段又没人认真核对，这条证据链在"事中"这一环其实是空的，只有"事后"补写的台账是硬的。

**建议修法**：gate 的 stderr 提示改为要求把声明写成一段可被 grep 的固定格式（例如约定 agent 把声明追加到一个当前会话的草稿文件，如 `.claude/.cache/doc-companion-<session>.declarations.md`），postflight 生成台账时读取并合并这份草稿，做到"gate 时声明 → postflight 时落账"有真实数据通路，而不是纯靠自觉。

### 2.4 "受影响调用方"字段无机器校验，可被字面应付（新发现）

`skills/postflight/SKILL.md` 第 4 步台账模板要求"受影响调用方/依赖方"字段引用 codegraph callers/impact 产出，"确无受影响方明确写'无'"——但这整个环节是纯 prompt 指导，`scripts/doc-preflight.mjs` 不做任何校验。一个疲于奔命的 agent 完全可能在没有真的跑 codegraph 查询的情况下直接写"无"了事，台账文件本身无法区分"真的查过、确认无受影响方"和"没查、图省事写无"。

**建议修法**：台账 markdown 里给这个字段加一个可选的机器可读小尾巴（例如 `<!-- verified-by: codegraph_impact | grep-fallback | unverified -->`），preflight/postflight 脚本在盖章前检查该标记是否存在，缺失时在 `mapIssues`（或新增字段）里报一条软告警，倒逼这一步不能被静默跳过。

### 2.5 台账与 DOC-MAP 之间没有关系图，无法做"悬空引用/环"检测（新发现，可参考 ruflo-adr）

现有的"索引校正"（preflight/postflight 的 `mapIssues`）只做**扁平**检查：锚点悬空、pattern 无匹配、孤儿文档。但 `docs/LEDGER/*.md` 之间、以及台账与 DOC-MAP entries 之间，完全没有"这条台账处理了哪个/哪些 DOC-MAP 条目"、"这次改动是否使某条 DOC-MAP entry 变成孤儿"这类**关系图**层面的自动检测——目前全靠 postflight 第 5 步人工数一遍。

这一点在 2026-07-10 对 ruflo 插件市场的审计中有直接可借鉴对象：`ruflo-adr` 插件的 `scripts/import.mjs`（322 行）/`verify.mjs`（122 行）是审计过的 37 个 ruflo 插件里为数不多的"真实现"之一——它做的正是：解析 frontmatter 中的 `supersedes/amends/depends-on` 关系字段、构建关系图、DFS 检测 supersede 环、检测悬空引用。这个**算法设计**（不是它的存储后端，那部分依赖外部未装的 CLI，不可用）值得 docc 移植：给 LEDGER 条目和 DOC-MAP entries 引入可选的关系字段（如台账 frontmatter 里的 `supersedes: 2026-06-01-xxx.md`），preflight 时用同样的 DFS 悬空引用+环检测手法做自检。

### 2.6 无漂移历史/趋势记录，只有"当前是否漂移"的快照（新发现，P3 路线图相关但更具体）

`docs/DOC-MAP.hashes.json` 只保存"当前基线"，`doc-preflight.mjs` 的报告也只反映"这一次跑出来的结果"，没有任何地方持久化"过去 N 次 preflight 分别抓到过多少漂移候选、多少是真漂移、多少是格式化误报"。这直接导致 2.1 提到的"格式化误报是否真的频繁出现"这件事无法被观测和验证——路线图里 P0 的触发条件写的是"格式化类误报实际出现后立即做"，但目前没有任何埋点能告诉维护者这个触发条件是否已经满足。

**建议修法（轻量级，不引入新依赖）**：`--stamp` 时顺带把本次报告的三个计数（`driftCandidates.length`/`docDrift.length`/`mapIssues.length`）以追加一行 JSONL 的方式写入一个 `docs/DOC-MAP.history.jsonl`（可选开启），不影响 fail-open/零依赖原则，只是加一条 `fs.appendFileSync`。这也顺带能支撑 2.9 提到的"报告可视化"。

### 2.7 glob 能力有限（已知限制，非 bug，值得写明）

`globToRegExp` 只支持 `**`/`*`/`?`，无 `!`（排除）、无大括号展开 `{a,b}`、无字符类 `[abc]`。对于"整个 `src/**` 都要关联文档，但 `src/**/*_test.go` 要排除"这类常见诉求，目前只能拆成多条正条目而非一条带排除的规则，DOC-MAP 会因此变得冗长。这是设计取舍（"极简 glob"是有意为之，避免引入 minimatch 之类依赖），但应当在 README/init skill 里明确写"不支持排除模式，需拆分正向条目"，目前文档没有这条说明，用户会在写复杂 DOC-MAP 时自己踩坑才发现。

### 2.8 多 agent/worktree 并发场景下契约门互不知情（新发现，呼应七角色体系已知的"多 agent 并发裁决"缺口）

`statePath` 按 `session_id` 分文件，这是有意设计（同会话去重、跨会话/resume 沿用）。但当 `superpowers:dispatching-parallel-agents` 或 `EnterWorktree` 派出多个并行子 agent 分别在不同 worktree 里改同一个 critical 锚点关联文件时，各 agent 有独立 `session_id`，契约门会对每个 agent 各自独立触发一次"声明影响"——如果两个 agent 各自声明了不同甚至矛盾的"文档影响"，docc 没有任何机制去合并或对账这两次声明。这不是 docc 独有的缺陷（本来就是七角色体系文档里"多 agent 并发裁决协议"这项尚未被任何工具填补的缺口），但值得在 docc 自己的文档里明确写一句"已知局限：不处理跨 worktree 并发编辑同一契约文件的声明合并"，避免用户误以为 docc 会自动处理这种情况。

### 2.9 无人类可读的漂移报告/评分，只有给 agent 消费的 JSON（P3 路线图已列，代码确认未做）

`doc-preflight.mjs` 输出纯 JSON，没有任何 renderer 把 `driftCandidates`/`docDrift`/`mapIssues` 渲染成人类友好的表格/评分。这在只有 agent 自己消费报告时不是问题，但当团队里有人类想直接跑一下这个脚本看看现在漂移状况如何时，体验很差（一堆 JSON）。

### 2.10 docc 自身未接入自己（dogfooding 缺口，非代码缺陷）

本仓库自己没有 `docs/DOC-MAP.json`（`find` 结果里没有），也就是说 docc 自己的 README/SKILL.md 和 `hooks/_shared.mjs` 等实现文件之间的一致性，并没有被 docc 自己监控。虽然是个小仓库、维护成本可控，但作为"文档随行"工具，自己不吃自己的狗粮，长期看 README 与代码之间也一样会漂移（例如本次读码没发现 README/SKILL 与当前实现有出入，但这只是运气，不是机制保证）。

### 2.11 无 CI 门禁，Claude Code 会话外的提交完全绕过（路线图 P1，代码/仓库结构确认未做）

仓库里没有 `.github/workflows/`，也没有任何 git `pre-commit`/`pre-push` hook 模板。所有三档 hook 都挂在 Claude Code 自己的 PreToolUse/PostToolUse/Stop 事件上，只在 Claude Code 编辑会话内生效。一个人类直接在终端/IDE 里改代码再 `git commit`（不经过 Claude Code），或者另一个不装 docc 的协作者提交代码，完全不会触发任何提醒或门禁——只有等下一次有人手动跑 `/docc:preflight` 时才会被动发现漂移。这是路线图里已经点名的 P1，本次读码确认目前仍是纯 agent-session-scoped，没有向 CI 方向做任何铺垫（例如没有提供一个可以直接塞进 CI 的独立 CLI 退出码约定文档）。

---

## 3. 优化优先级汇总（在原路线图 P0–P4 基础上合并新发现项）

| 优先级 | 优化点 | 类型 | 触发条件/收益 |
|---|---|---|---|
| P0 | 结构指纹替代纯内容哈希（2.1） | 原路线图 | 格式化误报首次出现即做；直接消除"狼来了" |
| P0-新增 | 锚点匹配改为"精确边界"而非裸前缀（2.2） | 新发现 | 属于正确性 bug，建议提前到 P0，不必等触发条件 |
| P1 | CI 门禁（2.11） | 原路线图 | 存在 agent 工作流外提交者时必做 |
| P1-新增 | 契约门声明→台账的数据通路（2.3） | 新发现 | docc"审查证据链"卖点要成立，这条必须补 |
| P2 | 符号级锚点 | 原路线图 | 配合 P0 收益最大，本次未展开新发现 |
| P2-新增 | LEDGER/DOC-MAP 关系图（悬空引用/环检测，2.5） | 新发现，参考 ruflo-adr 算法 | 台账规模变大后价值最高 |
| P3 | 漂移分级/评分报告（2.9） | 原路线图 | 体验优化，靠后 |
| P3-新增 | 漂移历史 JSONL 埋点（2.6） | 新发现 | 为验证 P0 触发条件是否满足提供数据，成本极低 |
| P3-新增 | "受影响调用方"字段机器可读校验标记（2.4） | 新发现 | 防止台账关键字段被字面应付 |
| P4 | 生成物默认排除（`.understand-anything/` 等） | 原路线图 | 成本极低，随手做 |
| 文档补全 | glob 排除能力的限制说明（2.7）、多 agent 并发局限说明（2.8）、docc 自我 init（2.10） | 新发现 | 不涉及代码改动，纯文档/流程 |

**明确不做（沿用原路线图边界，本次确认无需推翻）**：自动再生文档内容（DeepDocs/AutomaDocs 方向）——那是 understand-anything 的职责；docc 的价值锚点是"契约冻结是一次有意识的决定"，一旦让工具自动改文档内容去追平代码，就摧毁了这个锚点。

---

## 4. 该参考的外部插件/工具功能点

来源：本项目 2026-07-10 对 ruflo（ruvnet）市场 37 个插件的逐一源码审计，以及既有 §9.1 的网络查证（Fiberplane Drift / DeepDocs / Drift VSCode 扩展）。**下列每一条都是"思路/算法可参考"，不是"直接安装该插件"**——ruflo 生态整体不建议接入本项目工作流（详见对话历史里的完整审计结论：hooks 自动放行、供应链风险、大量"名不副实"实现），这里只提炼其中经审计确认为真实代码的、docc 可以借鉴设计思路的具体点。

| 参考对象 | 可参考的具体实现点 | 要规避的坑 |
|---|---|---|
| **Fiberplane Drift**（[github.com/fiberplane/drift](https://github.com/fiberplane/drift)） | AST 指纹而非纯内容哈希，对 TS/Python/Rust/Go/Java 做语法感知的结构比对——直接对应 2.1/P0 | 无（本条是路线图已经采纳的方向，本次读码只是确认还没动手） |
| **ruflo-adr**（`scripts/import.mjs` 322 行 + `verify.mjs` 122 行，本次审计中确认为 ruflo 全市场少数几个"真实现"之一） | frontmatter 关系字段解析（`supersedes`/`amends`/`depends-on`）→ 构建关系图 → DFS 检测悬空引用与环——直接对应 2.5 | 它自己的持久化层（写入外部未装的 AgentDB）不可用，只借算法/数据结构设计，不借它的存储方案；其 agent 里"Neural Learning"段落是同一批插件通用的营销占位文本，与此处借鉴内容无关，不要连带引入 |
| **ruflo-core 的 witness 工具箱**（`scripts/witness/*.mjs`，约 1000 行，本次审计中确认逻辑真实存在） | "对每次修复生成一条可追溯的历史记录，跨 git 历史追踪回归"这个**概念**——对应 2.6 漂移历史埋点的更完整版本（如果未来 docc 想做"历史台账"而不只是 JSONL 计数） | 其"Ed25519 加密签名"宣传不实——签名种子是 `sha256(gitCommit + 固定字符串)`，任何有仓库读权限的人都能反推重签，只是防误改的记账手段，不是真正的密码学保证；docc 若做类似历史记录，只需要普通 append-only JSONL/或依赖 git commit 本身的签名机制，不要重新发明一套"看起来像加密但实际不是"的方案 |
| **Drift VSCode 扩展**（[github.com/pallaprolus/drift-vscode](https://github.com/pallaprolus/drift-vscode)） | "漂移评分"而非二值判断的呈现方式——对应 2.9 报告可视化 | 纯 UX 参考，无代码可移植 |
| **DeepDocs / AutomaDocs** | （无——两者是"自动重新生成文档内容"方向，与 docc"契约冻结需要人为裁决"的定位相反） | 明确不采纳其核心思路；已在 §3"明确不做"重申 |

---

## 5. 结论

docc 的骨架设计（引擎/数据分离、fail-open、零依赖核心链路、同会话去重）没有需要推翻的问题。真正需要动手的，按性价比排序：

1. **锚点精确匹配**（2.2）——是正确性 bug，成本最低，应该马上修，不必等"触发条件出现"。
2. **契约门声明→台账数据通路**（2.3）——不修的话，docc 最核心的"审查证据链"卖点在事中这一环是空的。
3. **P0 结构指纹**——一旦真实项目里出现格式化误报会立刻感知到，到时候按原路线图 + 2.6 的埋点先确认再动手。
4. 其余（LEDGER 关系图、CI 门禁、报告可视化）按团队实际规模和台账条目数增长情况排期，不必抢跑。
