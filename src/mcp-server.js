/**
 * MCP（Model Context Protocol）stdio 服务端。
 *
 * 把同一套桥接能力以 MCP 工具形式暴露给支持 MCP 的客户端（Claude Desktop 等）。
 *
 * **关键约束：stdio 传输下 stdout 是 JSON-RPC 协议通道。**
 * 本模块因此：
 * - 绝不调用 `main()`（它会写 stdout），而是用导出的 `buildContext()` + `run()`
 *   在同进程内执行命令，拿到纯数据返回值后自行序列化成工具结果；
 * - 任何诊断信息一律走 `process.stderr`（`cli.js` 与 `secret-input.js` 本身也只写 stderr）；
 * - 不 spawn 子进程。
 *
 * **安全边界（刻意保留，与 CLI 一致）：**
 * - 只连接本机环回 DSH，拒绝重定向，凭据 authority 必须与目标地址一致；
 * - 只操作显式指定的会话，绝不推断「当前网页会话」；
 * - 有副作用的操作（`dsh_send` / `dsh_create` / `dsh_rename`）必须显式传 `confirm: true`，
 *   缺省直接返回错误、不执行任何动作。
 * @module zhihui-xiezuo/mcp-server
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { buildContext, run } from './cli.js'
import { asBridgeError, EXIT } from './errors.js'

/** 服务名与版本，随 package.json 一起发布。 */
export const SERVER_NAME = 'zhihui-xiezuo'
/** @type {string} */
export const SERVER_VERSION = '0.1.0'

/** 默认等待上限（毫秒），与 CLI 的 `--timeout` 默认值一致。 */
const DEFAULT_WAIT_TIMEOUT_MS = 300_000

/**
 * 公共入参：DSH 地址与状态目录覆盖。
 * @returns {Record<string, any>} JSON Schema 属性片段。
 */
function commonProperties() {
  return {
    url: {
      type: 'string',
      description: '覆盖 DSH 地址，默认 http://127.0.0.1:3080。只接受本机环回地址（127.0.0.1 / localhost / ::1）。',
    },
    home: {
      type: 'string',
      description: '覆盖状态目录。默认：Windows 为 %LOCALAPPDATA%\\zhihui-xiezuo，其它平台为 ~/.local/share/zhihui-xiezuo。',
    },
  }
}

/**
 * 构造一个「写操作确认」入参字段。
 * @param {string} what - 动作描述，用于描述文本。
 * @returns {Record<string, any>} JSON Schema 属性片段。
 */
function confirmProperty(what) {
  return {
    type: 'boolean',
    description: `安全门：必须显式传 true 才会真正执行${what}。缺省或 false 时本工具直接返回错误、不执行任何动作。`
      + '只有在用户明确要求该动作时才传 true。',
  }
}

