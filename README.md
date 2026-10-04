# RTS MVP — 人类指挥官 vs 大模型指挥官

一个可运行的 2D 即时战略（RTS）最小可行产品：你在浏览器里用蓝方（人类），大模型用红方（LLM）指挥，双方在 **64×64 迷雾地图**上争夺水晶、生产部队、拆掉对方基地。

技术栈：**TypeScript + Vite + Phaser 3（前端） / Node.js + Express + WebSocket（后端） / Vitest（测试）**。零美术素材，所有图形由 `Graphics` 图元绘制。

---

## 快速开始

### 前置要求

| 项目 | 要求 | 说明 |
| --- | --- | --- |
| Node.js | **≥ 22.9** | 需要内建的 `--env-file-if-exists`（本项目用它加载 `.env`，无额外 dotenv 依赖）。开发时使用 22.22。 |
| npm | ≥ 10 | 随 Node 一起安装。 |
| 浏览器 | 支持 WebGL2 的现代浏览器 | Chrome / Edge 均可。纯 Canvas 回退会明显掉帧。 |

```bash
node --version   # 必须 >= v22.9.0
```

### 安装与运行

```bash
npm install

# 开发模式：同时启动后端(3001) 与前端(5173)
npm run dev
# 然后打开 http://localhost:5173
```

首次运行**不需要任何配置文件**：红方会自动由内置规则 AI 接管，对局立刻可玩。

### 配置（全部可选）

```bash
cp .env.example .env     # 按需修改，.env 已被 gitignore
```

`.env` 里最常用的几个：

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `PORT` | `3001` | 后端 HTTP + WebSocket 端口 |
| `VITE_PORT` | `5173` | 前端开发服务器端口 |
| `OPPONENT` | `on` | `off` = 无对手沙盒，红方不动，适合熟悉操作或跑交互验收 |
| `GAME_SEED` | `12345` | 固定种子 → 地图与对局完全可复现 |
| `OPENAI_API_KEY` | 空 | 阶段 4 使用；空值时会自动回退到规则 AI |
| `LOG_LEVEL` | `info` | `debug` 会记录完整 LLM 请求体（密钥始终脱敏） |

**关于 API Key（阶段 4）**：密钥只放在服务端 `.env` 中，永远不会下发给浏览器。请通过 `OPENAI_BASE_URL` 指向任何 OpenAI 兼容服务：

```bash
OPENAI_API_KEY=sk-...
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4o-mini
```

### 其它命令

```bash
npm run server     # 只启动后端（用于单独调试网关）
npm run dev:web    # 只启动前端（需后端已运行）
npm test           # 全量单元测试
npm run typecheck  # TypeScript 严格模式检查
npm run sim        # 无头对局：两个规则 AI 互相打，打印统计
npm run build      # 产出 dist/（生产构建）
npm run preview    # 预览 dist/（注意：不含后端，需另起 npm run server）
```

---

## 操作说明

**进程模型**：`npm run dev` 会并行启动两个进程 —— 后端（Express + WebSocket，默认 `:3001`）和前端开发服务器（Vite，默认 `:5173`）。浏览器只访问 5173，Vite 把 `/api` 与 `/ws` 反向代理到 3001，因此浏览器侧看到的是同源请求，无需配置 CORS。

> 后端不是 `tsx watch`，而是 `node --watch --import tsx`：tsx 会把 `--env-file-if-exists` 的提示打印三次，node 原生 watch 只打印一次，输出更干净。

| 输入 | 行为 |
| --- | --- |
| **左键单击** | 选中一个己方单位（只有当前可见的己方单位可被选中） |
| **左键拖拽** | 框选范围内的己方单位；`Shift` + 拖拽为加选/减选 |
| **右键** | 下达指令：地面 → 移动；水晶 → 采集；可见敌人 → 攻击；己方工地 → 前往协助 |
| <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> / 方向键 | 平移相机 |
| <kbd>Space</kbd> | 视角回到己方基地 |
| <kbd>Q</kbd> / <kbd>E</kbd> | 缩小 / 放大（范围 0.35 ~ 2.0，鼠标滚轮同效） |
| <kbd>G</kbd> | 选中单位就近采集 |
| <kbd>H</kbd> / <kbd>X</kbd> | 原地待命 / 停止 |
| <kbd>Esc</kbd> | 取消选择 |
| <kbd>Tab</kbd> | 循环跳转到下一个待命单位 |

