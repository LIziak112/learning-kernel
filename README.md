# 学习平台内核

本仓实现可复用的在线学习活动内核。执行 Agent 从 [AGENTS.md](AGENTS.md) 和[仓库级 ub-mode 技能](.agents/skills/ub-mode/SKILL.md)开始。产品进度见[首版实施清单](docs/学习平台内核首版实施清单.md)，领域分层见[参考架构](docs/学习平台内核参考架构.md)，练法验收见[在线两步阅读实施规格](docs/在线两步阅读实施规格.md)。移入的设计文档保留[原许可](docs/LICENSE)。

## 从干净检出验收

若任务是 OwnClass 全量迁移而非内核首版验收，从[迁移启动提示词](docs/迁移/启动提示词.md)开工，进行到哪一批只看[兼容台账](docs/迁移/兼容台账.md)。

使用 Git、Node 24.19.0 和 pnpm 12.6.0。SQLite 使用 Node 自带的 `node:sqlite`。在待验收修订的干净 Git 检出根目录运行：

```sh
pnpm run accept:fresh
```

命令按锁文件安装依赖，准备锁定版 Playwright 的 Chromium，并执行累计门禁。它输出被测 Git 修订、四个异常场景、三个声明对照和师生浏览器链路的实跑数与通过数。安装目录和浏览器位于本次检出的 `target/acceptance/`。首次安装需要访问 npm 注册表和 Playwright 浏览器下载服务。各用例在系统临时目录创建独立 SQLite 库并在结束后清理。

## 本地开发

开发时可单独安装依赖和测试浏览器，并运行累计门禁。

```sh
pnpm install --frozen-lockfile
pnpm run hooks:install
pnpm exec playwright install --only-shell chromium
pnpm run verify
```

`verify` 顺序执行 `lint`、strict 类型检查、源码规模检查和真实测试。`node --test tests/database.test.ts` 单独验证首次建库、重复初始化、关闭后只读重开及初始化失败后的恢复。`openDatabase(path)` 在事务内应用迁移，`schema_migrations` 记录已应用的版本。数据库测试在系统临时目录中创建独立文件，结束后清理。

`node --test tests/single-quote.test.ts` 通过真实本地 HTTP 服务验收单步引文。用例由服务端注入学生会话，覆盖启动和提交重发、草稿升版、文件库重开和跨学生拒绝。累计验收要求数据库组和单步服务组都实际执行。

`pnpm run build` 编译服务端并将演示资源写入 `target/runtime/`。`node --test tests/reading-contrasts.test.ts` 一次构建后在同一产物上验证三个声明。仅运行该文件时使用开发段落安装的 Chromium。

## 接入外部宿主

在内核仓构建并打包服务端入口。交接时记录源码提交号和 `.tgz` 的 SHA-256。

```sh
pnpm run build target/host-package
npm pack ./target/host-package --ignore-scripts --pack-destination ./target
```

宿主把同一份 `.tgz` 放入自己的受控交付目录，并将文件依赖及锁文件纳入交付。例如依赖放在 `vendor/` 时，可运行 `pnpm add ./vendor/learning-kernel-0.1.0.tgz`。宿主服务使用 Node 24.19.x，从包名导入公开入口，TypeScript 使用 `NodeNext` 模块解析。

```ts
import { openLearningRuntime } from "learning-kernel";

const runtime = openLearningRuntime({ databasePath: "data/learning.sqlite" });
runtime.publish(frozenPublication);

const principal = { role: "student", id: currentStudentId } as const;
const receipt = runtime.start(principal, { protocolVersion: 1, operationId, practiceId, practiceVersion });
const activity = runtime.read(principal, receipt.activityId);
```

宿主在服务端确定发布内容，并在每次开卷和读取前验证当前身份及作业访问资格。`principal` 由通过验证的学生身份映射，开卷命令须指定已发布的练法版本。相同学生和操作标识重发同一开卷命令时取回原回执。以同一操作标识改用另一练法或版本会得到 `OPERATION_CONFLICT`。内核按活动归属及当前内核访问规则读取学生视图。宿主进程退出时调用 `runtime.close()`，重启后以同一文件库打开并通过原活动 ID 读取。

`formatVersion: 1` 的练法可以只绑定题目，此时发布可同时省略 `material` 和 `practice.material`。步骤绑定材料时须同时提供材料定义和匹配的版本引用。学生读取当前步骤获准的题目或材料。

可信宿主可用 `prepare(principal, input)` 显式预备阅读活动，沿用 `start` 的输入及原始回执。在首个作品、确认或步骤推进前，`replacePreparedActivityVersion(principal, activityId, input)` 可切换到同一练法已发布的另一版本，首个逻辑步骤须一致。传入 `protocolVersion`、`operationId`、当前 `stepAttemptId`、`expectedPracticeVersion` 和目标 `practiceVersion`。换版保留活动标识及原起算时刻，发行新的步骤尝试凭据，旧凭据无法保存或确认。指定当前版本时沿用当前步骤凭据。`read` 在同一快照返回当前 `practiceVersion`、步骤凭据和题面。重发按当前授权交付对应的原回执。普通 `start` 创建的活动固定原教学版本。

