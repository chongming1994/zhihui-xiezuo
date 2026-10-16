/**
 * 协作工作单：持久化、状态机、恢复计划与写入守卫。
 *
 * 设计要点（见 `docs/协作接口契约.md`）：
 * - 每个工作单一个 0600 JSON 文件，目录 0700；更新走“加锁 → 读 → 改 → 守卫 → 原子写”。
 * - 状态只按显式转移表前进；`accepted` 是终态，且**只能**由 Codex 的复查操作写入。
 * - 工作单只保存 ID / 路径 / 状态 / 摘要：写入前递归拒绝凭据、令牌与任务正文特征。
 * - 恢复只依据稳定 ID：`buildRecovery` 是纯函数，永不自动重发未知提交。
 * @module zhihui-xiezuo/workorder
 */

import { randomUUID } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeJsonAtomic } from './config.js'
import { BridgeError, EXIT, notFoundError, usageError } from './errors.js'
import { withLock } from './store.js'

/** 工作单状态取值。 */
export const WORKORDER_STATUS = {
  DRAFT: 'draft',
  NEGOTIATING: 'negotiating',
  NEGOTIATED: 'negotiated',
  APPROVED: 'approved',
  EXECUTOR_CREATED: 'executor_created',
  TASK_DELIVERED: 'task_delivered',
  EXECUTING: 'executing',
  REPORTED: 'reported',
  REVIEWING: 'reviewing',
  ACCEPTED: 'accepted',
  FIXING: 'fixing',
  BLOCKED: 'blocked',
  NEEDS_USER: 'needs_user',
}

/** 阶段名固定集合。 */
export const PHASE_NAMES = [
  'negotiation', 'approval', 'executor_create', 'rename', 'delivery', 'execution', 'report', 'review', 'fix',
]

/** 阶段状态取值。 */
export const PHASE_STATES = ['pending', 'active', 'done', 'failed', 'unknown', 'needs_user', 'blocked']

/** 三步操作（创建 / 改名 / 投递）的独立状态取值。 */
export const STEP_STATES = ['none', 'preparing', 'created', 'delivered', 'renamed', 'unknown', 'conflict', 'failed']

/**
 * 状态转移表。`accepted` 只允许从 `reviewing` 进入。
 */
export const STATUS_TRANSITIONS = {
  draft: ['negotiating', 'negotiated', 'approved', 'executor_created', 'needs_user', 'blocked'],
  negotiating: ['negotiated', 'approved', 'executor_created', 'needs_user', 'blocked'],
  negotiated: ['approved', 'executor_created', 'needs_user', 'blocked'],
  approved: ['executor_created', 'task_delivered', 'needs_user', 'blocked'],
  executor_created: ['task_delivered', 'needs_user', 'blocked'],
  task_delivered: ['executing', 'reported', 'needs_user', 'blocked'],
  executing: ['reported', 'fixing', 'needs_user', 'blocked'],
  reported: ['reviewing', 'accepted', 'fixing', 'needs_user', 'blocked'],
  reviewing: ['accepted', 'fixing', 'needs_user', 'blocked'],
  fixing: ['executing', 'reported', 'reviewing', 'needs_user', 'blocked'],
  blocked: [
    'draft', 'negotiating', 'negotiated', 'approved', 'executor_created', 'task_delivered',
    'executing', 'reported', 'reviewing', 'fixing', 'needs_user',
  ],
  needs_user: [
    'draft', 'negotiating', 'negotiated', 'approved', 'executor_created', 'task_delivered',
    'executing', 'reported', 'reviewing', 'fixing', 'blocked',
  ],
  accepted: [],
}

/** 禁止出现的键名（规范化后比较：小写、去掉 `-`/`_`）。 */
const FORBIDDEN_KEYS = new Set([
  'cookievalue', 'cookie', 'setcookie', 'token', 'password', 'secret',
  'credential', 'credentials', 'apikey', 'accesskey', 'privatekey',
])