**战争迷雾**：地图初始几乎全黑；单位走过的地方会被永久记住，之后变暗但**不会重新变黑**；敌方**建筑**离开视野后留下半透明虚线残影，敌方**单位**离开视野则直接消失（不提供残影，避免泄露行军路线）。

---

## 项目结构

```
src/
  shared/          领域类型 + WebSocket 线上协议（无任何运行时依赖）
  game/            ★ 权威模拟内核：零 IO，可在 Vitest 里纯内存跑完整对局
    config/        所有数值常量（唯一来源，禁止魔法数字）
    rng/           mulberry32 种子随机数 + 状态哈希
    map/           地形 / 位掩码编解码 / A* / 地图生成
    entities/      实体工厂（坐标约定写在这里）
    state/         GameState 与实体注册表
    systems/       经济 / 生产 / 移动 / 战斗 / 视野 / 胜负（每 tick 顺序执行）
    actions/       动作 schema → 校验器 → 执行器（唯一状态写入口）
    view/          面向人类的快照过滤 + 迷雾编码
    GameLoop.ts    tick 顺序编排（不含定时器）
  server/          Express + ws 网关（全项目唯一的文件 IO：logger）
  render/          Phaser 渲染层 + 人类输入 + 网络客户端
  llm/             规则 AI（阶段 4 将成为 LLM 的兜底）
scripts/
  simulate.ts              无头对局 CLI
  browser-acceptance.cjs   浏览器端到端验收（B1~B8，可选）
tests/                     19 个测试文件（内核 / 网关 / 渲染纯函数）
docs/
  SPEC.md          ★ 实现契约（含 §17 实现偏差记录）
  LLM_PROMPT.md    给大模型指挥官的提示词契约
  ROADMAP.md       ★ 阶段拆解、验收标准与完成记录
```

### 六条不可违反的工程约定

写代码前请先读 `docs/SPEC.md`，以下约束是硬性的：

1. **`src/game` 必须零 IO** —— 不得 import express / ws / phaser / fetch / fs / `node:*`。
   `tests/game/purity.test.ts` 会扫描源码强制执行这一条。
2. **单一执行路径** —— 人类指令与 LLM 动作都必须走 `actions/validator.ts` → `actions/executor.ts`。
   任何绕过校验器直接改 `state` 的代码都是 bug。
3. **唯一状态写入口** —— 除 `executor.ts` 与各 system 的 `tick` 函数外，不得在别处修改实体字段。
4. **随机数只能来自 `GameState.rng`**，禁止 `Math.random()`（同样有测试守卫）。
5. **所有数值常量集中在 `game/config/constants.ts`**，禁止在系统里写魔法数字。
6. **单一过滤出口** —— 所有下发给浏览器的数据都必须经 `game/view/snapshot.ts` 过滤。
   网关注释里写的「不绕过」是可以靠代码审查验证的，因为它只在一处构造出站消息。

改动其中任何一条，请同步更新 `docs/SPEC.md §17 实现偏差记录`。

---

## 测试

```bash
npm test          # 19 文件 / 228 用例
npm run typecheck # 严格模式 0 错误
```

分层情况：

| 层 | 覆盖内容 |
| --- | --- |
| `tests/game/*` | 经济、生产、战斗、视野、胜负、寻路、地图生成、位掩码编解码、确定性复现、纯净性守卫 |
| `tests/actions/*` | 10 步校验管线、批量预算、重复单位、合法动作集约束（44 个用例） |
| `tests/server/*` | 网关生命周期、`cmd` 走同一校验器、下行过滤 / 反作弊、迷雾增量、单次 gameover |
| `tests/render/*` | 快照插值、迷雾三态与过渡、选择拾取 / 指令解析 / 快捷键、绘制层（记录式 Graphics stub） |
| `tests/llm/*` | 规则 AI 只产出合法动作（LLM 兜底的前提） |

### 可选：浏览器端到端验收（B1~B8）

`scripts/browser-acceptance.cjs` 会自动跑完 `docs/ROADMAP.md` 里 B1~B8 的人工检查项（真实 Chromium + 真实 WebSocket），并把截图写到 `logs/acceptance-shots/`。它**不属于** `npm test`，因为需要浏览器且慢得多。

