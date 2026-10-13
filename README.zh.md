# pi-rsi

[English](README.md) | 中文

**为 [pi 编码代理](https://github.com/earendil-works/pi) 提供递归自我改进（RSI）。** 这个 pi 包把 [RSIAgent](https://github.com/AetherLabsAI/RSIAgent)（arXiv:2609.15364）中与基准无关的机制移植成 pi 扩展：

- **由 Actor 拥有的经验记忆**：流程、可复用脚本、环境事实与失败教训，按项目存放在项目目录之外。Actor 工作时只读；只有在独立裁决之后的学习阶段才会改变。
- **独立、隔离的 Verifier Agent**：一个单独的 pi 会话，只看到用户最近消息的原文和宿主采集的变更事实，看不到 Actor 的推理、自检和记忆，发布 `PASS`、`FAIL` 或 `UNVERIFIED`。有 bubblewrap 时，它的 shell 在只读沙箱中运行；否则候选结果先快照、事后回滚。
- **课程驱动的探索**：Phase 1 广度波次与 Phase 2 以目标为条件的深度练习（论文中的 BRS / DRS）。Curriculum Agent 为每个项目编写输入夹具，宿主私下捕获后逐字节重放。
- **冻结模式与密封评测**：测试时复用（Phase 3），以及可选的、仅宿主可见的评测器，其结果永远不会进入任何代理。

模型参数始终不变。改进只来自经过验证、被记忆带到后续任务中的经验。

## 安装

需要 Node ≥ 22.19 与 pi ≥ 1.2（`npm i -g @earendil-works/pi-coding-agent`）。

```sh
# 从 GitHub 安装
pi install git:github.com/mutsuki14/Pi-RSI

# 或从本地检出安装
git clone https://github.com/mutsuki14/Pi-RSI && pi install ./Pi-RSI

# 或只在本次运行中加载，不安装
pi -e ./Pi-RSI/src/index.ts
```

pi 直接加载 TypeScript 源码，无需构建。Linux 上安装 bubblewrap（`apt install bubblewrap` / `dnf install bubblewrap`）即可获得只读的 Verifier 沙箱。

## 工作原理

### 日常任务

pi 的主代理就是 Actor。pi-rsi 在它的系统提示中加入 RSI 协议和记忆清单（只有文件名与大小），分别是 `rsi_protocol` 与 `rsi_memory` 两节。

```
任务 → Actor 工作（把记忆当作提示读取：rsi_memory_list / _search / _read）
     → rsi_submit：隔离的 Verifier 会话依据最近的用户消息与 git 变更事实检查实时结果；
       检查前先为候选结果做快照
     → PASS / FAIL（Actor 据报告修复）/ UNVERIFIED（要求 CLAIM/PROBE 证据线索；
       宿主把每个探针运行一次，并标注为 PASS/FAIL/NOT_RUN）
     → 同一任务的每次修订都由同一个 Verifier 会话检查，可跨多轮对话
     → rsi_learn：在当前记忆的草稿副本上开启学习阶段
     → rsi_memory_write / rsi_memory_delete：提炼经验
     → rsi_memory_commit（第一次）：整体对账整个记忆库
     → rsi_memory_commit（第二次）：原子提升、写入日志、记录前后树哈希
```

任务状态（Verifier 代次、报告引用、裁决、学习阶段）从 pi 会话当前分支上的工具结果折叠得到，因此会随 `/tree`、分叉与恢复会话而变化；草稿和报告保存在磁盘上，学习阶段在重启后仍然有效。

### 探索谱系（`rsi_explore` 工具，`/rsi-explore` 命令）

| 阶段 | 论文 | 流程 |
|---|---|---|
| `broad` | Phase 1 · BRS | Curriculum 编写一波相互独立的项目，并为每个项目构建夹具目录。宿主检查目录形状、私下捕获，再重放到全新的项目根目录。每个分支都从同一份记忆快照出发，配一个新的 Actor 和新的 Verifier。整波全部验证完成后（**波次屏障**），这些 Actor 会话按编写顺序**依次**提炼经验，每个都基于最新的记忆。 |
| `deep` | Phase 2 · DRS | 新的 Actor 尝试一个不可变的目标（可选重放 `target_fixtures`）。FAIL 对本次尝试是终局；UNVERIFIED 会要求同一个 Actor 提供证据线索。反复 UNVERIFIED 或 Actor 没有动作会使尝试停滞：随后进行一次强制检查；若仍无结论，则由新的会话从工作日志继续（可选用升级模型，并让 Verifier 换到 Actor 的模型一次）。同一个 Actor 提炼、对账、为 Curriculum 写诊断，然后才提升记忆。Curriculum 选择练习，直到 `READY_FOR_TARGET` 或 `STALLED`。任何练习之后都必须重新尝试原目标，练习预算耗尽时也一样。 |
| — | Phase 3 | 设置 `"mode": "frozen"`、使用 `--rsi-mode frozen` 运行，或执行 `/rsi-freeze`。`/rsi-eval <lineage>` 运行配置好的密封评测器。 |

```
/rsi-explore broad 用 Python 和 shell 完成小型数据清洗任务。
/rsi-explore deep In <PROJECT_ROOT>, implement a CSV deduplicator cli.py that ...
/rsi-explore stop
```

命令在后台运行（进度显示在状态栏，`/rsi` 查看详情）；`rsi_explore` 工具则阻塞到谱系结束。一个谱系可能需要大量模型调用。

停止策略：`curriculum_review`（默认；目标 PASS 后 Curriculum 仍可要求继续练习）或 `verifier_pass`（目标 PASS 并提交记忆后立即停止）。基础设施故障永远不会被当作 PASS 或 FAIL，也不会提交记忆，会以 `infra`、`quarantined`、`aborted` 或 `error` 记录在谱系的 `result.json` 中。

### 角色会话在 pi 中如何运行

每个角色（Actor、Verifier、Curriculum）都是用 SDK（`createAgentSession`）在进程内创建的 pi 会话：

- 全新的对话，有自己的系统提示、工作目录和工具白名单；
- 不加载任何扩展、技能、提示模板或上下文文件，角色只听得到宿主的消息；
- 共用主会话的模型运行时（提供方、凭据），每个角色可以配置自己的模型路由；
- 一次 `send()` 就是一次 pi 运行：运行结束时的最后一条助手回复就是该角色的交接内容，下一次 `send()` 在**同一个**对话中继续（对应 RSIAgent 中持久的 `messages`）。

没有给出可用交接的运行，会在同一会话中得到续接提示（RSIAgent 的同上下文续接）。连续三次运行都没有任何工具动作，该阶段以“不计分的基础设施问题”结束，与 RSIAgent 一致；另有上限防止失控。pi 压缩上下文之后，角色收到的下一条消息会逐字重钉它最初的任务说明，并再次提示可以检索记忆（RSIAgent 的 `_memory_revisit`）。角色的对话记录以 pi 会话文件形式保存在谱系记录下（用 `pi --session <文件>` 打开）。

### 隔离

`verifier.isolation`（默认 `auto`）：

- `sandbox`：Verifier 的每条 shell 命令都在 bubblewrap 中运行：整个文件系统只读、不保留任何 capability（pi 以 root 运行时同样如此）、每条命令有新的 `/tmp`、独立的进程命名空间、宿主 IPC 套接字（Docker、D-Bus）被遮蔽、隐藏路径被遮蔽，另有一个私有的可写暂存目录（`$RSI_SCRATCH`），在它的多条命令之间保留。只有预检确认 bubblewrap 真的能阻止写入时才会选用；显式配置为 `sandbox` 而预检失败时会直接报错。
- `rollback`：Verifier 的命令不受限制；宿主事后恢复候选结果。文件工具仍会拒绝隐藏路径，shell 也会拒绝提及这些路径的命令，但刻意构造的命令仍可能触及它们。
- `auto`：可用时选 `sandbox`，否则 `rollback`。

**隐藏路径。** 任何角色会话都看不到 pi 的 agent 目录（会话、凭据、设置、所有项目的 pi-rsi 状态），也看不到本项目的 pi-rsi 状态与记忆（无论配置在哪里），只有它自己的目录树和暂存目录例外。谱系中的 Actor 或 Verifier 只能看到自己那一集的目录树，因此同一波的项目彼此不可见，其他谱系、捕获的夹具、课程笔记也不可见；Curriculum 只能看到它编写夹具的目录树。角色的文件工具是 pi 内置工具，但文件系统操作经过守卫，守卫检查的正是 pi 实际打开的路径；有 bubblewrap 时，遮蔽同样作用于 shell（谱系中的 Actor 与 Curriculum 运行在只遮蔽、不只读的“可见性沙箱”中）。

**回滚。** 无论哪种模式，Verifier 都没有 `write`/`edit` 工具；交互式候选结果在每次检查（以及运行证据探针）之前都会做快照，若有改动则恢复：已跟踪与未跟踪的文件，以及仓库的 refs、index、配置与钩子（Verifier 的 commit、stash 或改配置都会被撤销）。被忽略的文件不在快照范围内。检查前已存在的文件永远不会被删除。谱系中的候选目录整体复制，任何改动都会恢复。网络不隔离：Verifier 被要求绝不改动在线服务。

宿主侧的 `git`（变更事实、快照）不会运行仓库植入的程序：钩子、fsmonitor、外部 diff，以及仓库定义的 filter、diff、textconv 驱动全部禁用。

## 工具与命令

| 工具 | 使用者 | 用途 |
|---|---|---|
| `rsi_memory_list` / `rsi_memory_read` / `rsi_memory_search` | Actor、Curriculum（除非 `curriculumMemoryAccess: none`） | 查看记忆（学习阶段中查看草稿） |
| `rsi_memory_write` / `rsi_memory_delete` | Actor，仅限学习阶段 | 编辑草稿 |
| `rsi_submit` | 主 Actor | 请求独立验证；UNVERIFIED 之后传入 `evidence_leads`（claim 与 probe 成对） |
| `rsi_learn` | 主 Actor | 终局裁决后开启学习阶段 |
| `rsi_memory_commit` | 主 Actor | 第一次：对账；第二次：原子提升 |
| `rsi_explore` | 主 Actor | 运行 `broad` 或 `deep` 谱系（阻塞直到结束） |
| `rsi_notes` | Curriculum | 替换它的私有搜索笔记（Actor 与 Verifier 永远看不到） |

命令：`/rsi`（状态：模式、记忆、隔离、任务状态、提交、谱系）、`/rsi-freeze`、`/rsi-unfreeze`（先校验冻结时的树哈希）、`/rsi-explore broad|deep|stop`、`/rsi-eval <lineage>`。启动参数：`--rsi-mode learn|frozen|off`。

## 配置

pi-rsi 读取 `~/.pi/agent/rsi.json`，项目受信任时再读取 `<project>/.pi/rsi.json`；对象逐键合并，数组与标量直接替换。所有键都可省略，完整示例见 [README.md](README.md#configuration)。要点：

- `mode`：`learn`、`frozen`（Phase 3 测试时复用；学习类工具被停用）或 `off`。
- `memoryDir` / `stateDir`：留空即 `~/.pi/agent/rsi/projects/<项目>-<哈希>/{store,…}`，位于项目之外。
- `roles`：可选的角色模型路由；留空的字段继承会话当前的模型与思考级别。Verifier 使用不同的模型可以增强独立性。设置 `escalation` 后，恢复的目标 Actor 使用它；若它与 Verifier 的路由相同，该段的 Verifier 会改用 Actor 的路由一次。
- `audit.sealedTexts`：记忆中绝不能引用的材料（如留出的评测任务）；任何 8 词重叠都会隔离该次提交。
- `evaluation.command`：`/rsi-eval` 使用的密封评测器命令。它在最终候选结果的私有副本中运行，环境变量 `RSI_CANDIDATE_ROOT` 与 `RSI_TASK_FILE` 已设置，最后一行输出 `{"score": n}`；运行前先冻结记忆，并在前后校验树哈希。结果只写到磁盘供人查看，永远不会进入代理。

## 磁盘上的状态

```
~/.pi/agent/rsi/projects/<项目>-<哈希>/
  store/      memory/（规范记忆树）、drafts/、journal.jsonl、reports/、history/、frozen.json
  work/       角色可见的谱系根目录（自身是一个忽略自己的 git 仓库）
  lineages/   私有的谱系记录：lineage.json、events.jsonl、result.json、捕获、快照、
              课程笔记、检查点、角色对话记录（sessions/）
  results/    密封评测的运行结果
  scratch/    每个角色的暂存目录
```

记忆的 `tree_sha256` 与 RSIAgent 的 `explore/memory_hash.py` 逐字节兼容。

## 与 RSIAgent 的差异

- **角色使用工具，而不是每轮一个程序。** RSIAgent 的 Actor 在虚拟机中每轮输出一个 Python/Bash 程序、一次观察或 `done`；pi 的角色使用 pi 的工具，并以最后一条回复完成交接。交接令牌（`STATUS: SUBMIT`、`VERDICT:`、`DECISION:`、波次 JSON 信封）与传输规则沿用 RSIAgent。
- **进程而不是虚拟机。** 新角色获得新会话和新项目根目录，但不是新机器。bubblewrap 能遮蔽私有路径与兄弟项目，并让 Verifier 只读，但网络、沙箱之外的其他进程以及主 pi 代理能接触到的一切仍然共享。需要更强隔离时，请在容器中运行 pi。
- **证据探针**由宿主运行一次（沙箱中只读，否则在快照保护下），而不是作为 Actor 已验证的 `done` 检查。
- **Phase 2 中停滞的练习项目**（反复 UNVERIFIED 或 Actor 无动作）会让谱系以基础设施问题结束，与 RSIAgent 一致；此前经验已提交的记忆会保留。只有在 Verifier 发布第一份报告之前发生的运行故障才会让分支重来。
- **Phase 2 有预算上限**（默认 `deepPracticeBudget` 6、`targetCycleBudget` 6），RSIAgent 没有；长谱系请调高。练习预算用尽后，必须进行的全新目标测试仍会执行。
- **记忆再提示**沿用 RSIAgent 的 `_memory_revisit`：在 Verifier 反馈之后、上下文压缩之后、会话恢复时触发；`stagnation`（重复低信息动作）触发器未实现。
- **谱系在重启后不可恢复**；交互式学习阶段可以恢复。
- **角色会话不加载任何扩展**，因此你自己的权限或守卫扩展看不到谱系 Actor、Curriculum 与 Verifier 的工具调用；pi-rsi 用自己的路径守卫与沙箱代替。
- **分叉**：一个裁决在会话及其分叉之间只学习一次，先提升者生效。

## 开发

```sh
npm install
npm run typecheck
npm test                 # 单元测试 + 进程内 pi 集成测试（faux 模型）
npm run e2e              # 用真实 pi CLI 对接脚本化的 OpenAI 兼容模拟服务
```

集成测试使用 pi-ai 的 faux 提供方运行真实 pi 会话；沙箱测试只在 bubblewrap 可用的环境中运行。

## 许可证

Apache-2.0。对 RSIAgent 与 dsh-rsi 的署名见 [NOTICE](NOTICE)。
