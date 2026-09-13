# Kilo Phone — Kilo 作为「真人」与 agent 对话的独立通道

> 状态：设计待评审（未实现）
> 载体：kilo-resident（Kilo 侧工具/插件）+ cogos（phone helper）
> 日期：2026-09-13

## 1. 目的

调试 cogos agent 时，agent 需要与真人交流。除 YZ 外，Kilo 以**独立身份**（号码 `COGOS002:A0006`）作为另一个「真人」与 agent 对话。人不在场时，Kilo 就是那个与 agent 交流的真人。

对 agent 而言，A0006 就是通讯录里的一个人，与 YZ 无异。

## 2. 定位与边界

- Kilo 唯一身份 = A0006 一个号；调试多个 agent = 多个**会话**，不是多个号。
- 这是 **agent↔Kilo 通道**，与人↔Kilo 桥接通道分开：桥「必回」，本通道「Kilo 判断后决定」。
- 非目标（首版）：文件/图片、群聊、多卡多身份、常驻在线。

## 3. 架构

组件：

- **cogos phone helper**（Python，长驻，会话级）：持 cogos `Phone`（卡 + 通讯录 + 会话），收信 → 回调 sink；暴露 loopback API 供发送/状态/关闭。
- **kilo-resident kilo-phone 插件**（TS）：注册 `phone_open`/`phone_send` 工具；host sink；收到 helper 回调 → 注入会话（带来源标签）；会话切换/结束 → 杀 helper。
- **cogos feishu daemon**（既有，设备级单例）：持有 A0006 的飞书 WS。helper 以 pin 认领；helper 断开 → daemon `_wsm.remove`（`cogos/feishu/daemon.py`）→ A0006 下线。→ 「切会话自动释放号码」由既有机制保证。

数据流：

- 出站：Kilo → `phone_send` → helper → daemon → A0006 发出 → 对端 agent。
- 入站：agent → A0006 → daemon → helper → sink → 注入会话（`[agent] 号码 · 第N轮`）→ Kilo 判断 → 回则 `phone_send`。

## 4. 身份与会话

- 卡：A0006，pin 从 `~/.cogos/feishu/accounts/bot-COGOS002-A0006.json` 读（secret 不进 config）。
- 通讯录（配置，非工具步骤）：YZ→H0002、唐钰→A0005、…（可增）。
- 多对端：Phone 的 p2p 会话按对端 number 分桶；回复按会话，不串。
- 多身份：首版不需要；Phone 的 `add_card`/`from_number` 留作后路。

## 5. 事件来源与回复策略（总纲）

所有注入到会话的回合带来源标签；回复策略按来源查表。

| 来源 | 唤醒 | 回复策略 |
|---|---|---|
| 人（桥） | 注入回合 | 必回（桥自动回传） |
| agent（手机） | 注入回合（对端号 + 第 N 轮） | Kilo 判断，回则 `phone_send` |
| 闹钟（timer） | 注入回合（title + notes） | 不回，只自处理 |
| terminal 完成 | 注入回合（会话/命令） | 不回，自处理 |
| TUI 直接输入 | 正常 | 正常 |

- 桥的自动回传只认自己的 `inflight`（按 parentID），手机注入不经桥 inflight → 天然不自动回。
- 来源用统一前缀标注（当前注入原语为纯文本）；事件总线若支持类型化事件可结构化，首版用前缀。

## 6. 接口契约

### 6.1 cogos helper

- 入口：`python3.11 -m cogos.phone.helper`（模块名待定），参数：`--number COGOS002:A0006`、`--data-dir <dir>`、`--sink <url>`、`--contacts <json>`。
- 行为：`Phone()` + `add_card(number, pin)` + 逐个 `add_contact`；`listen(on_msg=...)`；`on_msg` → POST sink `{from, to, content, ts, seq}`。
- loopback API（仅本机）：`POST /send {to, text}`、`GET /status`、`POST /close`。
- 启动不自动恢复既有卡（仅显式 `add_card`）；`data-dir` 专用，保留会话/联系人。
- 退出即释放号码（daemon 机制）。

### 6.2 kilo-resident 工具

- `phone_open()`：幂等；缺 helper 则拉起；失败返回原因。config 提供 number/contacts/cogosDir/python/dataDir。
- `phone_send(to, text)`：`to` 可联系人名或号码。
- `phone_close()`（可选）：显式收工。
- 不新增：收消息（事件）、timer、terminal、后台进程生命周期（复用）。

## 7. 生命周期

