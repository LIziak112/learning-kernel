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

已保存草稿且还未确认任何题的预备题组可在同一练法的 `whole` 和 `perQuestion` 发布版本之间换版。调用 `replacePreparedActivityVersion` 时加上 `intent: "questionDeliveryMode"`。目标版本须保留冻结题目、材料引用、评分内容及其他练法声明，私有评分键可引用内容等值的另一版本。切换保留活动标识、原作答开始时刻、草稿原值、修订和改答计数，并轮换步骤凭据。若调用方需要恢复最新的草稿保存操作，使用当前步骤凭据和原操作 ID 重发原请求。已交付的题组拒绝新切换，成功切换可按原操作重放取回回执。

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

### 逐题原值与待人工判定

练法以单步 `finalAnswer`、`response-group@1` 和 `oneResponsePerQuestion` 声明逐题确认。槽位声明 `input: "booleanOrString"`、`confirmFromDrafts.allowUnanswered` 和每道题的固定版本。`grading.assessment` 固定独立的 `responseEvaluators` 注册项及私有评分键 `acceptedResponses`。本版评分键逐题为布尔，评估器解释学生原值。可参看[独立宿主示例](tests/fixtures/response-confirmation-consumer.mts)。

`saveResponseDraft` 接收同一题内的操作标识、基础修订、题版本和 `value`。布尔和原始字符串均按原类型保存，字符串经过保存和确认仍保留空格。未保存草稿的题在确认中是 `null`，显式保存的空字符串仍为字符串。`confirmResponses` 接收固定题集合、各题当前草稿修订和原稿声明，内核在同一事务记录作品、回执、完成与评估任务。原稿存在性仍由可信宿主使用 `verifyOriginal` 核实。同一意图重试取回原回执，改答冲突通过 `ResponseDraftConflict` 或 `ResponseConfirmationConflict` 交付本人当前稿。

可信宿主用原确认操作调用 `recoverResponseConfirmation`，每次经当前活动及 `authorizeConfirmationRecovery` 核准。同步评估器收到冻结版本、原值和私有布尔评分键，返回 `{ status: "judged", correct }` 或 `{ status: "needsReview" }`。内核独立保存待人工判定事实和布尔判定。回调未配置时返回 `EVALUATOR_UNAVAILABLE`，回调异常回滚本次评估。已存结果可在重开后读取，授权恢复不暴露私有评分键。`ownResponses` 仅开放本人确认作品，学生常规读面没有本模式的判定或待批详情。人工处理使用恢复出的待批事实，本契约提供待批登记与读取。普通单选继续使用相同的单选 API、成员校验及布尔评估。

版本 16 为该模式增加独立待评记录。旧版 15 升级保留既有作品、回执和布尔判定，升级后的数据库需由支持版本 16 的运行时打开。

### 整卷索引数组

普通整卷可在相同 `response-group@1` 单步交付中明确声明 `input: "optionIndexArray"`。每道题的选项键使用从零开始的连续十进制编号。私有评分键的 `acceptedIndexes` 为每道题提供非空正确索引集合。`grading.assessment` 固定 `indexResponseEvaluators` 中的版本，评估器逐题接收原数组或 `null`、实际冻结的正确集合和题版本，由宿主决定判定。发布、保存均以冻结选项范围校验下标。普通标量原值和单选使用各自既有入口。

`saveIndexResponseDraft` 保存索引原序与重复项。显式 `[]` 有草稿修订，无草稿为 `null`，两者均不计已答表现，并受 `allowUnanswered` 约束。`confirmIndexResponses` 保留一次正式回执，可信宿主经当前授权用 `recoverIndexResponseConfirmation` 执行或复读评估。学生本人草稿在 `indexResponseDrafts`，声明 `ownResponses` 后可在确认记录中读到自己的 `indexResponseConfirmation`。私有评分集合仅交给评估器。复用版本 16 的持久结构。可参看[独立宿主示例](tests/fixtures/index-response-confirmation-consumer.mts)。

### 混合整卷与逐题交付

单步活动可显式使用 `question-delivery@1` 和 `questionDelivery` 槽，在各冻结题上声明 `response` 为 `choice`、`booleanOrString`、`optionIndexArray`、`orderedTextBlanks` 或 `textWithOptionalTitle`。仅收作品时声明 `grading: {}`，省略 `scoringKey`。确认照常写入回执和完成记录，评估任务为零。自动评分使用 `grading.assessment`，私有 `scoringKey.acceptedByQuestion` 为参与自动评分的题固定形态和评分数据。评估器标识和版本必须在自动评分实际使用的每种题型注册中存在。评估器逐题收到该次确认中的原值和对应评分键。