```bash
# 1. 装一个 playwright-core（任意位置均可，不必进项目依赖）
npm install --no-save playwright-core

# 2. 起服务（建议用沙盒模式，红方不动，交互检查更稳定）
OPPONENT=off npm run server
npm run dev:web

# 3. 跑验收（按需覆盖路径）
PLAYWRIGHT=./node_modules/playwright-core \
CHROME_PATH="/path/to/chrome" \
node scripts/browser-acceptance.cjs
```

---

## 换一台机器开发

代码本身**不含任何硬编码的绝对路径**，迁移只需三步：

1. **重新克隆 / 同步仓库**，然后 `npm install`。
   `.env`、`logs/`、`node_modules/`、`dist/`、`.tmp/` 都不入库，需要在新机上重建。
2. **`.env.example` → `.env`**（可选），填入你的端口与（阶段 4 的）API Key。
3. `npm run typecheck && npm test` 应全绿，然后 `npm run dev`。

### 目录依赖说明

| 路径 | 是否入库 | 说明 |
| --- | --- | --- |
| `src/ tests/ scripts/ docs/` | ✅ | 全部源码与文档 |
| `index.html` `vite.config.ts` `package*.json` `tsconfig.json` `.env.example` `.gitignore` | ✅ | 工程配置 |
| `node_modules/` | ❌ | `npm install` 重建 |
| `.env` | ❌ | 含密钥，手动重建 |
| `logs/` `dist/` `.tmp/` | ❌ | 运行时产物 |

### 新环境自检清单

```bash
node --version                 # >= 22.9
npm install                    # 若失败见下方「已知问题」
npm run typecheck              # 期望 0 error
npm test                       # 期望 19 files / 228 tests passed
npm run sim -- --seed 12345    # 期望 p1 获胜于约 tick 2075，0 条动作被丢弃
npm run dev                    # 打开 http://localhost:5173 应看到己方基地
```

### 已知问题与排障

| 症状 | 原因 | 处理 |
| --- | --- | --- |
| `npm install` 报 `spawnSync ... EBUSY`（esbuild postinstall） | 受限沙箱禁止嵌套派生子进程 | 在**普通终端**（非沙箱）中执行安装 |
| 启动报 `Cannot find module @rollup/rollup-win32-x64-msvc` | npm 可选依赖 bug（安装中断后残留） | `rm -rf node_modules package-lock.json && npm install` |
| `npm test` 全绿但用例数比预期少、且伴随 `EPERM ... \Temp\...\ssr\...` | Vitest 的 SSR 运行器写到系统临时目录被拒 | 已在 `vite.config.ts` 中把 `TMPDIR/TMP/TEMP` 锚定到 `node_modules/.cache/harness-tmp`，一般无需处理；若仍出现，检查该目录可写 |
| 页面全黑、HUD 数字不动、控制台有 `Vertex Shader failed` | 浏览器拿到的是软件渲染上下文且着色器编译失败 | 不要用 `--use-gl=swiftshader` 启动浏览器；改用默认（ANGLE/D3D11）或 `--use-angle=swiftshader` |
| 端口被占用 | 上一次进程未退出 | `netstat -ano \| grep :3001` 找到 PID 后结束它，或改 `.env` 的 `PORT`/`VITE_PORT` |
| 对局早早结束、看不到自己的基地 | 规则 AI 已经打完了这一局 | 重启后端换一局，或用 `OPPONENT=off` 先熟悉操作 |

---

## 当前进度

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| 1 | 无头权威模拟内核（完整对局可复现） | ✅ 完成 |
| 2 | Phaser 渲染 + 战争迷雾 + 人类操作 + Express/WS 网关 | ✅ 完成 |
| 3 | 完整对局：人类 vs 规则 AI（含训练/建造 UI 与胜负结算） | ⬜ 待开始 |
| 4 | 大模型指挥官接入（`/api/llm/decide` + 校验 + 兜底） | ⬜ 待开始 |
| 5 | 打磨、`npm run bench`、完整 README | ⬜ 待开始 |

每个阶段的详细任务清单与验收标准（A1~A10 / B1~B10 / …）见 **`docs/ROADMAP.md`**，其中包含每一阶段的完成记录与遗留项。阶段 2 的**本阶段不做**：训练/建造 UI、战斗特效、LLM 接入、胜负结算界面、迷雾小地图。

---

## 许可

私有 MVP，未附许可协议。
