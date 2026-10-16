/**
 * 命令行入口：auth / check / sessions / bind / send / wait / status。
 *
 * 设计约束（来自实施任务书）：
 * - 只连接本机 DSH，保留其鉴权与信任校验，不提供任何绕过开关。
 * - 只向用户显式绑定的会话发送；绝不推断“当前网页会话”。
 * - 地址、凭据、绑定、请求记录四者的 authority 必须一致，否则失败关闭。
 * - 先落盘请求记录再发 HTTP；提交超时记为未知，重发必须同 requestId/sessionId/内容。
 * - 终态判定前必须证明日志连续：内部缺口要补页，补不上就不确定。
 * - 输出与日志一律脱敏；JSON 模式给出稳定的机器可读结构。
 *
 * 本模块**不向 stdout 写任何东西**（除 `main()` 注入的 `io.out`）。`buildContext()` 与
 * `run()` 已导出，MCP 层可在同进程内直接调用并自行序列化返回值，无需 spawn 子进程。
 * @module zhihui-xiezuo/cli
 */

import {
  DEFAULT_BASE_URL, Paths, credentialExpired, ensureHome, readConfig, readCredential,
  resolveHome, updateConfig, writeCredential, clearCredential,
} from './config.js'
import { asBridgeError, BridgeError, EXIT, usageError } from './errors.js'
import { authorityOf, DshApi, exchangeToken, normalizeBaseUrl } from './rpc.js'
import { followSessionStream } from './mux.js'
import { analyze, EventLog, isFinalPhase, PHASE } from './associate.js'
import { readTokenFile, readTokenInteractive } from './secret-input.js'
import { digestOf, newRequestId, RequestStore, REQUEST_STATE, readTaskFile, withLock } from './store.js'
import {
  assertStatusTransition, assertWorkOrderId, buildRecovery, deriveRestoreStatus, PHASE_NAMES, PHASE_STATES,
  setStatus, statusEffectOfPhase, WORKORDER_STATUS, WorkOrderStore,
} from './workorder.js'
import { redactText } from './redact.js'
import { randomUUID } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import { stat } from 'node:fs/promises'

/** 本工具声明的接口契约版本；接口字段变化时递增。 */
export const CONTRACT_VERSION = 'session-remote/1'

/** 单页最多取多少条消息（与 DSH 的 `maxMessages` 同义：只计 user/assistant 消息）。 */
const PAGE_MAX_MESSAGES = 200

/** 默认回溯补页上限。 */
const DEFAULT_BACKFILL_PAGES = 5

/** 帮助文本（中文）。 */
export const HELP = `zhihui-xiezuo — 本机 DSH 消息桥接

用法：
  zhihui-xiezuo <命令> [参数...] [选项]

命令：
  auth                     用 dsh web 的启动令牌换取浏览器会话凭据（令牌不回显、不落命令行）
  check                    检查连接、认证与接口兼容性；不激活任何会话
  sessions                 列出会话摘要（ID、标题、preset、权限、工作目录），不输出聊天正文
  inspect <会话ID>         只读核对一个会话的地址/标题/cwd/preset/权限；不激活
  bind <会话ID>            校验该会话存在并保存绑定；绝不推断“当前网页会话”
  send --file <任务文件>   向绑定会话提交任务（默认 mode=queue），返回 requestId 与接受状态
      [--session <会话ID>] 本次改用指定会话（必须已确认存在）
  send --file <任务文件> --work-order <工作单> --authorize
                           工作单投递入口：目标固定为工作单执行会话；锁内固定 requestId 并先落
                           delivery.preparing 再发 HTTP；已 preparing/unknown/delivered 不再发第二次
      [--request-id <UUID>] [--new-attempt]  新一轮投递必须显式 --new-attempt（保留旧 attempt 证据）
  wait <requestId>         订阅并等待该请求关联回合的最终结果
  status <requestId>       查询本地请求记录，并做只读核对
  create --cwd <目录> --authorize [--session-id <ID>] [--title <标题>] [--work-order <工作单>]
                           以预存 sessionId 创建执行会话（幂等收养）；cwd 必须是已存在的绝对目录
  rename <会话ID> --title <标题> --authorize [--work-order <工作单>]
                           重命名会话（会激活该会话）；标题按 80 字节截断并回读
  workorder <子命令>       协作工作单：init/list/show/attach/negotiate/approve/deliver/report/
                           review/phase/recover（机读状态在状态目录 workorders/ 下）

选项：
  --url <地址>             覆盖 DSH 地址，默认 ${DEFAULT_BASE_URL}（只接受本机环回地址）
  --home <目录>            覆盖状态目录
  --json                   输出机器可读 JSON
  --timeout <毫秒>         wait 的本地等待上限（默认 300000）
  --http-timeout <毫秒>    单次 /api 调用超时（默认 15000）
  --token-file <文件>      auth 从受保护文件读取令牌（POSIX 要求权限 600；Windows 改用 ACL 检查）
  --request-id <UUID>      复用既有 requestId 重发（必须同会话同内容）
  --backfill-pages <N>     回溯补页上限，默认 ${DEFAULT_BACKFILL_PAGES} 页（避免读取全部历史）
  --verify                 status 时额外做只读日志核对（可能激活冷会话）
  --authorize              明确声明“用户已授权本次创建/改名/工作单投递”（缺失即拒绝）
  --new-attempt            工作单 send 显式开启新一轮投递（保留旧 attempt 证据；默认拒绝重发）
  -h, --help               显示本帮助

退出码：
  0 成功   1 失败   2 用法错误   3 认证/信任失败   4 目标不存在
  5 本地等待超时   6 关联不确定   7 提交结果未知

示例：
  zhihui-xiezuo auth --token-file ~/.config/dsh-token
  zhihui-xiezuo check --json
  zhihui-xiezuo sessions
  zhihui-xiezuo inspect session-<会话ID>
  zhihui-xiezuo bind <会话ID>
  zhihui-xiezuo send --file ./task.md
  zhihui-xiezuo wait 7f3c... --timeout 600000
  zhihui-xiezuo workorder init --goal "让 Codex 与 DSH 协商执行" --scope 桥接 --authorize
  zhihui-xiezuo create --cwd /path/to/workspace --session-id session-<预存UUID> --work-order wo-<id> --authorize
  zhihui-xiezuo rename session-<预存UUID> --title "执行会话标题" --work-order wo-<id> --authorize
  zhihui-xiezuo send --file ./task.md --work-order wo-<id> --authorize   # 投递身份由工作单固定
  zhihui-xiezuo workorder recover wo-<id>
`

/** 需要取值的选项。 */
const VALUE_FLAGS = new Set([
  '--url', '--home', '--timeout', '--file', '--session', '--token-file', '--request-id', '--backfill-pages',
  '--http-timeout',
  // 协作工作流
  '--cwd', '--title', '--session-id', '--work-order', '--goal', '--scope', '--coordinator',
  '--coordinator-title', '--max-rounds', '--name', '--state', '--evidence', '--proposal', '--decision',
  '--report', '--artifact', '--verdict', '--by', '--issue', '--preset', '--permissions', '--base-url',
  '--reason', '--user-decision', '--note', '--creation-state', '--round',
])

/** 可重复出现的取值选项。 */
const REPEATABLE_FLAGS = new Set(['--scope', '--evidence', '--issue', '--artifact'])

/** 布尔选项。 */
const BOOLEAN_FLAGS = new Set(['--json', '--help', '-h', '--verify', '--quiet', '--authorize', '--new-attempt'])

/**
 * 解析命令行。
 * @param {string[]} argv - 不含 node 与脚本名的参数。
 * @returns {{command: string, positional: string[], flags: Record<string, any>}} 解析结果。
 */
export function parseArgs(argv) {
  /** @type {Record<string, any>} */
  const flags = {}
  /** @type {string[]} */
  const positional = []
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token.startsWith('--') || token === '-h') {
      const eq = token.indexOf('=')
      const name = eq === -1 ? token : token.slice(0, eq)
      if (VALUE_FLAGS.has(name)) {
        const value = eq === -1 ? argv[++index] : token.slice(eq + 1)
        if (value === undefined) throw usageError(`选项 ${name} 缺少取值。`)
        const key = name.slice(2)
        if (REPEATABLE_FLAGS.has(name)) {
          const existing = flags[key]
          flags[key] = existing === undefined ? [value] : [...(Array.isArray(existing) ? existing : [existing]), value]
        } else {
          flags[key] = value
        }
        continue
      }
      if (BOOLEAN_FLAGS.has(name)) {
        if (eq !== -1) throw usageError(`选项 ${name} 不接受取值。`)
        flags[name === '-h' ? 'help' : name.slice(2)] = true
        continue
      }
      throw usageError(`未知选项：${name}`)
    }
    positional.push(token)
  }
  const command = positional.shift() ?? (flags.help === true ? 'help' : '')
  return { command, positional, flags }
}

/**
 * 组装运行上下文。
 *
 * 导出给 MCP 层复用：`run()` 依赖它产出的 `ctx`，同进程内调用即可，不必 spawn CLI。
 * 会确保状态目录存在、读取配置与凭据、规范化地址。
 * @param {Record<string, any>} flags - 解析后的选项。
 * @returns {Promise<any>} 上下文。
 */
export async function buildContext(flags) {
  const paths = new Paths(resolveHome(flags.home))
  await ensureHome(paths)
  const config = await readConfig(paths)
  const baseUrl = normalizeBaseUrl(flags.url ?? config.baseUrl ?? DEFAULT_BASE_URL)
  const credential = await readCredential(paths)
  return {
    paths, config, baseUrl, authority: authorityOf(baseUrl), credential, flags,
    store: new RequestStore(paths), workorders: new WorkOrderStore(paths),
  }
}

/**
 * 构造已鉴权的 API 客户端；缺少凭据或凭据 authority 不匹配时给出明确失败。
 * @param {any} ctx - 上下文。
 * @param {boolean} [required] - 是否强制要求凭据。
 * @returns {DshApi} 客户端。
 */
function apiOf(ctx, required = true) {
  if (required && ctx.credential === null) {
    throw new BridgeError('auth_required', '尚未认证。请先运行 `zhihui-xiezuo auth`。', { exitCode: EXIT.AUTH })
  }
  if (ctx.credential !== null && credentialExpired(ctx.credential)) {
    throw new BridgeError('credential_expired', '本地凭据已过期。请重新运行 `zhihui-xiezuo auth`。', { exitCode: EXIT.AUTH })
  }
  const httpTimeout = Number(ctx.flags?.['http-timeout'] ?? Number.NaN)
  // DshApi 构造时会强制校验 credential.authority === 目标 authority。
  return new DshApi({
    baseUrl: ctx.baseUrl,
    credential: ctx.credential,
    ...Number.isFinite(httpTimeout) && httpTimeout > 0 ? { timeoutMs: httpTimeout } : {},
  })
}

/**
 * 校验请求记录所属地址与当前地址一致。
 * @param {any} record - 请求记录。
 * @param {string} baseUrl - 当前地址。
 * @returns {void} 一致时正常返回。
 */
function assertRecordAddress(record, baseUrl) {
  if (typeof record.baseUrl === 'string' && record.baseUrl !== '' && record.baseUrl !== baseUrl) {
    throw new BridgeError(
      'request_address_mismatch',
      `请求 ${record.requestId} 记录于地址 ${record.baseUrl}，与当前地址 ${baseUrl} 不一致；已拒绝，以免把结果接到别的实例。`,
      { exitCode: EXIT.USAGE, details: { recordBaseUrl: record.baseUrl, currentBaseUrl: baseUrl } },
    )
  }
}

/**
 * 安全地描述凭据（不含秘密）。
 * @param {any} credential - 凭据。
 * @returns {object} 描述。
 */
function describeCredential(credential) {
  if (credential === null) return { present: false }
  return {
    present: true,
    authority: credential.authority ?? null,
    cookieName: credential.cookieName ?? null,
    obtainedAt: credential.obtainedAt ?? null,
    expiresAt: credential.expiresAt ?? null,
    expired: credentialExpired(credential),
  }
}

/**
 * 格式化时间戳为 ISO 字符串。
 * @param {unknown} value - 时间戳。
 * @returns {string} 文本。
 */
function formatTime(value) {
  if (typeof value !== 'number') return '-'
  return new Date(value).toISOString()
}

