# 模型标注 / 切换 + 队列合并（设计与施工记录）

> 状态：施工中。完工时逐条核对本文件的整体思路；实现若偏离，在文末「偏差记录」写明理由。

## 1. 目标

三件互相咬合的事，落点都在 bridge 的入站 → 排队 → 注入 → 回复主链路上：

1. 每条**模型回复**标注是哪个模型回复的。
2. `/models` 罗列可选模型（白名单 + 当前），标注当前。
3. `/models <N>` 切换模型，且切换对其后的消息（含排队未发的）立即生效。
4. 同一 chat 的连发消息合并成一次模型调用（队列 + linger），并按批回执。

## 2. 模型白名单（`config.json`）

新增字段：

```json
"models": [
  "deepseek/deepseek-flash",
  "deepseek/deepseek-v4-pro",
  "moonshotai-cn/kimi-k2.7-code",
  "moonshotai-cn/kimi-k2.6",
  "moonshotai-cn/kimi-k2.7-code-highspeed",
  "moonshotai-cn/kimi-k3"
]
```

- 复用 `parseModel()`（`src/kilo.ts`）解析 `providerID/modelID`；非法项跳过并 warn。
- 加载期不校验（加载离线）；`/models` 执行时再校验白名单与 connected。
- 展示 label 从 `provider.list` 的 `name` 取，取不到回退 id（`deepseek-flash` 的 id ≠ name）。

## 3. 回复头部

- 位置唯一：`resolveReply` 拼 body 处，前缀一行 `▸ providerID/modelID`。
- 来源：assistant 消息 `info.providerID/modelID`（实际作答模型），取最后一条已完成消息。
- **只加在模型回复**上；ack / 审批 / timer / terminal / context 通知不加。
- 仅飞书侧渲染，不进 session 上下文。per-bot `modelHeader`（默认 true）可关。

## 4. `/models` 查看

- 列表 = **白名单固定顺序** + **当前模型**（仅当不在白名单，追加末尾）。
- 白名单项编号恒为 1..K；当前项标记。
- 当前模型取 `sessionModel()`（`src/kilo.ts`）；有 pending 时标「（下一条消息生效）」。

## 5. `/models <N>` 切换

- N 按**规范列表**解析（不依赖上次快照，跨重启稳），无需「先发 /models」。
- **立即生效**：在**构建 prompt 时**解析模型，所以对排队 drain 也有效；正在跑的那一轮不受影响。
- 机制 **A'（一次性 pending）**：切换只设 `rt.pendingModel`；下一条 prompt 带上它一次、成功后清掉；之后继续 `undefined`，靠 session 记住。
- 切换时校验属于白名单；prompt 若因该模型报错 → 清 pending + 走 `[系统] 消息处理失败`。
- 设 pending 是纯内存动作，**忙碌也允许**（不像 `/new`、`/pin` 要拒）。

## 6. 队列：per-chat + linger 合并

- 队列从 per-runtime 单队列改为 **per-chat 队列**（同 chat 才合并）。
- 入站先进该 chat 的 batch，并重置 **linger**（静默 <1s，可配）定时器；静默到才行动。
- drain 时整批合并成**一个 prompt** → 一个 injectedId → 一次 `resolveReply` → 一条回复。
- 附件路径已在入队前内联进 `text`，合并天然保留。
- 单批不定上限（已知风险，后续需要再加 cap）。

## 7. 回执状态机（per-chat）

| 状态 | 触发 | 回应 |
|---|---|---|
| coalescing | 有消息、仍在连发 | 逐条不回应，静默 |
| queued | 静默到但 session 正忙 | 回**一次**「前面还在处理，已排队」 |
| processing | 静默到且空闲 → drain | 回**一次**「收到，开始处理」（批量时带条数） |

- 每批最多两条信号（排队 + 开始处理），各自去重；绝不逐条 ack。
- 复用 `ack: always/delayed/off`，粒度上移到「每批」：
  - `always`：queued 发「已排队」，drain 发「开始处理」。
  - `delayed`：不发「开始处理」；仅当等待超过 `ackDelayMs` 才发「已排队」。
  - `off`：都不发。
- 「开始处理 / 已排队」是系统消息，**不带模型头部**。

## 8. 与现有机制的交互

- 回复路由随 per-chat 队列变准，回复精确发给对应 chat。
- `auto-handoff` / session `handoff`：携带「当前模型」（`rt.pendingModel ?? sessionModel`）。
- `/new`：设 pending＝白名单首个模型（下一条用户消息生效，之后靠 session 记住）并清所有 chat batch；仅针对飞书 `/new`，不影响启动/handoff 建的 session。`/pin`：保留 pending，清 batch。
- `/compact`：仍用固定 `config.model`，本次不动。
- `switchSession` 的队列清理、`tryDispatch` / `requestAutoHandoff` 的「队列非空」判定，都改为「任一 chat batch 非空」。

## 9. 验证

