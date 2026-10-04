# SPEC — 2D RTS MVP（人类 vs 大模型玩家）

| 项 | 值 |
| --- | --- |
| 文档版本 | v1.2 |
| 状态 | **阶段 1 已实现并通过全部验收（A1~A10）** |
| 变更 | v1.1：战争迷雾改为双方同等受限（三态 + 交战暴露 + 服务端权威过滤）；补决策记录（§15）；`FAIR_FOG` → `FOG_ENABLED`。<br>v1.2：阶段 1 落地后的实现偏差与数值微调，见 §17。 |
| 目标交付 | 可 `npm install && npm run dev` 直接在浏览器游玩的单机 RTS，红方由 LLM 指挥 |
| 阅读顺序 | 本文 → `docs/ROADMAP.md`（阶段验收）→ `docs/LLM_PROMPT.md`（提示词） |

---

## 1. 目标与非目标

### 1.1 目标（MVP 必须达成）

1. 单张 64×64 网格地图，2D 俯视角，纯几何图形渲染，零美术素材依赖。
2. 蓝方（人类，浏览器操作） vs 红方（LLM，服务端自动指挥）。
3. 一种资源（crystal）、两种单位（worker / soldier）、两种建筑（base / barracks）。
4. 工人采集、基地造工人、兵营造士兵、单位移动 / 攻击 / 待命、摧毁敌方基地获胜。
5. 固定 10 tick/s 服务器权威模拟；前端只做渲染与指令输入。
6. 简化战争迷雾：**人类与 LLM 同等受限** —— 双方都只能看到己方实体、视野内的敌方实体，以及自己已探索过的地形；过滤在服务端统一执行，客户端拿不到不可见信息（防作弊）。
7. LLM 通过后端代理调用 OpenAI 兼容 API，密钥仅存服务端环境变量。
8. LLM 输出严格 JSON，经服务端校验后由模拟内核执行；非法输出被丢弃且绝不影响游戏运行。
9. 无 API Key 时自动降级为本地规则 AI，游戏仍完整可玩、可测。

### 1.2 非目标（明确不做）

- 多人联机、匹配、房间、观战、账号体系。
- 复杂寻路/避障/编队阵型/地形高低差/视野遮挡（墙体遮挡）。
- 科技树、升级、多种族、多资源、英雄单位、技能。
- 复杂动画（不做骨骼/序列帧，只有色块、血条、位移插值）。
- 3D、Unity/Godot、外部美术资源、音效。
- LLM 直接写游戏状态、直接调用 MCP/工具、多轮对话式决策（每次决策为单轮无状态请求）。
- 移动端触屏适配（桌面浏览器鼠标键盘为唯一输入）。

---

## 2. 需求清单

### 2.1 功能需求（FR）

| ID | 需求 | 优先级 |
| --- | --- | --- |
| FR-01 | 服务端以固定 10 tick/s 推进模拟，tick 计数单调递增 | P0 |
| FR-02 | 64×64 网格，静态障碍（岩石）由 seed 确定性生成，A* 可绕行 | P0 |
| FR-03 | 资源节点（crystal）由 seed 确定性生成，含数量上限，采空后消失 | P0 |
| FR-04 | 工人：移动到资源节点 → 采集 → 满载返回基地 → 卸货入库 → 循环 | P0 |
| FR-05 | 基地训练工人（成本 + 训练时长 + 人口校验） | P0 |
| FR-06 | 工人建造兵营（成本 + 工地状态 + 建造进度） | P0 |
| FR-07 | 兵营训练士兵（成本 + 训练时长 + 人口校验） | P0 |
| FR-08 | 单位移动（A* 路径跟随）、攻击（追击进入射程后按冷却输出伤害）、待命 | P0 |
| FR-09 | 自动反击：被攻击的单位若无显式指令则还击（可配置开关） | P1 |
| FR-10 | 视野半径按单位/建筑类型定义；服务端为**双方**分别生成可见集合 | P0 |
| FR-10a | 三态迷雾：`unexplored` 未探索（实体完全不下发）/ `explored` 已探索（地形、资源与敌方建筑残影可见，敌方单位不下发）/ `visible` 当前可见（全量下发） | P0 |
| FR-10b | 服务端权威过滤：下发给人类客户端的 `snap` / `events` 不得包含任何不可见敌方单位信息 | P0 |
| FR-10c | 交战暴露：正在互相交火的敌我单位互相视为可见，脱离交火 30 tick 后失效 | P1 |
| FR-11 | 胜负判定：任一方 base 被摧毁 → 立即结束并宣布胜方 | P0 |
| FR-12 | 人类玩家操作：单选 / 框选 / 右键上下文指令 / 快捷键 / 相机平移缩放 | P0 |
| FR-12a | 前端迷雾渲染：纯黑（未探索）+ 半透明灰（已探索但当前不可见），随视野变化平滑过渡 | P0 |
| FR-13 | HUD：水晶、人口、tick、FPS、连接状态、胜负遮罩 | P0 |
| FR-14 | LLM 决策触发：每 20 tick 定时 + 事件触发（去抖） | P0 |
| FR-15 | LLM 输出解析、Schema 校验、动作合法性校验、非法丢弃 + 日志 | P0 |
| FR-16 | LLM 调用超时 3s、重试 1 次、再失败回退本地规则 AI | P0 |
| FR-17 | 每次 LLM 请求/响应落盘 `logs/`，API Key 脱敏 | P0 |
| FR-18 | seed 可配置；相同 seed + 相同指令序列产生完全相同状态（可回放） | P0 |
| FR-19 | 快照只包含 LLM 可见信息并压缩，单次请求体不超过 token 预算 | P0 |
| FR-20 | `POST /api/llm/decide` 对外可用（调试 / 外部 Agent 替换 LLM 玩家） | P1 |
| FR-21 | 前端展示 LLM 决策时间线与 reasoning（仅对局结束后可见，避免作弊） | P2 |

### 2.2 非功能需求（NFR）

