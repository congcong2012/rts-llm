# ROADMAP — 阶段 1~5 任务拆解与验收标准

> 配套文档：`docs/SPEC.md`（契约）、`docs/LLM_PROMPT.md`（提示词）
> 执行纪律：**每个阶段只做本阶段范围**；每阶段结束必须跑测试与构建并提交报告（改了哪些文件 / 如何运行 / 测试结果 / 未完成与风险）；需求冲突先停下提问。
> 阶段之间不并行。上一阶段验收未通过，不进入下一阶段。

---

## 总览

| 阶段 | 主题 | 依赖 | 预估产出 |
| --- | --- | --- | --- |
| 1 | 工程骨架 + 模拟内核（headless） | — | 可 headless 跑完整局 ✅ **已完成** |
| 2 | 渲染、战争迷雾与人类操作 | 阶段 1 | 浏览器可玩蓝方（视野受限）✅ **已完成** |
| 3 | 完整对局（人类 vs 规则 AI） | 阶段 2 | 能分出胜负的完整对局 |
| 4 | LLM 指挥接入 | 阶段 3 | 红方由真实 LLM 指挥 |
| 5 | 打磨、文档与交付 | 阶段 4 | 一键可玩 + 达标测试 |

---

## 阶段 1 — 工程骨架与模拟内核（headless，无浏览器、无 LLM）✅ 已完成（2026-10-04，见文末完成记录）

### 目标
搭出严格模式 TS 工程，实现**零 IO 依赖**的权威模拟内核：能在 Node 里用一条命令跑完一整局（蓝红双方都由脚本/规则驱动），输出 tick 日志与终局哈希。

### 任务清单
1. 工程初始化：`package.json`、`tsconfig.json`（`strict`、`noUncheckedIndexedAccess`、`noImplicitOverride`）、`vite.config.ts`（暂留）、`vitest.config.ts`、`.gitignore`、`.env.example`（字段先占位）。
2. `src/shared/types.ts` + `src/shared/protocol.ts`：实体、动作、快照、WS 消息类型（前后端共享，本阶段只定义不消费）。
3. `src/game/config/constants.ts`：把 SPEC §3 全部数值落成常量（唯一来源）。
4. `src/game/rng/index.ts`：mulberry32 + `hashState()`。
5. `src/game/entities/*`：Unit / Building / Resource 定义与工厂函数（id 采用 `u1/b1/r1` 前缀自增，便于 LLM 引用与日志阅读）。
6. `src/game/map/*`：`grid.ts`、`terrain.ts`（阻挡位图层）、`generate.ts`（seeded 地图生成 + 连通性校验）、`pathfinding.ts`（A*，4 邻域 + 对角，含不可达返回 null）。
7. `src/game/systems/*`：economy、production、movement、combat、vision、victory、spawn 七个 tick 函数（纯函数式，输入输出都是 state）。其中 `vision` 额外维护 `visible(p1)/visible(p2)/explored(p1)/explored(p2)` 四份集合与交战暴露时间戳（SPEC §10）。
8. `src/game/view/*`：`snapshot.ts`（人类视角过滤快照，含 `ghosts` 残影）、`fogCodec.ts`（explored 位掩码编码/解码/增量合并，纯函数）、`visibility.ts`（与 `src/llm/serialize.ts` 共用同一份可见性计算）。
9. `src/game/actions/*`：`schema.ts`（Zod）、`validator.ts`（SPEC §8.2 十步流水线）、`executor.ts`（唯一状态写入口）、`legalActions.ts`（声明式候选构建，本阶段用于规则 AI）。
10. `src/game/state/GameState.ts`：状态容器 + 实体索引 + `clone()`。
11. `src/game/GameLoop.ts`：`createGame(seed, config)` / `stepTick(state)` / `getSnapshot()`，不依赖任何网络或定时器（定时器由外层驱动）。
12. `src/llm/ruleAi.ts`：本地规则 AI（本阶段就写，作为阶段 1 的"红方操作者"和阶段 4 的回退）。
13. `scripts/simulate.ts`：`npm run sim -- --seed 12345 --ticks 9000` headless 跑一局，双方都用 RuleAi，打印每 100 tick 摘要与终局结果。
14. 测试：`tests/game/*`（pathfinding、resources、economy、vision、victory、determinism）、`tests/actions/validator.test.ts`、`tests/game/fogCodec.test.ts`、`tests/game/snapshotFilter.test.ts`。
15. `git init` + `.gitignore`（忽略 `node_modules/`、`.env`、`logs/`、`dist/`），提交本阶段为第一个 commit。