/** 工具清单（JSON Schema 入参）。 */
export const TOOLS = [
  {
    name: 'dsh_check',
    description: '只读。检查与 DSH 实例的连接、认证与接口兼容性，并记录契约字段。不激活任何会话、无副作用。',
    inputSchema: {
      type: 'object',
      properties: {
        ...commonProperties(),
        httpTimeout: { type: 'number', description: '单次 /api 调用超时（毫秒），默认 15000。' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_sessions',
    description: '只读。列出 DSH 上的会话摘要（sessionId、标题、preset、权限、工作目录、运行状态）。'
      + '不输出聊天正文、不激活会话、无副作用。',
    inputSchema: {
      type: 'object',
      properties: { ...commonProperties() },
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_titles',
    description: '只读。只返回会话的「ID + 标题 + 运行状态 + 工作目录」精简列表，适合在上下文里先定位目标会话。'
      + '是 dsh_sessions 的字段裁剪视图，无副作用。',
    inputSchema: {
      type: 'object',
      properties: { ...commonProperties() },
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_inspect',
    description: '只读。核对单个会话的地址 / 标题 / 工作目录 / preset / 权限 / 运行状态。不激活会话、无副作用。',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', description: '要核对的会话 ID，形如 session-<uuid>。' },
        ...commonProperties(),
      },
      required: ['session'],
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_status',
    description: '只读（可选的日志核对会激活冷会话）。查询某次投递的本地请求记录：状态、关联的回合、已记录的回复，'
      + '并做一次只读核对。不会重新发送任务。',
    inputSchema: {
      type: 'object',
      properties: {
        requestId: { type: 'string', description: 'dsh_send 返回的 requestId。' },
        verify: { type: 'boolean', description: '为 true 时额外做一次只读日志核对（可能激活冷会话），默认 false。' },
        backfillPages: { type: 'number', description: '回溯补页上限，默认 5 页。' },
        ...commonProperties(),
      },
      required: ['requestId'],
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_bind',
    description: '有副作用（仅本地状态）。校验会话存在并把该会话保存为绑定目标，之后 dsh_send 缺省就发给它。'
      + '只写本地配置文件，不在 DSH 侧产生任何动作；绝不推断「当前网页会话」。',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', description: '要绑定的会话 ID。' },
        ...commonProperties(),
      },
      required: ['session'],
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_send',
    description: '有副作用：会向 DSH 会话投递一条任务消息，并消耗一次模型回合。'
      + '目标只会是「显式 --session」或「已 bind 的会话」，绝不推断当前会话。'
      + '必须传 confirm: true 才执行。返回 requestId，之后用 dsh_wait 取回回复。',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: '任务正文文件的绝对路径（内容作为消息正文投递）。' },
        session: { type: 'string', description: '本次投递的目标会话 ID；省略则用已绑定的会话。' },
        requestId: { type: 'string', description: '复用既有 requestId 重发（必须同会话同内容）。省略则新建。' },
        workOrder: { type: 'string', description: '协作工作单 ID；给出时投递身份由工作单固定（隐含 authorize）。' },
        confirm: confirmProperty('投递'),
        ...commonProperties(),
      },
      required: ['file', 'confirm'],
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_wait',
    description: '长任务（可能阻塞到 timeout）。等待某次投递关联回合的最终结果，返回回复正文与终态。'
      + '不做任何写入；判定为「不确定」时绝不冒用其它回合的回复。',
    inputSchema: {
      type: 'object',
      properties: {
        requestId: { type: 'string', description: 'dsh_send 返回的 requestId。' },
        timeout: { type: 'number', description: `本地等待上限（毫秒），默认 ${DEFAULT_WAIT_TIMEOUT_MS}。` },
        backfillPages: { type: 'number', description: '回溯补页上限，默认 5 页。' },
        ...commonProperties(),
      },
      required: ['requestId'],
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_create',
    description: '有副作用：在 DSH 上创建（或按同一 sessionId 幂等收养）一个执行会话。'
      + '必须传 confirm: true 才执行。cwd 必须是已存在的绝对目录，本工具绝不代替用户建目录。',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: '已存在的绝对目录，作为新会话的工作目录。' },
        sessionId: { type: 'string', description: '预存的 session-<标识>，用于幂等收养；省略则由服务端生成。' },
        title: { type: 'string', description: '新会话标题（可省略）。' },
        workOrder: { type: 'string', description: '协作工作单 ID；给出时创建身份由工作单固定。' },
        confirm: confirmProperty('创建会话'),
        ...commonProperties(),
      },
      required: ['cwd', 'confirm'],
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_rename',
    description: '有副作用：重命名一个会话（会激活该会话）。必须传 confirm: true 才执行。'
      + '标题按 80 UTF-8 字节截断并回读核对。',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', description: '要重命名的会话 ID。' },
        title: { type: 'string', description: '新标题（非空）。' },
        workOrder: { type: 'string', description: '协作工作单 ID；给出时改名身份由工作单固定。' },
        confirm: confirmProperty('重命名'),
        ...commonProperties(),
      },
      required: ['session', 'title', 'confirm'],
      additionalProperties: false,
    },
  },
]

/**
 * 把 MCP 工具入参翻译成 CLI 的 `flags` 对象。
 *
 * `parseArgs` 会把 `--http-timeout` 解析成键 `http-timeout`，`--backfill-pages` 解析成
 * `backfill-pages`，因此这里沿用同样的键名，保证 `run()` 看到的结构与 CLI 完全一致。
 * @param {Record<string, any>} args - 工具入参。
 * @returns {Record<string, any>} flags。
 */