| ID | 需求 |
| --- | --- |
| NFR-01 | TypeScript `strict: true`，禁止隐式 any，禁止非空断言滥用 |
| NFR-02 | 单局 200 实体以内，服务端 tick 计算耗时 < 5ms（P95），浏览器 60fps |
| NFR-03 | LLM 调用全程异步，**绝不阻塞** tick 循环；同一时刻最多 1 个在途请求 |
| NFR-04 | 任何单条指令 / LLM 响应异常都不得导致进程崩溃或 uncaughtException |
| NFR-05 | Vitest 覆盖：动作校验、资源收支、胜负、视野、确定性、超时回退 |
| NFR-06 | 零第三方素材；`npm install` 后无需额外下载资源即可运行 |
| NFR-07 | **反作弊**：不可见信息不下发到客户端；前端只负责渲染，不参与可见性判定 |
| NFR-08 | 迷雾渲染不得拖垮帧率：explored 图层用离屏位图缓存，仅在行变化时重绘（预算 < 1ms/tick） |

---

## 3. 数值设计（单一事实来源）

> 实现时统一放在 `src/game/config/constants.ts`，所有系统只从此处读取，禁止散落魔法数字。
> 时间单位一律用 **tick**（10 tick = 1 秒）；速度单位 **tile/tick** 由 tile/s ÷ 10 得出。

### 3.1 全局

| 常量 | 值 | 说明 |
| --- | --- | --- |
| `TICK_RATE` | 10 | 每秒 tick 数 |
| `TICK_MS` | 100 | 单 tick 时长 |
| `MAP_W` / `MAP_H` | 64 × 64 | 网格尺寸 |
| `TILE_PX` | 32 | 渲染像素/tile（世界坐标） |
| `POP_CAP` | 80 | 单方人口上限（工人+士兵） |
| `ENTITY_HARD_CAP` | 200 | 全局实体硬上限（含建筑、资源） |

### 3.2 单位 / 建筑

| 实体 | HP | 视野 | 速度(tile/s) | 攻击 | 射程 | 冷却 | 成本 | 建造/训练 | 备注 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| worker | 60 | 6 | 1.6 | 4 | 1.0 | 1.5s | 50 | 6.0s (60t) | 采集者，可建造 |
| soldier | 110 | 8 | 1.4 | 12 | 1.5 | 1.0s | 75 | 8.0s (80t) | 主力战斗单位 |
| base | 1500 | 10 | — | — | — | — | — | — | 资源卸货点；训练 worker；不可重建 |
| barracks | 800 | 8 | — | — | — | — | 150 | 15.0s (150t) | 训练 soldier；上限 2 座/方 |
| crystal | — | — | — | — | — | — | — | — | 存量 1500，每 tick 可被采 0.5 |

### 3.3 采集与经济

| 常量 | 值 | 说明 |
| --- | --- | --- |
| `GATHER_RATE` | 0.5 /tick（5/s） | 工人贴住资源节点时的采集速率 |
| `CARRY_CAPACITY` | 20 | 满载后自动前往最近己方 base 卸货 |
| `GATHER_RANGE` | **1.5** tile | 判定"贴住"的距离。v1.2 由 1.2 上调：1.2 只允许正交相邻（1.0）采集，对角线相邻（1.414）会被拒；1.5 两者皆可，且仍排除 2 格外 |
| `START_CRYSTAL` | 250 | 开局资源 |
| `START_UNITS` | 4 worker | 开局单位 |

经济估算：4 工人 ≈ 8 crystal/s → 约 6s 产出 1 个工人；8 工人 ≈ 16/s → 约 5s 产出 1 个士兵。单局目标时长 5–12 分钟。

### 3.4 胜负与结束

- 任一方 `base` 的 `hp <= 0` → 该方 `defeated`，对局进入 `gameover`，tick 循环停止推进模拟（可继续收发心跳）。
- 无平局机制；无时间上限（可选 `GAME_MAX_TICKS=9000`（15 分钟）作为硬保险，默认关闭）。

### 3.5 地图生成规则（全部经 seeded RNG）

1. 双方基地固定锚点：蓝方 (10,10)、红方 (53,53)，周围 5×5 区域强制无阻挡。
2. 每个基地锚点附近（半径 6–12）生成 3 组水晶簇；地图中心对称位置生成 4 组中立水晶簇。
3. 每组水晶簇 = 3–5 个 `crystal` 实体，随机散布在 ±2 格内，互不重叠。
4. 岩石：在距任一基地锚点 > 12 格的位置生成 0–4 组，每组 3–8 格连通的阻挡格。
5. 校验：生成后跑一次连通性检查（从蓝方基地 4 邻域洪泛），确保红方基地可达；不可达则重掷（最多 10 次，仍失败则清空岩石）。

---

## 4. 系统架构

### 4.1 分层

```
┌──────────────────────── 浏览器（客户端） ────────────────────────┐
│  src/render (Phaser 3)                                          │
│   ├─ Scene: 绘制地图/实体/选择框/血条/特效（纯 Graphics，无素材）  │
│   ├─ Input: 点选、框选、右键指令、快捷键、相机                       │
│   └─ NetClient: WebSocket 收快照 / 发指令 / 插值渲染                │
└─────────────────────────────┬───────────────────────────────────┘
                    WebSocket(JSON) │ /ws   +  REST: /api/*
┌─────────────────────────────┴──────────── Node.js 服务端 ────────┐
│  src/server                                                     │
│   ├─ Express: 静态托管 / 健康检查 / POST /api/llm/decide           │
│   ├─ WsGateway: 连接管理、指令入口、快照广播                        │
│   ├─ GameLoop: setInterval 100ms 固定步长、累加器补偿               │
│   └─ SessionManager: 单局（MVP 单 session）                       │
│                                                                 │
│  src/game  （权威模拟内核，纯函数式、零 IO、零 Phaser 依赖）         │
│   ├─ GameState: 实体集合、资源、tick、胜负状态                      │
│   ├─ systems/: economy, movement, combat, production, vision,     │
│   │            victory, spawn                                     │
│   ├─ map/: terrain(阻挡/通行)、pathfinding(A*)、grid                │
│   ├─ entities/: 实体定义与工厂                                     │
│   ├─ actions/: ActionSchema、CommandValidator、ActionExecutor      │
│   └─ rng/: seeded PRNG（mulberry32）+ 状态哈希                     │
│                                                                 │
│  src/llm   （LLM 指挥层，纯逻辑 + 单一 IO 边界）                    │
│   ├─ prompts/: 版本化 system prompt (v1)                          │
│   ├─ serialize.ts: 迷雾过滤 + 压缩状态 → LLM 输入 JSON              │
│   ├─ legalActions.ts: 候选动作（声明式压缩）→ 校验用展开表           │
│   ├─ parse.ts: 原始响应 → 严格解析（容忍代码块包裹/多余文本）        │
│   ├─ llmClient.ts: OpenAI 兼容 API 调用（超时/重试/脱敏日志）        │
│   ├─ controller.ts: 触发策略（定时+事件）、在途锁、回退本地 AI       │
│   └─ ruleAi.ts: 本地规则 AI（LLM 不可用时的替代指挥）               │
└─────────────────────────────────────────────────────────────────┘
```