### 验收标准
| # | 标准 | 验证方式 |
| --- | --- | --- |
| A1 | `npm install` 无错误，`npx tsc --noEmit` 零报错（严格模式） | 命令 |
| A2 | `npm test` 全绿，用例数 ≥ 15 | 命令 |
| A3 | `npm run sim` 能在 30 秒内跑完一局并打印胜方、总 tick、双方终局资源与 `/hash` | 命令 |
| A4 | 同 seed 跑两次，终局哈希**完全一致**；换 seed 地图不同 | `npm run sim -- --seed 1` ×2 对比 |
| A5 | 地图生成 100 次随机 seed，全部通过双方基地连通性校验（无异常抛出） | `tests/game/mapgen.test.ts` |
| A6 | 工人采集闭环：跑 600 tick 后蓝方资源 > 开局值（证明采集→卸货生效） | 单测断言 |
| A7 | 规则 AI 在 200 个不同局面下产出的动作 100% 通过 validator（零非法动作） | `tests/llm/ruleAi.test.ts` |
| A8 | 三态可见性矩阵逐格正确：unexplored 不下发 / explored 下发地形与水晶、敌方建筑有残影、敌方单位无残影 / visible 全量 | `tests/game/vision.test.ts` |
| A9 | 人类视图过滤后检索不到不可见敌方单位 id，且不含敌方资源数（防泄露） | `tests/game/snapshotFilter.test.ts` |
| A10 | fog 位掩码编码→解码往返一致，explored 增量按位或合并后与直接计算一致 | `tests/game/fogCodec.test.ts` |

### 交付物
可运行内核 + `npm run sim` 演示 + 测试报告 + 终局哈希样例。

### 本阶段不做
渲染、Phaser、Express、WebSocket、任何 LLM 网络调用、UI。

### 完成记录（2026-10-04）

**状态：已完成，A1~A10 全部通过。**

| 验收 | 结果 |
| --- | --- |
| A1 | `npx tsc --noEmit` 零报错（strict + noUncheckedIndexedAccess + noImplicitOverride + noUnusedLocals） |
| A2 | `npm test` → 13 个测试文件 / **127 个用例全绿**（目标 ≥15） |
| A3 | `npm run sim -- --seed 12345 --ticks 9000` → p1 于 tick 2075 取胜，打印胜方/总tick/终局资源/哈希，**耗时 0.25s** |
| A4 | 同 seed 跑两次终局哈希一致（`a08a23a9`）；换 seed 地图与结果不同 |
| A5 | 100 个 seed 的地图生成全部通过连通性 + ≥6 可达水晶校验 |
| A6 | 600 tick 采集后资源由 250 → >250（单测断言） |
| A7 | 规则 AI 在 200 个真实局面下产出动作 100% 通过 validator（含 legalActions 成员校验） |
| A8 | 三态可见性矩阵、ghost 残影、交战暴露 30 tick 全部单测覆盖 |
| A9 | 人类快照中检索不到不可见敌方单位 id，也不含敌方水晶数 |
| A10 | fog 位掩码编码/解码往返一致，增量 diff+OR-merge 等价于全量编码 |

实测数据：seed 1/7/999/4242 均在 1964~2510 tick 内分出胜负，全部 0 条非法动作；单局运行 0.25~0.7s。