/** 禁止出现的字符串值特征：Cookie 名、带令牌的 URL、DSH 会话 Cookie 值。 */
const FORBIDDEN_VALUE_PATTERNS = [
  /dsh-auth-/iu,
  /(?:^|[?&\s])token=[^\s&]{8,}/iu,
  /v1\.[A-Za-z0-9_-]{8,}\./u,
]

/**
 * 递归检查值里是否夹带凭据或令牌；命中即抛出且不落盘。
 * @param {unknown} value - 待检查的值。
 * @param {string} [at] - 当前路径（用于诊断，不含值本身）。
 * @returns {void} 干净时正常返回。
 */
export function assertNoSecrets(value, at = '$') {
  if (typeof value === 'string') {
    for (const pattern of FORBIDDEN_VALUE_PATTERNS) {
      if (pattern.test(value)) {
        throw new BridgeError('workorder_secret_rejected', `工作单字段 ${at} 命中凭据/令牌特征，已拒绝写入。`, {
          exitCode: EXIT.ERROR,
          details: { at, pattern: String(pattern) },
        })
      }
    }
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => { assertNoSecrets(item, `${at}[${index}]`) })
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      const normalized = key.toLowerCase().replace(/[-_]/gu, '')
      if (FORBIDDEN_KEYS.has(normalized)) {
        throw new BridgeError('workorder_secret_rejected', `工作单不得包含凭据类字段 ${at}.${key}，已拒绝写入。`, {
          exitCode: EXIT.ERROR,
          details: { at: `${at}.${key}` },
        })
      }
      assertNoSecrets(item, `${at}.${key}`)
    }
  }
}

/**
 * 生成一个新的工作单身份。
 * @returns {string} `wo-<uuid>`。
 */
export function newWorkOrderId() {
  return `wo-${randomUUID()}`
}

/** 合法工作单 ID：只允许 `wo-` 加字母数字与连字符，杜绝路径穿越。 */
export const WORKORDER_ID_PATTERN = /^wo-[A-Za-z0-9-]{1,80}$/u

/**
 * 校验工作单 ID。任何会拼进文件路径的地方都必须先过这一关。
 * @param {unknown} workOrderId - 待校验 ID。
 * @returns {string} 合法 ID。
 */
export function assertWorkOrderId(workOrderId) {
  const id = typeof workOrderId === 'string' ? workOrderId : ''
  if (!WORKORDER_ID_PATTERN.test(id)) {
    throw new BridgeError('work_order_id_invalid', '工作单 ID 必须是 wo-<字母数字/连字符> 形式（拒绝路径穿越）。', {
      exitCode: EXIT.USAGE,
      details: { workOrderId: id },
    })
  }
  return id
}

/**
 * 构造一条工作单记录（不落盘）。
 * @param {object} input - 输入字段。
 * @param {string} input.goal - 目标。
 * @param {string[]} [input.scope] - 范围条目。
 * @param {string} [input.coordinatorSessionId] - 协调会话。
 * @param {string} [input.coordinatorTitle] - 协调会话标题。
 * @param {string} [input.baseUrl] - 地址。
 * @param {boolean} [input.authorize] - 是否已获明确授权。
 * @param {string} [input.reason] - 授权说明。
 * @param {number} [input.maxRounds] - 协商轮数上限。
 * @param {string} [input.workOrderId] - 指定身份（测试用）。
 * @returns {any} 工作单记录。
 */