可信宿主在配套备份或恢复时可直接从服务端包调用 `verifyActivityBindings(databasePath, claims)`。传入 `protocolVersion: 1`、已绑定活动 `bindings: [{ activityId, studentId, operationId }]` 和持久开卷意图 `openingIntents: [{ studentId, operationId }]`。每个已绑定活动须精确存在，内核的每个活动须由一条绑定或已持久化的开卷意图覆盖。尚未开卷的意图可以暂时没有内核活动。绑定、意图及两者之间的重复开卷键，任何遗漏或身份不符，均返回 `ACTIVITY_BINDINGS_MISMATCH`。通过时无返回数据。核验直接只读打开指定快照，缺失或不可读的文件报错。宿主从同一份配套快照提取绑定和意图，核验通过后再使用该配套备份。

配套备份也可传入 `teacherAmendments: { completed, pending }`。每条勘误声明包含 `kind`（`answer` 或 `snapshot`）、`activityId`、`studentId`、`stepAttemptId`、`slotId`、`questionId`、`reviewerId`、`operationId` 和回执的对外 `revision`。待处理意图可用命令的 `baseRevision + 1` 确定预期修订。每条已完成声明须对应一条内核勘误。待处理意图可覆盖已提交到内核或尚未提交的勘误；后者须绑定库中实际的学生、活动、步骤、题目和槽位。同一个操作只能占一个位置。遗漏、重复或身份及修订冲突均返回 `TEACHER_AMENDMENTS_MISMATCH`。明确传空声明会核实迁移账和勘误表，仅在可证没有记录时通过。省略该字段保留原有开卷核验。两层检查在同一个只读快照中完成。

逐题单选草稿使用 `saveChoiceDraft(principal, activityId, input)`。发布时在题目上声明冻结 `version`。保存指定 `protocolVersion`、当前 `stepAttemptId`、`slotId`、`questionId`、`questionVersion`、题内 `operationId`、`baseRevision` 和选项 ID `choice`。重发相同命令取回原回执，新操作保存与当前相同的选项时回当前修订和变更数。冻结题版本一致的修订冲突或操作冲突通过 `ChoiceDraftConflict.current` 交付判定当时的修订和本人选择。`read` 只向活动本人交付当前步骤的 `choiceDrafts`，没有条目的题从未作答，修订为 0。

旧协议调用同一个方法时省略 `operationId` 与 `baseRevision`。该题接受首次版本化操作前，每次旧协议保存都新增一个修订，包括重复保存相同选项。首次版本化操作即使与当前选项相同且沿用原修订，也会接管该题。此后旧协议保存返回 `ANSWER_REVISION_CONFLICT` 并附当前修订与本人选择。题与题独立接管。没有幂等键的旧协议请求每次都按一次新保存处理。

`saveCurrentChoiceDraft(principal, activityId, input, mode)` 按题目当前稿判定。最近操作标识和当前选项相同时返回当前修订，忽略请求的基础修订。最近操作标识相同而选项不同时返回 `ANSWER_REVISION_CONFLICT` 和当前稿。其他操作同文收敛并成为最近操作，异文要求基础修订等于当前修订。默认模式为 `save`。可信宿主可指定 `replayLatestOnly`，此时仅接受最近操作的同文重发，其他操作返回 `DRAFT_REPLAY_REQUIRED`。最近操作改文仍返回当前稿冲突。确认后当前稿保存关闭。

`saveChoiceDraft` 继续精确重放每个操作标识第一次接受的版本化请求。两种保存共用作品、计数和最近操作位置。按当前稿模式再次接受历史操作标识时，历史精确回执保持原样。精确重放、拒绝和回滚都不移动最近操作。旧数据库只有当前修订恰有一条操作记录时才恢复最近操作，否则需由普通保存来确定最近操作。

可信宿主为教师配置同步 `authorizeChoiceDraftAmendment`，按实际教师、学生、活动、冻结题和操作 `read` 或 `amend` 裁决。缺少授权时拒绝。已登记的内核评阅者也须仍在任。将已验证的教师映射为 `{ role: "reviewer", id }`，用 `readChoiceDraftForAmendment` 查询题内当前修订、学生改答计数和选项。教师通过 `amendChoiceDraft` 指定同一冻结题、当前 `baseRevision`、题内 `operationId`、有效选项和非空 `reason`。每次新修正保留一个作品修订，学生改答计数与活动时间保持原值。修正使该题转为版本化保存，并取消最近学生操作资格。学生的历史精确回执仍可用。只有未确认的题可修正。当前授权仍成立时，教师可重发相同操作和意图取回原修订，确认后也可恢复原回执。