### 4.2 架构原则（贯穿全部阶段）

| 原则 | 落地方式 |
| --- | --- |
| **单一权威** | 只有服务端持有 `GameState`；客户端与 LLM 都只能提交"意图"，无状态写权限 |
| **单一执行路径** | 人类指令与 LLM 动作走**同一个** `CommandValidator → ActionExecutor`，逻辑零分叉 |
| **内核零依赖** | `src/game` 不 import Express / ws / Phaser / fetch，可在 Vitest 中纯内存跑完整对局 |
| **IO 边界唯一** | 唯一网络 IO 在 `src/llm/llmClient.ts`；唯一文件 IO 在 `src/server/logger.ts` |
| **确定性** | 所有随机数来自注入的 `RNG` 实例；伤害无随机浮动；浮点位置在序列化时量化 |
| **永不阻塞** | LLM 调用为 Promise，tick 循环不 await；结果到手后在下一 tick 校验执行 |

### 4.3 依赖

| 依赖 | 用途 |
| --- | --- |
| `phaser@^3` | 前端渲染 |
| `vite`, `typescript`, `@types/node` | 构建与类型 |
| `express`, `ws`, `cors` | 服务端与 WebSocket |
| `zod` | Action / LLM 响应 Schema 校验 |
| `dotenv` | 服务端环境变量 |
| `tsx` | 开发期直接运行 TS 服务端 |
| `vitest` | 测试 |
| `concurrently` | `npm run dev` 并行起前后端 |

无其他运行时依赖；不引入 ECS 框架、状态管理库、UI 框架。

---

## 5. 数据流

### 5.1 主循环（每 tick）

```
GameLoop.tick()                                   [服务端, 100ms 固定步长]
 1. tick++
 2. 应用上一 tick 缓冲的已校验动作（人类 + LLM 的 Action[]）
      └─ CommandValidator.validateAll(actions, state)  // 逐条校验，非法丢弃+计数
      └─ ActionExecutor.execute(action, state)          // 唯一状态写入口
 3. systems.economy.tick(state)     采集/卸货/资源节点枯竭
 4. systems.production.tick(state)  训练队列推进/工地建造进度
 5. systems.movement.tick(state)    A* 路径跟随、到达判定
 6. systems.combat.tick(state)      索敌、射程判定、冷却、伤害结算、死亡回收
 7. systems.vision.tick(state)      重算双方可见集合 + 累积 explored 图层 + 交战暴露判定
                                    （人类视图与 LLM 视图共用同一份 visibility 计算）
 8. systems.victory.tick(state)     基地存活检查 → 可能进入 gameover
 9. LlmController.onTick(state)     [非阻塞]
      ├─ 判定是否触发决策（定时/事件）
      ├─ 在途锁占用中 → 跳过
      └─ 空闲 → buildStateView + buildLegalActions → POST LLM（Promise，不 await）
10. 广播快照到所有 WebSocket 客户端
```

### 5.2 LLM 决策闭环

```
  触发（tick % 20 == 0 或事件）
        │
        ▼
  StateSerializer ── 迷雾过滤(仅己方 + 视野内敌方) + 压缩 + 量化
        │                    └─ intel: 上次已知敌方基地坐标（永久记忆）、
        │                          近期敌方目击（150 tick 内有效）
        ▼
  LegalActionBuilder ── 声明式候选：train/build/move/attack/gather/hold/noop
        │
        ▼
  LlmClient.decide({systemPrompt, stateJson, legalActions})   [超时 3s]
        │                 ├─ 失败 → 重试 1 次（可换 temperature=0）
        │                 └─ 仍失败 → RuleAi.decide(state) 回退
        ▼
  Parse ── 提取 JSON（剥离 ```json 围栏 / 前后噪声文本）
        │
        ▼
  Zod Schema 校验 ── 失败 → 整包丢弃（记录 reason=SCHEMA_INVALID）
        │
        ▼
  CommandValidator（逐条：存在性/归属/资源/状态/目标/坐标/legalActions 成员/动作数上限）
        │       非法条目 → 丢弃 + 结构化日志（不抛异常、不中断同批次其他条目）
        ▼
  动作入缓冲队列 → 下一 tick 由 ActionExecutor 执行
        │
        ▼
  日志落盘 logs/llm/<date>/<gameId>.jsonl（request/response/耗时/接受/拒绝/回退）
