# evolver 安装 evolver-plugin：方案与设计

目标：一条 `evolver` 命令，把 `evolver-plugin`（EvoMap/evolver-agent-plugin）装进用户机器上的 agent，Linux、Windows、macOS 都能用。

## 1. 结论

**不要另起一套。**evolver-v2 的 `main` 上已经有 `evolver plugin`（提交 `91ab619a`，2026-10-29）。它有 `list` 和 `install` 两个子命令，管 10 个宿主：7 个由宿主自己的插件管理器自动安装，3 个只给出操作步骤（Cursor、WorkBuddy、通用 MCP 客户端）。它带预览、幂等、安装后回读验证、文件锁和回滚说明。本方案在它上面修复和补齐：

1. **P0：先让能自动装的宿主真的装得上，再发布。**今天 v1.0.0 的 `release` 布局和 evolver 的校验规则对不上：
   - **Grok：**装不上，缺 `--trust`。
   - **OpenCode：**装不上，入口文件路径对不上。
   - **dsh：**装不上，pnpm 缓存目录冲突，装好的包里也缺校验需要的文件。

   另外，npm 上的 `@evomap/evolver` 2.0.46 还不带这个功能，修好后要发版。
2. **P1：补齐生命周期。**加 `status`、`uninstall`、`update`，其中 `update` 要能改写 OpenCode 的配置。
3. **P2：WorkBuddy 自动化（待核实）。**本机 WorkBuddy 自带的命令行启动就崩溃（`MODULE_NOT_FOUND`），要先核实它的插件命令。
4. **P3：三个系统都用真实宿主验证一遍。**

## 2. 现状：已有的 `evolver plugin`

```text
evolver plugin list [--json]
evolver plugin install [--host <host>] [--scope user|project] [--root <dir>] [--profile <dsh-profile>] [--dry-run] [--json]
```

| 文件 | 职责 |
|---|---|
| `pluginHosts.ts` | 10 个宿主的描述：命令名、最低版本（Codex、Antigravity 没设）、安装方式（marketplace / bundle / profile / manual）、作用域、旧插件名、安装后提示；生成安装步骤和回滚说明 |
| `pluginInstall.ts` | 编排：查版本 → 读现有登记 → 冲突检查 → 加锁 → 执行步骤 → 再读登记 → 校验清单 |
| `pluginInspection.ts` | 判断"已装、冲突、旧插件"：<br>• marketplace 宿主和 Antigravity：读宿主的 `plugin list --json` / `marketplace list --json`（Qoder 用 `plugins`）<br>• OpenCode：读 `opencode.json` / `tui.json`<br>• dsh：读 profile 的 `package.json` 和 `node_modules`<br>• Claude Code、Codex：另外检查老的 `setup-hooks` 集成 |
| `pluginBundle.ts` | Antigravity、OpenCode：从 `release` 分支稀疏 clone `dist/<host>`，校验后放进 `~/.evolver/plugins/evolver-agent-plugin/<commit>/<host>/` |
| `pluginRuntime.ts` | 执行宿主命令：不经过 shell；Windows 下用 `USERPROFILE`，按固定顺序找 `.exe` → `.cmd` → `.bat`（不读 `PATHEXT`）；`.cmd` 只认 npm 生成的 node 启动脚本；`.ps1` 只认 `cursor-agent` 的固定布局；独立 Bun 二进制下改用 `node.exe`；版本比较；拒绝符号链接 |
| `pluginLock.ts` | evolver-core 的 `acquireLock`（硬链接发布 + 清理已死进程的锁），不排队等待；锁的范围是"宿主 + 作用域 + 项目根目录 + profile" |

各宿主的安装步骤如下。安装入口都指向 `release` 分支，`release` 只在推 `vX.Y.Z` tag 时前移：

| 宿主 | 方式 | evolver 执行的命令 |
|---|---|---|
| Claude Code | marketplace | `claude plugin marketplace add EvoMap/evolver-agent-plugin` → `claude plugin install evolver-plugin@evolver-agent-plugin --scope <s> --json` |
| Codex | marketplace | `codex plugin marketplace add EvoMap/evolver-agent-plugin` → `codex plugin add evolver-plugin@evomap --json` |
| Grok | marketplace | `grok plugin marketplace add …` → `grok plugin install evolver-plugin` |
| Qoder | marketplace | `qodercli plugins marketplace add …` → `qodercli plugins install evolver-plugin@evomap` |
| Antigravity | bundle | 稀疏 clone `release` 的 `dist/antigravity` → `agy plugin install <目录>` |
| OpenCode | bundle | 稀疏 clone `dist/opencode` → `opencode plugin <目录> [-g]` |
| DeepSeek Harness | profile | `dsh plugin --profile <p> add -w "github:EvoMap/evolver-agent-plugin#release&path:dist/dsh"` |
| Cursor、WorkBuddy、MCP 客户端 | 手动 | 输出操作步骤 |