- `npm run typecheck`。
- 新增/改造 `test/*.ts`（沿用直连风格）：模型列表与 N 解析、头部格式化、同 chat 合并、回执状态机、切换 pending 生效。
- `inbound-ack.ts` 按新 batch 语义重写。

## 10. 落地顺序

1. 白名单配置 + 头部
2. `/models` 查看 + 切换
3. per-chat 队列 + linger 合并 + 回执状态机

## TODO

- [x] types.ts：`Config.models`、`BotConfig.modelHeader`、`queue.coalesceMs`
- [x] `src/models.ts`：白名单解析 / 规范列表 / 头部格式化 / 列表渲染
- [x] kilo.ts：`providerCatalog()`（labels + connected + available）
- [x] bridge.ts：头部前缀（`resolveReply`）
- [x] bridge.ts：`/models` 查看 + `/models <N>` 切换 + `rt.pendingModel`
- [x] bridge.ts：prompt 构建时应用 pendingModel（`deliver`/`promptWake`）
- [x] bridge.ts：per-chat 队列 + linger + drain 合并
- [x] bridge.ts：回执状态机（coalescing/queued/processing）+ ack 语义上移
- [x] bridge.ts：交互修正（switchSession / tryDispatch / requestAutoHandoff / handoff 携带模型）
- [x] config.json / config.example.json 增补 models + coalesceMs
- [x] 测试新增/改造；typecheck 全绿
- [x] 完工核对本文件，写「偏差记录」（检视会话确认，见文末「检视结论」）

## 偏差记录

实现相对上述思路的偏差（均可接受，理由如下）：

1. **合并用单个 text（`join("\n\n")`）而非多个 text part**：`deliver`/`promptAsync` 管线是单文本签名，多 part 需一路透传改动；Kilo 对同一条消息内的多段文本语义等价，故从简。
2. **模型失败多一层兜底**：`pendingModel` 导致 prompt 失败时，自动清掉覆盖、用会话当前模型**重试一次**（并回执提示），再失败才走 `[系统] 消息处理失败`。比设计里"清 pending + 报错"更不易丢消息。
3. **切换未强制校验 connected**：只校验目标属于白名单（白名单本就是人工策展）；`connected` 仅在 `/models` 列表里以「不可用」提示，不阻断切换。
4. **`providerCatalog.available`**：`provider.list` 读取失败时返回 `available:false`，列表不再把全部模型误标「不可用」。
5. **config.json 为 gitignore**：`models` 落在提交的 `config.example.json`，并同步到本地 `config.json`（不提交）。

待检视会话核对：以上偏差是否成立、是否有遗漏的风险（尤其 per-chat 队列与 `becameIdle`/auto-handoff 的交互）。

## 检视结论（2026-10-04）

对照本文逐条核对 7f07fe6，发现并修复 1 处真 bug + 3 处与设计不符，确认 5 条偏差成立。

修复：

1. **turn-boundary drain 被永久短路（真 bug）**：`becameIdle` 先置 `rt.resolving = true`，再用 `canStartTurn`（其含 `!resolving`）作为 drain 门；该门恒为 false，导致「在忙时静默、已 ready」的批在其后 idle 永不被 drain（多 chat 场景消息卡死）。修法：抽出 `turnFree`（只含 `!busy/!inflight/!handoffRunning`），`becameIdle` 与 `drainChat` 的门改用它；`onQuiet` 仍用 `canStartTurn`（要挡 resolving）。回归测试见 `test/inbound-ack.ts` 的 "batch drains at the turn boundary"。
2. **`/new` 未清 `pendingModel`（违反 §8）**：切新会话前补 `rt.pendingModel = undefined`（吃新会话默认）；`/pin` 仍保留。
3. **processing 信号措辞**：单条 drain 由「收到，处理中…」改为「收到，开始处理…」，对齐 §7。
4. **白名单非法项静默跳过**：`buildModelList` 补 `warn`（§2 要求「跳过并 warn」）。

确认成立的偏差：1（单 text 合并）、2（失败重试一次）、3（切换不校验 connected）、4（`providerCatalog.available`）、5（config.json 不入库；已同步本地）。

遗留边界（未改，理由如下）：

- `pendingModel` 只被下一条**用户入站** prompt（含排队批）消费；timer/terminal/context 的通知 wake 走 `dispatchBatch`，不带也**不消费** `pendingModel`。设计 §5 说的是「其后消息」，通知 wake 非用户消息，且消费它反而可能抢在用户消息前清掉 pending，故保留会话当前模型。

## 后续变更（2026-10-04）

- **`/new` 默认模型**：改 §8 的「吃新会话默认」为**设 pending＝白名单首个模型**（`src/bridge.ts` `/new` case）。白名单空则回退 `undefined`（保持原行为）；成功回执追加一行 `模型：providerID/modelID`。
- **范围**：仅飞书 `/new`。启动/pin 失效新建（`resolveSession`）、显式 handoff、auto-handoff 均不变（后两者仍继承调用会话模型）。

