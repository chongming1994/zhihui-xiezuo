/**
 * 请求记录存储与并发控制。
 *
 * 每条请求一个 0600 文件；更新走“加锁 → 读 → 改 → 原子写 → 解锁”。
 * 锁只需管理桥接自己的并发，不影响用户在网页上的操作。
 *
 * 关键不变量：
 * - `createOrGet` 在**同一个临界区**里完成“身份校验 + 创建/复用”，
 *   因此同 requestId 不同内容/不同会话的并发创建不会互相覆盖。
 * - 状态只允许单调前进（{@link STATE_RANK}）：晚到的提交回执不会把
 *   `wait` 已经写入的 `queued`/`running`/终态回退成 `submitted`。
 * @module zhihui-xiezuo/store
 */

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rm, stat, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { readJson, writeJsonAtomic } from './config.js'
import { BridgeError, EXIT, notFoundError, usageError } from './errors.js'

/** 请求状态取值。`accepted` 与 `completed` 必须严格区分。 */
export const REQUEST_STATE = {
  /** 已生成 requestId 并落盘，尚未发出 HTTP。 */
  PREPARED: 'prepared',
  /** HTTP 提交没有拿到确定回执。 */
  SUBMISSION_UNKNOWN: 'submission_unknown',
  /** 已拿到 DSH 的 accepted 回执。 */
  SUBMITTED: 'submitted',
  /** 已在待发队列中被观测到（有日志证据）。 */
  QUEUED: 'queued',
  /** 已被回合认领、正在执行（有日志证据）。 */
  RUNNING: 'running',
  /** 关联回合正常结束。 */
  COMPLETED: 'completed',
  /** 关联回合以错误/阻塞结束。 */
  FAILED: 'failed',
  /** 关联回合被取消，或待发消息被撤销。 */
  CANCELLED: 'cancelled',
}

/**
 * 状态推进等级：数值只增不减，用于阻止晚到的弱证据覆盖强证据。
 */
export const STATE_RANK = {
  [REQUEST_STATE.PREPARED]: 0,
  [REQUEST_STATE.SUBMISSION_UNKNOWN]: 1,
  [REQUEST_STATE.SUBMITTED]: 2,
  [REQUEST_STATE.QUEUED]: 3,
  [REQUEST_STATE.RUNNING]: 4,
  [REQUEST_STATE.COMPLETED]: 5,
  [REQUEST_STATE.FAILED]: 5,
  [REQUEST_STATE.CANCELLED]: 5,
}

/** 终态集合。 */
const TERMINAL = new Set([
  REQUEST_STATE.COMPLETED,
  REQUEST_STATE.FAILED,
  REQUEST_STATE.CANCELLED,
])

/**
 * 判断状态是否为终态。
 * @param {string} state - 状态值。
 * @returns {boolean} 终态为 true。
 */
export function isTerminal(state) {
  return TERMINAL.has(state)
}

/**
 * 判断 `next` 是否可以覆盖 `current`（只允许单调前进）。
 * @param {string} current - 当前状态。
 * @param {string} next - 候选状态。
 * @returns {boolean} 允许覆盖时为 true。
 */
export function canAdvance(current, next) {
  const from = STATE_RANK[current]
  const to = STATE_RANK[next]
  if (from === undefined || to === undefined) return false
  return to >= from
}

/**
 * 计算任务正文摘要（用于重发一致性校验，不泄露正文）。
 * @param {string} text - 任务正文。
 * @returns {string} `sha256:<hex>`。
 */
