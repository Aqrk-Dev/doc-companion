# doc-companion 深度参考

本文是 README 的深度参考;日常使用见 [README.md](../README.md)。

## 环境要求(完整版)

| 组件 | 要求 |
|---|---|
| 操作系统 | Linux / macOS / WSL / 原生 Windows(0.6.0 起,hooks 为 exec form 不依赖 sh) |
| Node.js | ≥18 且在 PATH(hooks 与引擎脚本;无 node 时 hooks 每次编辑给一行非阻塞提示,preflight/postflight 走 skill 内建的手工降级路径) |
| git | 必需(文件枚举、状态、diff;哈希自 0.6.0 起为进程内计算,不依赖 git) |

## 接入一个项目(`/docc:init` 详情)

```
/docc:init
```

init 会对话式生成 `.docc/map.json`(映射 + `critical` 契约标记 + `config`),建立 `.docc/hashes.json` 哈希基线(归一化内容哈希:git blob 口径 sha1,CRLF→LF 归一化,二进制原样;node:crypto 内置,双侧:源码+文档),并输出工作流接线建议。**未 init 的项目装了插件零打扰**(hooks 检测不到 `.docc/map.json` 即静默退出)。

## 数据目录 `.docc/`

```
.docc/
├── map.json        # 契约登记(人维护;契约门内置守护)
├── hashes.json     # 共识基线(盖章重写;内置守护)
├── history.jsonl   # 漂移观测数据(盖章追加;内置守护)
└── LEDGER/         # 变更台账(ledgerDir 可配)
```

整个 `.docc/` 恒排除于漂移追踪(防盖章自引用);三个数据文件由契约门**内置**守护——编辑它们恒需声明,无需登记。

## 四环节详情

| 环节 | 入口 | 行为 |
|---|---|---|
| 事前 | `/docc:preflight` | 哈希比对锁定漂移候选(修改/首次纳管/**已删除**/文档被直改),派内置 `drift-checker` agent(只读)对候选做语义对拍并按四类记数(formatting/docLag/codeViolation/other),漂移归零再开工 |
| 事中 | hooks 自动 | 改到映射文件→提醒一次(每文件每会话);改 `critical` 文件或 `.docc` 数据文件→拦一次要求声明文档影响,同时机写声明 stub 到 `.claude/.cache/doc-companion-<session>.declarations.md` 供 postflight 对账,重试放行;每轮收尾→未处置清单一行提醒(不阻塞) |
| 事后 | `/docc:postflight` | 以机检报告为核对清单(与盖章范围同口径)→ 合并声明草稿 → 五字段台账(+声明对账节,verified-by 标记)→ 索引校正 → 盖章(带 `--verdict` 判定) |
| 索引 | preflight/postflight 内建 | 锚点悬空、锚点歧义、pattern 失配、孤儿清理 |

## 盖章门完整语义

--stamp 时:存在映射缺陷(mapIssues,baseline-corrupt 豁免——重新盖章正是基线损坏的修复手段),或存在真实漂移(基线失配/删除/docDrift)而未附对拍证词则拒绝盖章(stamped:false + stampBlocked 详情),防止"没走完对拍就盖章"把漂移静默吸收进基线。首次纳管无需证词。例外登记场景用 --force 显式跳过,forced 记入 history。

`--verdict` 接受两种形式,自动识别:
- **聚合形式**:`{"formatting":2,"docLag":1,...}`——键∈四类名(`formatting`/`docLag`/`codeViolation`/`other`)、值为非负整数;相符判据是四类计数总和与 `driftCandidates` 数相符。
- **per-file 形式**(推荐,粒度到文件供长期统计):`{"src/a.ts":"docLag","src/b.ts":"formatting"}`——值为四类名字符串之一;相符判据升级为**集合相等**——键集合须与 `driftCandidates` 的 file 集合完全一致。值非法(非四类名字符串)的条目会被丢弃(`verdict-invalid-value`),天然破坏集合相等。

识别规则:JSON 为纯对象且存在任一值为合法四类名字符串 → 判定为 per-file 形式;空对象 `{}` 维持聚合形式语义(候选 0 时天然相符)。相符的 verdict(任一形式)就是"对拍已完成"的机器可读凭证,正常收尾周期不再依赖 `--force`。

## 设计红线