退出码：0 表示成功、已装或仅预览；2 表示需要用户操作（含 `manual_required`）；1 表示冲突或失败。

## 3. 缺口

### P0：今天就会失败的

| # | 缺口 | 证据 | 修在哪 |
|---|---|---|---|
| G1 | **Grok 缺 `--trust`。**不加时 Grok 只提示需要确认，不安装；evolver 随后报失败 | grok 1.0.70 实测："requires confirmation … re-run with --trust" | evolver |
| G2 | **OpenCode 入口路径对不上。**<br>• evolver 期待 `dist/opencode/server.mjs`、`tui.mjs` 在包的根目录（`pluginBundle.ts:21`），实际在 `dist/opencode/hosts/opencode/dist/`，下载后被拒（"missing an entry module"）<br>• 就算找到入口，检查已装时要求 `server.mjs` 旁边有 `package.json`（`pluginInspection.ts:175-177`），也永远判断不出已装 | `origin/release` v1.0.0 的实际布局 | plugin 仓库（#12）：包的根目录放转发入口 `server.mjs`、`tui.mjs`，`exports` 不再改写 |
| G3 | **dsh：pnpm 缓存目录冲突。**命令行 `dsh` 用 PATH 上的 pnpm（本机 9），dsh 界面用自带的 pnpm 11。profile 被 11 装过后，9 会报 `ERR_PNPM_UNEXPECTED_STORE` | 本机实测；`web` profile 的 `node_modules/.modules.yaml`（JSON 格式）记录 `packageManager: pnpm@11.8.0`、`store/v11` | evolver：动手前先比对 |
| G4 | **dsh：装好后校验不过。**<br>• evolver 要求包里有 `.evolver-packed`（`pluginInspection.ts:137`），但 `dist/dsh/package.json` 的 `files` 没把它包含进去，pnpm 不会装它<br>• evolver 要求根目录有 `plugin.mjs`（`:138`），实际入口是 `hosts/dsh/dist/plugin.mjs` | 本机 `~/.dsh/profiles/web/node_modules/@evomap/dsh-evolver` 里两样都没有 | plugin 仓库（#12）：根目录放转发入口 `plugin.mjs`，`files` 加上它和 `.evolver-packed` |
| G5 | **单元测试和真实布局脱节。**测试里假的包把 `server.mjs`、`plugin.mjs` 都放在根目录（`plugin.test.ts:35`），真实 `release` 却不是，所以 G2、G4 测试照样全绿 | 同上 | #12 让真实布局和测试一致；契约测试（G6）防止再脱节 |
| G6 | **没有两仓之间的契约测试。**`--dry-run` 不下载、不执行宿主命令，拦不住布局变化 | `plugin.ts:16`、`pluginInstall.ts:37` | 两仓各加一个契约测试（见 5） |
| G7 | **没发布。**npm 上 2.0.46（10-24）不带这个功能 | `npm view @evomap/evolver` | evolver 发版 |
| G8 | **dsh 的独立旧插件冲突。**本机 `dsh-tui`、`headless`、`desktop` 三个 profile 里还装着 `@evomap/dsh-evolver` ^0.1.x；默认 profile 是 `dsh-tui`，必定撞上冲突检查（`pluginInspection.ts:207`） | 本机 profile 实际内容 | evolver：冲突时给出每个宿主具体的迁移命令 |

两点说明：
- **G9 不再算缺口：**之前担心的"各宿主是否支持 `--json` 清单"基本已经确认。Codex 0.164、Grok 1.0.70 的 `plugin list` 和 `marketplace list` 都支持；没确认的只剩 Qoder（本机没装）和 `agy plugin list --json`。
- **dsh 的 `allowBuilds` 提示多半是误报：**dsh 对任何失败的 git 来源安装都会打印这句提示。本机那次真正的错误是 G3，而 `dist/dsh/package.json` 也没有 `scripts` 和 `dependencies`。等 G3 绕开后，在干净的 profile 上复测确认。

### P1 及以后