产出文件：`src/shared/{types,protocol}.ts`、`src/game/{config,math,rng,entities,map,state,systems,actions,view}`、`src/game/GameLoop.ts`、`src/llm/ruleAi.ts`、`scripts/simulate.ts`、`tests/**`（13 个文件）、`package.json`、`tsconfig.json`、`vitest.config.ts`、`.env.example`。

与 SPEC 的实现偏差已记入 `docs/SPEC.md §17`（GATHER_RANGE 1.2→1.5、可见性落在 systems/vision.ts、工人可被拉离工地、人类批次上限 32、地形属公开信息等）。

**遗留（转入后续阶段）**：`npm run bench`、`src/server/*`、`src/render/*`、`src/llm/{prompts,serialize,legalActions,parse,llmClient,controller}`、`README.md`。

---

## 阶段 2 — 前端渲染与人类操作（蓝方手动可玩）✅ 已完成（2026-10-04，见本节完成记录）

### 目标
浏览器里能看到 64×64 地图并在**战争迷雾限制下**操作蓝方：未探索区域纯黑，移动后逐步揭示，已探索区域变暗保留地形与敌方建筑残影；能选中自己的单位并用右键下达移动/采集/攻击指令；相机可平移缩放；HUD 显示资源与人口。

### 任务清单
1. `src/server/index.ts`：Express + `ws` 最小可用网关；`GameLoop` 以 `setInterval(100ms)` 驱动；连接即发 `init`（含初始 fog 图层），每 tick 广播过滤后的 `snap`，fog 变化时下发 `fog` 增量。
2. `src/server/ws/gateway.ts`：连接生命周期、`cmd` 消息接收 → 走**同一个** validator/executor、`ping/pong`、断线处理、下行消息统一经 `snapshotForHuman()` 过滤（**唯一出口，杜绝绕过**）。
3. `index.html` + HUD DOM 骨架（资源、人口、tick、FPS、状态条）。
4. `src/render/main.ts` + `scenes/GameScene.ts`：Phaser 启动、世界坐标系（`TILE_PX=32`）、相机边界与缩放。
5. `src/render/draw/*`：网格线、岩石、水晶（菱形）、单位（圆 + 阵营色 + 血条）、建筑（方/三角），全部 `Graphics`/`Shape`，**零素材**。
6. `src/render/fog/*`：`fogMask.ts`（explored 位掩码 → 本地可见格集合合并，纯函数可单测）、`fogLayer.ts`（离屏 RenderTexture + 两层覆盖：unexplored 纯黑 / explored 黑灰 alpha 0.45；仅重绘变化行；视野边界 alpha 过渡 8 tick）；`ghosts` 残影绘制（半透明 + 虚线描边）。
7. `src/render/input/selection.ts`：单选 + 框选（拖拽矩形，**仅可选中当前可见/己方实体**）；`commands.ts`：右键上下文指令（地面→move，水晶→gather，敌方→attack，己方工地→协助）；`hotkeys.ts`：相机 WASD、空格回基地、ESC 取消选择。
8. `src/render/net/NetClient.ts`：WS 连接、快照缓存、`fog` 增量合并、重连提示。
9. `src/render/interp.ts`：快照插值（10 tick/s → 60fps 平滑），纯函数可单测；单位进出视野做 4 tick 淡入淡出。
10. `src/render/scenes/HudScene.ts`：HUD 更新 + 全屏遮罩（连接中/断线）。
11. 测试：`tests/render/interp.test.ts`、`tests/render/fogMask.test.ts`、`tests/server/gateway.test.ts`（内存双工 mock，验证 `cmd → 状态变化` 且下行消息已过滤）。
12. `npm run dev`：`concurrently` 起 `tsx watch src/server/index.ts` 与 `vite`，vite 代理 `/api`、`/ws` 到 3001。