export function buildWorkOrder(input) {
  const now = new Date().toISOString()
  const goal = typeof input.goal === 'string' ? input.goal.trim() : ''
  if (goal === '') throw usageError('工作单必须有非空 --goal。')
  if (goal.length > 2000) throw usageError('--goal 过长（上限 2000 字符）。')
  const scope = Array.isArray(input.scope) ? input.scope.map(String).filter(item => item !== '') : []
  const maxRounds = Number.isInteger(input.maxRounds) ? input.maxRounds : 2
  if (maxRounds < 1) throw usageError('--max-rounds 必须是 ≥1 的整数。')
  const authorize = input.authorize === true
  const record = {
    version: 1,
    workOrderId: input.workOrderId ?? newWorkOrderId(),
    goal,
    scope,
    authorization: {
      granted: authorize,
      note: typeof input.reason === 'string' ? input.reason : '',
      source: 'user',
      grantedAt: authorize ? now : null,
    },
    status: authorize ? WORKORDER_STATUS.NEGOTIATING : WORKORDER_STATUS.DRAFT,
    coordinator: {
      sessionId: input.coordinatorSessionId ?? null,
      title: input.coordinatorTitle ?? null,
      baseUrl: input.baseUrl ?? null,
    },
    executor: {
      sessionId: null,
      title: null,
      titleReadBack: null,
      cwd: null,
      agentPreset: null,
      permissions: null,
      baseUrl: null,
      creation: { state: 'none', at: null, requestedCwd: null, error: null, attempts: [] },
      rename: { state: 'none', at: null, title: null, seq: null, readBack: null, truncated: false, error: null },
    },
    negotiation: {
      state: authorize ? 'open' : 'none',
      maxRounds,
      rounds: [],
    },
    delivery: {
      state: 'none',
      requestId: null,
      sessionId: null,
      at: null,
      contentDigest: null,
      attempt: 0,
      attempts: [],
      error: null,
    },
    phases: PHASE_NAMES.map(name => ({
      name,
      state: 'pending',
      requestId: null,
      sessionId: null,
      startedAt: null,
      endedAt: null,
      evidence: [],
    })),
    deliverables: [],
    review: { verdict: 'none', by: null, evidence: [], issues: [], at: null },
    notes: [],
    createdAt: now,
    updatedAt: now,
  }
  assertNoSecrets(record)
  return record
}

/**
 * 校验一次状态转移是否合法。
 * @param {string} from - 当前状态。
 * @param {string} to - 目标状态。
 * @returns {void} 合法时正常返回。
 */
export function assertStatusTransition(from, to) {
  if (from === to) return
  const allowed = STATUS_TRANSITIONS[from] ?? []
  if (!allowed.includes(to)) {
    throw new BridgeError('invalid_transition', `工作单状态不能从 ${from} 变为 ${to}。`, {
      exitCode: EXIT.USAGE,
      details: { from, to, allowed },
    })
  }
}

/**
 * 在记录上设置状态（含合法性校验）。
 * @param {any} record - 工作单。
 * @param {string} next - 目标状态。
 * @returns {void} 就地修改。
 */
export function setStatus(record, next) {
  assertStatusTransition(record.status, next)
  record.status = next
}

/**
 * 由已完成步骤推导“进行中”状态，用于从 `needs_user` / `blocked` 恢复。
 * @param {any} record - 工作单。
 * @returns {string} 推导出的状态。
 */
export function deriveRestoreStatus(record) {
  if (record.review?.verdict === 'rejected') return WORKORDER_STATUS.FIXING
  if (record.review?.verdict === 'needs_user') return WORKORDER_STATUS.NEEDS_USER
  const done = name => record.phases?.find(phase => phase.name === name)?.state === 'done'
  if (done('review')) return WORKORDER_STATUS.REVIEWING
  if (done('report')) return WORKORDER_STATUS.REPORTED
  if (record.delivery?.state === 'delivered') return WORKORDER_STATUS.EXECUTING
  if (record.executor?.creation?.state === 'created') return WORKORDER_STATUS.EXECUTOR_CREATED
  if (done('approval')) return WORKORDER_STATUS.APPROVED
  if (record.negotiation?.state === 'converged' || done('negotiation')) return WORKORDER_STATUS.NEGOTIATED
  return WORKORDER_STATUS.NEGOTIATING
}

/**
 * 阶段推进对工作单状态的影响（`null` 表示不改状态）。
 * @param {string} name - 阶段名。
 * @param {string} state - 阶段状态。
 * @returns {string|null} 目标状态。
 */