| # | 缺口 | 说明 |
|---|---|---|
| G10 | 没有 `status` / `uninstall` / `update` | 发新版后用户不知道怎么升级 |
| G11 | Codex 的钩子装好后要在 `/hooks` 里手动信任才生效 | `status` 应该报告"已装但钩子未信任" |
| G12 | 网络失败时只报笼统的 `failed`，宿主的错误输出被隐藏；超时固定（`ls-remote` 30 秒，clone 和 install 各 120 秒） | 失败时给出"检查网络或代理"的提示；代理设置已经从环境变量继承 |
| G13 | bundle 缓存只增不减 | 只有有了 `update` 才会增长；放在 `update` 里一起做 |
| G14 | WorkBuddy 能否自动安装 | 本机没有 `codebuddy` 在 PATH 上；WorkBuddy 自带的命令行启动崩溃。现有文档刻意不猜测 `codebuddy` 的 shell 命令，先核实再说 |
| G15 | macOS 没跑 `plugin.test.ts` | 仓库里已经有 macOS runner（`native-lifecycle-acceptance.yml`、`reference-native-contract.yml`）；但 `test:macos-native` 只在手动触发的 `native-lifecycle-acceptance.yml` 里跑，`reference-native-contract.yml` 不跑它。要每个 PR 都覆盖 macOS，需要在 `ci.yml` 里加一个 macOS 任务跑 `plugin.test.ts`。注意测试用的是进程内假宿主，测不到真实 CLI 路径 |

## 4. 设计

### 4.1 P0 修复

- **G1 `--trust`：**
  - 新增 `--trust`，表示用户本人同意信任插件的钩子。evolver 从不默认加上。
  - **只接受需要它的宿主**（宿主描述里新增 `requiresTrust: true`；Grok 确认需要，Qoder 待核实）。传给不需要的宿主就报 `invalid_arguments`，沿用"不悄悄忽略参数"的规则（`plugin.ts:77`）。
  - **动手前就检查：**需要信任却没加 `--trust`，在执行 `marketplace add` 之前就返回新状态 `trust_required`（退出码 2），并说明要加的参数。依据是宿主描述，不解析宿主的输出文字。
- **G2 / G4 入口位置：**在 plugin 仓库修（PR #12），evolver 现有的检查不用改。
  - 两个包自己的 `package.json` 本来就声明入口在根目录，是打包时被改写成了 `hosts/<host>/dist/…`。
  - 现在打包时在根目录放转发入口（OpenCode 的 `server.mjs`、`tui.mjs`，dsh 的 `plugin.mjs`），`exports` 保持指向根目录。
  - `files` 加上这些入口和 `.evolver-packed`，pnpm 从 git 安装时就会保留它们。
  - plugin 仓库新增 `test/packed-layout.test.js`，按 evolver 的检查逐个宿主验证打包结果。
- **G3 dsh 缓存冲突：**
  - 执行任何 dsh 命令之前，读 profile 里 `node_modules/.modules.yaml` 记录的 pnpm 主版本和缓存目录，与 `dsh` 将要用的 pnpm 比较。
  - 不一致就返回新状态 `profile_store_mismatch`（退出码 2），提示"这个 profile 由 pnpm N 管理"，并给出两种做法：
    - 在 dsh 界面里填 `github:EvoMap/evolver-agent-plugin#release&path:dist/dsh`；
    - 用同一主版本的 pnpm 再试。
  - 不替用户重装整个 profile。
- **G8 旧插件冲突：**冲突信息里给出该宿主该 profile 的确切迁移命令，例如 `dsh plugin --profile dsh-tui remove @evomap/dsh-evolver`，并提醒先确认旧插件的数据。仍然不自动删除。
- **G5 / G6：**evolver 侧加一个默认跳过、按需开启的契约测试：拉取真实 `release`，跑真实的 `validateBundle` 和清单检查（见 5）。
- **G7：**以上修完后发 evolver 版本；evolver-agent-plugin 的 README 加一句"也可以用 `evolver plugin install --host <h>`，需要 evolver ≥ 该版本"。

### 4.2 P1 生命周期

先做 `status` 和 `uninstall`，`update` 放在最后，因为它要新增写配置的能力。

```text
evolver plugin status    [--host <h>] [--json]
evolver plugin uninstall --host <h> [--scope …] [--profile <p>] [--purge] [--dry-run] [--json]
evolver plugin update    --host <h> [--scope …] [--profile <p>] [--dry-run] [--json]
```