function toFlags(args) {
  /** @type {Record<string, any>} */
  const flags = {}
  // 目标地址：工具入参优先；否则回退环境变量（便于 MCP 客户端在启动配置里固定实例，
  // 不必每次调用都传 url）。两者最终都要过 normalizeBaseUrl 的环回校验，不放松安全边界。
  if (typeof args.url === 'string' && args.url !== '') flags.url = args.url
  else if (typeof process.env.ZHIHUI_XIEZUO_URL === 'string' && process.env.ZHIHUI_XIEZUO_URL !== '') {
    flags.url = process.env.ZHIHUI_XIEZUO_URL
  }
  if (typeof args.home === 'string' && args.home !== '') flags.home = args.home
  if (typeof args.httpTimeout === 'number' && Number.isFinite(args.httpTimeout)) flags['http-timeout'] = String(args.httpTimeout)
  if (typeof args.backfillPages === 'number' && Number.isFinite(args.backfillPages)) flags['backfill-pages'] = String(args.backfillPages)
  if (typeof args.timeout === 'number' && Number.isFinite(args.timeout)) flags.timeout = String(args.timeout)
  if (args.verify === true) flags.verify = true
  if (typeof args.file === 'string' && args.file !== '') flags.file = args.file
  if (typeof args.session === 'string' && args.session !== '') flags.session = args.session
  if (typeof args.sessionId === 'string' && args.sessionId !== '') flags['session-id'] = args.sessionId
  if (typeof args.title === 'string' && args.title !== '') flags.title = args.title
  if (typeof args.cwd === 'string' && args.cwd !== '') flags.cwd = args.cwd
  if (typeof args.workOrder === 'string' && args.workOrder !== '') flags['work-order'] = args.workOrder
  if (typeof args.requestId === 'string' && args.requestId !== '') flags['request-id'] = args.requestId
  return flags
}

/**
 * 组装一个工具错误结果。
 * @param {string} message - 面向调用方的说明。
 * @param {Record<string, any>} [extra] - 额外结构化字段。
 * @returns {{content: Array<{type: 'text', text: string}>, isError: true}} 工具结果。
 */
function errorResult(message, extra = {}) {
  const payload = { ok: false, error: { code: 'tool_error', message, ...extra } }
  return {
    content: [
      { type: 'text', text: message },
      { type: 'text', text: JSON.stringify(payload, null, 2) },
    ],
    isError: true,
  }
}

/**
 * 把 `run()` 的返回值序列化成 MCP 工具结果。
 *
 * `run()` 的返回是纯数据：`{ exitCode, text, ...结构化字段 }`。这里原样保留结构化字段，
 * 让调用方既能读人话（`text`）也能读机器可读字段。
 * @param {string} command - 命令名，写进结果便于追溯。
 * @param {any} result - `run()` 的返回值。
 * @returns {{content: Array<{type: 'text', text: string}>, isError: boolean}} 工具结果。
 */
function toToolResult(command, result) {
  const { text = '', exitCode = EXIT.OK, error = null, ...rest } = result ?? {}
  const ok = exitCode === EXIT.OK
  /** @type {Record<string, any>} */
  const payload = { ok, command, exitCode, ...rest }
  if (error !== null && error !== undefined) payload.error = error
  const content = []
  if (typeof text === 'string' && text !== '') content.push({ type: 'text', text })
  content.push({ type: 'text', text: JSON.stringify(payload, null, 2) })
  return { content, isError: !ok }
}

/**
 * 执行一次工具调用（已通过 confirm 门）。
 * @param {string} name - 工具名。
 * @param {Record<string, any>} args - 入参。
 * @returns {Promise<{content: Array<{type: 'text', text: string}>, isError: boolean}>} 工具结果。
 */