```

关键时序说明：LLM 响应可能在请求发出后 3–6 秒才到达（跨 30–60 个 tick）。
因此**动作在“应用时刻”而非“请求时刻”校验**，引用已死亡单位或已被采空资源点的动作会被自然丢弃 —— 这是设计的一部分，不是兜底补丁。

---

## 6. 目录结构

```
E:/RTS开发
├─ docs/
│  ├─ SPEC.md                     # 本文
│  ├─ ROADMAP.md                  # 阶段 1~5 与验收标准
│  └─ LLM_PROMPT.md               # 系统提示词、输入模板、示例、调优说明
├─ logs/                          # 运行时生成，已 gitignore
│  ├─ llm/<YYYY-MM-DD>/<gameId>.jsonl
│  └─ game/<gameId>.jsonl
├─ index.html                     # Vite 入口（含 canvas 容器 + HUD DOM）
├─ .env.example                   # 提交；.env 不提交
├─ .gitignore
├─ package.json
├─ tsconfig.json                  # strict: true
├─ vite.config.ts                 # /api、/ws 代理到 3001
├─ vitest.config.ts
├─ README.md                      # 阶段 5 产出：安装、配置、运行、FAQ
├─ src/
│  ├─ shared/
│  │  ├─ protocol.ts              # WS 消息类型（前后端共享）
│  │  └─ types.ts                 # 实体/动作/快照 DTO
│  ├─ game/
│  │  ├─ config/constants.ts      # 唯一数值来源（见 §3）
│  │  ├─ rng/index.ts             # mulberry32 + hashState()
│  │  ├─ state/GameState.ts       # 状态容器 + 实体索引
│  │  ├─ entities/{unit,building,resource}.ts
│  │  ├─ map/{grid.ts,terrain.ts,pathfinding.ts,generate.ts}
│  │  ├─ systems/{economy,production,movement,combat,vision,victory,spawn}.ts
│  │  ├─ actions/{schema.ts,validator.ts,executor.ts,legalActions.ts}
│  │  └─ GameLoop.ts              # 纯 tick 驱动（不依赖 ws/express）
│  ├─ render/
│  │  ├─ main.ts                  # Phaser 启动
│  │  ├─ scenes/{BootScene.ts,GameScene.ts,HudScene.ts}
│  │  ├─ input/{selection.ts,commands.ts,hotkeys.ts}
│  │  ├─ draw/{grid.ts,entities.ts,effects.ts}
│  │  ├─ interp.ts                # 快照插值（纯函数，可单测）
│  │  └─ net/NetClient.ts
│  ├─ server/
│  │  ├─ index.ts                 # Express + WS 启动
│  │  ├─ config.ts                # env 解析与默认值
│  │  ├─ ws/{gateway.ts,session.ts}
│  │  ├─ routes/llm.ts            # POST /api/llm/decide
│  │  ├─ logger.ts                # 落盘 + 脱敏
│  │  └─ replay.ts                # 指令日志录制/回放
│  └─ llm/
│     ├─ prompts/v1.ts
│     ├─ serialize.ts
│     ├─ legalActions.ts
│     ├─ parse.ts
│     ├─ llmClient.ts
│     ├─ controller.ts
│     └─ ruleAi.ts
└─ tests/
   ├─ actions/validator.test.ts   # 每类非法输入一条用例（表驱动）
   ├─ game/{resources,economy,victory,vision,pathfinding,determinism}.test.ts
   ├─ llm/{parse,serialize,legalActions,clientTimeout,ruleAi}.test.ts
   └─ helpers/{makeState,fixtures}.ts
```

---

## 7. 网络协议与状态同步

### 7.1 服务端 → 客户端

| 消息 | 载荷 | 时机 |
| --- | --- | --- |
| `init` | `{gameId, seed, map:{w,h,blockedRows:number[]}, crystals:[已探索的], ghosts:[已知敌方建筑], you:"human", config, snapshot, fog:{exploredRows:string[]}}` | 连接成功 |
| `snap` | `{tick, entities:[紧凑数组], ghosts:[残影], crystals:[已探索], resources:{me:number}, status, winner?}` —— **entities 仅含人类可见实体；不含敌方资源数** | 每 tick |
| `fog` | `{rows:[{i:number, bits:string}]}` —— explored 图层新增/变化的行（hex 位掩码，每行 16 字符 = 64 格） | 仅变化的 tick |
| `events` | `[{type:"damage"|"death"|"built"|"trained"|"arrive", ...}]` —— **仅含可见实体的事件**（不可见敌人的死亡不得泄露） | 有事件时（用于特效/音效位） |
| `llm` | `{status:"thinking"|"ok"|"fallback"|"error", latencyMs?, reason?}` | 决策状态变化（**不泄露 reasoning 内容**） |
| `gameover` | `{winner:"human"|"llm", tick}` | 对局结束 |
| `pong` | `{t}` | 心跳响应 |

### 7.2 客户端 → 服务端

| 消息 | 载荷 |
| --- | --- |
| `cmd` | `{actions: Action[], seq: number}` — 与 LLM 完全相同的 Action 格式 |
| `ping` | `{t}` |

### 7.3 紧凑编码约定

- 实体用**位置数组**而非对象数组：`[id, kindCode, ownerCode, x, y, hp, stateCode, extra]`，`kindCode/stateCode` 为枚举数字。
- 坐标量化到 **1 位小数**（0.1 tile 精度足够渲染）；`hp` 取整。
- **服务端过滤（反作弊）**：`snap` 只包含人类可见的（含坐标/血量/状态）实体；`ghosts` 单独承载"已探索但当前不可见"的**敌方建筑**残影（仅 id/type/x/y/血量百分比，允许陈旧）；不可见的敌方**单位**一律不下发。`events` 同样按可见性过滤（不可见敌人的死亡事件不得出现在事件流里）。
- **当前可见区域由客户端本地推导**：客户端持有己方全部实体 + 各类型 `VIS_RADIUS` 常量，即可算出"当前可见格集合"，用于决定哪些残影显示为实心、哪些显示为暗色。服务端不下发可见格掩码，既省带宽，也避免把敌方视野半径泄露给客户端。
- `explored` 图层单调增长（只增不减），服务端只发变化的行；每行 64 格用 16 个 hex 字符表示位掩码，客户端做按位或合并。
- 带宽估算：200 实体 × ~40B ≈ 8KB/快照 × 10/s ≈ 80KB/s + fog 增量 < 1KB/s（localhost 完全可接受）；若后续要远端部署，再引入 delta 快照（P2，不在 MVP）。

### 7.4 断线与重连

- 客户端断线：服务端保留模拟继续跑（LLM 仍会指挥红方），30s 内重连可接管蓝方；超过则对局暂停等待。
- 服务端重启：对局丢失，客户端自动重连并开新局（MVP 不做持久化恢复）。

---

## 8. 动作系统与校验规则

### 8.1 Action Schema（人类与 LLM 共用）

```ts
type ActionType = 'train' | 'build' | 'move' | 'attack' | 'gather' | 'hold' | 'noop';

