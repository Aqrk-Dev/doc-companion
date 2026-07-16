# doc-companion

一个让文档跟着代码走的 Claude Code 插件。

> English documentation: [README.en.md](README.en.md)

## 这是什么

AI 帮你改代码的时候,文档常常悄悄过期——接口变了、字段改了,说明书还停在上个版本,没人注意到。doc-companion 让每一次触及契约的改动都被看见:改到关键文件时,会被要求先声明这次改动对文档的影响;每个阶段开工前,先把已有的文档漂移对拍归零;收尾时自动生成变更台账、记录对账结果并盖章存档。它不会替你写文档,也绝不会挡你的路——所有检查都是 fail-open,出问题就放行并提示,而不是把你卡住。

## 安装

```
/plugin marketplace add Aqrk-Dev/doc-companion
/plugin install docc@doc-companion
```

## 环境要求

| 组件 | 要求 |
|---|---|
| 操作系统 | Linux / macOS / WSL / 原生 Windows |
| Node.js | ≥18,且在 PATH |
| git | 必需 |

## 快速上手

1. 每个仓库跑一次 `/docc:init`——对话式生成映射文件与哈希基线。
2. 日常写代码不用操心,hooks 全自动提醒/拦截。
3. 每个阶段开工前跑 `/docc:preflight`,收尾跑 `/docc:postflight`。

## 日常你会遇到什么

- **改到映射文件** → 收到一次性锚点提醒,无需任何动作。
- **改到 `critical` 契约文件** → 被拦一次:在消息里声明这次改动对文档的影响,把声明草稿里的 `<!-- pending -->` 替换成你的声明,原样重试即放行——同一会话同一文件不会再拦第二次。
- **会话快收尾** → 收到一行提醒,提示该跑 `/docc:postflight` 了。
- **盖章被拒(`stampBlocked`)** → 说明还有候选没走完对拍,或映射本身有缺陷:跑完对拍带上 `--verdict` 重新盖章,或者去修映射;确有例外场景可以 `--force` 显式跳过。

## 配置速查

```json
{
  "version": 1,
  "config": {
    "ledgerDir": ".docc/LEDGER",
    "exclude": ["ent/", "**/*_pb.go"],
    "history": true,
    "historyLimit": 500
  }
}
```

- `version`:map.json 的版本号,由 init 生成,勿手改。
- `ledgerDir`:变更台账存放目录,默认 `.docc/LEDGER`。
- `exclude`:额外排除的文件/目录,不参与漂移追踪。
- `history`:是否把每次盖章记一行到 `.docc/history.jsonl`,默认开启。
- `historyLimit`:history.jsonl 最多保留的行数,默认 500,`0` 为不限。

精确语义(pattern/anchor/exclude 的匹配规则等)见[深入参考](docs/REFERENCE.md)。

## CI / pre-commit(可选)

`--check` 标志可以在 pre-commit hook 或 CI 里检查"会话外提交"是否引入了漂移或映射问题;干净时 exit 0,有问题时非零退出。

```sh
node <插件路径>/scripts/doc-preflight.mjs --cwd . --check
```

## 常见问题与限制

**支持 Windows 吗?** 支持,原生 Windows(含无 Git Bash 的 PowerShell)自 0.6.0 起可用。

**monorepo 里的子目录怎么用?** 在包含 `.docc/` 的子包(或其子目录)内开会话即可。

**多个会话并行安全吗?** 各会话各写各的声明草稿,postflight 收尾时人工对账;并发下的重复拦截极少发生,重试即可通过。

**升级要注意什么?** 看 [CHANGELOG.md](CHANGELOG.md);升级后如果盖章被拒,先修好映射里的缺陷,例外场景可以 `--force`。

**`pattern` 为什么不支持 `!`/`{a,b}` 这类排除语法?** 这是有意的极简设计;排除需求走 `config.exclude`。

## 深入参考

报告字段与码表、盖章门精确语义、锚点与 glob 语义、数据目录结构、设计红线、结构指纹重评判据等完整细节,见 [docs/REFERENCE.md](docs/REFERENCE.md) 与 [CHANGELOG.md](CHANGELOG.md)。

## License

MIT