- **`status`（只读）：**每个宿主报告以下几项。
  - 是否已装、版本、来源是否为 `release`；
  - 是否有旧插件冲突；
  - 钩子是否已信任（宿主能报告时，比如 Codex 的 `/hooks`）；
  - 运行钩子需要的 `node` 是否 ≥ 22.13；
  - 最新发布版本：要联网 `ls-remote`，离线时显示"未知"，不算失败。

  只有 `status` 不带 `--host` 时列出全部宿主，`install` 和 `update` 第一版不做 `--all`（YAGNI）。
- **`uninstall`：**默认保留数据，只有显式 `--purge` 才删。各宿主的实际情况：

  | 宿主 | 命令 | 说明 |
  |---|---|---|
  | Claude Code | `claude plugin uninstall … --keep-data` | |
  | Codex | `codex plugin remove evolver-plugin@evomap` | 没有保留数据的选项，会删掉它自己的缓存；输出里如实说明 |
  | Grok | `grok plugin uninstall evolver-plugin --keep-data`（`--purge` 时去掉 `--keep-data`） | 不调用 `grok plugin marketplace remove`，它会连带卸掉该 marketplace 的所有插件；现有回滚说明（`pluginHosts.ts:138`）也要补上 `--keep-data` |
  | dsh | `dsh plugin --profile <p> remove @evomap/dsh-evolver` | |
  | OpenCode | 只删本插件在 `opencode.json`、`tui.json` 里的条目 | 需要 4.3 的配置写入能力 |

  只删自己放进 `~/.evolver/plugins/` 的 bundle 目录。
- **`update`：**

  | 宿主 | 做法 |
  |---|---|
  | Claude Code | `claude plugin marketplace update …` + `claude plugin update …` |
  | Grok | `grok plugin marketplace update` + `grok plugin update evolver-plugin` |
  | Codex | `codex plugin marketplace upgrade evomap` 刷新 marketplace，再重新 `codex plugin add evolver-plugin@evomap --json`，最后回读确认版本。Codex 0.164 没有 `plugin update`，也没有 `marketplace update`；只刷新 marketplace 不会更新已装的插件，因为装好的副本按版本号存放。待实测 |
  | dsh | 同一 profile 里重新 `add` |
  | OpenCode | 见 4.3 |

  版本没变返回 `already_current`。

### 4.3 OpenCode 的 `update`：需要新增配置写入

OpenCode 的登记写在用户的 `opencode.json`、`tui.json` 里（可能是带注释的 `.jsonc`）。新旧两份条目同时存在会被判为冲突（`pluginInspection.ts:182`），所以升级必须删掉旧条目。evolver 目前不写这两个文件，这是新能力，必须单独设计：

```text
update --host opencode
  ls-remote release → C2；当前登记指向 …/<C1>/opencode/dist/opencode
  C2 == C1 → already_current
  稀疏 clone C2，校验入口 → …/<C2>/opencode/dist/opencode
  备份 opencode.json / tui.json → 只把本插件的两个条目从 C1 改指 C2，保留其它内容和注释
  再读登记：确认只有指向 C2 的一对条目
    失败 → 用备份恢复两个文件，返回 failed（不承诺"自动保留 C1"之外的状态）
  成功 → 删除 …/<C1>/opencode（带本工具 receipt、已不被引用时）
```

如果第一版不想引入配置写入，就让 OpenCode 的 `update` 返回 `manual_required`，给出要改的两行。

### 4.4 三个系统

执行规则三个系统一样：不经过 shell，参数逐个传，命令名通过 PATH 解析。按系统区分的部分：

| 项目 | Linux | macOS | Windows |
|---|---|---|---|
| 用户目录 | `$HOME` | `$HOME` | `%USERPROFILE%`（已处理） |
| 找宿主命令 | PATH | PATH | PATH 上按 `.exe` → `.cmd` → `.bat` 找（已处理）；不是 npm 生成的 `.cmd` 启动器，今天会被判为找不到命令（报 `host_missing`）；计划改为报 `unsupported_capability`，让用户知道是启动器类型不受支持 |
| bundle 缓存 | `~/.evolver/plugins/…` | 同左 | `%USERPROFILE%\.evolver\plugins\…`；最长路径约 160 字符，不需要长路径设置 |
| 行尾 | LF | LF | clone 时加 `-c core.autocrlf=false`，避免 `autocrlf=true` 改写文件 |
| 插件运行需要的 Node | `node` ≥ 22.13 | 同左，常见在 `/opt/homebrew/bin` | `node.exe` ≥ 22.13；`status` 检查 |
| git（bundle 宿主） | 通常已装 | Xcode 命令行工具 | Git for Windows；缺失报 `host_missing` |
| 桌面版自带 CLI | 少见 | 有 | 有 |

