/**
 * 模拟 DSH 服务：按已核对的接口契约实现 `/api` 一元 RPC 与 `/api/remote.mux` 逻辑流。
 *
 * 用途：在没有真实凭据/会话的情况下，可重复地验证桥接工具的行为，
 * 包括 401/403、提交超时、断线补页、重复事件、排队、插话、工具事件、取消/错误等场景。
 *
 * 它模拟的是**契约**，不是 DSH 产品代码；模拟通过不等于实机通过。
 * @module zhihui-xiezuo/test/mock-dsh
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'

/** 生成 base64url 字符串。 */
function b64url(input) {
  return Buffer.from(input).toString('base64url')
}

/** 把事件数组分页为 `SessionHistoryRecord[]`。 */
function toRecords(events) {
  return events.map(event => ({ type: 'event', event }))
}

/** 计入 `maxMessages` 的事件类型（与 DSH `history.ts:39` 一致）。 */
const MESSAGE_TYPES = new Set(['user/message', 'assistant/message'])

/**
 * 会话标题规范化时要剥离的字符：
 * C0 控制符（`U+0000`–`U+001F`）、DEL 与 C1 控制符（`U+007F`–`U+009F`）、
 * 零宽字符与方向/双向控制符（`U+200B`–`U+200F`、`U+202A`–`U+202E`、
 * `U+2060`–`U+2064`、`U+2066`–`U+2069`）以及 BOM（`U+FEFF`）。
 */
const TITLE_STRIP_PATTERN = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/gu

/** 标题允许的最大 UTF-8 字节数（契约 §5：超出部分静默截断）。 */
const TITLE_MAX_BYTES = 80

/**
 * 规范化会话标题（契约 §5）。
 *
 * 顺序：剥离控制符/零宽字符 → 折叠连续空白为单个空格 → trim →
 * 按 **80 UTF-8 字节**静默截断（按码点累加，绝不截出半个字符）。
 * @param {any} input - 原始标题。
 * @returns {string} 规范化后的标题（可能为空字符串）。
 */
export function normalizeTitle(input) {
  const text = String(input ?? '')
    .replace(TITLE_STRIP_PATTERN, '')
    .replace(/\s+/gu, ' ')
    .trim()
  if (Buffer.byteLength(text, 'utf8') <= TITLE_MAX_BYTES) return text
  let out = ''
  let used = 0
  for (const char of text) {
    const size = Buffer.byteLength(char, 'utf8')
    if (used + size > TITLE_MAX_BYTES) break
    out += char
    used += size
  }
  return out
}

/**
 * 补齐会话摘要的 `projections` 与 `parentSessionId`（已有值不覆盖）。
 * @param {any} session - 会话摘要对象。
 * @returns {any} 同一个对象。
 */
function ensureSessionShape(session) {
  if (session.projections === undefined || session.projections === null) session.projections = { values: {} }
  if (session.projections.values === undefined || session.projections.values === null) {
    session.projections.values = {}
  }
  const values = session.projections.values
  if (!('title' in values)) values.title = null
  if (!('agentPreset' in values)) values.agentPreset = null
  if (values.permissions === undefined || values.permissions === null || typeof values.permissions !== 'object') {
    values.permissions = { currentValue: null }
  } else if (!('currentValue' in values.permissions)) {
    values.permissions.currentValue = null
  }
  if (!('parentSessionId' in session)) session.parentSessionId = null
  if (!('titlePinned' in session)) session.titlePinned = false
  return session
}

/**
 * 按 DSH 的真实分页契约裁切事件窗口。
 *
 * 对应 `packages/api/session-controller/src/history.ts:392-427`：
 * - `end = min(throughSeq + 1, beforeSeq ?? throughSeq + 1)`；
 * - 从 `end - 1` 向前扫描，**只有** `user/message` 与 `assistant/message` 计入 `maxMessages`；
 * - 命中上限时 `cut` 回退到该事件与其 `sourceEventSeqs` 的最小 seq，使同一消息的
 *   来源事件落在同一页；
 * - 返回 `[cut, throughSeq]` 的**连续**区间，`hasMore = cut > 0`。
 *
 * 模拟日志是稠密的（`seq === index + 1`），因此这里用 seq 区间表达等价语义。
 * @param {any[]} events - 该会话的全部事件（按 seq 升序）。
 * @param {object} [request] - `SessionPageRequest` 的子集。
 * @returns {{events: any[], hasMore: boolean, cursor: number}} 分页结果。
 */
