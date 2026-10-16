# 智慧协作体系（zhihui-xiezuo）

这是**「智慧协作体系」的第一个模块 —— DSH 会话桥**，后续会继续补充其它模块。

让**外部 Agent** 接入一个**已经在运行的本机 DeepSeek Harness (DSH) Web 实例**：列会话、只读核对、绑定会话、向指定会话投递任务，并取回**该任务所属回合**的最终回复。

提供 **CLI** 与 **MCP（stdio）** 双入口，Windows / macOS / Linux 可用。

---

## 这个包解决什么问题

你在浏览器里开着 `dsh web`，某个会话里有一场正在进行的对话。你想让**另一个 Agent**（Codex、Claude Desktop、Cursor、任何 MCP 客户端）把一条任务投进**那个会话**，并且拿到这一回合的回复。

DSH 官方没有提供这个能力：

- **官方 `@deepseek-ai/dsh-acp`** 是 ACP 协议 + stdio，**自己拉起一个全新的 DSH 进程**，只能操作**它自己创建/恢复**的会话。它**碰不到**你网页上正开着的那个会话——那个会话由 `dsh web` 进程持有跨进程写锁，ACP 去 `session/resume` 会撞上 `SessionAlreadyOwnedError`。
- **官方没有任何 MCP 形式的会话控制服务端**（`packages/mcp/` 下只有 `mcp-client` 和 `mcp-resources`，方向都是「DSH 消费外部 MCP」，不是对外暴露）。

本包补的就是这个缺口：**接入已运行实例、操作人正在看的那个会话、人在环**。

| | dsh-acp（官方） | zhihui-xiezuo（本包） |
|---|---|---|
| 协议 | ACP v1 | 私有 HTTP 信封 RPC + WebSocket |
| 传输 | stdio | HTTP + WS，仅本机环回 |
| 启动模型 | 客户端 **spawn 新 DSH 进程** | 连接**已存在**的 `dsh web` |
| 目标会话 | 自己创建/恢复的 | **任意已存在会话**，含网页正开着的 |
| 向已有会话发消息 | ❌ | ✅ |
| 取回回复正文 | ❌（只返回 `stopReason`） | ✅（`wait` 返回正文 + turn/seq） |
| 鉴权 | 无（受信控制器） | 启动令牌 → Cookie |
| 取消 / 审批 | ✅ `session/cancel`、权限应答 | ❌ 刻意不订阅审批通道 |
| 典型用途 | 进程外 subagent、测试运行器 | 把任务投给人正在看的会话 |

两者**不重叠**，各自独占不同场景。

---

## 安装

需要 **Node.js ≥ 22**。

```bash
npm install -g zhihui-xiezuo
```

或者从源码：

```bash
git clone https://github.com/chongming1994/zhihui-xiezuo.git && cd zhihui-xiezuo
npm install
npm link          # 可选，装出全局命令
```

安装后有两个可执行入口：

- `zhihui-xiezuo` —— 命令行
- `zhihui-xiezuo-mcp` —— MCP stdio 服务端

### Windows 说明

`npm install -g` / `npm link` 会自动生成 `.cmd` shim，**无需手动处理**。也可以不装全局，直接用 `node <包内路径>\bin\zhihui-xiezuo.js` 调用。

---

## 快速开始

### 1. 拿到 DSH 的启动令牌

启动 `dsh web` 时终端会打印一个带 `token` 参数的 URL，把那个 token 复制出来。

### 2. 认证

```bash
# 交互式输入（不回显，不落命令行历史）
zhihui-xiezuo auth

# 或从受保护文件读取
zhihui-xiezuo auth --token-file ~/.config/dsh-token
```

凭据写入状态目录（见下），**令牌本身不保存**。DSH 重启后令牌会变，需要重新 `auth`。

### 3. 检查连接

```bash
zhihui-xiezuo check --json
```

只调 `session/list`，**不激活任何会话**。

### 4. 列会话、绑定、投递、取回复

```bash
zhihui-xiezuo sessions                       # 列会话摘要（不含聊天正文）
zhihui-xiezuo inspect <会话ID>                # 只读核对单个会话
zhihui-xiezuo bind <会话ID>                   # 显式绑定目标
zhihui-xiezuo send --file ./task.md          # 投递任务
zhihui-xiezuo wait <requestId> --timeout 600000   # 取回该回合回复
```

---

## CLI 命令

| 命令 | 作用 | 副作用 |
|---|---|---|
| `auth` | 启动令牌换凭据 | 写本地凭据 |
| `check` | 检查连接与接口兼容性 | 无（不激活会话） |
| `sessions` | 列会话摘要 | 无 |
| `inspect <ID>` | 只读核对单会话 | 无 |
| `bind <ID>` | 校验并保存绑定 | 写本地配置 |
| `send --file <任务文件>` | 向绑定会话投递 | **有** |
| `wait <requestId>` | 等待并取回该回合结果 | 无 |
| `status <requestId>` | 查本地记录 + 只读核对 | 无 |
| `create` | 创建执行会话 | **有**（需 `--authorize`） |
| `rename` | 重命名会话 | **有**（需 `--authorize`） |
| `workorder <子命令>` | 协作工作单状态机 | 读写本地 |