/**
 * 主入口。
 * @param {string[]} argv - 参数。
 * @param {object} [io] - 注入的输出与交互（测试用）。
 * @param {(line: string) => void} [io.out] - 标准输出。
 * @param {(line: string) => void} [io.err] - 标准错误。
 * @returns {Promise<number>} 退出码。
 */
export async function main(argv, io = {}) {
  const out = io.out ?? ((line) => process.stdout.write(`${line}\n`))
  const err = io.err ?? ((line) => process.stderr.write(`${line}\n`))
  let parsed
  try {
    parsed = parseArgs(argv)
  } catch (error) {
    const bridge = asBridgeError(error)
    err(`错误：${bridge.message}`)
    return bridge.exitCode
  }
  const { command, positional, flags } = parsed
  const json = flags.json === true
  if (command === '' || command === 'help' || flags.help === true) {
    out(HELP)
    return command === '' && flags.help !== true && command !== 'help' ? EXIT.USAGE : EXIT.OK
  }
  try {
    const ctx = await buildContext(flags)
    const result = await run(command, positional, flags, ctx)
    const exitCode = result.exitCode ?? EXIT.OK
    const { text = '', error = null, ...rest } = result
    if (json) {
      const payload = exitCode === EXIT.OK
        ? { ok: true, command, ...rest }
        : { ok: false, command, error: error ?? { code: 'failed', message: text }, ...rest }
      out(JSON.stringify(payload, null, 2))
    } else if (text !== '') {
      out(text)
    }
    return exitCode
  } catch (error) {
    const bridge = asBridgeError(error)
    if (json) {
      out(JSON.stringify({
        ok: false,
        command,
        error: { code: bridge.code, message: bridge.message, details: bridge.details },
        exitCode: bridge.exitCode,
      }, null, 2))
    } else {
      err(`错误（${bridge.code}）：${bridge.message}`)
      if (bridge.details !== undefined && Object.keys(bridge.details).length > 0) {
        err(`细节：${JSON.stringify(bridge.details)}`)
      }
    }
    return bridge.exitCode
  }
}

/**
 * 分发命令。
 *
 * 导出给 MCP 层复用：返回值是**纯数据**（`exitCode` + 人类可读 `text` + 结构字段），
 * 不写任何输出；调用方自行决定序列化方式。
 * @param {string} command - 命令名。
 * @param {string[]} positional - 位置参数。
 * @param {Record<string, any>} flags - 选项。
 * @param {any} ctx - 上下文。
 * @returns {Promise<any>} 结果（含 `exitCode` 与人类可读 `text`）。
 */
export async function run(command, positional, flags, ctx) {
  switch (command) {
    case 'auth': return await commandAuth(flags, ctx)
    case 'check': return await commandCheck(flags, ctx)
    case 'sessions': return await commandSessions(flags, ctx)
    case 'inspect': return await commandInspect(positional, flags, ctx)
    case 'bind': return await commandBind(positional, flags, ctx)
    case 'send': return await commandSend(positional, flags, ctx)
    case 'wait': return await commandWait(positional, flags, ctx)
    case 'status': return await commandStatus(positional, flags, ctx)
    case 'create': return await commandCreate(positional, flags, ctx)
    case 'rename': return await commandRename(positional, flags, ctx)
    case 'workorder': return await commandWorkOrder(positional, flags, ctx)
    default:
      throw usageError(`未知命令：${command}。运行 zhihui-xiezuo --help 查看用法。`)
  }
}

/**
 * `auth`：用启动令牌换取会话 Cookie。
 * @param {Record<string, any>} flags - 选项。
 * @param {any} ctx - 上下文。
 * @returns {Promise<any>} 结果。
 */
async function commandAuth(flags, ctx) {
  const token = typeof flags['token-file'] === 'string'
    ? await readTokenFile(flags['token-file'])
    : await readTokenInteractive('请输入 dsh web 启动时打印 URL 里的 token（输入不回显）：')
  if (typeof token !== 'string' || token.trim() === '') {
    throw new BridgeError('token_empty', '令牌为空。', { exitCode: EXIT.USAGE })
  }
  const { credential } = await exchangeToken({ baseUrl: ctx.baseUrl, token })
  await writeCredential(ctx.paths, credential)
  // 换地址后不能复用旧绑定：绑定属于具体实例。
  const staleBinding = ctx.config.bound !== null
    && ctx.config.bound !== undefined
    && ctx.config.bound.baseUrl !== ctx.baseUrl
  await updateConfig(ctx.paths, {
    baseUrl: ctx.baseUrl,
    ...staleBinding ? { bound: null } : {},
  })
  const described = describeCredential(credential)
  const lines = [
    '认证成功。',
    `  地址：${ctx.baseUrl}`,
    `  凭据：已保存到 ${ctx.paths.credential}（0600，内容不回显）`,
    `  Cookie 名：${described.cookieName}`,
    `  到期：${described.expiresAt === null ? '会话结束时' : formatTime(described.expiresAt)}`,
  ]
  if (staleBinding) {
    lines.push(`  注意：原绑定属于 ${ctx.config.bound.baseUrl}，与本地址不同，已清除，请重新 bind。`)
  }
  return { exitCode: EXIT.OK, text: lines.join('\n'), credential: described, bindingCleared: staleBinding }
}

/**
 * `check`：检查连接、认证与接口兼容性，不激活会话。
 * @param {Record<string, any>} flags - 选项。
 * @param {any} ctx - 上下文。
 * @returns {Promise<any>} 结果。
 */
async function commandCheck(flags, ctx) {
  const api = apiOf(ctx)
  const value = await api.call('session/list', { _request: {} })
  if (value === null || typeof value !== 'object' || !Array.isArray(value.items)) {
    throw new BridgeError('contract_mismatch', 'session/list 的返回结构不是预期的 { items: [] }。', {
      details: { observed: Object.keys(value ?? {}) },
    })
  }
  const sample = value.items[0] ?? null
  const observedFields = sample === null ? [] : Object.keys(sample).sort()
  const requiredFields = ['sessionId', 'running', 'agentAvailable', 'updatedAt']
  const missing = requiredFields.filter(field => !observedFields.includes(field))
  await updateConfig(ctx.paths, {
    baseUrl: ctx.baseUrl,
    contract: {
      version: CONTRACT_VERSION,
      checkedAt: new Date().toISOString(),
      sessionCount: value.items.length,
      sessionSummaryFields: observedFields,
      missingFields: missing,
    },
  })
  const described = describeCredential(ctx.credential)
  const lines = [
    '检查通过。',
    `  地址：${ctx.baseUrl}`,
    `  认证：凭据有效（${described.cookieName ?? '-'}，到期 ${described.expiresAt === null ? '会话结束' : formatTime(described.expiresAt)}）`,
    `  接口：session/list 可用，会话数 ${value.items.length}`,
    `  契约：${CONTRACT_VERSION}；SessionSummary 字段 ${observedFields.join(', ') || '（空列表，未观测到）'}`,
  ]
  if (missing.length > 0) {
    lines.push(`  警告：缺少预期字段 ${missing.join(', ')}，DSH 版本可能已变化。`)
  }
  return {
    exitCode: EXIT.OK,
    text: lines.join('\n'),
    baseUrl: ctx.baseUrl,
    authority: ctx.authority,
    credential: described,
    contract: { version: CONTRACT_VERSION, sessionCount: value.items.length, sessionSummaryFields: observedFields, missingFields: missing },
  }
}

/**
 * 把 `session/list` 的一个 item 精简为摘要（精选 projections，不 dump 全量、不含聊天正文）。
 * @param {any} item - 会话列表项。
 * @returns {any} 摘要。
 */
function sessionSummary(item) {
  const values = item?.projections?.values ?? {}
  return {
    sessionId: item?.sessionId ?? null,
    running: item?.running === true,
    agentAvailable: item?.agentAvailable === true,
    blank: item?.blank === true,
    updatedAt: typeof item?.updatedAt === 'number' ? item.updatedAt : null,
    cwd: typeof item?.cwd === 'string' ? item.cwd : null,
    origin: typeof item?.origin === 'string' ? item.origin : null,
    title: typeof values.title === 'string' ? values.title : null,
    agentPreset: typeof values.agentPreset === 'string' ? values.agentPreset : null,
    permissions: typeof values.permissions?.currentValue === 'string' ? values.permissions.currentValue : null,
    parentSessionId: typeof item?.parentSessionId === 'string' ? item.parentSessionId : null,
  }
}

/**
 * `sessions`：列出会话摘要。
 * @param {Record<string, any>} flags - 选项。
 * @param {any} ctx - 上下文。
 * @returns {Promise<any>} 结果。
 */
async function commandSessions(flags, ctx) {
  const api = apiOf(ctx)
  const value = await api.call('session/list', { _request: {} })
  const items = Array.isArray(value?.items) ? value.items : []
  const rows = items.map(sessionSummary)
  const boundId = ctx.config.bound?.sessionId ?? null
  const lines = [`共 ${rows.length} 个会话（仅摘要，不含聊天正文）：`]
  for (const row of rows) {
    const marker = row.sessionId === boundId ? ' [已绑定]' : ''
    lines.push(`  ${row.sessionId}${marker}`)
    lines.push(`    标题：${row.title ?? '-'}`)
    lines.push(`    运行中：${row.running ? '是' : '否'}  可交互：${row.agentAvailable ? '是' : '否'}  空白：${row.blank ? '是' : '否'}`)
    lines.push(`    预设：${row.agentPreset ?? '-'}  权限：${row.permissions ?? '-'}  派生自：${row.parentSessionId ?? '-'}`)
    lines.push(`    更新：${formatTime(row.updatedAt)}  工作目录：${row.cwd ?? '-'}`)
  }
  if (rows.length === 0) lines.push('  （无）')
  return { exitCode: EXIT.OK, text: lines.join('\n'), sessions: rows, boundSessionId: boundId }
}

/**
 * `inspect`：只读核对一个会话的地址、cwd、标题与身份；不激活会话。
 * @param {string[]} positional - 位置参数。
 * @param {Record<string, any>} flags - 选项。
 * @param {any} ctx - 上下文。
 * @returns {Promise<any>} 结果。
 */
async function commandInspect(positional, flags, ctx) {
  const sessionId = positional[0]
  if (typeof sessionId !== 'string' || sessionId === '') throw usageError('用法：zhihui-xiezuo inspect <会话ID>')
  const api = apiOf(ctx)
  const value = await api.call('session/list', { _request: {} })
  const items = Array.isArray(value?.items) ? value.items : []
  const item = items.find(entry => entry.sessionId === sessionId)
  if (item === undefined) {
    throw new BridgeError('session_not_found', `会话 ${sessionId} 不在可见会话列表中。`, {
      exitCode: EXIT.NOT_FOUND,
      details: { sessionId, visible: items.length },
    })
  }
  const session = sessionSummary(item)
  const lines = [
    `会话 ${sessionId}`,
    `  标题：${session.title ?? '-'}`,
    `  工作目录：${session.cwd ?? '-'}`,
    `  预设：${session.agentPreset ?? '-'}  权限：${session.permissions ?? '-'}`,
    `  运行中：${session.running ? '是' : '否'}  可交互：${session.agentAvailable ? '是' : '否'}`,
    `  派生自：${session.parentSessionId ?? '-'}  更新：${formatTime(session.updatedAt)}`,
    `  地址：${ctx.baseUrl}（${ctx.authority}）`,
  ]
  return { exitCode: EXIT.OK, text: lines.join('\n'), session, baseUrl: ctx.baseUrl, authority: ctx.authority }
}

/**
 * `bind`：校验并保存会话绑定。
 * @param {string[]} positional - 位置参数。
 * @param {Record<string, any>} flags - 选项。
 * @param {any} ctx - 上下文。
 * @returns {Promise<any>} 结果。
 */