export function paginate(events, request = {}) {
  const throughSeq = Number.isInteger(request.throughSeq)
    ? request.throughSeq
    : (events.at(-1)?.seq ?? 0)
  const beforeSeq = Number.isInteger(request.beforeSeq) ? request.beforeSeq : undefined
  const maxMessages = Number.isInteger(request.maxMessages) ? request.maxMessages : 50
  const endSeq = Math.min(throughSeq + 1, beforeSeq ?? throughSeq + 1)
  const below = events.filter(event => event.seq < endSeq)
  let count = 0
  let cutSeq = 0
  for (let index = below.length - 1; index >= 0; index -= 1) {
    const event = below[index]
    if (!MESSAGE_TYPES.has(event.type)) continue
    if (event.surfaceOp === 'replace') continue
    count += 1
    let groupStart = event.seq
    for (const source of event.sourceEventSeqs ?? []) {
      if (source < groupStart) groupStart = source
    }
    if (count >= maxMessages) {
      cutSeq = groupStart
      break
    }
  }
  return {
    events: below.filter(event => event.seq >= cutSeq),
    hasMore: cutSeq > 0,
    cursor: throughSeq,
  }
}

/** 模拟的 DSH 服务。 */
export class MockDsh {
  /**
   * @param {object} [options] - 选项。
   * @param {Array<object>} [options.sessions] - 初始会话摘要。
   */
  constructor(options = {}) {
    this.sessions = options.sessions ?? [
      {
        sessionId: 'sess-alpha',
        running: false,
        agentAvailable: true,
        blank: true,
        updatedAt: Date.now(),
        cwd: '/tmp/dsh-workspace',
        origin: 'user',
      },
      {
        sessionId: 'sess-beta',
        running: false,
        agentAvailable: true,
        blank: false,
        updatedAt: Date.now(),
        cwd: '/tmp/dsh-workspace',
        origin: 'user',
      },
    ]
    for (const session of this.sessions) ensureSessionShape(session)
    /** @type {Map<string, any[]>} */
    this.logs = new Map(this.sessions.map(session => [session.sessionId, []]))
    /** @type {Map<string, Set<any>>} */
    this.subscribers = new Map()
    /** @type {Map<string, string[]>} */
    this.seenRequests = new Map()
    /** 行为开关，测试可随时修改。 */
    this.behavior = {
      /** 提交后是否自动跑完一个回合。 */
      autoRun: true,
      /** 自动回合的额外事件序列，例如 tool 事件。 */
      turnEvents: [],
      /** 回合结束原因。 */
      turnEndReason: { kind: 'completed' },
      /** 助手回复文本。 */
      replyText: '连接成功',
      /** 提交响应延迟（毫秒）。 */
      promptDelayMs: 0,
      /** 强制 HTTP 状态码（401/403 等）。 */
      forceStatus: null,
      /** 强制业务错误。 */
      forceRemoteError: null,
      /** 前 N 次订阅在发出快照后立刻断开（模拟载体丢失）。 */
      dropSnapshots: 0,
      /** 每次快照后重发最近 N 条事件（模拟重复投递）。 */
      replayLastN: 0,
      /** 快照/分页的 `maxMessages`（只计 user/assistant 消息），与真实契约一致。 */
      maxMessages: 50,
      /**
       * 测试专用：在分页结果之上再按**事件条数**截断，默认关闭。
       *
       * 这不是真实 DSH 的行为，只用于把窗口边界精确地放在某条事件之前，
       * 以便构造“回合起点落在窗口外”等场景。契约保真度由 `maxMessages` 保证。
       */
      snapshotWindow: null,
      /** 让接下来 N 次 `session/page` 返回错误（模拟补页失败）。 */
      pageFailures: 0,
      /** 提交成功后不产生任何日志（模拟“已接受但不可观测”）。 */
      silentAccept: false,
      /** `session/create` 的响应延迟（毫秒），用于构造本地超时。 */
      createDelayMs: 0,
      /** `session/create` 的业务错误 `{code, message}`。 */
      createFailRemote: null,
      /** `session/create` 直接返回的 HTTP 状态码。 */
      createFailStatus: null,
      /** 自动标题：非 null 时，未 pin 的会话会被改成该标题（用于验证 pin 不漂移）。 */
      autoTitle: null,
    }
    // 允许测试用扁平选项覆盖任一行为开关。
    for (const key of Object.keys(this.behavior)) {
      if (options[key] !== undefined) this.behavior[key] = options[key]
    }
    if (options.behavior !== undefined) Object.assign(this.behavior, options.behavior)
    this.token = randomBytes(32).toString('base64url')
    /** @type {number} */
    this.port = 0
    /** @type {import('node:http').Server|null} */
    this.server = null
    /** @type {WebSocketServer|null} */
    this.wss = null
    this.requestCounts = new Map()
    /** 收到的 `session/create` 请求次数（含失败与延迟的请求）。 @type {number} */
    this.createCalls = 0
    /** 实际新建的会话记录 `{sessionId, cwd, agentPreset}`（收养不记录）。 @type {Array<{sessionId: string, cwd: any, agentPreset: any}>} */
    this.createdSessions = []
    /** 新建会话时“本应创建”的工作目录；**不会真的 mkdir**。 @type {any[]} */
    this.mkdirCalls = []
    /** `session/rename` 成功的序号。 @type {number} */
    this.titleSeq = 0
    /** 被 `session/rename` 激活（`resolveAgent`）的会话顺序。 @type {string[]} */
    this.activatedSessions = []
    /** 建立的 follow 订阅次数（用于验证 send 不会预先订阅历史）。 */
    this.followOpens = 0
    /** 建立的 `$events` 订阅次数（桥接不得订阅审批通道）。 */
    this.eventStreamOpens = 0
    /** @type {string|undefined} */
    this._cookieValue = undefined
  }