### 验收标准
| # | 标准 | 验证方式 |
| --- | --- | --- |
| B1 | `npm install && npm run dev` 后打开 `http://localhost:5173` 能看到己方基地与周围已被自身视野揭示的地图 | 人工 |
| B2 | 左键单选、拖拽框选生效，被选单位有高亮环；**不可见实体无法被选中** | 人工 |
| B3 | 右键地面 → 单位沿 A* 路径绕开岩石移动，移动过程**平滑无抖动**（插值生效） | 人工 |
| B4 | 右键水晶 → 工人开始采集，资源数字持续上涨 | 人工 |
| B5 | HUD 实时显示水晶、人口、tick、FPS（FPS ≥ 55，迷雾开启时仍达标） | 人工 |
| B6 | 相机平移/缩放不越界，缩放范围 `[0.35, 2.0]` | 人工 |
| B7 | 迷雾正确：初始大部分为黑；单位移动沿途揭示；离开视野后变暗但**不回黑**；敌方单位离开视野后消失、敌方建筑留残影 | 人工 |
| B8 | 反作弊：浏览器的 WS 帧里检索不到不可见敌方实体 id（DevTools → Network → WS → 搜索敌方 id） | 人工 |
| B9 | 200 实体下服务端单 tick 耗时 P95 < 8ms，fog 增量编码 < 0.5ms（`npm run bench` 输出） | 命令 |
| B10 | `npm test` 全绿（含新增 interp / fogMask / gateway 用例） | 命令 |

### 交付物
可交互浏览器沙盒（迷雾、移动、采集、选择、相机构成；训练/建造 UI 留待阶段 3）。

### 本阶段不做
训练/建造 UI、战斗特效、LLM、迷雾小地图。

### 完成记录（2026-10-04）

**状态：已完成，B1~B10 全部通过。**

| 验收 | 结果 |
| --- | --- |
| B1 | `npm run dev` 后 `http://localhost:5173` 显示己方基地与周围已揭示地图；相机初始即对准己方基地（实测基地落在屏幕 336,336） |
| B2 | 左键单选、拖拽框选、空地取消选择均生效，被选单位有黄色高亮环；**非己方/不可见实体永不进入选择集**（单测 + 浏览器双重验证） |
| B3 | 右键地面 → 沿 A* 路径移动；约 90ms 采样 14 次，单次位移最大 0.20 格，无跳跃 |
| B4 | 右键水晶 → 工人进入采集循环，实测 `state=2, task=r10` 且水晶数上涨 |
| B5 | HUD 实时显示水晶 / 人口 / tick / FPS / 迷雾进度 / 种子；实测 **60 FPS**（迷雾开启、200 实体规模） |
| B6 | WASD 平移、空格回基地、Q/E 缩放；缩放实测夹紧在 `[0.35, 2.0]`；相机不出地图边界 |
| B7 | 迷雾三态像素级实测：未探索 **alpha 255**、已探索未可见 **114.75**（=0.45）、可见 **0**；行进沿途揭示且单调不减（7.7%→12.4%）；敌方单位离视野即消失，敌方建筑留虚线残影（绘制层单测断言虚线几何 + 截图确认） |
| B8 | 在真实 WS 帧流中检索 `b2/u5/u6/u7/u8` 全部不存在；快照中无任何 `o=1` 实体行；死亡事件按 `visibleTo` 过滤 |
| B9 | 200 实体下单 tick 服务端耗时与迷雾编码耗时：见阶段 5 的 `npm run bench`（本阶段未提供该命令，已记录为遗留） |
| B10 | `npm test` → 19 个文件 / **228 个用例全绿**（连续三次运行结果一致） |

**自动化验收**：新增 `scripts/browser-acceptance.cjs`，用真实 Chromium 驱动真实 WebSocket，**34/34 项检查通过**（覆盖上表 B1~B8 的可自动判定部分），截图输出到 `logs/acceptance-shots/`。运行方式见 `README.md § 测试`。

**其它实测**：`npx tsc --noEmit` 零报错；`npm run build` 成功（单包 1.7MB / gzip 393KB，主要为 Phaser）；`npm run sim -- --seed 12345` 结果与阶段 1 完全一致（tick 2075、0 条丢弃、哈希 `a08a23a9`），证明渲染层没有污染内核确定性。