async function callTool(name, args) {
  const flags = toFlags(args)
  switch (name) {
    case 'dsh_check': {
      const ctx = await buildContext(flags)
      return toToolResult('check', await run('check', [], flags, ctx))
    }
    case 'dsh_sessions': {
      const ctx = await buildContext(flags)
      return toToolResult('sessions', await run('sessions', [], flags, ctx))
    }
    case 'dsh_titles': {
      const ctx = await buildContext(flags)
      const result = await run('sessions', [], flags, ctx)
      // 历史契约：{ok, sessions:[{sessionId,title,running,cwd}]}
      const sessions = (Array.isArray(result.sessions) ? result.sessions : []).map(row => ({
        sessionId: row.sessionId,
        title: row.title,
        running: row.running,
        cwd: row.cwd,
      }))
      const payload = { ok: true, command: 'titles', exitCode: EXIT.OK, sessions, boundSessionId: result.boundSessionId ?? null }
      return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], isError: false }
    }
    case 'dsh_inspect': {
      const ctx = await buildContext(flags)
      return toToolResult('inspect', await run('inspect', [args.session], flags, ctx))
    }
    case 'dsh_status': {
      const ctx = await buildContext(flags)
      return toToolResult('status', await run('status', [args.requestId], flags, ctx))
    }
    case 'dsh_bind': {
      const ctx = await buildContext(flags)
      return toToolResult('bind', await run('bind', [args.session], flags, ctx))
    }
    case 'dsh_send': {
      // 有工作单时投递身份由工作单固定，CLI 侧要求 --authorize；confirm 已在此处把门。
      if (flags['work-order'] !== undefined) flags.authorize = true
      const ctx = await buildContext(flags)
      return toToolResult('send', await run('send', [], flags, ctx))
    }
    case 'dsh_wait': {
      if (flags.timeout === undefined) flags.timeout = String(DEFAULT_WAIT_TIMEOUT_MS)
      const ctx = await buildContext(flags)
      return toToolResult('wait', await run('wait', [args.requestId], flags, ctx))
    }
    case 'dsh_create': {
      flags.authorize = true
      const ctx = await buildContext(flags)
      return toToolResult('create', await run('create', [], flags, ctx))
    }
    case 'dsh_rename': {
      flags.authorize = true
      const ctx = await buildContext(flags)
      return toToolResult('rename', await run('rename', [args.session], flags, ctx))
    }
    default:
      return errorResult(`未知工具：${name}。`, { code: 'unknown_tool' })
  }
}

/** 需要 `confirm: true` 才执行的有副作用工具。 */
const CONFIRM_REQUIRED = new Map([
  ['dsh_send', '向 DSH 会话投递任务'],
  ['dsh_create', '在 DSH 上创建会话'],
  ['dsh_rename', '重命名 DSH 会话'],
])

/**
 * 工具调用的总入口：先过 confirm 门，再执行。
 *
 * confirm 门在**任何 I/O 之前**判定：缺省为 false 时直接返回错误说明，不读配置、
 * 不连 DSH、不写任何文件。
 * @param {string} name - 工具名。
 * @param {Record<string, any>} args - 入参。
 * @returns {Promise<{content: Array<{type: 'text', text: string}>, isError: boolean}>} 工具结果。
 */
export async function handleToolCall(name, args = {}) {
  const gate = CONFIRM_REQUIRED.get(name)
  if (gate !== undefined && args.confirm !== true) {
    return errorResult(
      `拒绝执行：${gate} 属于有副作用的操作，必须显式传 confirm: true。`
      + '本工具不会在未确认的情况下推断目标或代你动作；请先向用户确认，再带 confirm: true 重试。',
      { code: 'confirm_required', tool: name },
    )
  }
  try {
    return await callTool(name, args)
  } catch (error) {
    const bridge = asBridgeError(error)
    return errorResult(`错误（${bridge.code}）：${bridge.message}`, {
      code: bridge.code,
      exitCode: bridge.exitCode,
      details: bridge.details ?? null,
      tool: name,
    })
  }
}

/**
 * 创建并配置 MCP Server 实例（不连接传输，便于测试）。
 * @returns {Server} MCP server。
 */
export function createServer() {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {} },
      instructions: 'zhihui-xiezuo：接入一个**已经在运行**的本机 DSH Web 实例，'
        + '列会话、只读核对、绑定会话、向指定会话投递任务并取回该回合回复。'
        + '目标会话必须显式指定或已绑定，本服务绝不推断「当前网页会话」；'
        + 'dsh_send / dsh_create / dsh_rename 必须显式传 confirm: true。',
    },
  )
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params ?? {}
    return await handleToolCall(String(name), args ?? {})
  })
  return server
}

/**
 * 以 stdio 传输启动 MCP 服务端。
 *
 * stdout 完全交给 MCP 协议；本函数自身不写 stdout。
 * @returns {Promise<void>} 连接建立后返回（进程随后由传输保持存活）。
 */
export async function main() {
  const server = createServer()
  server.onerror = (error) => {
    process.stderr.write(`[${SERVER_NAME}] MCP server error: ${error instanceof Error ? error.message : String(error)}\n`)
  }
  const transport = new StdioServerTransport()
  await server.connect(transport)
}