  /** 启动服务并返回地址。 @returns {Promise<{baseUrl: string, token: string}>} */
  async start() {
    this.server = createServer((req, res) => { this.handleHttp(req, res) })
    this.wss = new WebSocketServer({ noServer: true })
    this.server.on('upgrade', (req, socket, head) => {
      const rejection = this.checkTrust(req)
      if (rejection !== null) {
        socket.write(`HTTP/1.1 ${rejection} ${rejection === 403 ? 'Forbidden' : 'Unauthorized'}\r\nConnection: close\r\n\r\n`)
        socket.destroy()
        return
      }
      const cookie = this.readCookie(req)
      if (cookie === null) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        ws.on('message', (data) => { this.handleMux(ws, String(data)) })
        ws.on('close', () => { for (const set of this.subscribers.values()) set.delete(ws) })
      })
    })
    await new Promise((resolve) => { this.server.listen(0, '127.0.0.1', resolve) })
    const address = this.server.address()
    this.port = typeof address === 'object' && address !== null ? address.port : 0
    return { baseUrl: `http://127.0.0.1:${this.port}`, token: this.token }
  }

  /** 停止服务。 @returns {Promise<void>} */
  async stop() {
    for (const set of this.subscribers.values()) {
      for (const ws of set) ws.terminate()
    }
    this.wss?.close()
    await new Promise((resolve) => { this.server?.close(() => resolve()) ?? resolve() })
  }

  /** 当前 authority。 @returns {string} `127.0.0.1:<port>` */
  get authority() {
    return `127.0.0.1:${this.port}`
  }

  /** 会话 Cookie 名（与 DSH 的派生方式一致）。 @returns {string} */
  get cookieName() {
    return `dsh-auth-${createHash('sha256').update(this.authority).digest('base64url')}`
  }

  /** 有效的 Cookie 值（同一实例内稳定，便于测试断言）。 @returns {string} */
  get cookieValue() {
    if (this._cookieValue === undefined) {
      this._cookieValue = `v1.${b64url(JSON.stringify({ version: 1, authority: this.authority, issuedAt: 1791520000000 }))}.${b64url('sig')}`
    }
    return this._cookieValue
  }

  /**
   * 校验 Host/Origin 信任栅栏（与 `isTrustedApiRequest` 行为一致）。
   * @param {import('node:http').IncomingMessage} req - 请求。
   * @returns {number|null} 403 表示拒绝，null 表示通过。
   */
  checkTrust(req) {
    const host = req.headers.host ?? ''
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/u.test(host)) return 403
    if (req.headers['sec-fetch-site'] === 'cross-site') return 403
    const origin = req.headers.origin
    if (typeof origin === 'string' && origin !== '') {
      if (origin !== `http://${host}` && origin !== `https://${host}`) return 403
    }
    return null
  }

  /**
   * 读取并校验会话 Cookie。
   * @param {import('node:http').IncomingMessage} req - 请求。
   * @returns {string|null} 命中时返回 Cookie 名，否则 null。
   */
  readCookie(req) {
    const header = req.headers.cookie
    if (typeof header !== 'string' || header === '') return null
    for (const pair of header.split(';')) {
      const at = pair.indexOf('=')
      if (at === -1) continue
      const name = pair.slice(0, at).trim()
      const value = pair.slice(at + 1).trim()
      if (name === this.cookieName && value.startsWith('v1.')) return name
    }
    return null
  }

  /**
   * 处理 HTTP 请求。
   * @param {import('node:http').IncomingMessage} req - 请求。
   * @param {import('node:http').ServerResponse} res - 响应。
   * @returns {void}
   */
  handleHttp(req, res) {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    if (req.method === 'GET' && url.pathname === '/') {
      const token = url.searchParams.get('token')
      if (token !== this.token) {
        res.writeHead(401, { 'content-type': 'text/plain' })
        res.end('dsh web authentication required; reopen the URL printed by dsh web.')
        return
      }
      res.writeHead(303, {
        location: './',
        'set-cookie': `${this.cookieName}=${this.cookieValue}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000`,
      })
      res.end()
      return
    }
    if (!url.pathname.startsWith('/api/')) {
      res.writeHead(404).end()
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(404).end()
      return
    }
    const contentType = String(req.headers['content-type'] ?? '')
    if (!contentType.includes('application/json')) {
      res.writeHead(415).end()
      return
    }
    const trust = this.checkTrust(req)
    if (trust !== null) {
      res.writeHead(trust).end()
      return
    }
    if (this.readCookie(req) === null) {
      res.writeHead(401, { 'content-type': 'text/plain' })
      res.end('dsh web authentication required; reopen the URL printed by dsh web.')
      return
    }
    if (this.behavior.forceStatus !== null) {
      res.writeHead(this.behavior.forceStatus).end()
      return
    }
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      let body
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        res.writeHead(400).end()
        return
      }
      this.dispatch(body, res, url.pathname.slice('/api/'.length))
    })
  }

  /**
   * 分发一元 RPC。
   * @param {any} body - 请求信封。
   * @param {import('node:http').ServerResponse} res - 响应。
   * @param {string} method - `<namespace>/<method>`。
   * @returns {void}
   */
  dispatch(body, res, method) {
    this.requestCounts.set(method, (this.requestCounts.get(method) ?? 0) + 1)
    const rpcId = body?.rpcId
    const reply = (result) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'server-response', rpcId, result }))
    }
    const fail = (code, message, details = {}) => reply({ ok: false, error: { code, message, details } })
    const args = body?.payload?.args ?? {}
    if (this.behavior.forceRemoteError !== null && method === 'session/prompt') {
      const forced = this.behavior.forceRemoteError
      fail(forced.code, forced.message)
      return
    }
    switch (method) {
      case 'session/list':
        reply({ ok: true, value: { items: this.sessions } })
        return
      case 'session/create':
        this.handleCreate(args.request ?? {}, res, reply, fail)
        return
      case 'session/rename': {
        const request = args.request ?? {}
        const title = normalizeTitle(request.title)
        if (title === '') {
          fail('session/title-invalid', 'mock: title is empty after normalization')
          return
        }
        const session = this.sessions.find(item => item.sessionId === request.sessionId)
        if (session === undefined) {
          fail('session/not-found', `session ${String(request.sessionId)} not found`)
          return
        }
        ensureSessionShape(session)
        session.projections.values.title = title
        session.titlePinned = true
        this.titleSeq += 1
        this.activatedSessions.push(session.sessionId)
        reply({ ok: true, value: { title, seq: this.titleSeq } })
        return
      }
      case 'session/prompt': {
        const request = args.request ?? {}
        if (!this.logs.has(request.sessionId)) {
          fail('session/not-found', `session ${String(request.sessionId)} not found`)
          return
        }
        const handle = () => {
          const seen = this.seenRequests.get(request.sessionId) ?? []
          if (seen.includes(request.requestId)) {
            reply({ ok: true, value: { accepted: true } })
            return
          }
          seen.push(request.requestId)
          this.seenRequests.set(request.sessionId, seen)
          reply({ ok: true, value: { accepted: true } })
          if (this.behavior.silentAccept) return
          this.enqueue(request)
          if (this.behavior.autoRun) this.runTurn(request.sessionId, request.requestId)
        }
        if (this.behavior.promptDelayMs > 0) setTimeout(handle, this.behavior.promptDelayMs)
        else handle()
        return
      }
      case 'session/page': {
        const request = args.request ?? {}
        const events = this.logs.get(request.address?.sessionId) ?? []
        if (this.behavior.pageFailures > 0) {
          this.behavior.pageFailures -= 1
          fail('session/page-unavailable', 'mock: page temporarily unavailable')
          return
        }
        const page = paginate(events, request)
        reply({
          ok: true,
          value: {
            records: toRecords(page.events),
            hasMore: page.hasMore,
            cursor: page.cursor,
            projections: { asOfSeq: page.cursor, values: {} },
          },
        })
        return
      }
      default:
        fail('gateway/bad-request', `unknown method ${method}`)
    }
  }

  /**
   * 处理 `session/create`（契约 §5）。
   *
   * - `workspaceId` 与 `cwd` 同时给 → `gateway/bad-request`（在创建之前）；
   * - `sessionId` 省略 → 生成 `session-<uuid>`；
   * - 同 ID 已存在：`cwd` 不同 → `session/conflict`（details 带 requestedCwd/existingCwd），
   *   `agentPreset` 不同 → `agent-preset/conflict`，否则收养（**不新建**）；
   * - 新建时记录 `createdSessions` 与 `mkdirCalls`，**绝不真的 mkdir**。
   *
   * 计数：每次收到请求都 `createCalls += 1`（含延迟、失败与冲突）。
   * 行为开关：`createFailStatus`（HTTP 状态码）、`createFailRemote`（业务错误）、
   * `createDelayMs`（响应延迟，用于构造本地超时）。
   * @param {any} request - `{sessionId?, cwd?, agentPreset?, workspaceId?}`。
   * @param {import('node:http').ServerResponse} res - 响应。
   * @param {(result: any) => void} reply - 成功回复。
   * @param {(code: string, message: string, details?: any) => void} fail - 失败回复。
   * @returns {void}
   */
  handleCreate(request, res, reply, fail) {
    this.createCalls += 1
    if (this.behavior.createFailStatus !== null) {
      res.writeHead(this.behavior.createFailStatus).end()
      return
    }
    const handle = () => {
      if (this.behavior.createFailRemote !== null) {
        const forced = this.behavior.createFailRemote
        fail(forced.code, forced.message)
        return
      }
      const hasCwd = typeof request.cwd === 'string' && request.cwd !== ''
      const hasWorkspaceId = request.workspaceId !== undefined
        && request.workspaceId !== null
        && request.workspaceId !== ''
      if (hasWorkspaceId && hasCwd) {
        fail('gateway/bad-request', 'mock: workspaceId and cwd are mutually exclusive')
        return
      }
      const requestedId = typeof request.sessionId === 'string' && request.sessionId !== ''
        ? request.sessionId
        : `session-${randomUUID()}`
      const requestedCwd = request.cwd ?? null
      const requestedPreset = request.agentPreset ?? null
      const existing = this.sessions.find(item => item.sessionId === requestedId)
      if (existing !== undefined) {
        ensureSessionShape(existing)
        const existingCwd = existing.cwd ?? null
        if (requestedCwd !== existingCwd) {
          fail('session/conflict', `mock: session ${requestedId} already exists with a different cwd`, {
            requestedCwd,
            existingCwd,
          })
          return
        }
        const existingPreset = existing.projections.values.agentPreset ?? null
        if (requestedPreset !== existingPreset) {
          fail('agent-preset/conflict', `mock: session ${requestedId} already exists with a different agentPreset`, {
            requestedAgentPreset: requestedPreset,
            existingAgentPreset: existingPreset,
          })
          return
        }
        // 收养：返回同一会话，不新建、不改动。
        reply({ ok: true, value: { sessionId: existing.sessionId, agentPreset: existingPreset } })
        return
      }
      const session = ensureSessionShape({
        sessionId: requestedId,
        running: false,
        agentAvailable: true,
        blank: true,
        updatedAt: Date.now(),
        cwd: requestedCwd,
        origin: 'user',
        projections: { values: { title: null, agentPreset: requestedPreset, permissions: { currentValue: null } } },
        parentSessionId: null,
      })
      this.sessions.push(session)
      this.logs.set(requestedId, [])
      this.createdSessions.push({ sessionId: requestedId, cwd: requestedCwd, agentPreset: requestedPreset })
      // 记录“本应创建”的目录；mock 不接触文件系统。
      this.mkdirCalls.push(request.cwd)
      if (typeof this.behavior.autoTitle === 'string' && session.titlePinned !== true) {
        session.projections.values.title = this.behavior.autoTitle
      }
      reply({ ok: true, value: { sessionId: requestedId, agentPreset: requestedPreset } })
    }
    if (this.behavior.createDelayMs > 0) setTimeout(handle, this.behavior.createDelayMs)
    else handle()
  }

  /**
   * 模拟 DSH 的自动命名：当 `behavior.autoTitle` 为字符串时，把**未 pin** 的会话标题
   * 改成该值；已 `titlePinned` 的会话保持不变（验证显式 rename 不漂移）。
   * @returns {string[]} 被改写的会话 ID。
   */
  applyAutoTitle() {
    if (typeof this.behavior.autoTitle !== 'string') return []
    const changed = []
    for (const session of this.sessions) {
      ensureSessionShape(session)
      if (session.titlePinned === true) continue
      session.projections.values.title = this.behavior.autoTitle
      changed.push(session.sessionId)
    }
    return changed
  }

  /**
   * 追加一个持久事件并推送给订阅者。
   * @param {string} sessionId - 会话。
   * @param {string} type - 事件类型。
   * @param {any} data - 事件负载。
   * @returns {any} 事件。
   */
  append(sessionId, type, data) {
    const log = this.logs.get(sessionId)
    if (log === undefined) throw new Error(`unknown session ${sessionId}`)
    const event = { type, seq: (log.at(-1)?.seq ?? 0) + 1, time: Date.now(), data }
    log.push(event)
    const session = this.sessions.find(item => item.sessionId === sessionId)
    if (session !== undefined) session.updatedAt = Date.now()
    for (const ws of this.subscribers.get(sessionId) ?? []) {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'item', streamId: ws.streamId, value: { type: 'event', event } }))
    }
    return event
  }

  /**
   * 把一条用户任务放进待发队列。
   * @param {any} request - `SessionPromptRequest`。
   * @returns {any} 事件。
   */
  enqueue(request) {
    const text = (request.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n')
    const message = {
      id: `msg-${randomUUID()}`,
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user', rpcId: request.requestId },
    }
    return this.append(request.sessionId, 'agent/inbox/spliced', {
      target: 'next-turn',
      start: 0,
      inserted: [message],
    })
  }

  /**
   * 跑完一个回合：认领队列消息、产生助手消息、结束回合。
   * @param {string} sessionId - 会话。
   * @param {string} requestId - 触发它的请求。
   * @param {object} [options] - 覆盖项。
   * @param {number} [options.turn] - 指定回合号。
   * @param {boolean} [options.withUserInterjection] - 在同一回合内插入另一条用户消息。
   * @param {Array<any>} [options.extraEvents] - 额外的中间事件。
   * @param {any} [options.endReason] - 回合结束原因。
   * @param {string} [options.replyText] - 助手回复文本。
   * @returns {{turn: number, endSeq: number|null}} 回合信息。
   */
  runTurn(sessionId, requestId, options = {}) {
    const log = this.logs.get(sessionId)
    const previous = [...log].reverse().find(event => event.type === 'turn/end')
    const turn = options.turn ?? ((previous?.data?.turn ?? 0) + 1)
    this.append(sessionId, 'turn/start', { turn })
    const queued = [...log].reverse().find(event =>
      event.type === 'agent/inbox/spliced' && event.data?.inserted?.some(message => message.source?.rpcId === requestId))
    const message = queued?.data?.inserted.find(item => item.source?.rpcId === requestId)
    this.append(sessionId, 'user/message', message ?? {
      id: `msg-${randomUUID()}`,
      role: 'user',
      content: [{ type: 'text', text: '' }],
      source: { kind: 'user', rpcId: requestId },
    })
    if (options.withUserInterjection === true) {
      this.append(sessionId, 'user/message', {
        id: `msg-${randomUUID()}`,
        role: 'user',
        content: [{ type: 'text', text: '另外顺便看一下别的' }],
        source: { kind: 'user', rpcId: `rpc-${randomUUID()}` },
      })
    }
    this.append(sessionId, 'step/start', { turn, step: 1 })
    for (const event of options.extraEvents ?? this.behavior.turnEvents) {
      this.append(sessionId, event.type, { turn, step: 1, ...event.data })
    }
    const endReason = options.endReason ?? this.behavior.turnEndReason
    if (endReason.kind !== 'error' || options.replyText !== undefined) {
      this.append(sessionId, 'assistant/message', {
        turn,
        step: 1,
        message: {
          id: `amsg-${randomUUID()}`,
          role: 'assistant',
          content: [{ type: 'text', text: options.replyText ?? this.behavior.replyText }],
          source: { kind: 'model', provider: 'mock', model: 'mock' },
        },
        stream: [],
      })
    }
    this.append(sessionId, 'step/end', { turn, step: 1 })
    const endEvent = this.append(sessionId, 'turn/end', { turn, reason: endReason })
    return { turn, endSeq: endEvent.seq }
  }

  /**
   * 处理 mux 帧。
   * @param {any} ws - WebSocket。
   * @param {string} raw - 原始帧。
   * @returns {void}
   */
  handleMux(ws, raw) {
    let frame
    try {
      frame = JSON.parse(raw)
    } catch {
      return
    }
    if (frame?.type !== 'open') return
    if (frame.endpoint === '$events') {
      this.eventStreamOpens += 1
      return
    }
    if (frame.endpoint !== 'session/follow') return
    const sessionId = frame.payload?.args?.request?.address?.sessionId
    this.followOpens += 1
    const log = this.logs.get(sessionId)
    ws.streamId = frame.streamId
    if (log === undefined) {
      ws.send(JSON.stringify({
        type: 'error',
        streamId: frame.streamId,
        error: { code: 'session/not-found', message: `session ${String(sessionId)} not found`, details: {} },
      }))
      ws.send(JSON.stringify({ type: 'end', streamId: frame.streamId }))
      return
    }
    const cursor = log.at(-1)?.seq ?? 0
    const page = paginate(log, { maxMessages: this.behavior.maxMessages, throughSeq: cursor })
    const window = this.behavior.snapshotWindow === null
      ? page.events
      : page.events.slice(-this.behavior.snapshotWindow)
    ws.send(JSON.stringify({
      type: 'item',
      streamId: frame.streamId,
      value: {
        type: 'snapshot',
        header: { sessionId, cwd: this.sessions.find(item => item.sessionId === sessionId)?.cwd ?? null },
        cursor,
        records: toRecords(window),
        hasMore: page.hasMore || window.length < page.events.length,
        projections: { asOfSeq: cursor, values: {} },
      },
    }))
    if (this.behavior.replayLastN > 0) {
      for (const event of log.slice(-this.behavior.replayLastN)) {
        ws.send(JSON.stringify({ type: 'item', streamId: frame.streamId, value: { type: 'event', event } }))
      }
    }
    if (this.behavior.dropSnapshots > 0) {
      this.behavior.dropSnapshots -= 1
      setTimeout(() => ws.terminate(), 5)
      return
    }
    const set = this.subscribers.get(sessionId) ?? new Set()
    set.add(ws)
    this.subscribers.set(sessionId, set)
  }

  /**
   * 直接注入一段原始日志（用于构造历史场景）。
   * @param {string} sessionId - 会话。
   * @param {Array<{type: string, data: any}>} events - 事件序列。
   * @returns {void}
   */
  seed(sessionId, events) {
    for (const event of events) this.append(sessionId, event.type, event.data)
  }
}