async function commandBind(positional, flags, ctx) {
  const sessionId = positional[0]
  if (typeof sessionId !== 'string' || sessionId === '') {
    throw usageError('用法：zhihui-xiezuo bind <会话ID>')
  }
  const api = apiOf(ctx)
  const value = await api.call('session/list', { _request: {} })
  const items = Array.isArray(value?.items) ? value.items : []
  const target = items.find(item => item.sessionId === sessionId)
  if (target === undefined) {
    throw new BridgeError('session_not_found', `会话 ${sessionId} 不在可见会话列表中，未保存绑定。`, {
      exitCode: EXIT.NOT_FOUND,
      details: { sessionId, visible: items.length },
    })
  }
  await updateConfig(ctx.paths, { bound: { sessionId, boundAt: new Date().toISOString(), baseUrl: ctx.baseUrl } })
  const lines = [
    '绑定已保存。',
    `  会话 ID：${sessionId}`,
    `  地址：${ctx.baseUrl}`,
    `  运行中：${target.running === true ? '是' : '否'}`,
    `  工作目录：${typeof target.cwd === 'string' ? target.cwd : '-'}`,
    '  注意：绑定来自本次显式指定，不包含任何“当前网页会话”推断。',
  ]
  return { exitCode: EXIT.OK, text: lines.join('\n'), bound: { sessionId, baseUrl: ctx.baseUrl } }
}

/**
 * `send`：提交一条任务。
 * @param {string[]} positional - 位置参数。
 * @param {Record<string, any>} flags - 选项。
 * @param {any} ctx - 上下文。
 * @returns {Promise<any>} 结果。
 */
async function commandSend(positional, flags, ctx) {
  const file = flags.file
  if (typeof file !== 'string' || file === '') {
    throw usageError('用法：zhihui-xiezuo send --file <任务文件> [--work-order <工作单ID> --authorize]')
  }
  const text = await readTaskFile(file)
  if (text.trim() === '') throw usageError('任务文件内容为空。')
  const workOrderId = workOrderIdOf(flags)
  if (workOrderId !== null) return await sendWithWorkOrder(ctx, { workOrderId, flags, text })
  const explicitSession = typeof flags.session === 'string' && flags.session !== ''
  const sessionId = explicitSession ? flags.session : ctx.config.bound?.sessionId
  if (typeof sessionId !== 'string' || sessionId === '') {
    throw new BridgeError('no_bound_session', '尚未绑定会话。请先 `zhihui-xiezuo bind <会话ID>`，或用 --session 指定。', {
      exitCode: EXIT.USAGE,
    })
  }
  if (!explicitSession && ctx.config.bound?.baseUrl !== undefined && ctx.config.bound.baseUrl !== ctx.baseUrl) {
    throw new BridgeError(
      'bound_address_mismatch',
      `当前绑定属于 ${ctx.config.bound.baseUrl}，与地址 ${ctx.baseUrl} 不一致；已拒绝，请重新 bind。`,
      { exitCode: EXIT.USAGE, details: { boundBaseUrl: ctx.config.bound.baseUrl, currentBaseUrl: ctx.baseUrl } },
    )
  }
  const mode = 'queue'
  const requestId = typeof flags['request-id'] === 'string' && flags['request-id'] !== ''
    ? flags['request-id']
    : newRequestId()

  // 身份校验 + 创建/复用在同一个临界区完成，避免并发创建互相覆盖。
  const { record, created } = await ctx.store.createOrGet({
    requestId, sessionId, baseUrl: ctx.baseUrl, mode, text,
  })

  const api = apiOf(ctx)
  const request = {
    requestId,
    sessionId,
    mode,
    content: [{ type: 'text', text }],
    clientTimeZone: resolveTimeZone(),
  }
  let accepted = false
  let state = REQUEST_STATE.SUBMITTED
  /** @type {BridgeError|null} */
  let failure = null
  try {
    const value = await api.call('session/prompt', { request })
    accepted = value?.accepted === true
    if (!accepted) {
      failure = new BridgeError('not_accepted', 'DSH 没有返回 accepted:true。', { details: { value } })
      state = REQUEST_STATE.FAILED
    }
  } catch (error) {
    const bridge = asBridgeError(error)
    if (bridge.exitCode === EXIT.TIMEOUT || bridge.code === 'transport_failure') {
      state = REQUEST_STATE.SUBMISSION_UNKNOWN
      failure = bridge
    } else {
      state = REQUEST_STATE.FAILED
      failure = bridge
    }
  }
  const { record: updated, applied } = await ctx.store.applySubmission(requestId, {
    state,
    outcome: state,
    error: failure === null ? null : { code: failure.code, message: failure.message },
  })
  if (failure !== null) {
    const exitCode = state === REQUEST_STATE.SUBMISSION_UNKNOWN ? EXIT.SUBMISSION_UNKNOWN : failure.exitCode
    const lines = [
      state === REQUEST_STATE.SUBMISSION_UNKNOWN
        ? `提交结果未知：${failure.message}`
        : `提交失败：${failure.message}`,
      `  requestId：${requestId}`,
      `  会话：${sessionId}`,
      `  本地状态：${updated.state}`,
      '  说明：本地记录已保留；重发必须使用同一 requestId、同一会话、同一内容。',
    ]
    if (!applied) lines.push('  注意：已存在更强的观测状态，本次回执未覆盖它。')
    return {
      exitCode,
      text: lines.join('\n'),
      error: {
        code: failure.code,
        message: failure.message,
        details: { requestId, sessionId, state: updated.state, accepted: false },
      },
      requestId,
      sessionId,
      accepted: false,
      state: updated.state,
    }
  }
  const lines = [
    '已接受（accepted）。',
    `  requestId：${requestId}`,
    `  会话：${sessionId}`,
    `  模式：${mode}`,
    `  本地状态：${updated.state}`,
    `  下一步：zhihui-xiezuo wait ${requestId}`,
  ]
  if (!created) lines.push('  说明：复用了既有同 requestId 记录（幂等重发）。')
  if (!applied) lines.push('  注意：已存在更强的观测状态，本次回执未覆盖它。')
  return {
    exitCode: EXIT.OK,
    text: lines.join('\n'),
    requestId,
    sessionId,
    accepted,
    state: updated.state,
    reused: !created,
    record: { ...record, text: undefined },
  }
}

/**
 * 工作单投递入口（`send --work-order`）：把「投递身份」和「真正发送」串成一次动作。
 *
 * 关键不变量：
 * - 目标、内容摘要、requestId 在**同一个临界区**内固定并先落盘 `delivery.state='preparing'`，
 *   真正发 HTTP 用的是这个 requestId；崩溃留下的 `preparing` 按未知处理，只能观察，不重发。
 * - 已 `preparing`/`unknown`/`delivered` 一律不再发送第二次；并发调用同样只会有一个赢家。
 * - 成功才登记 `delivered`，传输未知登记 `unknown`，失败如实登记 `failed`。
 * - 新一轮投递必须显式 `--new-attempt`（保留旧 attempt 证据），不借重置覆盖原身份。
 * @param {any} ctx - 上下文。
 * @param {object} input - 输入。
 * @param {string} input.workOrderId - 工作单 ID。
 * @param {Record<string, any>} input.flags - 选项。
 * @param {string} input.text - 任务正文。
 * @returns {Promise<any>} 结果。
 */
async function sendWithWorkOrder(ctx, { workOrderId, flags, text }) {
  requireAuthorize(flags, '工作单投递（send --work-order）')
  const requestedSession = typeof flags.session === 'string' && flags.session !== '' ? flags.session : null
  const requestedRequestId = typeof flags['request-id'] === 'string' && flags['request-id'] !== ''
    ? flags['request-id']
    : null
  const newAttempt = flags['new-attempt'] === true
  const contentDigest = digestOf(text)
  const generatedRequestId = newRequestId()
  /** @type {any} */
  let decision = null
  await ctx.workorders.update(workOrderId, (record) => {
    assertWorkOrderWritable(workOrderId, record)
    const savedSession = record.executor?.sessionId ?? null
    const target = requestedSession ?? savedSession
    if (target === null) {
      throw usageError('send --work-order 需要工作单已有执行会话（先 create/attach），或显式 --session。')
    }
    if (savedSession !== null && requestedSession !== null && savedSession !== requestedSession) {
      throw identityMismatchError(workOrderId, savedSession, requestedSession)
    }
    if (typeof record.executor?.baseUrl === 'string' && record.executor.baseUrl !== ctx.baseUrl) {
      throw new BridgeError(
        'work_order_address_mismatch',
        `工作单 ${workOrderId} 已记录地址 ${record.executor.baseUrl}，与当前 ${ctx.baseUrl} 不一致；拒绝投递。`,
        { exitCode: EXIT.USAGE, details: { workOrderId, saved: record.executor.baseUrl, current: ctx.baseUrl } },
      )
    }
    if (typeof record.coordinator?.baseUrl === 'string' && record.coordinator.baseUrl !== ctx.baseUrl) {
      throw new BridgeError(
        'work_order_address_mismatch',
        `工作单 ${workOrderId} 已记录地址 ${record.coordinator.baseUrl}，与当前 ${ctx.baseUrl} 不一致；拒绝投递。`,
        { exitCode: EXIT.USAGE, details: { workOrderId, saved: record.coordinator.baseUrl, current: ctx.baseUrl } },
      )
    }
    const delivery = record.delivery ?? {}
    const attempts = Array.isArray(delivery.attempts) ? delivery.attempts : []
    const state = delivery.state ?? 'none'
    if (state === 'preparing' || state === 'unknown') {
      decision = { kind: 'observe', requestId: delivery.requestId ?? null, state, sessionId: target }
      return record
    }
    if (state === 'delivered' && !newAttempt) {
      decision = { kind: 'already', requestId: delivery.requestId ?? null, state, sessionId: target }
      return record
    }
    if (state === 'failed' && !newAttempt) {
      decision = { kind: 'failed_attempt', requestId: delivery.requestId ?? null, state, sessionId: target }
      return record
    }
    const attempt = attempts.length + 1
    const requestId = requestedRequestId ?? generatedRequestId
    if (attempts.some(item => item.requestId === requestId)) {
      throw usageError(`--request-id ${requestId} 已被本工作单的既有 attempt 使用；新一轮请用新的 ID。`)
    }
    const now = new Date().toISOString()
    record.delivery = {
      state: 'preparing',
      requestId,
      sessionId: target,
      at: now,
      contentDigest,
      attempt,
      attempts: [
        ...attempts,
        { attempt, requestId, sessionId: target, at: now, contentDigest, state: 'preparing', error: null },
      ],
      error: null,
    }
    const phase = record.phases.find(item => item.name === 'delivery')
    if (phase !== undefined) {
      phase.state = 'active'
      phase.requestId = requestId
      phase.sessionId = target
      phase.startedAt = phase.startedAt ?? now
      phase.evidence = [...phase.evidence, `投递 attempt ${attempt} 落盘 preparing（requestId=${requestId}）`]
    }
    decision = { kind: 'send', requestId, sessionId: target, attempt, state: 'preparing' }
    return record
  })

  if (decision.kind !== 'send') {
    const base = {
      workOrderId,
      requestId: decision.requestId,
      sessionId: decision.sessionId,
      deliveryState: decision.state,
      observeOnly: decision.kind !== 'already',
      alreadyDelivered: decision.kind === 'already',
      sent: false,
    }
    if (decision.kind === 'already') {
      return {
        exitCode: EXIT.OK,
        text: [
          `工作单 ${workOrderId} 已投递过（delivered），本次未再发送。`,
          `  requestId：${decision.requestId}`,
          `  下一步：zhihui-xiezuo wait ${decision.requestId}（不得重复投递；新一轮需显式 --new-attempt）`,
        ].join('\n'),
        ...base,
      }
    }
    if (decision.kind === 'failed_attempt') {
      throw new BridgeError(
        'delivery_failed_needs_new_attempt',
        `工作单 ${workOrderId} 上一次投递失败（requestId=${decision.requestId}）；未自动重发。核对后如需新一轮投递，请显式加 --new-attempt。`,
        { exitCode: EXIT.USAGE, details: { workOrderId, requestId: decision.requestId } },
      )
    }
    return {
      exitCode: EXIT.UNCERTAIN,
      text: [
        decision.state === 'preparing'
          ? `工作单 ${workOrderId} 的投递停留在 preparing（崩溃窗口）：按未知处理，本次未发送。`
          : `工作单 ${workOrderId} 的投递结果未知：本次未发送。`,
        `  requestId：${decision.requestId}`,
        `  只允许：zhihui-xiezuo status ${decision.requestId} / wait ${decision.requestId}`,
        '  禁止：重发、生成新 requestId 绕过未知状态。',
      ].join('\n'),
      error: {
        code: decision.state === 'preparing' ? 'delivery_preparing' : 'delivery_unknown',
        message: '投递身份已固定但结果未知，只允许按同一 requestId 观察。',
        details: { workOrderId, requestId: decision.requestId, state: decision.state },
      },
      ...base,
    }
  }

  const { requestId, sessionId, attempt } = decision
  const mode = 'queue'
  await ctx.store.createOrGet({ requestId, sessionId, baseUrl: ctx.baseUrl, mode, text })
  const api = apiOf(ctx)
  let accepted = false
  let state = REQUEST_STATE.SUBMITTED
  /** @type {BridgeError|null} */
  let failure = null
  try {
    const value = await api.call('session/prompt', {
      request: { requestId, sessionId, mode, content: [{ type: 'text', text }], clientTimeZone: resolveTimeZone() },
    })
    accepted = value?.accepted === true
    if (!accepted) {
      failure = new BridgeError('not_accepted', 'DSH 没有返回 accepted:true。', { details: { value } })
      state = REQUEST_STATE.FAILED
    }
  } catch (error) {
    const bridge = asBridgeError(error)
    if (bridge.exitCode === EXIT.TIMEOUT || bridge.code === 'transport_failure') {
      state = REQUEST_STATE.SUBMISSION_UNKNOWN
      failure = bridge
    } else {
      state = REQUEST_STATE.FAILED
      failure = bridge
    }
  }
  await ctx.store.applySubmission(requestId, {
    state,
    outcome: state,
    error: failure === null ? null : { code: failure.code, message: failure.message },
  })
  const deliveryState = failure === null
    ? 'delivered'
    : state === REQUEST_STATE.SUBMISSION_UNKNOWN ? 'unknown' : 'failed'
  const finalRecord = await ctx.workorders.update(workOrderId, (record) => {
    const now = new Date().toISOString()
    const attempts = Array.isArray(record.delivery?.attempts) ? record.delivery.attempts : []
    record.delivery = {
      ...record.delivery,
      state: deliveryState,
      requestId,
      sessionId,
      at: now,
      contentDigest,
      attempt,
      attempts: attempts.map(item => item.attempt === attempt
        ? { ...item, state: deliveryState, error: failure === null ? null : failure.code }
        : item),
      error: failure === null ? null : { code: failure.code, message: failure.message },
    }
    const phase = record.phases.find(item => item.name === 'delivery')
    if (phase !== undefined) {
      phase.state = deliveryState === 'delivered' ? 'done' : deliveryState === 'unknown' ? 'unknown' : 'failed'
      phase.requestId = requestId
      phase.sessionId = sessionId
      if (deliveryState === 'delivered') phase.endedAt = now
      phase.evidence = [
        ...phase.evidence,
        `投递 attempt ${attempt} → ${deliveryState}（requestId=${requestId}）`,
      ]
    }
    if (deliveryState === 'delivered' && [WORKORDER_STATUS.EXECUTOR_CREATED, WORKORDER_STATUS.APPROVED].includes(record.status)) {
      setStatus(record, WORKORDER_STATUS.TASK_DELIVERED)
    }
    return record
  })

  const lines = [
    failure === null
      ? '已投递并接受（accepted）；注意 accepted≠done。'
      : deliveryState === 'unknown'
        ? `投递结果未知：${failure.message}`
        : `投递失败：${failure.message}`,
    `  requestId：${requestId}`,
    `  会话：${sessionId}`,
    `  工作单：${workOrderId}  投递状态：${deliveryState}  attempt ${attempt}`,
    failure === null
      ? `  下一步：zhihui-xiezuo wait ${requestId}`
      : deliveryState === 'unknown'
        ? `  只允许：zhihui-xiezuo status ${requestId} / wait ${requestId}（禁止重发）`
        : '  说明：未自动重发；核对后如需新一轮投递请显式 --new-attempt。',
  ]
  return {
    exitCode: failure === null
      ? EXIT.OK
      : state === REQUEST_STATE.SUBMISSION_UNKNOWN ? EXIT.SUBMISSION_UNKNOWN : failure.exitCode,
    text: lines.join('\n'),
    workOrderId,
    requestId,
    sessionId,
    accepted,
    deliveryState,
    attempt,
    sent: true,
    observeOnly: deliveryState !== 'delivered',
    alreadyDelivered: false,
    workOrderStatus: finalRecord.status,
    ...failure === null ? {} : { error: { code: failure.code, message: failure.message, details: { requestId, sessionId, deliveryState } } },
  }
}