产出文件：
- 服务端：`src/server/index.ts`、`src/server/ws/gateway.ts`、`src/server/logger.ts`
- 渲染：`index.html`、`src/render/{main.ts,interp.ts}`、`src/render/{scenes,draw,fog,input,net,state}/*`
- 工程：`vite.config.ts`（含 Vitest 配置）、`tsconfig.json`（补 DOM lib）、`.env.example`、`README.md`、`.gitignore`
- 测试：`tests/server/gateway.test.ts`、`tests/render/{interp,fogMask,input,draw}.test.ts`、`tests/game/purity.test.ts`
- 内核微调：`src/game/GameLoop.ts`（新增 `GameLoop` 类 / `dispatchHumanCommands` / `blockedRows` / `HUMAN_PLAYER`）、`src/game/actions/schema.ts`（`encodeActionList`）、`src/game/config/constants.ts`（`RULE_AI_DECIDE_INTERVAL_TICKS`）

与 SPEC 的实现偏差已记入 `docs/SPEC.md §18`（12 项，含 P2-7 相机初始位置 bug、P2-12 临时目录导致测试静默缺失等实测教训）。

**遗留（转入后续阶段）**：
- `npm run bench`（B9 的量化验收）→ 阶段 5
- 训练/建造 UI、战斗特效、迷雾小地图 → 阶段 3
- `src/llm/{prompts,serialize,legalActions,parse,llmClient,controller}` 与 `POST /api/llm/decide` → 阶段 4
- `npm audit` 报 5 个漏洞（3 moderate / 1 high / 1 critical），全部位于 vite/vitest 开发链路，`npm audit fix --force` 会产生破坏性升级，**待你决定是否处理**

---

## 阶段 3 — 完整对局：人类 vs 本地规则 AI（可分出胜负）

### 目标
打通全部 RTS 动作与胜负条件，人类蓝方 vs 规则 AI 红方能完整打一局；非法输入不崩溃。

### 任务清单
1. 生产系统完善：训练队列（进度条）、建筑建造（工地状态 + 工人陪伴推进）、人口校验、出兵落点寻找。
2. 存档位选择与建筑放置校验（连通、不重叠、不越界）；`build` 的 UI 预览幽灵方块 + 非法位置红色提示。
3. 战斗完善：索敌、射程判定、冷却、伤害结算、死亡回收与视野清理、自动反击、`attack-move` 语义（追击）、**交战暴露**（交火双方在脱离视野后 30 tick 内仍互相可见，SPEC §10.3）。
4. 胜负：`system victory` + `gameover` 广播 + 前端结算遮罩（胜/负、耗 tick、"再来一局"按钮）。
5. HUD 扩展：选中实体详情（HP、状态、当前任务）、训练/建造按钮与快捷键（B 造工人 / S 造士兵 / E 造兵营 / H 待命）、人口与队列显示。
6. `RuleAi` 提升为完整策略：开经济（补工人到 8）→ 造兵营 → 持续出兵 → 防御基地 → 兵力达标后集体进攻敌方基地（含撤退阈值）；侦察与迷雾下的目标优先级。
7. 指令限流与容错：人类客户端也走 validator，非法指令丢弃并计数（HUD 小提示"指令无效"）。
8. `src/server/replay.ts`：录制 `{seed, config, commands}`；`npm run replay -- logs/game/xxx.jsonl` 重跑并对比终局哈希。
9. 测试：胜利/失败、训练与建造边界、人口上限、资源刚好够/差 1、单位死亡瞬间下达非法指令不崩溃、交战暴露、replay 哈希一致。

