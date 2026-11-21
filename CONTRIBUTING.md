# 协作规范

本项目按 **GitHub Flow** 协作：`main` 永远可运行，所有较大的改动都经过 issue → 分支 → PR → 合并。

## 1. 什么时候开 issue + PR

| 改动 | 流程 |
|---|---|
| 新功能、新插件、架构调整、跨多个模块的重构 | **必须** issue + 分支 + PR |
| Bug 修复 | issue + PR（一行的小修可以只开 PR） |
| 错别字、注释、依赖小版本更新 | 可以直接提交到 `main` |

架构决策另写 ADR（`docs/adr/`），在 issue / PR 中引用。

## 2. Issue

用模板创建（功能 / 缺陷 / 设计讨论）。每个 issue 必须写清：

- **背景**：为什么要做
- **验收标准**：做到什么程度算完成，尽量可测
- 归属的**里程碑**（M1、M2…）和**标签**（`type:*`、`area:*`）

## 3. 分支

```
<类型>/<issue 编号>-<简短描述>
```

例：`feat/12-web-chat`、`fix/31-lease-expiry`、`docs/40-adr-taint`。分支短命，合并后删除。

## 4. 提交信息

遵循 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/)，并要求写正文：

```
<类型>(<范围>): <一句话说明做了什么>

为什么：
动机、背景、要解决的问题。

做了什么：
- 关键改动 1
- 关键改动 2

验证：
跑了哪些测试 / 评测，结果如何。

Refs #12
```

- **类型**：`feat` 新功能 · `fix` 修复 · `docs` 文档 · `refactor` 重构 · `test` 测试 · `perf` 性能 · `eval` 评测 · `build` 构建与依赖 · `ci` · `chore` 杂项
- **范围**：`core`、`web`、`broker`、`plugin-<名字>` 等
- 主题行不超过 72 个字符；除 `docs`/`chore` 和小修外，正文的"为什么 / 验证"必填
- 用 `Refs #N` 关联 issue；PR 里用 `Closes #N` 在合并时自动关闭
- 一个提交只做一件事，便于回溯与回滚

本地启用提交模板与校验：

```bash
git config core.hooksPath .githooks
git config commit.template .gitmessage
```

## 5. Pull Request

- 用 PR 模板，写清：关联 issue、改了什么、为什么这样做、如何验证、截图（界面改动）、风险与回滚方式
- 合并前：类型检查、测试、gitleaks 全部通过
- **合并方式：`--no-ff` 合并提交**，保留分支上的每个详细提交，同时留下 PR 编号，方便回溯

## 6. 里程碑与发布

- 每个里程碑对应 GitHub Milestone，见 [路线图](docs/roadmap.md)
- 里程碑完成时打标签 `v0.<里程碑号>.0`，在 Release 中写更新说明