export function statusEffectOfPhase(name, state) {
  if (state === 'needs_user') return WORKORDER_STATUS.NEEDS_USER
  if (state === 'blocked') return WORKORDER_STATUS.BLOCKED
  if (state !== 'done' && state !== 'active') return null
  const table = {
    negotiation: state === 'done' ? WORKORDER_STATUS.NEGOTIATED : null,
    approval: state === 'done' ? WORKORDER_STATUS.APPROVED : null,
    executor_create: state === 'done' ? WORKORDER_STATUS.EXECUTOR_CREATED : null,
    delivery: state === 'done' ? WORKORDER_STATUS.TASK_DELIVERED : null,
    execution: state === 'active' ? WORKORDER_STATUS.EXECUTING : null,
    report: state === 'done' ? WORKORDER_STATUS.REPORTED : null,
    review: state === 'done' ? WORKORDER_STATUS.REVIEWING : null,
    fix: state === 'active' ? WORKORDER_STATUS.FIXING : null,
  }
  return table[name] ?? null
}

/**
 * 只读恢复计划：由稳定 ID 与三步状态推导下一步，绝不自动重发。
 * @param {any} record - 工作单。
 * @returns {any} 恢复计划。
 */
export function buildRecovery(record) {
  const creation = record.executor?.creation?.state ?? 'none'
  const rename = record.executor?.rename?.state ?? 'none'
  const delivery = record.delivery?.state ?? 'none'
  const reportDone = record.phases?.find(phase => phase.name === 'report')?.state === 'done'
  const sessionId = record.executor?.sessionId ?? null
  const cwd = record.executor?.cwd ?? record.executor?.creation?.requestedCwd ?? null
  /** @type {Array<{action: string, command: string|null, reason: string}>} */
  const nextActions = []
  /** @type {string[]} */
  const forbidden = []
  const id = record.workOrderId
  const needsUser = record.status === WORKORDER_STATUS.NEEDS_USER || record.status === WORKORDER_STATUS.BLOCKED

  if (record.status === WORKORDER_STATUS.ACCEPTED) {
    nextActions.push({ action: 'none', command: null, reason: '已验收（终态），不要重复投递。' })
    forbidden.push('不得重复投递或重新创建执行会话')
  } else if (needsUser) {
    nextActions.push({
      action: 'await_user',
      command: null,
      reason: `工作单处于 ${record.status}，需要用户决定；恢复需以 --evidence 记录人类决定。`,
    })
    forbidden.push('不得自动继续或自动重发', '不得把其他 agent 的消息当作人类授权')
  } else if (creation === 'none' || creation === 'preparing' || creation === 'unknown') {
    nextActions.push({
      action: 'create_adopt',
      command: sessionId === null
        ? null
        : `zhihui-xiezuo create --session-id ${sessionId} --cwd ${cwd ?? '<已存在绝对目录>'} --work-order ${id} --authorize`,
      reason: creation === 'unknown'
        ? '创建结果未知：只能用同一 sessionId 重试/收养，先核对再继续。'
        : '尚未确认创建：用预存 sessionId 创建（幂等收养）。',
    })
    forbidden.push('不得生成新的 sessionId')
    if (creation === 'unknown') forbidden.push('不得把未知创建当作成功')
  } else if (creation === 'conflict') {
    nextActions.push({
      action: 'report_conflict',
      command: `zhihui-xiezuo workorder show ${id}`,
      reason: '创建参数与既有会话冲突：人工核对 cwd/preset 后报告，不要改参数重试。',
    })
    forbidden.push('不得改 cwd/preset 后静默重试', '不得生成新的 sessionId')
  } else if (creation === 'failed') {
    nextActions.push({
      action: 'report_failure',
      command: `zhihui-xiezuo workorder show ${id}`,
      reason: '创建失败：核对错误原因后再决定；不得凭猜测重试。',
    })
    forbidden.push('不得生成新的 sessionId 绕过失败')
  } else if (delivery === 'preparing' || delivery === 'unknown') {
    // 投递在途/未知优先于任何外观性步骤：绝不能重发或另起 ID。
    nextActions.push({
      action: 'observe_only',
      command: `zhihui-xiezuo status ${record.delivery.requestId ?? '<requestId>'}`,
      reason: delivery === 'preparing'
        ? '投递已落盘 preparing 但未确认结果（崩溃窗口）：按未知处理，只允许同 requestId 查询/等待。'
        : '投递结果未知：只允许按同一 requestId 查询/等待。',
    })
    forbidden.push('不得重发', '不得新建 requestId 绕过未知状态')
  } else if (delivery === 'failed') {
    nextActions.push({
      action: 'inspect_delivery',
      command: `zhihui-xiezuo status ${record.delivery.requestId ?? '<requestId>'}`,
      reason: '投递失败：核对本地记录与远端观测后，由 Codex 决定是否用新 requestId 重新投递。',
    })
    forbidden.push('不得在未核对前自动重发')
  } else if (delivery === 'delivered') {
    // 一旦投递完成，改名只是外观性步骤：优先等待报告/交复查，不再提示改名。
    if (!reportDone) {
      nextActions.push({
        action: 'wait',
        command: `zhihui-xiezuo wait ${record.delivery.requestId ?? '<requestId>'}`,
        reason: '已投递但未收到报告：按同一 requestId 等待，不重新发送。',
      })
      forbidden.push('不得重新 send')
    } else if (record.review?.verdict === 'none') {
      nextActions.push({
        action: 'codex_review',
        command: `zhihui-xiezuo workorder review ${id} --verdict accepted|rejected|needs_user --evidence <证据>`,
        reason: 'DSH 报告不等于验证通过：需要 Codex 独立复查并给出结论。',
      })
      forbidden.push('不得自动 accepted', '不得把 turn/end 当作验收')
    } else {
      nextActions.push({
        action: 'none',
        command: null,
        reason: '已投递、已复查：没有需要自动推进的步骤。',
      })
    }
  } else if (rename === 'none' || rename === 'failed') {
    nextActions.push({
      action: 'rename',
      command: `zhihui-xiezuo rename ${sessionId} --title <标题> --work-order ${id} --authorize`,
      reason: '执行会话已创建，尚未确认命名。',
    })
    forbidden.push('不得新建执行会话')
  } else if (rename === 'unknown') {
    nextActions.push({
      action: 'verify_rename',
      command: `zhihui-xiezuo inspect ${sessionId}`,
      reason: '改名结果未知：先只读核对当前标题，再决定是否重试同一会话。',
    })
    forbidden.push('不得新建执行会话', '不得把未知改名当作成功')
  } else if (delivery === 'none') {
    nextActions.push({
      action: 'deliver',
      command: `zhihui-xiezuo send --file <任务文件> --work-order ${id} --authorize`,
      reason: '尚未投递：用工作单投递入口一次固定身份（锁内落盘 preparing 后再发 HTTP）。',
    })
    forbidden.push('不得绕过工作单自行生成 requestId')
  } else if (reportDone && record.review?.verdict === 'none') {
    nextActions.push({
      action: 'codex_review',
      command: `zhihui-xiezuo workorder review ${id} --verdict accepted|rejected|needs_user --evidence <证据>`,
      reason: 'DSH 报告不等于验证通过：需要 Codex 独立复查并给出结论。',
    })
    forbidden.push('不得自动 accepted', '不得把 turn/end 当作验收')
  } else {
    nextActions.push({
      action: 'none',
      command: null,
      reason: '没有需要自动推进的步骤；按既有 requestId 继续观察。',
    })
  }
  return {
    workOrderId: id,
    status: record.status,
    steps: {
      creation,
      rename,
      delivery,
      report: reportDone ? 'done' : 'none',
      review: record.review?.verdict ?? 'none',
    },
    nextActions,
    forbidden,
    needsUser,
  }
}