- **fail-open**:任何脚本异常、状态损坏、运行时缺失 = 放行 + 告警,绝不阻塞开发;契约门状态不可写时降级放行;盖章门拒绝仍 exit 0,只影响盖章动作本身。
- **同会话同文件只拦一次**:迭代式"编辑→测试→再编辑"不受契约门干扰。
- **运行时分层**:核心链路只依赖 git;哈希算法自算(node:crypto 内置,零 npm 依赖,归一化 CRLF→LF);hooks 需要 node(≥18 于 PATH),无 node 机器每次编辑收到一行非阻塞提示(不再全静默);skill 有手工降级路径。
- **引擎零项目耦合**:本仓库代码不含任何具体项目信息。
- **契约冻结靠人为裁决**:工具只记录、比对、催促、留证,绝不代写文档;`--force` 保留人的最终决定权。

## map.json 精确语义

```json
{
  "version": 1,
  "config": {
    "ledgerDir": ".docc/LEDGER",
    "exclude": ["ent/", "**/*_pb.go"],
    "history": true,
    "historyLimit": 500
  },
  "entries": [
    {
      "pattern": "src/api/**",
      "docs": [
        { "file": "docs/appendix.md", "anchor": "### 2.6", "note": "API 契约", "critical": true },
        { "file": "README.md", "anchor": "## 状态" }
      ]
    }
  ]
}
```

- `pattern`:极简 glob——`**` 仅在**段边界**跨路径段(`src/**`、`**/x.ts`);段内 `**` 等价单星不跨 `/`(`a**b` 同 gitignore 语义);`*` 段内 / `?` 单字符;连续 `**/` 自动折叠。
- `anchor`:标题行前缀,**边界匹配**(前缀后须行尾或空白);命中 ≥2 处报"锚点歧义"。
- `critical`:事中契约门开关。
- `config.exclude`:排除数组——成员含 `*`/`?` 按 glob 整路径匹配(如 `**/*_pb.go`),否则按目录前缀(如 `ent/`);叠加在默认排除(`.understand-anything/`、`.claude/`、`.docc/`)之上。适用于**入库的**生成物;未入库的(.gitignore 覆盖)本来就不纳管。
- `config.history`:缺省 true——盖章时向 `.docc/history.jsonl` 追加一行 `{ts,driftCandidates,docDrift,mapIssues,warnings,stamped,forced,verdict,verdictFiles?}`;`verdict` 来自 `--verdict`(四类判定计数;per-file 形式下由文件级映射派生),用于回答"格式化误报是否真实出现"等长期问题;`verdict` 仅在成功盖章的行携带(拒绝行为 null),统计无需额外过滤;`verdictFiles`(optional)——仅当 `--verdict` 为 per-file 形式且成功盖章时携带,值为 `{file: category}` 文件级证词映射,其余情形省略该键;建议随仓库提交。**结构指纹重评判据**:最近 20 条 `stamped:true` 且 verdict 非空的 history 行中,Σformatting/Σ(四类和) ≥ 30% 且 Σformatting ≥ 5 → 格式化误报已真实出现,重开结构指纹评估;未达阈值维持字节哈希。统计命令(容忍撕裂行——进程被杀导致的半写行会被跳过而非让整条命令崩溃):`node -e 'const l=require("fs").readFileSync(".docc/history.jsonl","utf8").trim().split("\n").map(l=>{try{return JSON.parse(l)}catch{return null}}).filter(Boolean).filter(r=>r.stamped&&r.verdict).slice(-20);const s=k=>l.reduce((a,r)=>a+(r.verdict[k]||0),0);const f=s("formatting"),t=f+s("docLag")+s("codeViolation")+s("other");console.log({formatting:f,total:t,ratio:t?+(f/t).toFixed(2):0})'`
- `config.historyLimit`:history.jsonl 最大行数,超出只保留最新 N 行(缺省 500,`0` 不限)。

## 报告字段全解

`scripts/doc-preflight.mjs [--stamp] [--force] [--verdict '<json>'] [--cwd <dir>] [--check]` 输出 JSON:`ok`(mapIssues 为空;盖章拒绝**不**影响 ok)、`driftCandidates`(结构化,按 file 排序:`{file, kind, docs}`——`kind` 为 `modified`(基线有记录且失配)/`new`(无记录,首次纳管)/`removed`(基线有记录但本次未纳管:已删/改名/移出映射);`docs` 为命中该文件的所有 entry 的 docs 合并去重后的数组,元素 `{file, anchor?, critical?, note?}`(anchor/note 缺省省略,critical 仅 true 时输出;removed 的 docs 由记录路径对全部合法 pattern 重新匹配求得))、`docDrift`(string[])、`mapIssues` 与 `warnings`(元素为 `{code, message}`——mapIssues 码:`bad-entry/bad-pattern/pattern-no-match/doc-escape/docc-dir-doc/doc-missing/anchor-missing/anchor-ambiguous/baseline-corrupt/stamp-write-failed`;warnings 码:`pattern-only-excluded/unhashable/ledger-verified-by-missing/verdict-missing/verdict-count-mismatch/verdict-file-mismatch/verdict-parse-failed/verdict-unknown-key/verdict-invalid-value/history-write-failed/ledger-not-indexed`——`verdict-file-mismatch` 仅 per-file 形式产生,与 `verdict-count-mismatch`(仅聚合形式产生)互斥)、`stampBlocked`(盖章拒绝详情 `{realDriftCount, docDriftCount, mapDefects, message}`,非 stamp 或未拒绝为 null)、`stamped`。