教师可用 `reviseChoiceSnapshot` 勘误单步整卷确认中仍无证据的一题。宿主配置同步 `authorizeChoiceSnapshotRevision` 裁决当前归属与权限，并可通过 `hasChoiceSnapshotEvidence` 拒绝已有宿主证据的勘误。宿主在调用期间须保证外部证据检查与并发写入一致。输入指定当前题版本、基础修订、题内操作标识、理由、新题面、选项和正确选项。内核先校验作答修订，再检查目标题证据，其他题仍可独立作答。教师修订冲突只返回当前修订号。勘误推进该实例题版本和作答修订。普通学生读面显示当前题面并在 `choiceSnapshotRevisions` 给出无答时的基础修订，实答仍由 `choiceDrafts` 交付。勘误保留活动和步骤身份，计数和实质时间由学生的真实作答推进。评分按确认时的实例题版本读取私有键。确认后禁止新勘误，原操作回执按当前授权恢复。

`readChoiceDraftActivity(principal, activityId)` 按当前活动权限返回 `firstChangedAt` 和 `lastChangedAt`，确认后仍可读取。首次实际选中选项和之后的实际改选与草稿同事务写入。同内容保存、接管、重发和冲突都不更新时间。未发生学生逐题保存的活动返回 `undefined`。历史草稿未采集的时刻保持为 `null`，升级后新增的实质改选可从最近一次时刻读回。

整卷确认使用单步 `finalAnswer` 的单选槽，显式声明 `confirmFromDrafts: { allowUnanswered: true }` 可保留空答。`confirmChoices` 接受冻结全题的题版本、当前草稿修订和原稿状态，服务端从已存草稿取选项。`uncollected` 用于旧协议未采集。可信宿主同步 `verifyOriginal` 核实各状态，包括旧协议是否允许未采集。未配置回调时只接受 `uncollected`。`frozen` 保存文档 ID、版本 ID 和可选 SHA-256。宿主先持久保留选定版本，再把核实结果交给内核。确认成功返回唯一回执。草稿修订冲突通过 `ChoiceConfirmationConflict` 返回冲突的题和本人当前草稿。授权仍有效时可用同一操作和意图重取回执。常规学生 `read` 遵守已发布的回看字段。可信宿主另可凭活动、步骤尝试和操作标识调用 `recoverChoiceConfirmation`，每次须经当前活动授权和配置的 `authorizeConfirmationRecovery` 核对，返回引用的发布版本、完整确认事实及逐题 `choiceDraftChangeCounts`。

宿主可在 `openLearningRuntime({ databasePath, choiceEvaluators: [{ id, version, evaluate }], authorizeConfirmationRecovery })` 注册同步纯函数评估器。在草稿确认槽的 `grading.assessment` 指定同一评估器版本和本次发布的评分键。确认时持久化评估任务。可信宿主使用原确认操作标识调用 `recoverChoiceConfirmation`，经现行授权后完成待评任务，并在 `evaluation` 取回评估器版本、冻结题数、正确题数及逐题布尔判定。回调逐题收到活动、步骤尝试、槽、练法和题目版本，以及本人的选项和私有正确选项。空答为 `null`，也参与评估。等待评估时缺少精确版本返回 `EVALUATOR_UNAVAILABLE`，修复配置后可用同一操作恢复。评估异常会回滚整份判定并保留待评任务。任务完成后直接读取已存判定。学生结果仍遵守发布时的公布条件，历史 `choice-key` 声明仍使用原评估规则。

`node --test tests/installed-runtime.test.ts` 在两个独立临时项目安装同一个固定包，通过包名开卷和读取，在新进程打开原库，并验证严格类型检查、冻结版本和学生隔离。

## 浏览器演示

安装依赖后运行 `pnpm run dev`。学生和教师使用不同的浏览器配置，例如普通窗口与无痕窗口，以便同时保留两种会话。

1. 学生点击「打开活动」。把「每晚平均有三十人到馆」所在段选为客流观察，把「自习室因维修暂时关闭」所在段选为同期条件，再点「提交选据」。第二步按 A、B、A 作答并交卷。预期整篇初判为 1/3，若显示待评可点击「刷新成绩」。复制地址栏中的活动链接。 [两步阅读学生入口](http://127.0.0.1:3000/demo/reading)
2. 教师粘贴活动链接并点击「打开评阅」。在第二题填写评阅理由，点「判对」，核对修订变为 1，再点「开放复盘」。 [教师评阅入口](http://127.0.0.1:3000/demo/teacher)
3. 学生在原活动页刷新，核对原答仍是 A、B、A，整篇变为 2/3，第二题显示「判定正确」。教师关闭复盘后，学生再次刷新仍见原答和 2/3，逐题判定随复盘关闭而隐藏。

演示服务监听本机 `127.0.0.1:3000` 并使用 `data/demo.sqlite`。在终端按 Ctrl+C 关闭后文件保留。重启后先按原角色重进演示入口，学生可访问保存的活动链接，教师可重新输入活动链接打开评阅。

单步演示可在《晚一点关门》中拖选一句话，核对预览后提交。刷新后仍显示同一引文和回执。 [单步引文入口](http://127.0.0.1:3000/demo/student)

浏览器测试由锁定的 Playwright 1.64.1 运行 Chromium。可单独运行 `node --test tests/browser/reading.test.ts`。Linux 若缺 Chromium 所需的系统库，可用 `pnpm exec playwright install --with-deps --only-shell chromium` 准备系统依赖和开发用浏览器。

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