/** 工作单仓库。 */
export class WorkOrderStore {
  /**
   * @param {import('./config.js').Paths} paths - 状态目录。
   */
  constructor(paths) {
    this.paths = paths
  }

  /**
   * 工作单文件路径。
   * @param {string} workOrderId - 工作单身份。
   * @returns {string} 路径。
   */
  file(workOrderId) {
    return join(this.paths.workorders, `${assertWorkOrderId(workOrderId)}.json`)
  }

  /**
   * 读取一条工作单；损坏时显式报错而不是静默重置。
   * @param {string} workOrderId - 工作单身份。
   * @returns {Promise<any|null>} 工作单或 null。
   */
  async get(workOrderId) {
    let raw
    try {
      raw = await readFile(this.file(workOrderId), 'utf8')
    } catch (error) {
      if (error !== null && typeof error === 'object' && error.code === 'ENOENT') return null
      throw error
    }
    try {
      return JSON.parse(raw)
    } catch (error) {
      throw new BridgeError('workorder_corrupt', `工作单 ${workOrderId} 的文件不是合法 JSON，已拒绝继续。`, {
        exitCode: EXIT.ERROR,
        details: { workOrderId },
        cause: error,
      })
    }
  }

  /**
   * 读取一条工作单，不存在时抛出。
   * @param {string} workOrderId - 工作单身份。
   * @returns {Promise<any>} 工作单。
   */
  async require(workOrderId) {
    const record = await this.get(workOrderId)
    if (record === null) {
      throw notFoundError('work_order_not_found', `没有找到工作单 ${workOrderId}。`, { workOrderId })
    }
    return record
  }