export function digestOf(text) {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`
}

/** 默认锁等待与陈旧阈值。 */
const LOCK_RETRY_MS = 25
const LOCK_TIMEOUT_MS = 10_000
const LOCK_STALE_MS = 30_000

/**
 * 在命名锁下执行临界区。锁用 `mkdir` 的原子性实现，陈旧锁可被接管。
 * @template T
 * @param {import('./config.js').Paths} paths - 状态目录。
 * @param {string} name - 锁名。
 * @param {() => Promise<T>} fn - 临界区。
 * @returns {Promise<T>} 临界区结果。
 */
export async function withLock(paths, name, fn) {
  const lockDir = join(paths.locks, `${name}.lock`)
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  await mkdir(paths.locks, { recursive: true, mode: 0o700 })
  for (;;) {
    try {
      await mkdir(lockDir, { mode: 0o700 })
      break
    } catch (error) {
      if (error === null || typeof error !== 'object' || error.code !== 'EEXIST') throw error
      // 陈旧锁接管：持锁进程崩溃时不会永久阻塞。
      try {
        const info = await stat(lockDir)
        if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
          await rm(lockDir, { recursive: true, force: true })
          continue
        }
      } catch {
        continue
      }
      if (Date.now() > deadline) {
        throw new BridgeError('lock_timeout', `等待锁 ${name} 超时，可能有另一个桥接进程正在运行。`, {
          exitCode: EXIT.ERROR,
          details: { lock: name },
        })
      }
      await new Promise(resolve => setTimeout(resolve, LOCK_RETRY_MS))
    }
  }
  try {
    return await fn()
  } finally {
    await rm(lockDir, { recursive: true, force: true })
  }
}

/** 请求记录仓库。 */
export class RequestStore {
  /**
   * @param {import('./config.js').Paths} paths - 状态目录。
   */
  constructor(paths) {
    this.paths = paths
  }

  /**
   * 读取一条请求记录。
   * @param {string} requestId - 请求身份。
   * @returns {Promise<any|null>} 记录或 null。
   */
  async get(requestId) {
    return readJson(this.paths.request(requestId), null)
  }

  /**
   * 读取一条请求记录，不存在时抛出。
   * @param {string} requestId - 请求身份。
   * @returns {Promise<any>} 记录。
   */
  async require(requestId) {
    const record = await this.get(requestId)
    if (record === null) {
      throw notFoundError('request_not_found', `没有找到请求记录 ${requestId}。`, { requestId })
    }
    return record
  }

  /**
   * 构造一条新记录（不落盘）。
   * @param {object} input - 记录字段。
   * @returns {any} 记录。
   */
  static build(input) {
    const now = new Date().toISOString()
    return {
      version: 1,
      requestId: input.requestId,
      sessionId: input.sessionId,
      baseUrl: input.baseUrl,
      mode: input.mode,
      contentDigest: digestOf(input.text),
      text: input.text,
      state: REQUEST_STATE.PREPARED,
      createdAt: now,
      updatedAt: now,
      submittedAt: null,
      attempts: [],
      cursor: { lastSeq: null },
      promptSeq: null,
      turn: null,
      reply: null,
      reason: null,
      error: null,
      notes: [],
    }
  }

  /**
   * 在**同一个临界区**里完成身份校验与创建/复用。
   *
   * 同 requestId 已存在时：会话或内容不一致一律拒绝（不覆盖、不改写）；
   * 完全一致时复用旧记录（幂等重发）。
   * @param {object} input - 记录字段。
   * @param {string} input.requestId - 请求身份。
   * @param {string} input.sessionId - 目标会话。
   * @param {string} input.baseUrl - 目标地址。
   * @param {string} input.mode - `queue`。
   * @param {string} input.text - 任务正文。
   * @returns {Promise<{record: any, created: boolean}>} 记录与是否新建。
   */
  async createOrGet(input) {
    return withLock(this.paths, 'requests', async () => {
      const existing = await readJson(this.paths.request(input.requestId), null)
      if (existing !== null) {
        if (existing.sessionId !== input.sessionId || existing.mode !== input.mode) {
          throw usageError(
            `requestId ${input.requestId} 已用于会话 ${existing.sessionId}，不能改投别的会话。`,
          )
        }
        if (existing.baseUrl !== input.baseUrl) {
          throw usageError(`requestId ${input.requestId} 已用于地址 ${existing.baseUrl}，不能改投别的地址。`)
        }
        if (existing.contentDigest !== digestOf(input.text)) {
          throw new BridgeError('request_id_content_conflict', `requestId ${input.requestId} 已用于不同内容，重发必须内容完全一致。`, {
            exitCode: EXIT.USAGE,
            details: { requestId: input.requestId },
          })
        }
        return { record: existing, created: false }
      }
      const record = RequestStore.build(input)
      await writeJsonAtomic(this.paths.request(input.requestId), record)
      return { record, created: true }
    })
  }

  /**
   * 在锁内读改写一条记录。
   * @param {string} requestId - 请求身份。
   * @param {(record: any) => any|Promise<any>} mutate - 变更函数。
   * @returns {Promise<any>} 更新后的记录。
   */
  async update(requestId, mutate) {
    return withLock(this.paths, 'requests', async () => {
      const current = await this.require(requestId)
      const next = (await mutate(structuredClone(current))) ?? current
      next.updatedAt = new Date().toISOString()
      await writeJsonAtomic(this.paths.request(requestId), next)
      return next
    })
  }

  /**
   * 写入一次提交尝试的结果，且**不覆盖更强证据**。
   *
   * 仅当当前状态仍是 `prepared` 或 `submission_unknown` 时才接受提交回执；
   * 若 `wait` 已经写入 `queued`/`running`/终态，则保留更强的状态。
   * @param {string} requestId - 请求身份。
   * @param {object} outcome - 提交结果。
   * @param {string} outcome.state - 候选状态。
   * @param {string} outcome.outcome - 记录到 attempts 的标签。
   * @param {{code: string, message: string}|null} [outcome.error] - 错误。
   * @returns {Promise<{record: any, applied: boolean}>} 记录与是否被接受。
   */
  async applySubmission(requestId, outcome) {
    return withLock(this.paths, 'requests', async () => {
      const current = await this.require(requestId)
      const attempt = { at: new Date().toISOString(), outcome: outcome.outcome, error: outcome.error?.code ?? null }
      const applicable = current.state === REQUEST_STATE.PREPARED
        || current.state === REQUEST_STATE.SUBMISSION_UNKNOWN
      const next = structuredClone(current)
      next.attempts = [...(next.attempts ?? []), attempt]
      if (applicable) {
        next.state = outcome.state
        next.submittedAt = new Date().toISOString()
        next.error = outcome.error ?? null
      } else {
        next.notes = [...(next.notes ?? []), {
          at: new Date().toISOString(),
          note: `提交回执 ${outcome.state} 未覆盖更强的本地状态 ${current.state}`,
        }]
      }
      next.updatedAt = new Date().toISOString()
      await writeJsonAtomic(this.paths.request(requestId), next)
      return { record: next, applied: applicable }
    })
  }

  /**
   * 写入一次观测结果（`wait` / `status --verify`），同样只允许单调前进。
   * @param {string} requestId - 请求身份。
   * @param {object} patch - 观测字段。
   * @returns {Promise<{record: any, applied: boolean}>} 记录与是否被接受。
   */
  async applyObservation(requestId, patch) {
    return withLock(this.paths, 'requests', async () => {
      const current = await this.require(requestId)
      const next = structuredClone(current)
      const applicable = patch.state === undefined || canAdvance(current.state, patch.state)
      if (applicable) {
        if (patch.state !== undefined) next.state = patch.state
        if (patch.cursor !== undefined) next.cursor = patch.cursor
        if (patch.promptSeq !== undefined) next.promptSeq = patch.promptSeq
        if (patch.turn !== undefined) next.turn = patch.turn
        if (patch.reason !== undefined) next.reason = patch.reason
        if (patch.reply !== undefined) next.reply = patch.reply
        if (patch.error !== undefined) next.error = patch.error
      }
      if (Array.isArray(patch.notes) && patch.notes.length > 0) {
        next.notes = [...(next.notes ?? []), ...patch.notes.map(note => ({ at: new Date().toISOString(), note }))]
      }
      next.updatedAt = new Date().toISOString()
      await writeJsonAtomic(this.paths.request(requestId), next)
      return { record: next, applied: applicable }
    })
  }

  /**
   * 追加一条备注（用于记录不确定性，而不是覆盖结果）。
   * @param {string} requestId - 请求身份。
   * @param {string} note - 备注。
   * @returns {Promise<any>} 更新后的记录。
   */
  async addNote(requestId, note) {
    return this.update(requestId, (record) => {
      record.notes = [...(record.notes ?? []), { at: new Date().toISOString(), note }]
      return record
    })
  }

  /**
   * 列出全部请求记录，按创建时间升序。
   * @returns {Promise<any[]>} 记录数组。
   */
  async list() {
    let entries
    try {
      entries = await readdir(this.paths.requests)
    } catch {
      return []
    }
    /** @type {any[]} */
    const records = []
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue
      const record = await readJson(join(this.paths.requests, entry), null)
      if (record !== null) records.push(record)
    }
    records.sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)))
    return records
  }

  /**
   * 触摸锁目录时间，避免长任务被误判为陈旧。
   * @param {string} name - 锁名。
   * @returns {Promise<void>} 完成后返回。
   */
  async touchLock(name) {
    const now = new Date()
    await utimes(join(this.paths.locks, `${name}.lock`), now, now).catch(() => {})
  }
}

/**
 * 生成一个新的请求身份。
 * @returns {string} UUID。
 */
export function newRequestId() {
  return randomUUID()
}

/**
 * 读取受保护文件（例如 `--file` 的任务文件）。
 * @param {string} file - 路径。
 * @returns {Promise<string>} 文件内容。
 */
export async function readTaskFile(file) {
  try {
    return await readFile(file, 'utf8')
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.code === 'ENOENT') {
      throw new BridgeError('task_file_missing', `任务文件不存在：${file}`, { exitCode: EXIT.USAGE, details: { file } })
    }
    throw error
  }
}