/**
 * 解析本地时区名（失败时不发送该字段）。
 * @returns {string|undefined} IANA 时区名。
 */
function resolveTimeZone() {  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
  return typeof zone === 'string' && zone !== '' ? zone : undefined
}

/**
 * `wait`：订阅并等待关联回合的最终结果。
 * @param {string[]} positional - 位置参数。
 * @param {Record<string, any>} flags - 选项。
 * @param {any} ctx - 上下文。
 * @returns {Promise<any>} 结果。
 */
async function commandWait(positional, flags, ctx) {
  const requestId = positional[0]
  if (typeof requestId !== 'string' || requestId === '') throw usageError('用法：zhihui-xiezuo wait <requestId>')
  const timeoutMs = Number(flags.timeout ?? 300_000)
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw usageError('--timeout 必须是正数毫秒。')
  const record = await ctx.store.require(requestId)
  assertRecordAddress(record, ctx.baseUrl)
  const api = apiOf(ctx)
  const address = { kind: 'session', sessionId: record.sessionId }
  const log = new EventLog()
  const budget = { pages: normalizePageBudget(flags['backfill-pages']) }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let baselineCursor = null
  let carrierLosses = 0
  let gapRepairRounds = 0
  let historyPages = 0
  let timedOut = false
  /** @type {any} */
  let latest = analyze([], requestId)

  /**
   * 当前结论：把日志连续性纳入判定。
   * @returns {any} 结论。
   */
  const verdict = () => analyze(log.events(), requestId, {
    conflicts: log.conflicts,
    gaps: log.missingSeqs(),
  })

  /**
   * 证据不足时先补页，再给结论；补页上限用尽仍不足则判不确定。
   * @param {boolean} initial - 是否首次（首帧快照之后）。
   * @returns {Promise<any>} 结论。
   */
  const settle = async (initial) => {
    // 1) 内部缺口：断线重连最容易在两次快照之间留下空洞，必须补上才能谈终态。
    if (log.missingSeqs().length > 0) {
      await repairGaps(api, address, log, budget, () => { gapRepairRounds += 1 })
    }
    let result = verdict()
    // 2) 回合起点可能落在快照窗口之外；首帧后若毫无证据也要向前找一次。
    const wantsHistory = result.needsBackfill
      || (initial && result.phase === PHASE.NOT_FOUND)
    if (wantsHistory) {
      while (budget.pages > 0) {
        const progressed = await pullPage(api, address, log, (log.minSeq ?? 0) - 1, budget)
        if (!progressed) break
        historyPages += 1
        result = verdict()
        if (!result.needsBackfill && !(initial && result.phase === PHASE.NOT_FOUND)) break
      }
      result = verdict()
    }
    // 3) 补页上限用尽仍无法确认回合起点：只能是不确定，不能冒用。
    if (result.needsBackfill && budget.pages <= 0) {
      result = {
        ...result,
        phase: PHASE.UNCERTAIN,
        needsBackfill: false,
        reply: null,
        detail: `${result.detail}；补页上限已用尽`,
      }
    }
    return result
  }

  try {
    let firstSnapshot = true
    const stream = followSessionStream({
      baseUrl: ctx.baseUrl,
      credential: ctx.credential,
      request: { address },
      signal: controller.signal,
      onCarrierLoss: () => { carrierLosses += 1 },
    })
    for await (const frame of stream) {
      if (frame.kind !== 'item') continue
      const value = frame.value
      if (value?.type === 'snapshot') {
        baselineCursor = typeof value.cursor === 'number' ? value.cursor : null
        for (const item of Array.isArray(value.records) ? value.records : []) {
          log.add(item?.event ?? item)
        }
      } else if (value?.type === 'event') {
        log.add(value.event)
      } else {
        continue
      }
      latest = await settle(firstSnapshot)
      firstSnapshot = false
      if (isFinalPhase(latest)) break
      if (controller.signal.aborted) break
    }
  } catch (error) {
    if (!controller.signal.aborted) throw error
  } finally {
    clearTimeout(timer)
  }
  if (controller.signal.aborted) timedOut = true
  if (!isFinalPhase(latest)) latest = await settle(false)

  const notes = [...latest.ambiguityReasons]
  if (log.missingSeqs().length > 0) notes.push(`仍存在未补齐的缺口 seq ${log.missingSeqs().slice(0, 20).join(', ')}`)
  if (log.hasConflicts()) notes.push(`存在 ${log.conflicts} 处同 seq 内容冲突`)

  const { record: persisted, applied } = await ctx.store.applyObservation(requestId, {
    state: stateFromPhase(latest.phase, record.state),
    cursor: { lastSeq: log.maxSeq },
    promptSeq: latest.promptSeq,
    turn: latest.turn === null ? null : { turn: latest.turn, startSeq: latest.turnStartSeq, endSeq: latest.turnEndSeq },
    reason: latest.reason,
    reply: latest.reply,
    error: latest.phase === PHASE.FAILED ? { code: 'turn_failed', message: latest.detail } : null,
    notes,
  })

  const payload = {
    requestId,
    sessionId: record.sessionId,
    phase: latest.phase,
    state: persisted.state,
    reply: latest.reply,
    candidateReply: latest.candidateReply ?? null,
    turn: latest.turn,
    promptSeq: latest.promptSeq,
    turnStartSeq: latest.turnStartSeq,
    turnEndSeq: latest.turnEndSeq,
    reason: latest.reason,
    ambiguityReasons: latest.ambiguityReasons,
    detail: latest.detail ?? null,
    baselineCursor,
    observedMaxSeq: log.maxSeq,
    eventsObserved: log.size,
    duplicatesIgnored: log.duplicates,
    conflictsDetected: log.conflicts,
    unresolvedGaps: log.missingSeqs().length,
    gapRepairRounds,
    historyPages,
    pagesRemaining: budget.pages,
    carrierLosses,
    stateWriteApplied: applied,
    timedOut,
  }
  const exitCode = exitForPhase(latest.phase, timedOut, persisted.state)
  return {
    ...payload,
    exitCode,
    text: renderWait(payload),
    ...exitCode === EXIT.OK ? {} : { error: waitError(latest, timedOut, persisted.state) },
  }
}

/**
 * 规范化补页上限。
 * @param {unknown} value - 选项值。
 * @returns {number} 页数上限。
 */
function normalizePageBudget(value) {
  if (value === undefined) return DEFAULT_BACKFILL_PAGES
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) throw usageError('--backfill-pages 必须是非负整数。')
  return Math.floor(parsed)
}

/**
 * 拉取一页历史并合入日志。
 *
 * `session/page` 的真实语义（`history.ts:392-427`）：`maxMessages` 只计
 * `user/message` 与 `assistant/message`，返回 `[cut, throughSeq]` 的**连续**区间。
 * @param {DshApi} api - 客户端。
 * @param {object} address - 会话地址。
 * @param {EventLog} log - 事件集合。
 * @param {number} throughSeq - 包含式上界。
 * @param {{pages: number}} budget - 页数预算（就地扣减）。
 * @returns {Promise<boolean>} 是否新增了事件。
 */
async function pullPage(api, address, log, throughSeq, budget) {
  if (budget.pages <= 0) return false
  if (!Number.isInteger(throughSeq) || throughSeq < 0) return false
  budget.pages -= 1
  let page
  try {
    page = await api.call('session/page', {
      request: { address, throughSeq, maxMessages: PAGE_MAX_MESSAGES },
    })
  } catch {
    return false
  }
  const before = log.size
  for (const item of Array.isArray(page?.records) ? page.records : []) {
    log.add(item?.event ?? item)
  }
  return log.size !== before
}

/**
 * 修复日志内部缺口（断线重连后两次快照之间的空洞）。
 *
 * 只向最老事件之前补页无法修复内部缺口，因此这里以缺口上界为 `throughSeq` 取页，
 * 必要时再向后扩展。任何一次补页没有进展即停止，避免无界读取。
 * @param {DshApi} api - 客户端。
 * @param {object} address - 会话地址。
 * @param {EventLog} log - 事件集合。
 * @param {{pages: number}} budget - 页数预算。
 * @param {() => void} [onRound] - 每轮回调。
 * @returns {Promise<boolean>} 缺口是否已全部补齐。
 */