完整选项与退出码见 `zhihui-xiezuo --help`。

**退出码**（给调用方用的稳定契约）：

```
0 成功   1 失败   2 用法错误   3 认证/信任失败   4 目标不存在
5 本地等待超时   6 关联不确定   7 提交结果未知
```

---

## MCP 接入

MCP 服务端是 **stdio** 传输，暴露 10 个工具。

### 通用配置

```json
{
  "mcpServers": {
    "zhihui-xiezuo": {
      "command": "node",
      "args": ["/绝对路径/zhihui-xiezuo/bin/zhihui-xiezuo-mcp.js"],
      "env": {
        "ZHIHUI_XIEZUO_URL": "http://127.0.0.1:3080"
      }
    }
  }
}
```

全局安装后也可以直接用命令名：

```json
{
  "mcpServers": {
    "zhihui-xiezuo": {
      "command": "zhihui-xiezuo-mcp"
    }
  }
}
```

> Windows 上如果用命令名，注意某些客户端不走 shell、找不到 `.cmd`；此时请写 `"command": "node"` + 绝对路径的 `args`。

### 工具清单

**只读**

| 工具 | 作用 |
|---|---|
| `dsh_check` | 检查连接、认证与接口兼容性 |
| `dsh_sessions` | 列会话摘要 |
| `dsh_inspect` | 只读核对单个会话 |
| `dsh_titles` | 只读列会话标题 |
| `dsh_status` | 查本地请求记录 |

**写入**（需要显式 `confirm: true`，否则直接拒绝、不执行）

| 工具 | 作用 |
|---|---|
| `dsh_bind` | 绑定目标会话 |
| `dsh_send` | 向会话投递任务 |
| `dsh_create` | 创建会话 |
| `dsh_rename` | 重命名会话 |

**长任务**

| 工具 | 作用 |
|---|---|
| `dsh_wait` | 等待并取回该回合回复 |

写操作要求 `confirm: true` 是**刻意的安全边界**：本工具绝不推断「当前网页会话」，也绝不代替用户授权。

---

## 状态目录

| 平台 | 位置 |
|---|---|
| Windows | `%LOCALAPPDATA%\zhihui-xiezuo` |
| macOS / Linux | `~/.local/share/zhihui-xiezuo` |

可用环境变量覆盖，优先级：

```
--home 参数  →  ZHIHUI_XIEZUO_HOME  →  DSH_BRIDGE_HOME（旧变量，向后兼容）  →  平台默认
```

目录内含 `config.json`、`credential.json`（凭据）、`requests/`（请求账本）、`workorders/`、`locks/`。

---

## 安全边界

本工具在设计上刻意收紧，使用前请知悉：

- **仅本机环回**：只接受 `127.0.0.1` / `localhost` / `::1`，非环回地址在发出任何网络请求之前就失败关闭。
- **不跟随重定向**：所有 `/api` 调用与令牌交换都用 `redirect: 'manual'`，任何 3xx 一律显式拒绝，绝不把任务正文或凭据转发到别的地址。
- **只发显式绑定的会话**：绝不推断「当前网页会话」。目标必须显式指定或已绑定。
- **不订阅审批通道**：因此**不可能自动批准任何请求**。审批永远留给人。
- **不提供** `cancel` / `steer` / `approve` / 改队列 / 改模型 / 改 preset。
- **未知状态不自动重发**：`submission_unknown` / `result-unknown` 只留账等人工核对，不重试。
- **不读密钥**：凭据只存在状态目录的 `credential.json`，不打印、不写入任务正文。

---

## 已知限制

- **不能取消、不能批准**：`send` 只支持 `mode=queue`，不提供 `steer` / `cancel` / `approve`。
- **需要有一个跑着的 `dsh web`**：本包是纯 HTTP 客户端，不自己拉起 DSH。
- **DSH 接口契约是 pre-stable**：上游升级后需重新核对（`check` 会报告契约字段）。
- **Windows 上不做自动 ACL 收紧**：`chmod` 在 Windows 只能切只读位，本包不自动改 ACL。若要限制令牌文件访问，请自行执行：

  ```cmd
  icacls "C:\path\to\dsh-token" /inheritance:r /grant:r "%USERNAME%:R"
  ```

  或直接用交互式 `auth`（令牌不落文件，最省事）。

---

## 开发

```bash
npm install
npm test          # 139 项测试
```

源码结构：

```
src/
  cli.js             命令行入口、参数解析、命令分派
  mcp-server.js      MCP stdio 服务端（10 个工具）
  rpc.js             DSH HTTP 客户端（环回校验、令牌交换、redirect 拒绝）
  mux.js             WebSocket 会话事件流
  associate.js       回合归属关联（requestId → turn → reply）
  store.js           请求账本、文件锁、状态单调前进
  config.js          状态目录、配置、凭据、原子写
  secret-input.js    令牌输入（POSIX mode 校验 / Windows ACL 校验）
  workorder.js       协作工作单状态机
  errors.js          稳定错误码与退出码
  redact.js          输出脱敏
```

---

## 许可

MIT