- helper 作为**会话级**后台进程：切会话/退出 → 随会话销毁 → 号码释放。
- 崩溃：socket 断 → daemon 释放；心跳超时兜底。
- 单持有者：daemon `manager.register` 踢旧连接。

## 8. 自激防护

- 默认不回（结构层）。
- 注入附事实：对端号、本线程第 N 轮、对方是 agent。
- 保险丝：每对端连续触发上限（默认 5）；超限停注入并注入一条「已暂停，需确认继续」。
- 窗口有限：不调试即下线。

## 9. 闹钟/看门狗用法（纪律，非机制）

- agent 不发消息 → 定时器唤醒 Kilo 检查 agent。
- 长命令 → 设看门狗 timer；正常返回则取消。
- 闹钟须自描述（title/notes 说清用途），处理须幂等（检查条件）→ 忘取消只是打扰，可容错。

## 10. 配置形状（kilo-resident config.json 新增）

```json
"phone": {
  "number": "COGOS002:A0006",
  "contacts": { "YZ": ["COGOS002:H0002"], "唐钰": ["COGOS002:A0005"] },
  "dataDir": "/home/zhengyp/.cogos/kilo-phone",
  "cogosDir": "/home/zhengyp/work/A/cogos",
  "python": "python3.11",
  "maxConsecutive": 5
}
```

## 11. 验证

- 单测（cogos `phone/fake.py` 的 FakeTelecomClient）：`add_card`、`listen`→sink、`send`。
- 集成（mock sink/inject）：工具注册、来源标签、回复分流、轮次上限。
- 真机：A0006 ↔ 唐钰 A0005 双向；确认无自动回传；切会话后 A0006 下线（daemon `list-bot` 核）。

## 12. 开放问题

1. helper 启动/自动杀：用平台后台进程工具，还是插件托管子进程？
2. kilo 插件能否对自身会话注入回合（append/submit）？需验证。
3. A0006 的 `open_id` 在 registry 可解析？飞书 bot 互发权限？
4. sink 传输：loopback HTTP vs unix socket。
5. 工具命名、helper 模块名。

## 13. 参考

- 桥注入/唤醒：`kilo-resident/src/bridge.ts`
- cogos phone：`cogos/phone/{phone,store,model}.py`、`cogos/docs/phone-design.md`
- daemon 卡生命周期：`cogos/feishu/daemon.py`

## 14. 实现状态（2026-09-13）

已落码：

- cogos（分支 `feat/kilo-phone`，worktree `work/A/cogos-kilo-phone`）：`cogos/phone/helper.py` + `tests/phone/test_helper.py`（10 项）。全量 `1071 passed / 1 skipped`。
- kilo-resident（分支 `feat/kilo-phone`）：`src/phone.ts`（PhoneManager + formatInbound）、`bridge.ts`（`/phone/{open,send,status,close}` 控制路由 + 注入）、`control.ts`、`types.ts`、`config.example.json`、`plugin/kilo-phone.ts`（`phone_open`/`phone_send`/`phone_close`）、`test/phone.ts`。`npm run typecheck` 过、`npm run test:phone` 过。

真机验证（helper 层）：

- 入站：A0001 → A0006 → helper sink，payload `{source:"agent",from:"COGOS002:A0001",round:1,...}` ✅
- 出站：`POST /send {to:"COGOS002:A0001"}` → A0001 收到 `from=COGOS002:A0006` ✅
- 生命周期：helper 停 → daemon `list-bot` 中 A0006 消失（号码释放）✅
- 无自动回传：helper 收到入站后不发送，只有显式 `/send` 才发 ✅

未验证 / 遗留：

- **Kilo 侧注入未真机验证**：`bridge.ts` 的 `deliver()`（tui/async）注入需常驻 bridge + 一个 Kilo 会话才能端到端跑；本次未起 bridge（A 侧 fresh clone 无 `config.json`，且避免与 B 侧 bridge 端口冲突）。
- **切会话自动释放未机制化**：当前是显式 `phone_close` 或 helper 崩溃释放；会话切换的自动杀未接线（开放问题 1 仍未闭合）。
- 插件需按现有方式软链/加载到 Kilo（`~/.config/kilo/plugin/`），本次未做环境挂载。

开放问题更新：

1. 已定为**插件/桥托管子进程**；自动杀待机制化。
2. 已用桥的 `deliver()` 实现注入；真机未验。
3. 飞书 bot 互发已真机验通（A0001↔A0006）。
4. 定为 **loopback HTTP**。
5. 定为 `cogos.phone.helper`、`phone_open`/`phone_send`/`phone_close`。
