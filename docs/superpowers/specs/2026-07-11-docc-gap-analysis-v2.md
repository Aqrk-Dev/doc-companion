# docc gap 分析 v2(v0.2.0 审计结论与 0.2.1 处置)

- **日期**:2026-07-11
- **方法**:对 v0.2.0(commit `6b2aa60`)做 15-agent 审计——功能清单 + 5 镜头(hooks 协议/引擎/skills 规程/安全健壮性/产品缺口)并行查找 + 逐条对抗验证(候选按严重度取前 9 条,全部在 /tmp 一次性仓库复现确认,0 条被驳倒)。
- **上游**:`2026-07-11-docc-gap-analysis.md`(v1)。

## 1. 经复现确认的 9 条与处置

| # | 问题 | 严重度 | 处置(0.2.1) |
|---|---|---|---|
| 1 | 删除盲区:已删/移出映射的纳管源文件零信号,`ok:true` 假干净;再盖章销毁基线记录 | high | **已修**:反向对账——基线有记录但未纳管的文件进入 `driftCandidates` |
| 2 | `git ls-files` 超 spawnSync 默认 1MB → preflight 整体失效并误报"非 git 仓库"(实测 3201 文件触发) | high | **已修**:`maxBuffer 64MB`;顺带 `-c core.quotepath=false` 修非 ASCII 源文件名漏纳管(v1 已知项) |
| 3 | postflight 核对范围(diffBase...HEAD)与盖章范围(全基线)脱节:在 main 上开发时 diff 恒空,未对拍漂移被盖章静默吸收 | high | **待设计裁决**(见 §2) |
| 4 | 不可哈希文件(悬空 symlink、gitlink)被 `if(!h) continue` 静默吞掉 | high(与 #1 同主题) | **已修**:`warnings` 报"无法哈希(已跳过)" |
| 5 | `docs[].file` 无仓库包含性校验,`../` 可越界读取/哈希仓库外文件 | medium | **已修**:`repoRelative` 校验,越界报 mapIssue 并拒绝 |
| 6 | history.jsonl 只记盖章时刻计数、无语义判定字段,无法支撑其设计目标(判断"格式化误报是否真实出现"=P0 结构指纹触发条件)——v1 建议方案自身的设计缺口 | medium | **待设计裁决**(见 §2) |
| 7 | 同会话并发 hook 进程 state 读-改-写竞态:gated 记录丢失(实测 10 轮丢 2)→ 违背"重试即放行"承诺、重复声明 stub | medium | **部分缓解**:状态文件 tmp+rename 原子写(杜绝半写损坏);竞态窗口留存,已写入 README 已知限制 #2 |
| 8 | 盖章写入非原子 + 基线损坏被静默当作"无基线" → docDrift 防篡改静默失效(实测截断基线后篡改不再上报) | medium | **已修**:盖章 tmp+rename;基线"损坏≠不存在",损坏报 mapIssue"哈希基线文件损坏" |
| 9 | `git hash-object` 未加 `--no-filters`,受 core.autocrlf/.gitattributes 影响 → 混合配置团队幻影漂移与基线抖动 | medium | **已修**:`--no-filters`;README 升级说明 #5(哈希口径变化,升级首跑一次性全量候选,重盖章恢复) |

## 2. 待设计裁决(下一轮优先)

> 2026-07-11 更新:两条均已在 v0.3.0 落地——#3 范围改源+盖章门(--force 逃生口),#6 盖章 --verdict 四类判定入 history。详见 `2026-07-11-docc-v0.3.0-design.md`。

1. **postflight 范围一致性(#3)**:候选方向——(a) 盖章前强制对账"本次报告的 driftCandidates/docDrift 是否都在核对清单内",不一致时拒绝盖章或降级软告警;(b) diffBase 恒空时(同分支)以"上次盖章以来的 driftCandidates"替代 diff 圈定核对范围。涉及 postflight SKILL 流程与脚本的职责划分,须与"盖章是有意识决定"的定位一起裁决。
2. **history 数据模型(#6)**:候选方向——preflight(非 stamp)也追加记录,并增加语义判定字段(由 skill 在对拍后回写,如 `{verdict:{real:N,formatting:N,docLag:N}}`)。改动采集点与 schema,现有行为是 v1 gap 2.6 建议方案的忠实实现,升级需迁移说明。

## 3. 未验证候选 22 条(按镜头分组,验证截断于前 9)

> 2026-07-11 更新:本节结构性条目已在 v0.4.0 处置——报告 schema 类型化(stampBlocked/码表)、--stamp 受 mapIssues 约束(baseline-corrupt 豁免)、归零判据+verdict-count-mismatch、草稿生命周期(id/两阶段/时序/分组)、a**b 单星、批量哈希(约 250 倍提速)、history 轮转、version 激活、INDEX 机检、rename 行解析。平台覆盖类(NotebookEdit/子目录/Windows)仍留档。

**skills 规程逻辑**:--stamp 不受 mapIssues 约束(坏映射照样盖章);preflight"归零"判据与报告语义脱节(重跑必然仍列已处理候选);"代码违约登记例外"无落地机制且下次盖章吸收例外;postflight 跨会话收割并删除活跃会话草稿(归属/存活性无检查);postflight 第 6 步索引校正可能触发契约门而草稿已删,新声明错位;降级路径 Grep 锚点校验与脚本不等价(重新引入长标题假阳性、无歧义检出);降级手工构造 hashes 规程悬空引用且漏"无记录=首次纳管";diffBase 分支不存在时 fatal 无回退指引。

**协议/平台覆盖**:NotebookEdit 绕过契约门(matcher 未覆盖且载荷为 notebook_path)— 2026-07-15 更新:v0.4.1 已处置;会话在仓库子目录启动时整套防护静默失效(未文档化)— 2026-07-15 更新:v0.4.1 已处置;hooks.json 为 POSIX sh 语法,原生 Windows 静默失效— 2026-07-15 更新:v0.6.0 已改 exec form 支持;契约门跨会话遗忘已声明内容(重复拦截+重复 stub 无去重键)。CRLF 跨机混配、同会话状态竞态、gated 无界增长已在 v0.6.0 处置;会话外提交缺口由 opt-in --check 收窄。

**引擎/数据模型**:globToRegExp 连续 `**/` 灾难性回溯(8 个 `**/` 单次匹配 10 秒,ReDoS 面);`a**b` 翻译为 `a.*b` 跨 `/` 匹配偏离常规 globstar 语义;每文件一次 spawnSync hash-object(实测 1000 文件 1.84s vs 批量 7ms,差 250 倍);history.jsonl 无上限无轮转且随仓库提交;DOC-MAP `version` 死字段(无校验无迁移);warnings 混装映射级/盖章级两类语义无类型码;gate 事件(state.gated)从不被 postflight 消费,stub 写失败的事件必然缺席对账;INDEX.md 零机器校验;listDirtyLedgerFiles 对 rename 行解析出伪路径(fail-open 吸收)。

## 4. v1 遗留的有意不做(边界不变)

结构指纹(触发条件观测依赖 §2.2 裁决)、LEDGER 关系图、人类可读报告、CI 门禁、`.claude/` 恒排除 vs `.claude/commands/` 纳管诉求、自动再生文档内容(永久不做)。