### 验收标准
| # | 标准 | 验证方式 |
| --- | --- | --- |
| C1 | 人类可完整操作：采集 → 造工人 → 造兵营 → 造士兵 → 移动 → 攻击 → 摧毁红方基地，出现胜利遮罩 | 人工 |
| C2 | 规则 AI 能自主开经济、造兵营、出兵、防守与进攻；在玩家不操作时能反过来推掉蓝方基地 | 人工 |
| C3 | 人口到 80 后训练被拒绝且有明确 UI 提示 | 人工 |
| C4 | 资源不足时按钮置灰，强行发指令被服务端丢弃且无异常 | 人工 + 日志 |
| C5 | 任一 tick 下达 200 条垃圾/畸形指令，服务端不崩溃、不卡顿、全部记录原因码 | `tests/server/fuzz.test.ts` |
| C6 | 同 seed + 录制指令回放，终局哈希与原局一致 | `npm run replay` |
| C7 | 单局 15 分钟长跑无内存泄漏（堆增长 < 20%）与无未捕获异常 | `npm run sim -- --ticks 9000 --metrics` |
| C8 | 交战暴露：偷袭红方工人后即使脱离视野，仍能看到红方赶来支援的士兵（30 tick 内） | 人工 |
| C9 | `npm test` 全绿，用例数 ≥ 30 | 命令 |

### 交付物
一个功能完整的单机 RTS（对手是规则 AI），可作为 LLM 接入的稳定底座。

### 本阶段不做
LLM、美术打磨、小地图。

---

## 阶段 4 — LLM 指挥接入（红方换脑）

### 目标
红方由真实 LLM 通过后端代理指挥：每 20 tick / 事件触发决策，输出严格 JSON，服务端全量校验，异常自动回退规则 AI，全程可观测且不阻塞游戏循环。