## CI / pre-commit 完整说明

可用 `--check` 标志在 pre-commit hook 或 CI step 收窄"会话外提交"的缺口。脚本照常输出报告,但按以下逻辑退出:
- 有映射问题 / 漂移候选 / 文档改动:exit 1(存在问题)
- 全部清洁:exit 0(通过)
- 用法错误(如 `--check --stamp` 并用):exit 2

示例接线(pre-commit hook 或 CI step):
```sh
node <插件路径>/scripts/doc-preflight.mjs --cwd . --check
```

非零退出 = 漂移候选/映射缺陷/文档被改,或环境错误(缺 `.docc/map.json`、非 git 仓库)。引擎只提供命令模板,项目自行接线。

## 已知限制(完整版)

1. **glob 无排除语法**:pattern 不支持 `!`/`{a,b}`/`[abc]`;排除需求走 `config.exclude`。
2. **多 agent/worktree 并发不合并声明**:并行会话各写各的声明草稿,postflight 合并时需人工对账;同会话并行子 agent 仍有极小竞态窗口(合并式写入——写前重读磁盘最新状态再取并集,记录不丢失;窗口已从"整个 hook 生命周期"收窄至重读与原子写之间的微秒级,窗口内仍可能重复拦截一次,fail-closed,重试即放行)。同一文件在盖章前的重复编辑跨会话只拦一次(去重键=文件@基线哈希,盖章后基线变更自动重新设防);并行会话对共享去重文件为最后写者赢。例外:`.docc` 三内置文件(`map.json`/`hashes.json`/`history.jsonl`)恒排除于基线之外,不参与跨会话去重(每会话仍拦一次)——否则它们的去重键永远落 `@unbaselined`,一台机器一生只拦一次会让内置自守护形同虚设。
3. **仅 Claude Code 会话内生效**:会话外提交无门禁,靠下一次 preflight 被动发现(可用 `--check` 在 pre-commit/CI 收窄该缺口,opt-in);`.docc/hashes.json` 被会话外手工篡改无实时防护,靠 git 历史审计;`.docc/map.json` 损坏时 fail-open 会连同内置守护一起旁路(hooks 静默退出),修复 map.json 后恢复。
4. **升级(破坏性)**:1.0 前版本均可能破坏性变更,各版本变更与迁移动作见 [CHANGELOG.md](../CHANGELOG.md)。当前要点:0.5.x → 0.6.0 含 CRLF 的文本文件基线一次性失效(preflight 浮为 modified 候选,postflight 以 formatting verdict 重盖章吸收);既有映射缺陷在升级后首个盖章会被拒——先修映射,例外登记场景一次性 `--force`。
5. **CRLF 跨机混配**:已在 0.6.0 由归一化哈希(自算 CRLF→LF)根治;LF 文件升级前后字节完全等价,CRLF 文件升级首次出现浮为 modified 候选(verdict 记 formatting);二进制文件(含 NUL 字节)保持原样比对。
6. **子目录/monorepo**:hooks 与 preflight 以**最近祖先** `.docc/map.json`(限定在当前 git 仓库根内)定位仓库根,v0.4.1 起支持在含 `.docc/` 的目录**或其子目录**内启动会话;顶层无 `.docc/` 而 `.docc/` 在某子包内的 monorepo,需在该子包(或其子目录)内启动会话,否则走"未 init 零打扰"。仅在 git 仓库内自子目录向上发现 `.docc/`;非 git 项目仅认会话起始目录自身的 `.docc/`(不采信祖先)。
7. **平台**:原生 Windows(含无 Git Bash 的 PowerShell 环境)自 0.6.0 起支持(hooks 为 exec form 不依赖 sh)。NotebookEdit 自 v0.4.1 起纳入契约门/提醒档覆盖。

## 本仓库自身测试

```
node --test
```

当前基线 120/120 通过。
