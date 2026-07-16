# Changelog

1.0 之前所有版本均可能破坏性变更(升级说明随版本给出)。通用提醒:既有映射缺陷在升级后首个盖章会被拒——先修映射,例外登记场景一次性 `--force`。

## 0.9.1 — 2026-07-16

- README 重构为面向用户(快速上手/日常场景/FAQ);全部深度参考内容一字不丢迁至 `docs/REFERENCE.md`;README.en.md 同步。纯文档,无行为变化。

## 0.9.0 — 2026-07-15

- **运行时输出全英文化**:报告 message、契约门/提醒/收尾 hook 文案、声明 stub 标签(`- Contract anchors:` / `- Declaration:`)改为英文——机器契约(`code` 字段、`<!-- pending -->`、verified-by 标记、字段名)不变。若有脚本匹配中文 message 文本需改为匹配 `code` 字段(message 从来不是契约)。
- 新增 `README.en.md` 英文文档,中英互链;README.md 保持中文。

## 0.8.0 — 2026-07-15

- `--verdict` 支持 **per-file 形式**(推荐):`{"src/a.ts":"docLag",...}`——盖章证词从计数相等升级为与候选**集合相等**(新告警码 `verdict-file-mismatch`),history 行携 `verdictFiles` 支持按路径/类型长期统计;聚合计数形式完全兼容。drift-checker agent 的 Tally 输出与 skills 同步为 per-file 形式。
- 新增仓库自身 CI(GitHub Actions:ubuntu/windows/macos × node 18/22 跑 `node --test`)——首次在真实 Windows 环境验证引擎与测试。
- init skill 增加小仓库快路径:整份 map 草案 + 一次性确认,替代逐项提问。无 breaking。

## 0.7.1 — 2026-07-15

- 三个 skill(init/preflight/postflight)全文改为英文(与 drift-checker agent 一致);机器契约字面量(codes/字段名/`<!-- pending -->`/verified-by 标记/统计命令)逐字节保留;postflight 台账模板小节标题随之英文化(agent 书写内容,非机器校验)。无 breaking。

## 0.7.0 — 2026-07-15

- 新增内置 **`drift-checker` agent**(`agents/drift-checker.md`,英文定义,只读):preflight 第 2 步语义对拍的标准执行者——输入结构化候选 `{file, kind, docs}`,输出逐锚点判定(含证据引用与方向 update-doc/escalate)+ 可直接透传 `--verdict` 的 tally JSON。preflight SKILL 第 2 步接线(无该 agent 的环境保留会话内逐条核对降级路径)。无 breaking。

## 0.6.0 — 2026-07-15

**Breaking**:哈希口径从 `git hash-object` 子进程改为**归一化内容哈希**(node:crypto,git blob 口径 sha1 + 文本 CRLF→LF 归一化,二进制原样)。LF 文件哈希逐字节不变、基线兼容;**含 CRLF 的文本文件基线一次性失效**——升级首跑 preflight 浮为 `modified` 候选,postflight 以 `--verdict '{"formatting":N,...}'` 重盖章吸收。

- hooks 改 **exec form**(不经 shell):原生 Windows(含无 Git Bash 的 PowerShell 环境)支持;无 node 机器由全静默改为每次编辑一行非阻塞提示。
- 新增 `--check` 退出码模式(opt-in):pre-commit/CI 轨,漂移/映射缺陷/文档被改/环境错误时非零退出;默认路径恒 exit 0 不变。
- 会话状态合并式写入(写前重读取并集):并发 hook 竞态不再丢记录。
- 共享跨会话去重文件:换键清旧 + 盖章时 GC 死键(有界)。
- 大仓枚举缓冲 64MB→256MB;删除批量哈希/回退机制(不再需要)。

## 0.5.0 — 2026-07-15

**Breaking**:报告 schema——`driftCandidates` 由字符串数组改为 `{file, kind: modified|new|removed, docs:[{file,anchor,critical,note}]}`(候选自携锚点关联);`stampBlocked` 计数字段更名 `realDriftCount`/`docDriftCount`。自定义消费脚本需适配。

- 契约门跨会话去重:键=`文件@基线哈希`,盖章后基线变更自动重新设防;`.docc` 三内置文件豁免(自守护每会话仍拦)。
- verdict 防呆:新增 `verdict-parse-failed`/`verdict-unknown-key`/`verdict-invalid-value` 软告警。
- 契约门 stderr 与声明 stub 补 `note` 上下文;结构指纹重评判据(history verdict 统计)写入文档。

## 0.4.1 — 2026-07-15

- NotebookEdit 纳入契约门/提醒档(matcher + `notebook_path` 回退)。
- 子目录会话向上发现 `.docc` 根(最近祖先,限当前 git 仓库内;非 git 项目仅认起始目录自身)。
- 已知限制文档化:CRLF 跨机混配(0.6.0 已根治)、Windows(0.6.0 已支持)、同会话竞态(0.6.0 已修)。

## 0.4.0 — 2026-07-11

**Breaking**:报告 schema 类型化(`mapIssues`/`warnings` 元素为 `{code,message}`,新增 `stampBlocked` 独立字段);glob 段内 `**` 对齐 gitignore 单星语义(不再跨 `/`)。

- 盖章门:映射缺陷或真漂移缺相符 `--verdict` 证词时拒绝盖章(`--force` 例外登记)。
- 声明草稿生命周期:stub 勾稽 id、两阶段删除、对账按文件分组;preflight 归零判据重写。
- history 轮转(`historyLimit` 缺省 500)、`map.json` version 校验激活、INDEX.md 机检、批量哈希提速(约 250 倍,0.6.0 起由进程内哈希取代)。

## 0.3.x — 2026-07-11

**Breaking**:数据目录迁移 `docs/DOC-MAP*` → `.docc/`(`map.json`/`hashes.json`/`history.jsonl`),`ledgerDir` 缺省 `.docc/LEDGER`——0.2.x 用户删除旧文件后重新 `/docc:init`(台账手工移动)。

- 删除盲区修复:基线反向对账,已删/改名文件浮为漂移候选。
- 大仓修复(枚举缓冲)、`--no-filters`(单机 autocrlf 影响消除)、`docs[].file` 越界拒绝、基线损坏显式告警、原子写、`--verdict` 对拍判定落 history(0.3.1:仅随成功盖章落行)。

## 0.2.0 — 2026-07-11

- 锚点边界匹配(前缀后须行尾或空白)+ 歧义检测——修裸前缀假阳性;升级后既有假阳性锚点会浮为 `锚点未找到`,属预期暴露。
- 契约门机写声明 stub → postflight 对账通路;`verified-by` 台账软校验;`warnings` 报告字段;漂移历史埋点;默认排除 + `config.exclude`;自引用文件防护。

## 0.1.0 — 2026-07-09

初始版本:三档 hook(契约门/提醒/收尾)、`preflight`/`postflight`/`init` 三 skill、git hash-object 双侧哈希基线、五字段台账、fail-open 体系。