interface TrainAction  { type:'train';  buildingId:string; unitType:'worker'|'soldier' }
interface BuildAction  { type:'build';  unitIds:string[]; buildingType:'barracks'; x:number; y:number }
interface MoveAction   { type:'move';   unitIds:string[]; x:number; y:number }
interface AttackAction { type:'attack'; unitIds:string[]; targetId:string }
interface GatherAction { type:'gather'; unitIds:string[]; targetId?:string }  // 省略则自动选最近
interface HoldAction   { type:'hold';   unitIds:string[] }
interface NoopAction   { type:'noop' }
```

### 8.2 校验流水线（逐条独立，任一失败即丢弃该条并记日志）

| # | 检查 | 失败原因码 |
| --- | --- | --- |
| 1 | 形状与类型（Zod） | `SCHEMA_INVALID` |
| 2 | `type` 属于白名单 | `UNKNOWN_TYPE` |
| 3 | 引用实体存在（未死亡/未被回收） | `ENTITY_NOT_FOUND` |
| 4 | 实体归属为提交方 | `NOT_OWNED` |
| 5 | 实体状态允许该动作（工人非建造中、建筑非工地、单位非死亡、单位未被本 tick 重复指派） | `INVALID_STATE` |
| 6 | 资源足够 / 建筑可训练该类型 / 兵营未达上限 / 人口未满 | `INSUFFICIENT_RESOURCE` \| `PRODUCTION_BLOCKED` \| `POP_CAP_REACHED` | 
| 7 | 目标合法（敌人在视野内、资源点未枯竭、兵营选址连通且无重叠、建造者为工人） | `INVALID_TARGET` |
| 8 | 坐标在 `[0,MAP_W/H)` 内且目标格可通行 | `OUT_OF_BOUNDS` \| `BLOCKED_TILE` |
| 9 | 动作在本次 `legalActions` 的声明式展开表内（**人类客户端豁免此项**） | `NOT_IN_LEGAL_ACTIONS` |
| 10 | 通过 | `ACCEPTED` |

补充规则：

- **批次上限**：单次决策最多接受 `MAX_ACTIONS_PER_TURN = 12` 条（超出部分丢弃，原因 `TURN_BUDGET_EXCEEDED`）。
- **单位独占**：同一 tick 内同一单位被多条动作引用时，仅第一条生效。
- **人类豁免**：第 9 项仅用于 LLM（人类的输入自由度不通过 legalActions 限制）。
- **异常兜底**：`validate` 与 `execute` 全流程 `try/catch`，任何未预期异常记 `INTERNAL_ERROR` 并按"丢弃该条"处理。

### 8.3 动作语义

| 动作 | 语义与副作用 |
| --- | --- |
| `train` | 校验后立即扣资源，建筑进入训练队列（`queue` + `progress`），完成时在建筑旁可通行格生成单位并占人口 |
| `build` | 扣资源，目标格创建 `barracks`（`constructing`，hp 按进度从 10% 涨到 100%），指派工人（`state=building`）到工地旁；工人离开 >2 格则进度暂停 |
| `move` | A* 求路，`state=moving`，仅显式移动时放弃当前采集/攻击目标 |
| `attack` | `state=attacking`，自动追击至射程内后按冷却输出；目标死亡后自动转攻击附近敌人或回到 `idle` |
| `gather` | 工人 `state=gathering`，绑定目标资源点，执行 采集→满载→回基地→卸货 循环直到被打断 |
| `hold` | `state=holding`，不移动，射程内敌人自动攻击 |
| `noop` | 无操作；用于 LLM 主动放弃本回合 |

---

## 9. LLM 接入设计

### 9.1 触发策略（`LlmController`）

| 触发条件 | 说明 |
| --- | --- |
| 定时 | `tick % LLM_DECIDE_INTERVAL_TICKS(20) === 0` |
| 发现敌人 | 相对上次决策新增可见敌方实体 |
| 资源足够 | 空闲生产建筑 + 资源 ≥ 该建筑可造单位最低成本 |
| 有单位闲置 | `idle` 单位数 > 0 且距上次决策 ≥ 20 tick |
| 基地被攻击 | 己方任意建筑/单位在最近 20 tick 内受到伤害 |

去抖与限流：
- 两次决策最小间隔 `LLM_MIN_INTERVAL_TICKS = 10`。
- 最多 **1 个在途请求**；在途期间的新触发仅置 `pending` 标记，响应回来后若 `pending` 且距今 ≥ 10 tick 立即重新决策。
- `LLM_ENABLED=false`（无 Key 或显式关闭）→ 全程 `RuleAi`。

### 9.2 超时 / 重试 / 回退

```
attempt 1 (timeout 3000ms)
   ├─ 成功且 Schema 合法 ─────────────────────────► 使用
   ├─ 网络/HTTP 错误 / 超时 ──► attempt 2 (timeout 3000ms, temperature=0)
   │                                  ├─ 成功 ──► 使用
   │                                  └─ 失败 ──► RuleAi.decide()
   └─ Schema 非法（有响应但格式错）──► 记录后直接 RuleAi.decide()（不重试，避免放大错误）