### 任务清单
1. `docs/LLM_PROMPT.md` → 落地为 `src/llm/prompts/v1.ts`（含 `PROMPT_VERSION`）。
2. `src/llm/serialize.ts`：迷雾过滤 + 压缩 + 量化 + `intel` 记忆（敌方基地永久、目击 150 tick）+ 截断上限（SPEC §9.3）。**必须复用阶段 1 的 `game/view/visibility.ts`**，不得另写一份可见性逻辑（新增用例：人类视图与 LLM 视图对同一 state 的可见集合一致）。
3. `src/llm/legalActions.ts`：声明式候选生成（train/build/move/attack/gather/hold/noop）+ 校验用展开表。
4. `src/llm/parse.ts`：三级容错提取 JSON（直接解析 / 剥离 ```` ```json ```` 围栏 / 取首尾大括号子串）+ Zod 校验。
5. `src/llm/llmClient.ts`：OpenAI 兼容 `POST {BASE_URL}/chat/completions`；`AbortController` 3s 超时；重试 1 次（第二次 `temperature=0`）；错误分类（网络/HTTP/超时/格式）。
6. `src/llm/controller.ts`：触发策略（定时 + 4 类事件）、去抖（≥10 tick）、在途锁 + `pending` 标记、连续失败熔断 300 tick、`source: llm|rule` 标记。
7. `src/server/routes/llm.ts`：`POST /api/llm/decide`（复用同一 service 层）；`LLM_MODE=internal|external`。
8. `src/server/logger.ts`：JSONL 落盘 + 脱敏（`sk-*` / `Authorization` / 环境变量永不落盘）+ 按天分目录。
9. 前端：红方 AI 状态指示（思考中/正常/已回退，**不展示 reasoning 内容**）；对局结束后可查看决策时间线（reasoning、耗时、被拒动作）。
10. 测试：`tests/llm/*`（parse 的 8 种脏输入、serialize 体积预算、legalActions 压缩、mock fetch 超时→重试→回退、熔断恢复、迷雾过滤正确性、ruleAi 回退永不非法）。
11. `README` 雏形：API Key / BASE_URL / MODEL 配置说明（阶段 5 完善）。

### 验收标准
| # | 标准 | 验证方式 |
| --- | --- | --- |
| D1 | 配置真实 Key 后，红方能自主补工人、造兵营、出兵、进攻、防守，最终能摧毁蓝方基地（至少 1 局成功） | 人工 |
| D2 | 每次决策请求体 token 估算 < 6000，`legalActions` ≤ 80 条 | 单测 + 日志 |
| D3 | 非法输出（缺字段、超 12 条动作、引用不存在单位、越界坐标、造兵营资源不足）全部被丢弃并记录原因码，**游戏继续运行** | `tests/llm/integration.test.ts` |
| D4 | LLM 超时 3s → 重试 1 次 → 回退规则 AI，玩家侧无卡顿（tick 不掉帧） | mock + 人工 |
| D5 | 连续失败触发熔断，日志中有 `source:"rule"` 记录，冷却后自动恢复 LLM | 日志 |
| D6 | LLM 看不到视野外敌人与未探索信息（构造测试场景断言） | 单测 |
| D7 | `logs/llm/**` 中 grep `sk-` 或真实 Key **零命中** | 命令 |
| D8 | 日志与回放中带 `stateHash`，可定位分歧 tick | 日志 |
| D9 | `npm test` 全绿，用例数 ≥ 40 | 命令 |

### 交付物
人类 vs LLM 的可玩对局 + `POST /api/llm/decide` 调试端点 + 完整 LLM 日志。

### 本阶段不做
多轮对话式决策、工具调用、多模型投票、LLM 学习/微调。

---

## 阶段 5 — 打磨、文档与交付

### 目标
一键可玩、文档完备、测试达标、异常兜底到位。

### 任务清单
1. `README.md` 完整版：环境要求、`npm install` / `npm run dev` / `npm test` / `npm run sim` / `npm run replay`、`.env` 逐项说明（API Key、BASE_URL、MODEL）、无 Key 时的降级行为、常见问题（端口占用、代理、模型不支持 JSON）、操作键位表。
2. 性能：`npm run bench`（200 实体 tick 耗时、快照体积、token 估算）输出报告；必要时引入 delta 快照与实体池化。
3. 健壮性：全局 `uncaughtException` / `unhandledRejection` 捕获与日志；WS 消息大小上限；恶意超长字符串防护；`try/catch` 全覆盖 validator/executor。
4. 体验打磨：事件特效（攻击线、命中闪白、死亡淡出）、相机边缘滚动、`FOG_ENABLED` 调试开关（关闭后仅人类全图可见，LLM 永远受限）、暂停/加速（1x/2x/4x，仅调试）、小地图（按已探索图层渲染）、对局结果面板与统计（资源曲线、单位损失、LLM 决策次数与回退率）。
5. 测试收口：补齐覆盖率到 `src/game`、`src/llm` ≥ 80%；新增 `fuzz`（随机垃圾动作 10 万条）与确定性长跑（9000 tick）用例。
6. `.env.example` 与 `docs/` 校对；清理死代码与 TODO；ESLint（可选）`no-restricted-globals: Math.random` 落地。
7. `git` 提交收口：每阶段一个 commit（阶段 1 已 `git init`），`.env`、`logs/`、`node_modules/`、`dist/` 均已忽略。

### 验收标准
| # | 标准 | 验证方式 |
| --- | --- | --- |
| E1 | 全新克隆后 `npm install && npm run dev` → 浏览器直接可玩（含无 Key 时的规则 AI 降级路径） | 人工 |
| E2 | 人类可采集、造兵、移动、攻击、摧毁敌方基地 | 人工 |
| E3 | LLM 玩家能自动发展、造兵、进攻、防守 | 人工 |
| E4 | 非法 LLM 输出不崩溃（含 10 万条模糊测试） | 命令 |
| E5 | `npm test` 全绿，用例 ≥ 45，行覆盖 ≥ 80% | 命令 |
| E6 | README 覆盖 Key / BASE_URL / MODEL 配置、迷雾说明与键位表 | 文档审查 |
| E7 | 单 tick P95 < 5ms，快照 < 12KB，token 估算 < 6000 | `npm run bench` |
| E8 | 对局无未捕获异常、无内存持续增长、可正常结束与重开 | 人工 + 日志 |
| E9 | 迷雾全链路回归：双方同等受限、无信息泄露、`FOG_ENABLED=false` 时人类全图可见而 LLM 仍受限 | 人工 + `tests/game/snapshotFilter.test.ts` |

### 交付物
完整仓库：源码 + 测试 + 文档 + 一键运行。