async function repairGaps(api, address, log, budget, onRound) {
  for (;;) {
    const missing = log.missingSeqs()
    if (missing.length === 0) return true
    if (budget.pages <= 0) return false
    onRound?.()
    const before = log.size
    await pullPage(api, address, log, missing[missing.length - 1], budget)
    if (log.missingSeqs().length === 0) return true
    if (log.size === before) {
      const through = (log.minSeq ?? 0) - 1
      if (through < 0) return false
      const before2 = log.size
      await pullPage(api, address, log, through, budget)
      if (log.size === before2) return false
    }
  }
}

/**
 * 把分析阶段映射为记录状态。
 * @param {string} phase - 阶段。
 * @param {string} fallback - 现有状态。
 * @returns {string} 状态。
 */
function stateFromPhase(phase, fallback) {
  switch (phase) {
    case PHASE.QUEUED: return REQUEST_STATE.QUEUED
    case PHASE.RUNNING: return REQUEST_STATE.RUNNING
    case PHASE.COMPLETED: return REQUEST_STATE.COMPLETED
    case PHASE.FAILED: return REQUEST_STATE.FAILED
    case PHASE.CANCELLED: return REQUEST_STATE.CANCELLED
    default: return fallback
  }
}

/**
 * 为 `wait` 的非零结果构造结构化错误（任务结果本身仍在 payload 里）。
 * @param {any} latest - 分析结果。
 * @param {boolean} timedOut - 是否本地超时。
 * @param {string} state - 记录状态。
 * @returns {{code: string, message: string}} 错误。
 */
function waitError(latest, timedOut, state) {
  const message = latest.detail ?? '等待结束但任务没有完成。'
  if (latest.phase === PHASE.FAILED) return { code: 'task_failed', message }
  if (latest.phase === PHASE.CANCELLED) return { code: 'task_cancelled', message }
  if (latest.phase === PHASE.UNCERTAIN) return { code: 'association_uncertain', message }
  if (state === REQUEST_STATE.SUBMISSION_UNKNOWN) return { code: 'submission_unknown', message }
  if (timedOut) return { code: 'wait_timeout', message: `本地等待超时；远端未被取消。${message}` }
  return { code: 'not_observed', message }
}

/**
 * 由阶段与超时决定退出码。
 * @param {string} phase - 阶段。
 * @param {boolean} timedOut - 是否本地超时。
 * @param {string} state - 记录状态。
 * @returns {number} 退出码。
 */
function exitForPhase(phase, timedOut, state) {
  if (phase === PHASE.COMPLETED) return EXIT.OK
  if (phase === PHASE.FAILED || phase === PHASE.CANCELLED) return EXIT.ERROR
  if (phase === PHASE.UNCERTAIN) return EXIT.UNCERTAIN
  if (state === REQUEST_STATE.SUBMISSION_UNKNOWN) return EXIT.SUBMISSION_UNKNOWN
  return EXIT.TIMEOUT
}

/**
 * 渲染 `wait` 的人类可读输出。
 * @param {any} payload - 结果。
 * @returns {string} 文本。
 */
function renderWait(payload) {
  const lines = [
    `请求 ${payload.requestId}（会话 ${payload.sessionId}）`,
    `  阶段：${payload.phase}   本地状态：${payload.state}`,
    `  关联：promptSeq=${payload.promptSeq ?? '-'} turn=${payload.turn ?? '-'} turnEnd=${payload.turnEndSeq ?? '-'}`,
    `  事件：已观测 ${payload.eventsObserved} 条，最大 seq=${payload.observedMaxSeq ?? '-'}，重连 ${payload.carrierLosses} 次`,
    `  连续性：缺口修复 ${payload.gapRepairRounds} 轮，历史补页 ${payload.historyPages} 页，剩余 ${payload.pagesRemaining} 页，未补齐缺口 ${payload.unresolvedGaps} 个，内容冲突 ${payload.conflictsDetected} 处`,
  ]
  if (payload.detail !== null) lines.push(`  说明：${payload.detail}`)
  if (payload.ambiguityReasons.length > 0) lines.push(`  不确定：${payload.ambiguityReasons.join('；')}`)
  if (payload.reply !== null && payload.reply !== undefined) {
    lines.push('  最终回复：')
    lines.push(payload.reply.text.split('\n').map(line => `    ${line}`).join('\n'))
  } else if (payload.candidateReply !== null && payload.candidateReply !== undefined) {
    lines.push('  候选回复（未归属，仅参考）：')
    lines.push(payload.candidateReply.text.split('\n').map(line => `    ${line}`).join('\n'))
  }
  if (payload.timedOut) lines.push('  注意：本地等待超时，DSH 未被打断，可稍后重跑 wait。')
  return lines.join('\n')
}

/**
 * `status`：查询本地记录并做只读核对。
 * @param {string[]} positional - 位置参数。
 * @param {Record<string, any>} flags - 选项。
 * @param {any} ctx - 上下文。
 * @returns {Promise<any>} 结果。
 */
async function commandStatus(positional, flags, ctx) {
  const requestId = positional[0]
  if (typeof requestId !== 'string' || requestId === '') throw usageError('用法：zhihui-xiezuo status <requestId>')
  const record = await ctx.store.require(requestId)
  assertRecordAddress(record, ctx.baseUrl)
  /** @type {any} */
  let crossCheck = null
  if (ctx.credential !== null && !credentialExpired(ctx.credential)) {
    try {
      const api = apiOf(ctx)
      const value = await api.call('session/list', { _request: {} })
      const item = (Array.isArray(value?.items) ? value.items : []).find(entry => entry.sessionId === record.sessionId)
      crossCheck = item === undefined
        ? { sessionVisible: false }
        : { sessionVisible: true, running: item.running === true, agentAvailable: item.agentAvailable === true, updatedAt: item.updatedAt ?? null }
    } catch (error) {
      crossCheck = { error: asBridgeError(error).code }
    }
  } else {
    crossCheck = { skipped: 'no_credential' }
  }
  let verify = null
  if (flags.verify === true) {
    verify = await verifyAgainstLog(ctx, record, normalizePageBudget(flags['backfill-pages']))
  }
  const lines = [
    `请求 ${requestId}`,
    `  会话：${record.sessionId}   模式：${record.mode}   状态：${record.state}`,
    `  地址：${record.baseUrl}`,
    `  创建：${record.createdAt}   提交：${record.submittedAt ?? '-'}`,
    `  关联：promptSeq=${record.promptSeq ?? '-'} turn=${record.turn?.turn ?? '-'} turnEnd=${record.turn?.endSeq ?? '-'}`,
    `  只读核对：${JSON.stringify(crossCheck)}`,
  ]
  if (verify !== null) lines.push(`  日志核对：${verify.phase}（${verify.detail ?? '-'}）`)
  if (record.reply?.text !== undefined) {
    lines.push('  已记录回复：')
    lines.push(String(record.reply.text).split('\n').map(line => `    ${line}`).join('\n'))
  }
  if (Array.isArray(record.notes) && record.notes.length > 0) {
    lines.push(`  备注：${record.notes.map(note => note.note).join('；')}`)
  }
  return {
    exitCode: EXIT.OK,
    text: lines.join('\n'),
    request: { ...record, text: undefined },
    crossCheck,
    verify,
  }
}

/**
 * 用只读日志核对一条请求的关联结论（`status --verify`）。
 *
 * 快照之后若证据不足（`needsBackfill` 或完全找不到目标），按预算补页再判定；
 * 存在未补齐的缺口或内容冲突时返回不确定，不冒用回复。
 * @param {any} ctx - 上下文。
 * @param {any} record - 请求记录。
 * @param {number} maxPages - 补页页数上限。
 * @returns {Promise<any>} 核对结果。
 */
async function verifyAgainstLog(ctx, record, maxPages) {
  const api = apiOf(ctx)
  const address = { kind: 'session', sessionId: record.sessionId }
  const log = new EventLog()
  const budget = { pages: maxPages }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20_000)
  const verdict = () => analyze(log.events(), record.requestId, {
    conflicts: log.conflicts,
    gaps: log.missingSeqs(),
  })
  try {
    const stream = followSessionStream({
      baseUrl: ctx.baseUrl,
      credential: ctx.credential,
      request: { address },
      signal: controller.signal,
    })
    for await (const frame of stream) {
      if (frame.kind !== 'item') continue
      const value = frame.value
      if (value?.type === 'snapshot') {
        for (const item of Array.isArray(value.records) ? value.records : []) log.add(item?.event ?? item)
        // `status` 只做一次基线读取，不做长时间等待。
        break
      }
      if (value?.type === 'event') log.add(value.event)
    }
  } catch {
    // 只读核对失败不改变本地记录。
  } finally {
    clearTimeout(timer)
  }
  await repairGaps(api, address, log, budget)
  let result = verdict()
  const wantsHistory = result.needsBackfill || result.phase === PHASE.NOT_FOUND
  if (wantsHistory) {
    while (budget.pages > 0) {
      const progressed = await pullPage(api, address, log, (log.minSeq ?? 0) - 1, budget)
      if (!progressed) break
      result = verdict()
      if (!result.needsBackfill && result.phase !== PHASE.NOT_FOUND) break
    }
    result = verdict()
  }
  if (result.needsBackfill && budget.pages <= 0) {
    result = {
      ...result,
      phase: PHASE.UNCERTAIN,
      needsBackfill: false,
      reply: null,
      detail: `${result.detail}；补页上限已用尽`,
    }
  }
  return result
}

/**
 * 断言调用方声明了明确授权。
 * @param {Record<string, any>} flags - 选项。
 * @param {string} what - 操作名。
 * @returns {void} 已授权时正常返回。
 */
function requireAuthorize(flags, what) {
  if (flags.authorize !== true) {
    throw new BridgeError(
      'authorization_required',
      `${what}需要明确授权：请加 --authorize（仅当用户明确要求该操作时使用；普通 send/查询永不创建或改名）。`,
      { exitCode: EXIT.USAGE },
    )
  }
}

/**
 * 校验创建用的 cwd：必须是已存在的绝对目录；本工具绝不代替用户 mkdir。
 * @param {Record<string, any>} flags - 选项。
 * @returns {Promise<string>} 绝对目录。
 */
async function resolveCreateCwd(flags) {
  const cwd = typeof flags.cwd === 'string' ? flags.cwd : ''
  if (cwd === '' || !isAbsolute(cwd)) {
    throw new BridgeError(
      'cwd_invalid',
      'create 需要 --cwd <已存在的绝对目录>；相对路径会被拒绝，以免在 DSH 进程目录下误建。',
      { exitCode: EXIT.USAGE, details: { cwd } },
    )
  }
  let info
  try {
    info = await stat(cwd)
  } catch {
    throw new BridgeError('cwd_not_found', `--cwd 指向的目录不存在：${cwd}；本工具不会代替用户创建目录。`, {
      exitCode: EXIT.USAGE,
      details: { cwd },
    })
  }
  if (!info.isDirectory()) {
    throw new BridgeError('cwd_invalid', `--cwd 不是目录：${cwd}`, { exitCode: EXIT.USAGE, details: { cwd } })
  }
  return resolve(cwd)
}

/**
 * 把可能重复的选项值规范为数组。
 * @param {unknown} value - 选项值。
 * @returns {string[]} 数组。
 */
function asArray(value) {
  if (value === undefined || value === null) return []
  return (Array.isArray(value) ? value : [value]).map(String).filter(item => item !== '')
}

/**
 * 取工作单 ID 选项。
 * @param {Record<string, any>} flags - 选项。
 * @returns {string|null} 工作单 ID 或 null。
 */
function workOrderIdOf(flags) {
  const value = flags['work-order']
  if (typeof value !== 'string' || value === '') return null
  return assertWorkOrderId(value)
}

/**
 * 载入工作单并校验授权与阻塞状态（写操作前的统一门槛）。
 * @param {any} ctx - 上下文。
 * @param {string|null} workOrderId - 工作单 ID。
 * @returns {Promise<any|null>} 工作单或 null。
 */
async function loadAuthorizedWorkOrder(ctx, workOrderId) {
  if (workOrderId === null) return null
  const record = await ctx.workorders.require(workOrderId)
  assertWorkOrderWritable(workOrderId, record)
  return record
}