```
- 连续失败 3 次 → 熔断 `LLM_COOLDOWN_TICKS = 300`（30s）内不再调用 LLM，全部走 RuleAi，之后恢复。
- 回退产生的动作**同样**经过完整校验流水线，且回退决策写入日志（`source: "rule"`）。

### 9.3 Token 预算与压缩

| 项 | 限额 | 压缩手段 |
| --- | --- | --- |
| 己方单位 | 40（超出取最近的 40，附 `truncated:true`） | 位置量化、hp 取整、短字段名 |
| 可见敌人 | 20（取距离己方基地最近的 20） | 同上 |
| 己方建筑 | 20 | 同上 |
| `legalActions` | 展开上限 80 条 | 声明式压缩（见下） |
| `reasoning` | ≤ 200 字符（超长截断，不判非法） | 提示词约束 |
| system prompt | 单次固定约 900–1200 token | 稳定不变，可命中 prompt cache |
| 单次请求体 | 目标 < 6k token | 上述合计 |

**legalActions 声明式压缩**（响应格式与你给的示例完全一致，只是候选集用压缩形式表达）：

```json
{
  "legalActions": [
    { "type": "train",  "buildingId": "b1", "unitType": "worker" },
    { "type": "build",  "unitIds": ["u2"], "buildingType": "barracks",
      "targets": [{"x":12,"y":10},{"x":11,"y":13}] },
    { "type": "move",   "unitIds": ["u1","u3","u5"],
      "targets": [{"x":15,"y":20,"label":"enemy_base_last_seen"},
                  {"x":10,"y":12,"label":"nearest_crystal"},
                  {"x":30,"y":30,"label":"map_center"}] },
    { "type": "attack", "unitIds": ["u1","u3"],
      "targets": [{"id":"e1","x":20,"y":30},{"id":"e2","x":22,"y":31}] },
    { "type": "gather", "unitIds": ["u2"], "targets": [{"id":"r4"},{"id":"r7"}] },
    { "type": "hold",   "unitIds": ["u1","u3"] },
    { "type": "noop" }
  ]
}
```

校验第 9 项的等价展开：`unitIds ∈ 该 type 下的单位全集` 且 `(x,y) ∈ targets`（train 则 `buildingId` 与 `unitType` 必须精确匹配）。
LLM 只需回复所用到的具体条目，例如 `{"type":"move","unitIds":["u1"],"x":15,"y":20}`。
这样做同时满足三个约束：**格式与需求示例一致**、**校验仍然严格**、**token 不随单位数线性爆炸**。

### 9.4 `/api/llm/decide`

| 项 | 说明 |
| --- | --- |
| 用途 | 调试用；也可让外部进程/其他模型接管红方（`LLM_MODE=external` 时游戏循环不再内部调用） |
| 请求 | `POST /api/llm/decide`，body `{systemPrompt?, state, legalActions, options?}`；省略 systemPrompt 则用 `prompts/v1` |
| 响应 | `{reasoning, actions, meta:{source, latencyMs, attempts, accepted?, rejected?}}` |
| 鉴权 | 默认仅监听 localhost；`LLM_PROXY_TOKEN` 配置后要求 `Authorization: Bearer` |
| 幂等性 | 无状态，不接触 `GameState` |

> 架构说明：游戏循环内部调用 `LlmClient` **进程内直连**，不通过 HTTP 自请求（避免自环、超时叠加、端口依赖）。HTTP 端点复用同一 service 层，保证两条入口行为完全一致。

### 9.5 可观测性

`logs/llm/<date>/<gameId>.jsonl` 每行一条：

```json
{"ts":"2026-10-04T08:00:00.000Z","gameId":"g1","tick":120,"promptVersion":"v1",
 "model":"<MODEL>","trigger":"interval","inFlightOk":true,
 "request":{"tokenEstimate":2450,"stateHash":"a91f","legalActionCount":17},
 "response":{"latencyMs":1840,"attempts":1,"rawChars":312,"reasoning":"先补经济",
             "actions":[{"type":"train","buildingId":"b1","unitType":"worker"}],
             "parseOk":true},
 "validation":{"accepted":1,"rejected":[{"reason":"INSUFFICIENT_RESOURCE","action":{...}}]},
 "source":"llm"}