有序填空题用非负整数 `blankCount` 声明冻结位置数，可省略 `options`。没有参考答案且无排序位置的题可声明 `blankCount: 0`，并通过 `grading.teacherReview.questionIds` 登记教师待评。自动评估需要正数位置和匹配的私有条目 `{ response: "orderedTextBlanks", acceptedBlanks: string[][] }`，其中每一项对应一个冻结空位，由该空的非空参考字符串组成，候选列表可为空。宿主通过 `openLearningRuntime({ orderedTextEvaluators: [{ id, version, evaluate }], ... })` 注册本形态评估器。评估器收到 `value` 与 `acceptedBlanks`，沿同一任务返回 `judged` 或 `needsReview`。

`saveQuestionDeliveryDraft` 使用原题版本、当前修订和操作标识保护草稿，保留字符串原样、布尔值及数组原序与重复项。传给 `confirmQuestionDelivery` 的请求附同一逻辑槽、操作标识、题版本、所见修订和原稿声明：

- `delivery.mode: "whole"` 使用 `source: "whole"` 一次确认冻结全题。
- `delivery.mode: "perQuestion"` 的 `questionSlots` 为每题固定互异的交付位置。`source: "question"` 只确认一题，其他题可继续保存，最后一题确认后完成活动。显式空交也有本题确认位置。
- 逐题活动可用 `source: "finish"` 发出全题版本与修订清单。内核核对全部题版本，仅以未交题当前稿或空值组成收尾提交。先交题保留原作品、回执与判定。确认来源区分主动单题空交和收尾时的被动空值。保存的空数组保有草稿修订；无稿值为 `null`，空值不登记表现。

活动确认、必要评估任务和完成记录同事务提交。经当前权限同意后，同一意图重发取回原回执。`recoverQuestionDelivery(principal, activityId, key)` 按原活动、步骤尝试和操作标识交付同一回执、确认题范围、原完整请求和 `evaluation`，适用于自动评分题组。待自动评分的任务可在首次获准恢复时执行，已记录的判定和待评状态可直接复读。

可信宿主可传第四参数 `"declared"`，按该回执的 `assessment` 字段识别 `"none"`、`"manual"`、`"teacherReview"` 和 `"automatic"`。各模式都带原回执与确认事实，并按现行授权交付。有预先声明的待评题时，`review.questions` 交付确认时登记的题与冻结版本。学生 `read` 只按发布策略交付 `questionDeliveries` 的回执或本人题值，并返回本步仍可编辑的 `questionDeliveryDrafts`。

需要人工评阅时，在 `grading.manualReview.keyRef` 引用本次私有 `scoringKey: { id, version, reviewCriteria }`。填写实际的量表或评阅准则文本。每个确认覆盖的位置都登记待评，含已确认的空答。表现记录继续遵守已答规则。宿主配置同步 `authorizeQuestionDeliveryReview`，凭已验证的 `{ role: "reviewer", id }`、活动 ID 和原确认键调用 `readQuestionDeliveryReview`。授权收到真实评阅者、学生、活动、步骤尝试、操作标识、提交 ID 和回执槽位。已有内核评阅指派也须有效。该读口交付冻结原值、待评题和精确版本的 `basis`，私有量表仅随获准的评阅读取交付。

无参考答案的题可在 `grading.teacherReview.questionIds` 列出互异的冻结题标识。确认时立即登记该回执中的这些题，含显式空交和未存稿。若同时声明 `grading.assessment`，其余题使用真实的自动评分键，混合回执的 `evaluation` 只包含自动子集及其计数，`"declared"` 恢复同时交付 `review.questions`。仅教师评阅的回执返回 `assessment: "teacherReview"`，其目标无评分键。练法只声明 `teacherReview` 时，其余题仅收作品。`teacherReview` 与引用实际量表的 `manualReview` 互斥。默认确认恢复仅用于带自动评估的回执。

读题组当前判定时传入 `readQuestionDeliveryReview(reviewer, activityId, confirmationKey, "verdicts")`。它按原确认交付回执、获准评阅的题位原值与任务目标，逐题返回判定修订和状态。自动评估尚未执行显示 `pendingEvaluation`，需要人工判定显示 `needsReview`，已有有效判定显示 `judged`。自动原判通过 `automatic` 返回，`effective.source` 区分生效的 `teacherReview` 与 `automatic`。`basis` 仅随 `manualReview` 的实际量表交付。原三参评阅读口及声明式确认恢复交付原始待评登记，当前状态通过 `"verdicts"` 读取。