/**
 * 实施类写操作的统一门槛：终态与待用户状态一律停发。
 * `accepted` 是写终态，任何改动都被拒绝（审计记录不可事后改写）。
 * @param {string} workOrderId - 工作单 ID。
 * @param {any} record - 工作单。
 * @returns {void} 通过时正常返回。
 */
function assertWorkOrderWritable(workOrderId, record) {
  if (record.status === WORKORDER_STATUS.ACCEPTED) {
    throw new BridgeError(
      'work_order_accepted',
      `工作单 ${workOrderId} 已验收（accepted 为终态），拒绝任何改动；如需新一轮工作请新建工作单。`,
      { exitCode: EXIT.USAGE, details: { workOrderId, status: record.status } },
    )
  }
  if (record.authorization?.granted !== true) {
    throw new BridgeError('work_order_unauthorized', `工作单 ${workOrderId} 未记录用户授权，已拒绝该操作。`, {
      exitCode: EXIT.USAGE,
      details: { workOrderId },
    })
  }
  if (record.status === WORKORDER_STATUS.NEEDS_USER || record.status === WORKORDER_STATUS.BLOCKED) {
    throw new BridgeError('work_order_blocked', `工作单 ${workOrderId} 处于 ${record.status}，需用户决定后才能继续。`, {
      exitCode: EXIT.USAGE,
      details: { workOrderId, status: record.status },
    })
  }
}

/**
 * 会话身份漂移的统一拒绝（RPC 之前）。
 * @param {string} workOrderId - 工作单 ID。
 * @param {string} saved - 工作单已保存的身份。
 * @param {string} requested - 本次请求的身份。
 * @returns {BridgeError} 错误。
 */
function identityMismatchError(workOrderId, saved, requested) {
  return new BridgeError(
    'session_identity_mismatch',
    `工作单 ${workOrderId} 已绑定执行会话 ${saved}，拒绝用 ${requested} 替换（稳定身份不可漂移）。`,
    { exitCode: EXIT.USAGE, details: { workOrderId, saved, requested } },
  )
}

/**
 * `create`：以预存 sessionId 创建执行会话（幂等收养）。
 * @param {string[]} positional - 位置参数。
 * @param {Record<string, any>} flags - 选项。
 * @param {any} ctx - 上下文。
 * @returns {Promise<any>} 结果。
 */
async function commandCreate(positional, flags, ctx) {
  requireAuthorize(flags, '创建会话')
  const cwd = await resolveCreateCwd(flags)
  const workOrderId = workOrderIdOf(flags)
  const requestedSessionId = typeof flags['session-id'] === 'string' && flags['session-id'] !== ''
    ? flags['session-id']
    : null
  if (requestedSessionId !== null && !/^session-[A-Za-z0-9._-]+$/u.test(requestedSessionId)) {
    throw usageError('--session-id 必须是 session-<标识> 形式。')
  }
  const api = apiOf(ctx)
  const generatedSessionId = requestedSessionId ?? `session-${randomUUID()}`
  let sessionId = generatedSessionId
  // 只有工作单能证明“此前已创建”：没有工作单时无法区分新建与收养，如实返回 null。
  let reused = workOrderId === null ? null : false
  if (workOrderId !== null) {
    // 身份选定与落盘在同一个临界区：并发 create 会看到对方写入的身份，从而收敛到同一个 ID。
    const prepared = await ctx.workorders.update(workOrderId, (record) => {
      assertWorkOrderWritable(workOrderId, record)
      const savedSession = record.executor?.sessionId ?? null
      const chosen = requestedSessionId ?? savedSession ?? generatedSessionId
      if (savedSession !== null && chosen !== savedSession) {
        throw new BridgeError(
          'session_identity_mismatch',
          `工作单 ${workOrderId} 已绑定执行会话 ${savedSession}，拒绝用 ${chosen} 替换（稳定身份不可漂移）。`,
          { exitCode: EXIT.USAGE, details: { workOrderId, saved: savedSession, requested: chosen } },
        )
      }
      if (typeof record.executor?.cwd === 'string' && record.executor.cwd !== cwd) {
        throw new BridgeError(
          'work_order_cwd_mismatch',
          `工作单 ${workOrderId} 已记录 cwd=${record.executor.cwd}，与本次 --cwd=${cwd} 不一致；拒绝在 RPC 前改参数重试。`,
          { exitCode: EXIT.USAGE, details: { workOrderId, saved: record.executor.cwd, requested: cwd } },
        )
      }
      const savedBaseUrl = typeof record.executor?.baseUrl === 'string'
        ? record.executor.baseUrl
        : (typeof record.coordinator?.baseUrl === 'string' ? record.coordinator.baseUrl : null)
      if (typeof savedBaseUrl === 'string' && savedBaseUrl !== ctx.baseUrl) {
        throw new BridgeError(
          'work_order_address_mismatch',
          `工作单 ${workOrderId} 已记录地址 ${savedBaseUrl}，与当前 ${ctx.baseUrl} 不一致；拒绝继续。`,
          { exitCode: EXIT.USAGE, details: { workOrderId, saved: savedBaseUrl, current: ctx.baseUrl } },
        )
      }
      reused = savedSession !== null
      const now = new Date().toISOString()
      record.executor.sessionId = chosen
      record.executor.cwd = cwd
      record.executor.baseUrl = ctx.baseUrl
      if (typeof flags.title === 'string' && flags.title !== '') record.executor.title = flags.title
      record.executor.creation.state = 'preparing'
      record.executor.creation.at = now
      record.executor.creation.requestedCwd = cwd
      record.executor.creation.error = null
      record.executor.creation.attempts = [
        ...(record.executor.creation.attempts ?? []),
        { at: now, outcome: 'preparing', error: null },
      ]
      return record
    })
    sessionId = prepared.executor.sessionId
  }

  let value
  try {
    value = await api.call('session/create', { request: { sessionId, cwd } })
  } catch (error) {
    const bridge = asBridgeError(error)
    const unknown = bridge.exitCode === EXIT.TIMEOUT || bridge.code === 'transport_failure'
    const conflict = bridge.code === 'session/conflict' || bridge.code === 'agent-preset/conflict'
    const outcome = unknown ? 'unknown' : conflict ? 'conflict' : 'failed'
    if (workOrderId !== null) {
      await ctx.workorders.update(workOrderId, (record) => {
        const now = new Date().toISOString()
        record.executor.creation.state = outcome
        record.executor.creation.at = now
        record.executor.creation.error = { code: bridge.code, message: bridge.message }
        record.executor.creation.attempts = [
          ...(record.executor.creation.attempts ?? []),
          { at: now, outcome, error: bridge.code },
        ]
        const phase = record.phases.find(item => item.name === 'executor_create')
        if (phase !== undefined) {
          phase.state = unknown ? 'unknown' : 'failed'
          phase.evidence = [...phase.evidence, `create ${outcome}: ${bridge.code}`]
        }
        if (conflict && record.status !== WORKORDER_STATUS.BLOCKED) setStatus(record, WORKORDER_STATUS.BLOCKED)
        return record
      }).catch(() => {})
    }
    const lines = [
      unknown ? `创建结果未知：${bridge.message}` : `创建失败：${bridge.message}`,
      `  sessionId：${sessionId}（稳定身份，已记录）`,
      `  cwd：${cwd}`,
      unknown
        ? '  说明：只能用同一 sessionId 重试/收养；禁止生成新 ID。'
        : '  说明：已停机，不会改 cwd/preset 静默重试。',
    ]
    return {
      exitCode: unknown ? EXIT.SUBMISSION_UNKNOWN : bridge.exitCode,
      text: lines.join('\n'),
      error: { code: bridge.code, message: bridge.message, details: { sessionId, cwd, outcome } },
      sessionId,
      cwd,
      workOrderId,
      recorded: workOrderId === null ? null : outcome,
      reused,
    }
  }

  if (value?.sessionId !== sessionId) {
    throw new BridgeError('create_identity_mismatch', `DSH 返回的 sessionId ${String(value?.sessionId)} 与请求 ${sessionId} 不一致，已拒绝收养。`, {
      exitCode: EXIT.ERROR,
      details: { requested: sessionId, returned: value?.sessionId ?? null },
    })
  }
  const agentPreset = typeof value?.agentPreset === 'string' ? value.agentPreset : null
  if (workOrderId !== null) {
    await ctx.workorders.update(workOrderId, (record) => {
      const now = new Date().toISOString()
      record.executor.sessionId = sessionId
      record.executor.cwd = cwd
      record.executor.agentPreset = agentPreset
      record.executor.baseUrl = ctx.baseUrl
      record.executor.creation.state = 'created'
      record.executor.creation.at = now
      record.executor.creation.error = null
      record.executor.creation.attempts = [
        ...(record.executor.creation.attempts ?? []),
        { at: now, outcome: 'created', error: null },
      ]
      const phase = record.phases.find(item => item.name === 'executor_create')
      if (phase !== undefined) {
        phase.state = 'done'
        phase.sessionId = sessionId
        phase.endedAt = now
        phase.evidence = [...phase.evidence, `session/create 成功：${sessionId}（preset=${agentPreset ?? '-'}）`]
      }
      const creatable = [WORKORDER_STATUS.DRAFT, WORKORDER_STATUS.NEGOTIATING, WORKORDER_STATUS.NEGOTIATED, WORKORDER_STATUS.APPROVED]
      if (creatable.includes(record.status)) setStatus(record, WORKORDER_STATUS.EXECUTOR_CREATED)
      return record
    })
  }
  const lines = [
    reused === true ? '执行会话已确认（同 ID 收养，未重复创建）。' : '执行会话已创建（或已收养，见 sessionId）。',
    `  sessionId：${sessionId}`,
    `  cwd：${cwd}`,
    `  预设：${agentPreset ?? '（默认）'}`,
    `  工作单：${workOrderId ?? '-'}`,
    typeof flags.title === 'string' && flags.title !== ''
      ? `  预期标题：${flags.title}（rename 是独立显式步骤，本命令不改名）`
      : '',
    '  说明：创建本身不等于任务完成；下一步是投递任务并等待报告。',
  ].filter(line => line !== '')
  return {
    exitCode: EXIT.OK,
    text: lines.join('\n'),
    sessionId,
    cwd,
    agentPreset,
    workOrderId,
    recorded: workOrderId === null ? null : 'created',
    reused,
  }
}

/**
 * `rename`：重命名会话（会激活该会话），并只读回读规范化/截断后的标题。
 * @param {string[]} positional - 位置参数。
 * @param {Record<string, any>} flags - 选项。
 * @param {any} ctx - 上下文。
 * @returns {Promise<any>} 结果。
 */
