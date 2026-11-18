# 学习平台内核

本仓实现可复用的在线学习活动内核。执行 Agent 从 [AGENTS.md](AGENTS.md) 和[仓库级 ub-mode 技能](.agents/skills/ub-mode/SKILL.md)开始。产品进度见[首版实施清单](docs/学习平台内核首版实施清单.md)，领域分层见[参考架构](docs/学习平台内核参考架构.md)，练法验收见[在线两步阅读实施规格](docs/在线两步阅读实施规格.md)。移入的设计文档保留[原许可](docs/LICENSE)。

## 本地开发

使用 Node 24.19.0、pnpm 12.6.0。SQLite 使用该 Node 版自带的 `node:sqlite`，无需数据库服务。请在独立检出的 Git 仓库根目录运行：

```sh
pnpm install --frozen-lockfile
pnpm run hooks:install
pnpm run verify
```

`verify` 顺序执行 `lint`、strict 类型检查、源码规模检查和真实测试。`node --test tests/database.test.ts` 单独验证首次建库、重复初始化、关闭后只读重开及初始化失败后的恢复。`openDatabase(path)` 在事务内应用迁移，`schema_migrations` 记录已应用的版本。数据库测试在系统临时目录中创建独立文件，结束后清理。

`node --test tests/single-quote.test.ts` 通过真实本地 HTTP 服务验收单步引文。用例由服务端注入学生会话，覆盖启动和提交重发、草稿升版、文件库重开和跨学生拒绝。累计验收要求数据库组和单步服务组都实际执行。

## 源码规模与持续集成

`pnpm run lint` 用锁定的开发依赖 `@babel/parser` 识别 JS/TS 语法。所有受检源码都检查普通注释、压制指令和显式 `any`，测试路径还检查常用入口的聚焦调用。允许 shebang 和独占文件头一行的 SPDX 标识。别名和运行时配置需要人工审查。

`pnpm run lint` 和 `pnpm run check:size` 检查 Git 跟踪及未忽略的新源码。克隆后执行一次 `pnpm run hooks:install`，提交前两项快检只读暂存版本。CI 对 PR 和 `main` 的 push 重新执行完整 `verify`，不依赖本地钩子。规模豁免不等于 lint 豁免。参见[开发约定](AGENTS.md)和 [PR 模板](.github/pull_request_template.md)。

## 质量审计

当首个产品源码和对应测试进入 `src` 后，运行下面的审计命令。三个独立的 ub-mode 命令需要已安装并在 PATH 内。日常 `verify` 在干净机器上仅依赖本仓锁定的工具。

```sh
pnpm run coverage
crapper --use-existing-coverage --threshold 9.99 src
dryer --threshold 0.8 src
mutator --use-existing-coverage --max-workers 1 --test-command "pnpm test" src
```

覆盖模式需要真实的产品源码。覆盖数据位于 `coverage/lcov.info`，审计工具报告位于 `.metrics/`。比较复杂度时确认每个函数有覆盖数据，重复检测需阅读候选，变异检测需核对实际执行、杀死、存活和未覆盖数。运行完变异测试后再跑一次 `pnpm run verify`。