改判使用 `writeQuestionDeliveryVerdict(reviewer, activityId, confirmationKey, command)`。宿主须另配同步 `authorizeQuestionDeliveryVerdict`，使用真实提交、槽位、冻结题及版本、评价目标和动作裁决每次写入与重放。命令使用 `protocolVersion: 1`、`operationId`、`submissionId`、`targetId`、`questionId`、`expectedRevision` 和 `reason`，按 `action: "override"` 传 `correct` 或按 `action: "withdraw"` 传当前生效判定的 `withdrawId`。先用 `"verdicts"` 读到当前修订，初次为 0。成功得到含判定事件 ID 和新修订的回执。相同命令重发取回原回执，内容变更返回 `OPERATION_CONFLICT`，过旧修订或撤销非当前判定返回 `VERDICT_CONFLICT`。

题组对同一冻结作答的新改判替换以前的教师结果。清除回到仍有效的自动原判、待人工判定或尚未执行的自动评估。逐题确认只能评本次实际交付的题。学生原答和提交回执按原策略交付。自动评分恢复继续交付原评估事实。[题组判定独立宿主示例](tests/fixtures/question-delivery-verdict-consumer.mts)

填空按原序保留 `string[]`、空白和数组长度，允许少于或多于题面的空位数。数组为空或所有项去除首尾空白后均为空时不计作答，必答槽拒绝确认。显式全空和空数组仍存有草稿修订，未存稿为 `null`。宿主根据自己的冻结策略处理待人工判定。

带可选标题的文字题使用 `response: "textWithOptionalTitle"`，可省略 `options`，私有条目只需 `{ response: "textWithOptionalTitle" }`。草稿值为 `{ body: string, title?: string }`，确认后原样保留正文及标题，区分缺省标题、空标题和未存稿。纯空白或空正文不登记表现。允许未作答的槽仍可确认仅有标题的作品，必答槽须等正文含有非空白字符后才能确认。宿主在 `titledTextEvaluators` 注册精确版本，收到冻结正文与标题或 `null`，沿同一任务返回 `judged` 或 `needsReview`。

宿主可在冻结练法上通过私有 `questionAnswerRules: { [questionId]: { id, version } }` 为单题声明已答规则。注册项通过 `openLearningRuntime({ questionAnswerRules: [{ id, version, response, isAnswered }], ... })` 配置。发布时必须匹配题的原值形态和规则的精确版本。确认时，函数同步读取该题已存的原值并返回布尔值。缺稿按未答处理。必答校验与表现写入共用这一次结果。新确认缺少精确注册时返回 `ANSWER_RULE_UNAVAILABLE`，可在补齐配置后重试。已确认回执按当前授权取回，沿用原结果。省略绑定沿用该值形态的原确认行为，规则配置留在可信服务端。

SQLite v17 允许用无键的评阅目标保存教师评阅，迁移保留已存自动任务、判定历史及待评题。升级后的数据库须由支持 v17 的运行时打开。[混合题独立宿主示例](tests/fixtures/question-delivery-consumer.mts) · [文字题独立宿主示例](tests/fixtures/titled-text-consumer.mts)

### 材料版本与使用位置

单步最终作答可用 `single-choice-group@1` 或 `question-delivery@1` 在发布时提供顶层 `materials`，题组交付支持整卷与逐题模式。每项 `from:"material"` 输入各自声明唯一的 `positionId` 和精确的 `material:{id,version}`。同一份材料可在多个位置使用。每个引用须对应同一次发布中提供的不可变定义，所有定义都须在当前练法使用。此项声明与旧版顶层及练法的单数 `material` 互斥。

活动固定公开版本和该版本的材料引用。只换一份材料时，发布该材料的新版本并更新对应位置，再发布练法的新版本。恢复旧活动仍使用原位置和原材料版本。 `read` 在当前步骤 `inputs` 的相应材料输入下返回 `positionId` 和 `material`。旧单材料练法继续在活动顶层返回 `material`，无材料练法照常工作。资料展示布局与附加附件留宿主处理。可参看[独立宿主示例](tests/fixtures/material-positions-consumer.mts)。

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