async function commandRename(positional, flags, ctx) {
  requireAuthorize(flags, '重命名会话')
  const sessionId = positional[0]
  if (typeof sessionId !== 'string' || sessionId === '') throw usageError('用法：zhihui-xiezuo rename <会话ID> --title <标题> --authorize')
  const title = typeof flags.title === 'string' ? flags.title.trim() : ''
  if (title === '') throw new BridgeError('title_invalid', 'rename 需要非空 --title。', { exitCode: EXIT.USAGE })
  const workOrderId = workOrderIdOf(flags)
  await loadAuthorizedWorkOrder(ctx, workOrderId)
  const api = apiOf(ctx)
  if (workOrderId !== null) {
    await ctx.workorders.update(workOrderId, (record) => {
      assertWorkOrderWritable(workOrderId, record)
      const saved = record.executor?.sessionId ?? null
      if (saved !== null && saved !== sessionId) throw identityMismatchError(workOrderId, saved, sessionId)
      const savedBaseUrl = typeof record.executor?.baseUrl === 'string'
        ? record.executor.baseUrl
        : (typeof record.coordinator?.baseUrl === 'string' ? record.coordinator.baseUrl : null)
      if (savedBaseUrl !== null && savedBaseUrl !== ctx.baseUrl) {
        throw new BridgeError(
          'work_order_address_mismatch',
          `工作单 ${workOrderId} 已记录地址 ${savedBaseUrl}，与当前 ${ctx.baseUrl} 不一致；拒绝改名。`,
          { exitCode: EXIT.USAGE, details: { workOrderId, saved: savedBaseUrl, current: ctx.baseUrl } },
        )
      }
      const now = new Date().toISOString()
      record.executor.sessionId = sessionId
      record.executor.rename = { ...record.executor.rename, state: 'preparing', title, at: now, error: null }
      return record
    })
  }
  let value
  try {
    value = await api.call('session/rename', { request: { sessionId, title } })
  } catch (error) {
    const bridge = asBridgeError(error)
    const unknown = bridge.exitCode === EXIT.TIMEOUT || bridge.code === 'transport_failure'
    if (workOrderId !== null) {
      await ctx.workorders.update(workOrderId, (record) => {
        const now = new Date().toISOString()
        record.executor.rename = {
          ...record.executor.rename,
          state: unknown ? 'unknown' : 'failed',
          at: now,
          error: { code: bridge.code, message: bridge.message },
        }
        const phase = record.phases.find(item => item.name === 'rename')
        if (phase !== undefined) {
          phase.state = unknown ? 'unknown' : 'failed'
          phase.evidence = [...phase.evidence, `rename ${unknown ? 'unknown' : 'failed'}: ${bridge.code}`]
        }
        return record
      }).catch(() => {})
    }
    return {
      exitCode: unknown ? EXIT.SUBMISSION_UNKNOWN : bridge.exitCode,
      text: [
        unknown ? `改名结果未知：${bridge.message}` : `改名失败：${bridge.message}`,
        `  sessionId：${sessionId}`,
        unknown ? '  说明：先只读 inspect 核对当前标题，再决定是否对同一会话重试；不新建会话。' : '  说明：已停机，不自动改投或新建会话。',
      ].join('\n'),
      error: { code: bridge.code, message: bridge.message, details: { sessionId } },
      sessionId,
      workOrderId,
    }
  }
  // 只读回读：标题会被 DSH 规范化并按 80 UTF-8 字节静默截断。
  let titleReadBack = null
  try {
    const listed = await api.call('session/list', { _request: {} })
    const item = (Array.isArray(listed?.items) ? listed.items : []).find(entry => entry.sessionId === sessionId)
    const readBack = item?.projections?.values?.title
    titleReadBack = typeof readBack === 'string' ? readBack : null
  } catch {
    titleReadBack = null
  }
  const truncated = titleReadBack !== null && titleReadBack !== title
  const seq = typeof value?.seq === 'number' ? value.seq : null
  if (workOrderId !== null) {
    await ctx.workorders.update(workOrderId, (record) => {
      const now = new Date().toISOString()
      record.executor.sessionId = sessionId
      record.executor.title = title
      record.executor.titleReadBack = titleReadBack
      record.executor.rename = {
        state: 'renamed', at: now, title, seq, readBack: titleReadBack, truncated, error: null,
      }
      const phase = record.phases.find(item => item.name === 'rename')
      if (phase !== undefined) {
        phase.state = 'done'
        phase.sessionId = sessionId
        phase.endedAt = now
        phase.evidence = [...phase.evidence, `rename 成功：回读「${titleReadBack ?? '-'}」${truncated ? '（发生截断）' : ''}`]
      }
      return record
    })
  }
  const lines = [
    '会话已重命名（注意：rename 会激活该会话）。',
    `  sessionId：${sessionId}`,
    `  请求标题：${title}`,
    `  回读标题：${titleReadBack ?? '（未能回读）'}`,
    truncated ? '  注意：标题被 DSH 截断/规范化，权威身份仍是 sessionId，标题只作显示与寻址线索。' : '',
    `  seq：${seq ?? '-'}`,
  ].filter(line => line !== '')
  return {
    exitCode: EXIT.OK,
    text: lines.join('\n'),
    sessionId,
    titleRequested: title,
    title: typeof value?.title === 'string' ? value.title : null,
    titleReadBack,
    truncated,
    seq,
    activated: true,
    workOrderId,
  }
}

/**
 * `workorder`：协作工作单子命令族。
 * @param {string[]} positional - 位置参数（`<子命令> [工作单ID]`）。
 * @param {Record<string, any>} flags - 选项。
 * @param {any} ctx - 上下文。
 * @returns {Promise<any>} 结果。
 */