```
脱敏规则：`OPENAI_API_KEY`、`Authorization` 头、任何 `sk-*` 形态字符串一律替换为 `sk-***`；`.env` 永不打印。

---

## 10. 战争迷雾（简化但双方同等）

### 10.1 定义

`visibleTo(player)` = `⟨该方全部实体⟩` ∪ `⟨处于任一该方实体视野半径内的敌方实体⟩` ∪ `⟨交战暴露中的敌方单位⟩`

- 视野半径取实体类型常量（§3.2），**不做**视线遮挡（墙体不挡视野），不做单位朝向视野。
- 人类与 LLM 使用**同一份** `visibility` 计算（`src/game/systems/vision.ts`），只是输出形态不同：人类侧生成过滤后的快照，LLM 侧生成压缩状态 JSON。

### 10.2 三态与可见性矩阵

| 实体类别 | `unexplored`（从未进入视野） | `explored`（曾进入视野，当前不可见） | `visible`（当前在视野内） |
| --- | --- | --- | --- |
| 地形 / 岩石 | 不下发（渲染纯黑） | 下发，渲染为 45% 黑灰 | 下发，渲染正常 |
| 水晶节点 | 不下发 | **下发**（含存量，可据此规划采集） | 下发 |
| 己方单位 / 建筑 | 永远下发 | 永远下发 | 永远下发 |
| 敌方建筑 | 不下发 | **残影下发**（最后已知位置 + 血量百分比，`ghosts`） | 下发（实时） |
| 敌方单位 | 不下发 | **不下发**（不保留残影，避免"鬼影"误导） | 下发（实时） |
| 敌方资源数 / 人口 | 永不下发 | 永不下发 | 永不下发（RTS 常规：只能看到自己） |

### 10.3 交战暴露（避免"看不见的敌人打我"）

若 A 在最近 30 tick 内攻击过 B 或曾被 B 攻击，则 A 与 B 互相视为可见，直到交火停止 30 tick（3 秒）。
实现：`entity.combatExposure = tick`（每次造成/受到伤害刷新），`visibleTo` 额外纳入 `tick - combatExposure <= 30` 的敌方单位。
对 LLM 与人类同样生效。

### 10.4 前端渲染

- 两层覆盖：`unexplored` 纯黑（alpha 1.0）、`explored` 但不可见 黑灰（alpha 0.45）；**可见格不覆盖**。
- 一帧 64×64 = 4096 格，用**离屏 RenderTexture 缓存**（按格绘制），仅在 `fog.rows` 有变化时重绘受影响的 row（预算 < 1ms/tick，见 NFR-08）。
- 视野边界做 8 tick 的 alpha 过渡，减少明暗跳变；单位跨视野边界出入时的实体出现/消失用 4 tick 淡入淡出。
- 调试开关 `FOG_ENABLED=false` 时人类全图可见（仅用于开发排障，LLM 仍受限）。

### 10.5 情报记忆（作用于 LLM 视图）

- `intel.lastKnownEnemyBase: {x,y,tick} | null` —— 一旦发现永久记忆（否则 LLM 在迷雾下永远无法主动进攻）。
- `intel.lastKnownEnemySighting: {x,y,tick} | null` —— 仅 150 tick（15s）内有效。
- 人类侧不需要 `intel` 字段：残影（`ghosts`）与水晶可见即等价物。
- 该记忆属于"玩家认知"，不是游戏状态，不参与模拟，也不参与 `hashState`。

---

## 11. 确定性与回放

- `RNG`：mulberry32，构造时接受 `seed`；`GameState` 持有唯一实例，所有系统共享（**不允许**各系统自建 RNG）。
- 浮点：位置用 `number` 但每 tick 结束前量化保留 3 位小数，避免长跑漂移分歧。
- 无随机伤害（固定伤害值），无 `Math.random()`（ESLint 级别禁止，`no-restricted-globals`）。
- 状态哈希：`hashState(state)` 用 FNV-1a 遍历规范化实体数组 + 资源 + tick，用于：
  - 单测断言"同 seed + 同指令 → 同哈希"；
  - 日志中记录每 100 tick 的哈希，线上排查分歧。
- 回放：`logs/game/<gameId>.jsonl` 记录 `{seed, config, commands:[{tick, source, action}]}`；`npm run replay -- <file>` 重跑并对比终局哈希。

---

## 12. 配置项（`.env`）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `3001` | HTTP + WS 端口 |
| `OPENAI_API_KEY` | — | **仅服务端**；缺失时自动 `LLM_ENABLED=false` |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | 任何 OpenAI 兼容端点 |
| `OPENAI_MODEL` | `gpt-4o-mini` | 模型名 |
| `LLM_ENABLED` | `true` | 显式关闭即用规则 AI |
| `LLM_TIMEOUT_MS` | `3000` | 单次超时 |
| `LLM_MAX_RETRIES` | `1` | 重试次数 |
| `LLM_TEMPERATURE` | `0.2` | 决策温度 |
| `LLM_DECIDE_INTERVAL_TICKS` | `20` | 定时决策间隔 |
| `LLM_MAX_ACTIONS_PER_TURN` | `12` | 单次动作上限 |
| `LLM_COOLDOWN_TICKS` | `300` | 熔断时长 |
| `GAME_SEED` | 随机 | 固定则地图与对局可复现 |
| `FOG_ENABLED` | `true` | 战争迷雾开关。默认**双方同等受限**；置 false 时人类全图可见（仅调试/排障用，LLM 永远受限） |
| `LOG_LEVEL` | `info` | `debug` 会记录完整请求体（仍脱敏） |

---

## 13. 测试策略

| 层 | 文件 | 覆盖点 |
| --- | --- | --- |
| 动作校验 | `tests/actions/validator.test.ts` | 10 条流水线规则各 1+ 用例；表驱动；断言"拒绝原因码正确且同批其他条目不受影响" |
| 资源/经济 | `tests/game/resources.test.ts`, `economy.test.ts` | 扣费边界（刚好够/差 1）、采集循环、资源点枯竭、人口上限 |
| 胜负 | `tests/game/victory.test.ts` | 基地摧毁 → gameover + 胜方正确；非基地单位全灭不结束 |
| 视野与迷雾 | `tests/game/vision.test.ts` | explored 图层单调累积不回退；三态可见性矩阵（§10.2）逐格断言；敌方单位无残影 / 敌方建筑有残影；交战暴露生效与 30 tick 后失效；`intel` 记忆过期 |
| 防泄露 | `tests/game/snapshotFilter.test.ts` | 人类 `snap` / `events` 中检索不到不可见敌方单位 id；`ghosts` 仅含建筑；敌方资源数不出现在任何下行消息中 |
| 迷雾编解码 | `tests/game/fogCodec.test.ts` | hex 位掩码编码→解码往返一致；explored 增量按位或合并后等于直接计算结果；人类视图与 LLM 视图可见集合一致 |
| 寻路 | `tests/game/pathfinding.test.ts` | 最短路径长度、绕障碍、不可达返回 null |
| 确定性 | `tests/game/determinism.test.ts` | 同 seed 同指令 → 同 `hashState`；不同 seed → 不同地图 |
| 序列化 | `tests/llm/serialize.test.ts` | 截断上限生效、坐标量化、体积预算断言（估算 token < 6000） |
| 解析 | `tests/llm/parse.test.ts` | 代码块包裹、前后噪声、非法 JSON、缺字段、多余字段 |
| 回退 | `tests/llm/clientTimeout.test.ts` | mock fetch：超时→重试→回退；连续失败→熔断 |
| 规则 AI | `tests/llm/ruleAi.test.ts` | 各类局面下产出合法动作，且**永不产出非法动作**（用真 validator 断言 100% 通过） |
| 内核 | `tests/game/loop.test.ts` | fake timers 下 1000ms = 10 tick；对局跑到 gameover 不抛异常 |
| 渲染纯函数 | `tests/render/interp.test.ts` | 插值不越界、快照缺失容错 |
| 迷雾渲染纯函数 | `tests/render/fogMask.test.ts` | hex 位掩码编码/解码往返一致；explored 增量按位或合并正确；可见格集合推导与 `vision.ts` 结果一致 |

禁止在测试中真实调用外部 API（`fetch` 一律 mock）。
目标：阶段 5 时用例数 ≥ 45，`src/game` 与 `src/llm` 行覆盖 ≥ 80%。

---

## 14. 里程碑概览

| 阶段 | 主题 | 单句验收 |
| --- | --- | --- |
| 1 | 模拟内核（headless） | 无浏览器、无 LLM，纯 Node 脚本能跑完一局并输出胜方 |
| 2 | 渲染、迷雾与人类操作 | 浏览器能看见地图、在迷雾限制下操作自己的单位 |
| 3 | 完整对局可玩 | 人类 vs 规则 AI 能完整打完一局并有胜负 |
| 4 | LLM 指挥接入 | 红方由真实 LLM 指挥，异常时自动回退且不崩溃 |
| 5 | 打磨与交付 | `npm install && npm run dev` 一键可玩，README 完备，测试达标 |

详细任务拆解与每阶段验收清单见 **`docs/ROADMAP.md`**。

---

## 15. 决策记录（已确认 / 默认采纳）

### 15.1 用户已确认（2026-10-04）

| # | 决策点 | 结论 |
| --- | --- | --- |
| D1 | `legalActions` 中 move/attack 等带目标动作的粒度 | **声明式压缩**：候选集用「可行动单位全集 + 目标集合」表达，LLM 响应格式仍为 `{type,unitIds,x,y}`，校验时按展开表严格比对（§9.3） |
| D2 | 战争迷雾适用范围 | **双方同等受限**：人类与 LLM 都只看得到己方实体 + 视野内敌方 + 已探索地形；三态迷雾 + 交战暴露（§10），服务端权威过滤防作弊 |
| D3 | 建筑与人口规则 | 只有 base / barracks 两种建筑；base **不可重建**（打掉即败）；兵营上限 **2 座/方**；人口硬上限 **80**；**不做**人口建筑 |
| D4 | 仓库版本管理 | `git init` + `.gitignore`（忽略 `node_modules/`、`.env`、`logs/`、`dist/`）；按阶段提交，阶段 1 开工时打首个 commit |

### 15.2 默认采纳（如有异议请指出，否则按此实现）

| # | 决策点 | 默认方案 |
| --- | --- | --- |
| D5 | 人类操作完整性 | 单选 + 框选 + 右键上下文指令 + 少量快捷键（不做编队/路径点队列） |
| D6 | 单位数值 | 直接采用 §3 数值表；阶段 3 结束后做一次平衡微调（对局时长目标 5–12 分钟） |
| D7 | 部署形态 | 仅本地开发（`npm run dev`），不做 docker / 单文件部署 |
| D8 | 人类侧视野数据形态 | 客户端本地推导"当前可见格"（不下发掩码），服务端只发 `explored` 增量（§7.3） |
| D9 | 对局结束后 | 允许查看 LLM 决策时间线（reasoning / 耗时 / 被拒动作），对局中不展示 reasoning |

> 需求变更流程：任何与本文冲突的新需求，先更新本文并取得确认，再动代码。

---

## 16. 风险登记

| 风险 | 概率 | 影响 | 缓解 |
| --- | --- | --- | --- |
| LLM 响应延迟（2–6s）导致动作"过期"，观感上像发呆 | 高 | 中 | 定时 20 tick + 事件触发；动作应用时校验；前端显示"红方思考中"状态；规则 AI 负责紧急防守（可选 `HYBRID` 模式） |
| LLM 输出格式不稳定（加解释文字、代码块、多包一层 JSON） | 高 | 中 | `parse.ts` 三级容错提取 + Zod 严格校验 + 失败即回退，绝不半信半疑 |
| 无 API Key 时无法验收 | 高 | 低 | `LLM_ENABLED=false` 自动规则 AI，全流程仍可验收 |
| token 爆炸 | 中 | 高 | 上限裁剪 + 短字段 + 声明式 legalActions + 单测断言体积预算 |
| 帧率与 tick 解耦导致抖动/闪烁 | 中 | 中 | 固定步长累加器 + 前端快照插值（10 → 60fps） |
| 迷雾导致单位"凭空出现/消失"，观感突兀 | 中 | 中 | 实体出现/消失做 4 tick 淡入淡出；视野边界 alpha 过渡；交战暴露避免"隐形敌人攻击" |
| 迷雾渲染每帧重绘 4096 格导致掉帧 | 低 | 中 | 离屏 RenderTexture 缓存 + 仅重绘变化行（NFR-08，预算 < 1ms/tick） |
| 客户端被篡改（改代码看全图） | 低 | 低 | 服务端权威过滤，客户端根本收不到不可见数据，篡改无收益 |
| 长时间运行浮点漂移破坏确定性 | 低 | 低 | 每 tick 位置量化 + `hashState` 定期比对 |
| 范围蔓延（想加科技树/多人/迷雾渲染） | 中 | 高 | §1.2 非目标清单 + 需求冲突必须停下来问 |

---

## 17. 阶段 1 实现偏差记录（v1.2）

阶段 1（模拟内核，headless）落地时对本文做了以下调整。**代码为最终事实**，此表保证文档与代码一致。

| # | 项 | 原计划 | 实际实现 | 理由 |
| --- | --- | --- | --- | --- |
| P1-1 | `GATHER_RANGE` | 1.2 tile | **1.5 tile** | 1.2 只允许正交相邻采集（1.0），对角线相邻（1.414）被拒；1.5 两者皆可，仍排除 2 格外 |
| P1-2 | 可见性实现位置 | `src/game/view/visibility.ts` | **`src/game/systems/vision.ts`** | 人类视图与 LLM 视图必须共用同一份计算，放在 systems 里避免出现两份可见性逻辑；`view/` 只保留 `fogCodec.ts` / `snapshot.ts` |
| P1-3 | 建造前置状态 | 工人"空闲"（idle） | idle / holding / **gathering** 均可 | 把采集中的工人拉去工地是常规 RTS 操作；实现为工人放弃采集循环转入建造 |
| P1-4 | 建造中的工人能否被 `move` 拉走 | 未定义 | **可以**（工地进度暂停，不取消） | 否则工人一旦卡在工地就永远无法自救。注意：LLM 的 `legalActions` 仍不列出建造中的工人，避免 LLM 误操作让自家工地停摆 |
| P1-5 | 单批指令上限 | 统一 12 条 | **LLM/规则 AI 12 条，人类 32 条** | 12 条是针对自动化指挥的反滥用限制；人类框选一次操作多个单位属正常操作 |
| P1-6 | 事件类型 | 无 `gameover` | 新增 `gameover`；`GameEvent.visibleTo` 记录"当时能看见该事件的玩家" | 死亡事件在实体已被移除后无法再判定可见性；同时保证不可见的死亡不泄露给对手 |
| P1-7 | 地形是否属于迷雾 | §10.2 写"unexplored 不下发地形" | `init` 下发完整岩石布局，客户端**只在已探索区域绘制** | 地形由 seed 决定且对双方完全相同，属公开信息；隐藏它收益为零却会让渲染复杂化。实体位置仍严格过滤 |
| P1-8 | 建筑占地 | 未明确 | 所有建筑占 **1 格** | MVP 简化；多格占地会牵动放置校验、寻路与渲染三处 |
| P1-9 | 超时判定 | "无平局" | `MAX_TICKS` 到达时按 基地血量比 → 兵力 → 平局 判定 | 仅供 headless 跑局与极端僵局兜底，正常对局均在 2500 tick 内结束 |
| P1-10 | 单位碰撞 | 未要求避障 | 单位之间**不碰撞**，仅地形阻挡 | 与 §1.2 非目标一致 |

阶段 1 验证结果（2026-10-04）：`npx tsc --noEmit` 零报错；`npm test` 13 个文件 / 127 用例全绿；`npm run sim -- --seed 12345 --ticks 9000` 于 2075 tick 分出胜负、0 条非法动作、耗时 0.25s；同 seed 两次运行哈希完全一致。

---

*本文件为实现契约。任何偏离需先更新本文件并取得确认。*