  /**
   * 列出全部工作单，按更新时间降序。
   * @returns {Promise<any[]>} 工作单数组。
   */
  async list() {
    let entries
    try {
      entries = await readdir(this.paths.workorders)
    } catch {
      return []
    }
    /** @type {any[]} */
    const records = []
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue
      const id = entry.slice(0, -'.json'.length)
      if (!WORKORDER_ID_PATTERN.test(id)) continue
      const record = await this.get(id)
      if (record !== null) records.push(record)
    }
    records.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))
    return records
  }

  /**
   * 创建一条工作单。
   * @param {object} input - 见 {@link buildWorkOrder}。
   * @returns {Promise<any>} 已落盘的工作单。
   */
  async create(input) {
    const record = buildWorkOrder(input)
    return withLock(this.paths, 'workorders', async () => {
      const existing = await this.get(record.workOrderId)
      if (existing !== null) {
        throw new BridgeError('work_order_exists', `工作单 ${record.workOrderId} 已存在。`, {
          exitCode: EXIT.USAGE,
          details: { workOrderId: record.workOrderId },
        })
      }
      await writeJsonAtomic(this.file(record.workOrderId), record)
      return record
    })
  }

  /**
   * 在锁内读改写一条工作单；写入前做密钥守卫。
   * @param {string} workOrderId - 工作单身份。
   * @param {(record: any) => any|Promise<any>} mutate - 变更函数（可原地改或返回新对象）。
   * @returns {Promise<any>} 更新后的工作单。
   */
  async update(workOrderId, mutate) {
    return withLock(this.paths, 'workorders', async () => {
      const current = await this.require(workOrderId)
      if (current.status === WORKORDER_STATUS.ACCEPTED) {
        throw new BridgeError(
          'work_order_accepted',
          `工作单 ${workOrderId} 已验收（accepted 为终态），任何改动都被拒绝；如需新一轮工作请新建工作单。`,
          { exitCode: EXIT.USAGE, details: { workOrderId, status: current.status } },
        )
      }
      const draft = structuredClone(current)
      const next = (await mutate(draft)) ?? draft
      next.updatedAt = new Date().toISOString()
      assertNoSecrets(next)
      await writeJsonAtomic(this.file(workOrderId), next)
      return next
    })
  }

  /**
   * 追加一条备注。
   * @param {string} workOrderId - 工作单身份。
   * @param {string} note - 备注。
   * @returns {Promise<any>} 更新后的工作单。
   */
  async addNote(workOrderId, note) {
    return this.update(workOrderId, (record) => {
      record.notes = [...(record.notes ?? []), { at: new Date().toISOString(), note }]
      return record
    })
  }
}

export { BridgeError, EXIT, usageError }