async function commandWorkOrder(positional, flags, ctx) {
  const sub = positional[0] ?? ''
  const workOrderId = positional[1] ?? null
  const store = ctx.workorders
  switch (sub) {
    case 'init': {
      const maxRoundsRaw = flags['max-rounds']
      const maxRounds = maxRoundsRaw === undefined ? 2 : Number(maxRoundsRaw)
      if (!Number.isInteger(maxRounds)) throw usageError('--max-rounds 必须是整数。')
      const record = await store.create({
        goal: typeof flags.goal === 'string' ? flags.goal : '',
        scope: asArray(flags.scope),
        coordinatorSessionId: typeof flags.coordinator === 'string' ? flags.coordinator : null,
        coordinatorTitle: typeof flags['coordinator-title'] === 'string' ? flags['coordinator-title'] : null,
        baseUrl: ctx.baseUrl,
        authorize: flags.authorize === true,
        reason: typeof flags.reason === 'string' ? flags.reason : '',
        maxRounds,
      })
      return {
        exitCode: EXIT.OK,
        text: [
          `工作单已创建：${record.workOrderId}`,
          `  状态：${record.status}`,
          `  授权：${record.authorization.granted ? '已记录用户授权' : '未授权（只读/协商准备）'}`,
          `  协商上限：${record.negotiation.maxRounds} 轮`,
        ].join('\n'),
        workOrder: record,
      }
    }
    case 'list': {
      const records = await store.list()
      const rows = records.map(record => ({
        workOrderId: record.workOrderId,
        goal: String(record.goal ?? '').slice(0, 60),
        status: record.status,
        executorSessionId: record.executor?.sessionId ?? null,
        updatedAt: record.updatedAt,
      }))
      const lines = [`共 ${rows.length} 个工作单：`]
      for (const row of rows) lines.push(`  ${row.workOrderId}  [${row.status}]  ${row.goal}  执行会话：${row.executorSessionId ?? '-'}`)
      if (rows.length === 0) lines.push('  （无）')
      return { exitCode: EXIT.OK, text: lines.join('\n'), workOrders: rows }
    }
    case 'show': {
      if (workOrderId === null) throw usageError('用法：zhihui-xiezuo workorder show <工作单ID>')
      const record = await store.require(workOrderId)
      return {
        exitCode: EXIT.OK,
        text: [
          `工作单 ${record.workOrderId}`,
          `  目标：${record.goal}`,
          `  状态：${record.status}   授权：${record.authorization?.granted ? '是' : '否'}`,
          `  执行会话：${record.executor?.sessionId ?? '-'}（${record.executor?.titleReadBack ?? record.executor?.title ?? '-'}）`,
          `  创建：${record.executor?.creation?.state ?? '-'}  改名：${record.executor?.rename?.state ?? '-'}  投递：${record.delivery?.state ?? '-'}`,
          `  复查：${record.review?.verdict ?? 'none'}`,
          `  协商轮数：${record.negotiation?.rounds?.length ?? 0}/${record.negotiation?.maxRounds ?? '-'}`,
        ].join('\n'),
        workOrder: record,
      }
    }
    case 'attach': {
      if (workOrderId === null) throw usageError('用法：zhihui-xiezuo workorder attach <工作单ID> --session <会话ID> [--creation-state created --evidence ...]')
      const sessionId = typeof flags.session === 'string' && flags.session !== '' ? flags.session : null
      if (sessionId === null) throw usageError('attach 需要 --session <已存在的执行会话ID>。')
      const creationState = typeof flags['creation-state'] === 'string' ? flags['creation-state'] : null
      const evidence = asArray(flags.evidence)
      if (creationState !== null && evidence.length === 0) {
        throw new BridgeError('evidence_required', '记录执行会话身份需要 --evidence（说明依据，例如已核对的创建回执/状态文件）。', { exitCode: EXIT.USAGE })
      }
      const updated = await store.update(workOrderId, (record) => {
        assertWorkOrderWritable(workOrderId, record)
        const saved = record.executor?.sessionId ?? null
        if (saved !== null && saved !== sessionId) throw identityMismatchError(workOrderId, saved, sessionId)
        record.executor.sessionId = sessionId
        if (typeof flags.title === 'string') record.executor.title = flags.title
        if (typeof flags.cwd === 'string') record.executor.cwd = flags.cwd
        if (typeof flags.preset === 'string') record.executor.agentPreset = flags.preset
        if (typeof flags.permissions === 'string') record.executor.permissions = flags.permissions
        record.executor.baseUrl = typeof flags['base-url'] === 'string' ? flags['base-url'] : record.executor.baseUrl ?? ctx.baseUrl
        if (creationState !== null) {
          if (!['created', 'unknown', 'conflict', 'failed', 'none'].includes(creationState)) {
            throw usageError('--creation-state 只能是 created|unknown|conflict|failed|none。')
          }
          const now = new Date().toISOString()
          record.executor.creation.state = creationState
          record.executor.creation.at = now
          record.executor.creation.attempts = [
            ...(record.executor.creation.attempts ?? []),
            { at: now, outcome: creationState, error: null },
          ]
          const phase = record.phases.find(item => item.name === 'executor_create')
          if (phase !== undefined) {
            phase.state = creationState === 'created' ? 'done' : creationState === 'unknown' ? 'unknown' : 'failed'
            phase.sessionId = sessionId
            phase.endedAt = now
            phase.evidence = [...phase.evidence, ...evidence]
          }
          if (creationState === 'created') {
            const creatable = [WORKORDER_STATUS.DRAFT, WORKORDER_STATUS.NEGOTIATING, WORKORDER_STATUS.NEGOTIATED, WORKORDER_STATUS.APPROVED]
            if (creatable.includes(record.status)) setStatus(record, WORKORDER_STATUS.EXECUTOR_CREATED)
          }
        }
        return record
      })
      return {
        exitCode: EXIT.OK,
        text: [
          `已记录执行会话：${sessionId}`,
          `  工作单状态：${updated.status}  创建状态：${updated.executor.creation.state}`,
          '  说明：attach 只做本地记录，不创建、不改名、不发消息。',
        ].join('\n'),
        workOrder: updated,
      }
    }
    case 'negotiate': {
      if (workOrderId === null) throw usageError('用法：zhihui-xiezuo workorder negotiate <工作单ID> --round N --request-id <R>')
      const round = Number(flags.round)
      if (!Number.isInteger(round) || round < 1) throw usageError('--round 必须是 ≥1 的整数。')
      const requestId = typeof flags['request-id'] === 'string' && flags['request-id'] !== '' ? flags['request-id'] : null
      if (requestId === null) throw usageError('negotiate 需要 --request-id（该轮协商消息的 requestId）。')
      const userDecision = typeof flags['user-decision'] === 'string' && flags['user-decision'] !== '' ? flags['user-decision'] : null
      const updated = await store.update(workOrderId, (record) => {
        const maxRounds = record.negotiation?.maxRounds ?? 2
        if (round > maxRounds && userDecision === null) {
          throw new BridgeError(
            'negotiation_limit',
            `工作单 ${workOrderId} 的协商上限是 ${maxRounds} 轮，第 ${round} 轮需要用户决定（--user-decision <人类决定>）。`,
            { exitCode: EXIT.USAGE, details: { round, maxRounds } },
          )
        }
        const now = new Date().toISOString()
        record.negotiation.rounds = [
          ...(record.negotiation.rounds ?? []),
          {
            round,
            requestId,
            proposalPath: typeof flags.proposal === 'string' ? flags.proposal : null,
            decisionPath: typeof flags.decision === 'string' ? flags.decision : null,
            at: now,
            userDecision,
          },
        ]
        record.negotiation.state = 'converged'
        const phase = record.phases.find(item => item.name === 'negotiation')
        if (phase !== undefined) {
          phase.state = 'done'
          phase.requestId = requestId
          phase.endedAt = now
          phase.evidence = [...phase.evidence, `第 ${round} 轮协商 requestId=${requestId}`]
        }
        if (userDecision !== null) {
          record.notes = [...(record.notes ?? []), { at: now, note: `第 ${round} 轮超出上限，依据用户决定继续：${userDecision}` }]
        }
        if ([WORKORDER_STATUS.DRAFT, WORKORDER_STATUS.NEGOTIATING].includes(record.status)) {
          setStatus(record, WORKORDER_STATUS.NEGOTIATED)
        }
        return record
      })
      return {
        exitCode: EXIT.OK,
        text: `协商第 ${round} 轮已记录（requestId=${requestId}）；工作单状态：${updated.status}`,
        workOrder: updated,
      }
    }
    case 'approve': {
      if (workOrderId === null) throw usageError('用法：zhihui-xiezuo workorder approve <工作单ID> --evidence <定案依据>')
      const evidence = asArray(flags.evidence)
      if (evidence.length === 0) throw new BridgeError('evidence_required', 'approve 需要 --evidence（定案文件/结论）。', { exitCode: EXIT.USAGE })
      const updated = await store.update(workOrderId, (record) => {
        const now = new Date().toISOString()
        const phase = record.phases.find(item => item.name === 'approval')
        if (phase !== undefined) {
          phase.state = 'done'
          phase.endedAt = now
          phase.evidence = [...phase.evidence, ...evidence]
        }
        setStatus(record, WORKORDER_STATUS.APPROVED)
        return record
      })
      return { exitCode: EXIT.OK, text: `工作单已定案：${updated.status}`, workOrder: updated }
    }
    case 'deliver': {
      if (workOrderId === null) throw usageError('用法：zhihui-xiezuo workorder deliver <工作单ID> --request-id <R> [--state delivered|unknown|failed]')
      const requestId = typeof flags['request-id'] === 'string' && flags['request-id'] !== '' ? flags['request-id'] : null
      if (requestId === null) throw usageError('deliver 需要 --request-id。')
      const deliveryState = typeof flags.state === 'string' && flags.state !== '' ? flags.state : 'delivered'
      if (!['delivered', 'unknown', 'failed', 'preparing'].includes(deliveryState)) {
        throw usageError('deliver 的 --state 只能是 delivered|unknown|failed|preparing。')
      }
      const sessionId = typeof flags.session === 'string' && flags.session !== '' ? flags.session : null
      const updated = await store.update(workOrderId, (record) => {
        assertWorkOrderWritable(workOrderId, record)
        const saved = record.executor?.sessionId ?? null
        if (saved !== null && sessionId !== null && saved !== sessionId) {
          throw identityMismatchError(workOrderId, saved, sessionId)
        }
        const target = sessionId ?? saved
        const now = new Date().toISOString()
        const attempts = Array.isArray(record.delivery?.attempts) ? record.delivery.attempts : []
        const attempt = deliveryState === 'preparing' ? attempts.length + 1 : (record.delivery?.attempt ?? attempts.length)
        record.delivery = {
          state: deliveryState,
          requestId,
          sessionId: target,
          at: now,
          contentDigest: record.delivery?.contentDigest ?? null,
          attempt,
          attempts: deliveryState === 'preparing'
            ? [...attempts, { attempt, requestId, sessionId: target, at: now, contentDigest: null, state: 'preparing', error: null }]
            : attempts.map(item => item.attempt === attempt ? { ...item, state: deliveryState } : item),
          error: deliveryState === 'delivered' ? null : { code: `delivery_${deliveryState}`, message: '投递结果未确认' },
        }
        const phase = record.phases.find(item => item.name === 'delivery')
        if (phase !== undefined) {
          phase.state = deliveryState === 'delivered'
            ? 'done'
            : deliveryState === 'unknown' ? 'unknown' : deliveryState === 'preparing' ? 'active' : 'failed'
          phase.requestId = requestId
          phase.sessionId = target
          if (deliveryState === 'delivered') phase.endedAt = now
          phase.evidence = [...phase.evidence, `投递 requestId=${requestId}（${deliveryState}）`]
        }
        const deliverable = flags.artifact
        for (const path of asArray(deliverable)) {
          record.deliverables = [...(record.deliverables ?? []), { name: String(path).split('/').pop(), path, status: 'pending' }]
        }
        if (deliveryState === 'delivered') {
          if ([WORKORDER_STATUS.EXECUTOR_CREATED, WORKORDER_STATUS.APPROVED].includes(record.status)) {
            setStatus(record, WORKORDER_STATUS.TASK_DELIVERED)
          } else if (![WORKORDER_STATUS.TASK_DELIVERED, WORKORDER_STATUS.EXECUTING, WORKORDER_STATUS.REPORTED,
            WORKORDER_STATUS.REVIEWING, WORKORDER_STATUS.FIXING].includes(record.status)) {
            throw new BridgeError('invalid_transition', `工作单 ${workOrderId} 处于 ${record.status}，不能登记投递。`, {
              exitCode: EXIT.USAGE,
              details: { status: record.status },
            })
          }
        }
        return record
      })
      if (deliveryState !== 'delivered') {
        return {
          exitCode: EXIT.OK,
          text: `已登记投递结果未知（state=${deliveryState}，requestId=${requestId}）；只允许按同一 requestId 查询，禁止重发。`,
          workOrder: updated,
        }
      }
      return {
        exitCode: EXIT.OK,
        text: `已登记投递：requestId=${requestId}；工作单状态：${updated.status}（accepted≠done，仍需等待与复查）`,
        workOrder: updated,
      }
    }
    case 'report': {
      if (workOrderId === null) throw usageError('用法：zhihui-xiezuo workorder report <工作单ID> --request-id <R> [--report <路径>]')
      const requestId = typeof flags['request-id'] === 'string' && flags['request-id'] !== '' ? flags['request-id'] : null
      if (requestId === null) throw usageError('report 需要 --request-id。')
      const updated = await store.update(workOrderId, (record) => {
        assertWorkOrderWritable(workOrderId, record)
        const now = new Date().toISOString()
        const phase = record.phases.find(item => item.name === 'report')
        if (phase !== undefined) {
          phase.state = 'done'
          phase.requestId = requestId
          phase.endedAt = now
          phase.evidence = [...phase.evidence, typeof flags.report === 'string' ? `报告：${flags.report}` : `收到报告 requestId=${requestId}`]
        }
        if (typeof flags.report === 'string') {
          record.deliverables = [...(record.deliverables ?? []), { name: String(flags.report).split('/').pop(), path: flags.report, status: 'present' }]
        }
        if ([WORKORDER_STATUS.TASK_DELIVERED, WORKORDER_STATUS.EXECUTING].includes(record.status)) {
          setStatus(record, WORKORDER_STATUS.REPORTED)
        } else if (![WORKORDER_STATUS.REPORTED, WORKORDER_STATUS.REVIEWING, WORKORDER_STATUS.FIXING].includes(record.status)) {
          throw new BridgeError('invalid_transition', `工作单 ${workOrderId} 处于 ${record.status}，不能登记报告。`, {
            exitCode: EXIT.USAGE,
            details: { status: record.status },
          })
        }
        return record
      })
      return {
        exitCode: EXIT.OK,
        text: `已登记 DSH 报告；工作单状态：${updated.status}（报告不等于验证通过，等待 Codex 复查）`,
        workOrder: updated,
      }
    }
    case 'review': {
      if (workOrderId === null) throw usageError('用法：zhihui-xiezuo workorder review <工作单ID> --verdict accepted|rejected|needs_user --evidence <证据>')
      const verdict = typeof flags.verdict === 'string' ? flags.verdict : ''
      if (!['accepted', 'rejected', 'needs_user'].includes(verdict)) {
        throw usageError('--verdict 只能是 accepted|rejected|needs_user。')
      }
      const evidence = asArray(flags.evidence)
      if (evidence.length === 0) throw new BridgeError('evidence_required', 'review 需要 --evidence（Codex 的验收证据）。', { exitCode: EXIT.USAGE })
      const issues = asArray(flags.issue)
      const by = typeof flags.by === 'string' && flags.by !== '' ? flags.by : 'codex'
      const updated = await store.update(workOrderId, (record) => {
        const now = new Date().toISOString()
        record.review = { verdict, by, evidence, issues, at: now }
        const phase = record.phases.find(item => item.name === 'review')
        if (phase !== undefined) {
          phase.state = verdict === 'needs_user' ? 'needs_user' : 'done'
          phase.endedAt = now
          phase.evidence = [...phase.evidence, ...evidence]
        }
        if (verdict === 'accepted') {
          if (![WORKORDER_STATUS.REPORTED, WORKORDER_STATUS.REVIEWING].includes(record.status)) {
            throw new BridgeError('invalid_transition', `工作单 ${workOrderId} 处于 ${record.status}，不能在复查前进入 accepted。`, {
              exitCode: EXIT.USAGE,
              details: { status: record.status },
            })
          }
          setStatus(record, WORKORDER_STATUS.ACCEPTED)
        } else if (verdict === 'rejected') {
          setStatus(record, WORKORDER_STATUS.FIXING)
        } else {
          setStatus(record, WORKORDER_STATUS.NEEDS_USER)
        }
        return record
      })
      return {
        exitCode: EXIT.OK,
        text: `复查结论：${verdict}；工作单状态：${updated.status}`,
        workOrder: updated,
      }
    }
    case 'phase': {
      if (workOrderId === null) throw usageError('用法：zhihui-xiezuo workorder phase <工作单ID> --name <阶段> --state <状态>')
      const name = typeof flags.name === 'string' ? flags.name : ''
      const state = typeof flags.state === 'string' ? flags.state : ''
      if (!PHASE_NAMES.includes(name)) throw usageError(`--name 必须是 ${PHASE_NAMES.join('|')} 之一。`)
      if (!PHASE_STATES.includes(state)) throw usageError(`--state 必须是 ${PHASE_STATES.join('|')} 之一。`)
      const evidence = asArray(flags.evidence)
      const requestId = typeof flags['request-id'] === 'string' && flags['request-id'] !== '' ? flags['request-id'] : null
      if (state === 'done' && evidence.length === 0 && requestId === null) {
        throw new BridgeError('evidence_required', `阶段 ${name} 置为 done 需要 --evidence 或 --request-id。`, { exitCode: EXIT.USAGE })
      }
      if ((state === 'needs_user' || state === 'blocked') && evidence.length === 0) {
        throw new BridgeError('evidence_required', `阶段 ${name} 置为 ${state} 需要 --evidence（具体阻塞/待决条件）。`, { exitCode: EXIT.USAGE })
      }
      const sessionId = typeof flags.session === 'string' ? flags.session : null
      const updated = await store.update(workOrderId, (record) => {
        const now = new Date().toISOString()
        const phase = record.phases.find(item => item.name === name)
        if (phase === undefined) throw usageError(`未知阶段 ${name}。`)
        phase.state = state
        if (requestId !== null) phase.requestId = requestId
        if (sessionId !== null) phase.sessionId = sessionId
        if (state === 'active') phase.startedAt = phase.startedAt ?? now
        if (['done', 'failed', 'unknown'].includes(state)) phase.endedAt = now
        phase.evidence = [...phase.evidence, ...evidence]
        const effect = statusEffectOfPhase(name, state)
        const restoring = [WORKORDER_STATUS.NEEDS_USER, WORKORDER_STATUS.BLOCKED].includes(record.status)
          && ['pending', 'active', 'done'].includes(state)
          && evidence.length > 0
        if (effect !== null) {
          setStatus(record, effect)
        } else if (restoring) {
          const restored = deriveRestoreStatus(record)
          setStatus(record, restored)
        }
        return record
      })
      return {
        exitCode: EXIT.OK,
        text: `阶段 ${name} → ${state}；工作单状态：${updated.status}`,
        workOrder: updated,
      }
    }
    case 'recover': {
      if (workOrderId === null) throw usageError('用法：zhihui-xiezuo workorder recover <工作单ID>')
      const record = await store.require(workOrderId)
      const plan = buildRecovery(record)
      const lines = [
        `工作单 ${record.workOrderId} 恢复计划（只读，不发任何请求）：`,
        `  状态：${plan.status}   创建：${plan.steps.creation}  改名：${plan.steps.rename}  投递：${plan.steps.delivery}  复查：${plan.steps.review}`,
      ]
      for (const action of plan.nextActions) lines.push(`  下一步：${action.action} — ${action.reason}${action.command === null ? '' : `\n    命令：${action.command}`}`)
      for (const item of plan.forbidden) lines.push(`  禁止：${item}`)
      return { exitCode: EXIT.OK, text: lines.join('\n'), recovery: plan }
    }
    default:
      throw usageError('用法：zhihui-xiezuo workorder <init|list|show|attach|negotiate|approve|deliver|report|review|phase|recover> ...')
  }
}

export { describeCredential, redactText, clearCredential, withLock }