桌面版自带 CLI：
- **Claude：**桌面版和 PATH 上的 CLI 多半共用 `~/.claude`，主要风险是版本检查读到了另一个二进制。
- **DSH Desktop：**`dsh` 命令行本来就能用 `--profile desktop`，它真正的障碍是 G3。

所以第一版不加"指定 CLI 路径"的参数（它还会扩大能执行任意程序的范围），只在 `status` 里列出发现的桌面版 CLI 及其版本。

各宿主各系统的状态。每格两项："代码路径"指现有代码是否支持，"实测"指是否用真实宿主装通过。今天没有一个宿主完成过端到端实测：

| 宿主 | Linux | macOS | Windows |
|---|---|---|---|
| Claude Code | 支持 / ? | 支持 / 很可能可用（缓存里有正确标记） | 支持 / ? |
| Codex | 支持 / ? | 支持 / 很可能可用 | 支持 / ? |
| Grok | ✗ G1 | ✗ G1 | ✗ G1 |
| Qoder | 支持 / ? | 支持 / ?（本机未装） | 支持 / ? |
| Antigravity | 支持 / ? | 支持 / ?（本机未装） | 支持 / ? |
| OpenCode | ✗ G2 | ✗ G2 | ✗ G2 |
| DeepSeek Harness | ✗ G4 | ✗ G3、G4 | ✗ G4 |
| Cursor、WorkBuddy、MCP | 手动 | 手动 | 手动 |

## 5. 测试与验证

| 层 | 内容 |
|---|---|
| 单元 | 改正假包布局（G5）；每个新状态（`trust_required`、`profile_store_mismatch`、`already_current`）至少一个测试；`--trust` 传给不需要的宿主时报错 |
| 两仓契约（新增，P0） | evolver 侧：稀疏 clone 真实 `release`，对每个 bundle 宿主跑 `validateBundle` 和 `verifyPluginManifest`；dsh 用 pnpm 真装一份再校验。plugin 仓库侧：`release.test.js` 里断言每个 `dist/<host>` 满足 evolver 的校验规则。任何一边改布局都会让另一边测试失败 |
| 跨平台 | Windows 已在 CI；macOS 在 `ci.yml` 里新增任务，每个 PR 跑 `plugin.test.ts` |
| 真实宿主 | 每个系统、每个可用宿主，在临时用户目录里跑 `install → status → uninstall`（P1 后加 `update`）；不登录、不消耗额度 |

## 6. 分阶段计划

| 阶段 | 内容 | 完成标志 |
|---|---|---|
| P0 | G1–G8；契约测试；发 evolver 版本 | macOS 真实宿主上 Claude Code、Codex、Grok、OpenCode、dsh 安装全部通过并能回读；契约测试在两仓 CI 里跑；npm 有新版本 |
| P1 | `status`、`uninstall`；然后 `update`（含 OpenCode 配置写入或改为手动） | 每个状态有测试；macOS 真实宿主完整生命周期跑通 |
| P2 | G14 WorkBuddy 核实与自动化；G12 网络提示 | WorkBuddy 自带命令行实测 |
| P3 | Windows、Linux 真实宿主验证，回填 4.4 的表 | 三个系统各一份验证记录 |

## 7. 不做的事

- 不替用户信任钩子；`--trust` 只接受用户本人逐个宿主传入（第一版不支持一次性信任全部）。
- 不登录 Hub、不注册节点（那是 `/evolver-login` 的事）。
- 不删其它插件、其它 marketplace、旧插件的数据；不调用会连带删除的命令（如 `grok plugin marketplace remove`）。
- 不重装用户的 dsh profile；除 4.3 明确设计的 OpenCode 条目外，不改用户的配置文件。
- 不读宿主内部的登记文件来代替 `--json` 清单；宿主不支持就报 `unsupported_capability`（沿用现有规则）。
- 不并入 `setup-hooks`，两者并存，冲突时报 `conflict`。

## 8. 风险

- **宿主命令行会变：**用最低版本加回读验证兜底，Codex 和 Antigravity 要补上最低版本。
- **两仓版本耦合：**`dist/<host>` 的布局、入口位置、marketplace 名称是两仓之间的契约，靠第 5 节的契约测试守住。
- **本地 evolver-v2 检出落后 5 周且有未提交改动：**实现时另开 worktree，不动它。
