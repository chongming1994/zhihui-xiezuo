/**
 * 请求 → 用户消息 → 回合 → 最终回复 的关联分析（纯函数，便于测试）。
 *
 * 关联链（每一步都要求持久日志证据）：
 * 1. `requestId` → `user/message` 事件的 `data.source.rpcId`：证明本次任务已进入会话。
 * 2. 该事件的 `seq` → 其前最近的 `turn/start`：得到所属回合号 `turn`。
 * 3. `turn` → `data.turn === turn` 的 `turn/end`：得到回合终态与原因。
 * 4. `turn` → `data.turn === turn` 的 `assistant/message`：得到该回合的助手消息。
 *
 * 未认领的排队消息落在 `agent/inbox/spliced` 的 `inserted` 里，用于区分
 * “已接受”与“已开始执行”。任何一步无法证明时返回 `uncertain`，绝不冒用其它回合的回复。
 *
 * 三种“证据不足”与“证据冲突”必须分开处理：
 * - `needsBackfill`：窗口外可能还有更早的证据（例如回合起点），调用方应先补页；
 * - `gaps`：日志存在未补齐的 seq 缺口，缺口内可能藏着影响归属的事件，禁止给出终态；
 * - `conflicts`：同一 seq 出现内容不同的事件，日志不可信，禁止给出终态。
 * @module zhihui-xiezuo/associate
 */

/** 分析阶段。 */
export const PHASE = {
  /** 日志里既没有排队记录也没有已认领的用户消息。 */
  NOT_FOUND: 'not_found',
  /** 在待发队列中（有 inbox 证据）。 */
  QUEUED: 'queued',
  /** 已被回合认领，回合尚未结束。 */
  RUNNING: 'running',
  /** 回合正常结束。 */
  COMPLETED: 'completed',
  /** 回合以错误或阻塞结束。 */
  FAILED: 'failed',
  /** 回合被取消，或排队消息被撤销。 */
  CANCELLED: 'cancelled',
  /** 存在日志证据但无法证明关联。 */
  UNCERTAIN: 'uncertain',
}

/** 回合结束原因 → 阶段映射（依据 `TurnEndReasonMap`）。 */
const REASON_PHASE = {
  completed: PHASE.COMPLETED,
  'max-tokens': PHASE.COMPLETED,
  aborted: PHASE.CANCELLED,
  error: PHASE.FAILED,
  blocked: PHASE.FAILED,
  interrupted: PHASE.FAILED,
  forked: PHASE.FAILED,
}

/**
 * 从内容块数组中抽取纯文本（忽略 reasoning / tool-call / image 等）。
 * @param {unknown} content - `ContentBlock[]`。
 * @returns {string} 以换行连接的文本。
 */
export function extractText(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter(block => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
}

/**
 * 计算事件的内容指纹：只取语义字段 `type` 与 `data`，忽略 `time` 等易变字段。
 * 用递归排序键的稳定序列化，避免键顺序造成假冲突。
 * @param {any} event - 会话事件。
 * @returns {string} 稳定指纹。
 */
export function canonicalEvent(event) {
  return stableStringify({ type: event?.type ?? null, data: event?.data ?? null })
}

/**
 * 稳定序列化（对象键排序）。
 * @param {unknown} value - 任意 JSON 值。
 * @returns {string} 稳定字符串。
 */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(item => stableStringify(item)).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
}

/**
 * 按 `seq` 去重的持久事件集合。重复按内容判定：同 seq 不同内容记为冲突。
 */
export class EventLog {
  constructor() {
    /** @type {Map<number, any>} */
    this.bySeq = new Map()
    /** @type {Map<number, string>} */
    this.fingerprints = new Map()
    /** @type {number|null} */
    this.maxSeq = null
    /** @type {number|null} */
    this.minSeq = null
    this.duplicates = 0
    this.conflicts = 0
    /** @type {number[]} */
    this.conflictSeqs = []
  }

  /**
   * 加入一个持久事件（`{type, seq, time, data}`）。
   * @param {any} event - 会话事件。
   * @returns {'new'|'duplicate'|'invalid'|'conflict'} 处理结果。
   */
  add(event) {
    if (event === null || typeof event !== 'object') return 'invalid'
    const seq = event.seq
    if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0) return 'invalid'
    if (typeof event.type !== 'string') return 'invalid'
    const fingerprint = canonicalEvent(event)
    const existing = this.bySeq.get(seq)
    if (existing !== undefined) {
      if (this.fingerprints.get(seq) === fingerprint) {
        this.duplicates += 1
        return 'duplicate'
      }
      this.conflicts += 1
      if (!this.conflictSeqs.includes(seq)) this.conflictSeqs.push(seq)
      return 'conflict'
    }
    this.bySeq.set(seq, event)
    this.fingerprints.set(seq, fingerprint)
    if (this.maxSeq === null || seq > this.maxSeq) this.maxSeq = seq
    if (this.minSeq === null || seq < this.minSeq) this.minSeq = seq
    return 'new'
  }

  /**
   * 按 seq 升序返回全部事件。
   * @returns {any[]} 事件数组。
   */
  events() {
    return [...this.bySeq.values()].sort((left, right) => left.seq - right.seq)
  }

  /**
   * 返回缺失的 seq（用于补页）。
   * @returns {number[]} 缺失序号，升序。
   */
  missingSeqs() {
    if (this.minSeq === null || this.maxSeq === null) return []
    /** @type {number[]} */
    const missing = []
    for (let seq = this.minSeq; seq <= this.maxSeq; seq += 1) {
      if (!this.bySeq.has(seq)) missing.push(seq)
    }
    return missing
  }

  /** @returns {boolean} 是否存在内容冲突。 */
  hasConflicts() {
    return this.conflicts > 0
  }

  /** @returns {number} 已记录事件数。 */
  get size() {
    return this.bySeq.size
  }
}

/**
 * 重放 `agent/inbox/spliced`，判断某个 requestId 的消息当前是否仍在待发队列，
 * 以及**能否证明**它被撤销了。
 *
 * 关键事实（`packages/core/agent-loop/src/inbox.ts:207-235`）：splice 的 `start` 是
 * **真实队列中的绝对下标**（`actualStart = offset < 0 ? max(len+offset,0) : min(offset, len)`），
 * `removedCount` 是真实删除数。因此：
 *
 * 1. 只要**看到**目标消息被某次 splice 插入，就能精确锚定它的绝对下标
 *    `start + offsetInInserted`，不需要知道队列更早的内容；
 * 2. 此后每次同队列 splice 都能按下标规则推进（落在移除区间内 → 被移除；
 *    在移除区间之后 → 下标减去 `removedCount` 再加上 `inserted.length`）；
 * 3. 唯一前提是**两次之间的事件没有被跳过** —— 这一点由调用方（`analyze` 的缺口门禁）
 *    保证：存在未补齐缺口时，终态一律降级为不确定。
 *
 * 因此「队列历史自空队列起是否完整」**不再**是判定撤销的前提；真正必要的是
 * 「看到插入」+「日志连续」。看不到插入（例如插入落在快照窗口之外）时不推断撤销。
 * @param {any[]} events - 按 seq 升序的事件。
 * @param {string} requestId - 请求身份。
 * @returns {{present: boolean, messageId: string|null, lastSeq: number|null, cancelled: boolean, indexTracked: boolean, target: string|null}} 队列状态。
 */
export function replayInbox(events, requestId) {
  /** @type {string|null} */
  let target = null
  /** @type {number|null} */
  let index = null
  let messageId = null
  let lastSeq = null
  let sawInsertion = false
  let removedByObservedSplice = false
  for (const event of events) {
    if (event.type !== 'agent/inbox/spliced') continue
    const data = event.data
    if (data === null || typeof data !== 'object') continue
    const spliceTarget = String(data.target ?? 'unknown')
    const start = Number.isInteger(data.start) ? data.start : 0
    const removedCount = Number.isInteger(data.removedCount) ? data.removedCount : 0
    const inserted = Array.isArray(data.inserted) ? data.inserted : []
    if (target !== null && spliceTarget === target && index !== null) {
      if (start <= index && index < start + removedCount) {
        removedByObservedSplice = true
        index = null
      } else if (index >= start + removedCount) {
        index += inserted.length - removedCount
      }
    }
    const offset = inserted.findIndex(message => message?.source?.rpcId === requestId)
    if (offset !== -1) {
      sawInsertion = true
      target = spliceTarget
      index = start + offset
      messageId = typeof inserted[offset]?.id === 'string' ? inserted[offset].id : null
      lastSeq = event.seq
      removedByObservedSplice = false
    }
  }
  const present = sawInsertion && index !== null
  return {
    present,
    messageId,
    lastSeq,
    // 只有「看到插入」+「被后续 splice 移除」才算撤销；看不到插入时一律不推断。
    cancelled: sawInsertion && !present && removedByObservedSplice,
    indexTracked: sawInsertion,
    target,
  }
}

/**
 * 分析日志，给出某 requestId 的关联结论。
 * @param {any[]} events - 按 seq 升序的持久事件。
 * @param {string} requestId - 请求身份。
 * @param {object} [options] - 证据完整性信息。
 * @param {number} [options.conflicts] - 同 seq 内容冲突数量。
 * @param {number[]} [options.gaps] - 未补齐的 seq 缺口。
 * @returns {object} 关联结果。
 */
export function analyze(events, requestId, options = {}) {
  const ordered = [...events].sort((left, right) => left.seq - right.seq)
  const result = analyzeEvidence(ordered, requestId)
  const conflicts = options.conflicts ?? 0
  const gaps = options.gaps ?? []
  // 证据完整性不足时禁止给出终态：宁可不确定，也不冒用回复。
  if (conflicts > 0 || gaps.length > 0) {
    if (isFinalPhase(result)) {
      const reasons = [...result.ambiguityReasons]
      if (conflicts > 0) reasons.push(`日志存在 ${conflicts} 处同 seq 内容冲突`)
      if (gaps.length > 0) reasons.push(`日志存在未补齐的缺口 seq ${gaps.slice(0, 20).join(', ')}${gaps.length > 20 ? ' …' : ''}`)
      return {
        ...result,
        phase: PHASE.UNCERTAIN,
        reply: null,
        candidateReply: result.reply,
        ambiguityReasons: reasons,
        detail: conflicts > 0
          ? '同 seq 事件内容冲突，日志不可信，无法证明关联'
          : '日志存在未补齐的缺口，缺口内可能有影响归属的事件，无法证明关联',
      }
    }
    result.ambiguityReasons = [...result.ambiguityReasons, ...conflicts > 0
      ? [`日志存在 ${conflicts} 处同 seq 内容冲突`]
      : [`日志存在未补齐的缺口 seq ${gaps.slice(0, 20).join(', ')}`]]
  }
  return result
}

/**
 * 在证据自洽的前提下做关联分析（不处理 gaps/conflicts）。
 * @param {any[]} ordered - 升序事件。
 * @param {string} requestId - 请求身份。
 * @returns {object} 关联结果。
 */
function analyzeEvidence(ordered, requestId) {
  const prompt = ordered.find(event =>
    event.type === 'user/message' && event.data?.source?.rpcId === requestId)
  const inbox = replayInbox(ordered, requestId)

  if (prompt === undefined) {
    if (inbox.present) {
      return base(requestId, PHASE.QUEUED, {
        detail: '消息已在待发队列，尚未被回合认领',
        inboxSeq: inbox.lastSeq,
        messageId: inbox.messageId,
      })
    }
    if (inbox.cancelled) {
      return base(requestId, PHASE.CANCELLED, {
        detail: '排队消息已被撤销（由 splice 重放证明该 messageId 被移除）',
        inboxSeq: inbox.lastSeq,
        messageId: inbox.messageId,
      })
    }
    return base(requestId, PHASE.NOT_FOUND, { detail: '日志中没有该 requestId 的任何证据' })
  }

  const promptSeq = prompt.seq
  const turnStart = lastBefore(ordered, promptSeq, event => event.type === 'turn/start')
  if (turnStart === undefined) {
    // 回合起点可能落在快照窗口之外：标记为可补页，而不是直接判不确定。
    return base(requestId, PHASE.UNCERTAIN, {
      detail: `在 seq ${promptSeq} 之前找不到 turn/start，需补页确认所属回合`,
      promptSeq,
      messageId: typeof prompt.data?.id === 'string' ? prompt.data.id : null,
      needsBackfill: true,
    })
  }
  const turn = turnStart.data?.turn
  if (typeof turn !== 'number') {
    return base(requestId, PHASE.UNCERTAIN, {
      detail: 'turn/start 缺少 turn 字段',
      promptSeq,
      turnStartSeq: turnStart.seq,
    })
  }

  const turnEnd = ordered.find(event =>
    event.type === 'turn/end' && event.data?.turn === turn && event.seq > promptSeq)
  const windowEnd = turnEnd === undefined ? Number.POSITIVE_INFINITY : turnEnd.seq
  const assistants = ordered.filter(event =>
    event.type === 'assistant/message' && event.data?.turn === turn
    && event.seq > turnStart.seq && event.seq < windowEnd)

  // 同一回合内的其它“人类提示”：带不同 rpcId，或 kind==='user' 但没有 rpcId。
  const otherPrompts = ordered.filter((event) => {
    if (event.type !== 'user/message') return false
    if (event.seq <= turnStart.seq || event.seq >= windowEnd) return false
    if (event.seq === promptSeq) return false
    const source = event.data?.source
    return source?.kind === 'user'
  })

  const replyEvent = assistants.length === 0 ? undefined : assistants[assistants.length - 1]
  const replyText = replyEvent === undefined ? null : extractText(replyEvent.data?.message?.content)
  const ambiguityReasons = []
  if (otherPrompts.length > 0) {
    ambiguityReasons.push(`同一回合内还有 ${otherPrompts.length} 条其它用户消息（seq ${otherPrompts.map(e => e.seq).join(', ')}）`)
  }
  if (assistants.length > 1) {
    ambiguityReasons.push(`同一回合内有 ${assistants.length} 条助手消息，已取最后一条`)
  }
  if (replyEvent !== undefined && replyEvent.data?.interrupted === true) {
    ambiguityReasons.push('最后一条助手消息标记为 interrupted')
  }

  const result = base(requestId, PHASE.RUNNING, {
    promptSeq,
    turn,
    turnStartSeq: turnStart.seq,
    messageId: typeof prompt.data?.id === 'string' ? prompt.data.id : null,
    assistantSeqs: assistants.map(event => event.seq),
    ambiguityReasons,
  })

  if (turnEnd === undefined) {
    result.detail = `回合 ${turn} 尚未结束`
    return result
  }

  const reason = turnEnd.data?.reason ?? { kind: 'unknown' }
  const phase = REASON_PHASE[reason.kind] ?? PHASE.UNCERTAIN
  result.turnEndSeq = turnEnd.seq
  result.reason = reason
  result.detail = `回合 ${turn} 以 ${String(reason.kind)} 结束`
  // 同一回合里还有别的用户消息时，该回合的助手回复不能唯一归属于本请求：
  // 明确返回“不确定”，只给出候选回复，不冒用。
  if (otherPrompts.length > 0 && phase === PHASE.COMPLETED) {
    result.phase = PHASE.UNCERTAIN
    result.candidateReply = replyText === null
      ? null
      : { text: replyText, seq: replyEvent.seq, turn, step: replyEvent.data?.step ?? null }
    result.detail = `回合 ${turn} 内有其它用户消息，无法把该回合的回复唯一归属于本请求`
    return result
  }
  result.phase = phase
  if (phase === PHASE.COMPLETED && replyText === null) {
    result.ambiguityReasons = [...ambiguityReasons, '回合正常结束但没有助手文本消息']
  }
  result.reply = replyText === null
    ? null
    : {
      text: replyText,
      seq: replyEvent.seq,
      messageId: typeof replyEvent.data?.message?.id === 'string' ? replyEvent.data.message.id : null,
      turn,
      step: replyEvent.data?.step ?? null,
    }
  return result
}

/**
 * 构造结果骨架。
 * @param {string} requestId - 请求身份。
 * @param {string} phase - 阶段。
 * @param {object} extra - 附加字段。
 * @returns {any} 结果。
 */
function base(requestId, phase, extra = {}) {
  return {
    requestId,
    phase,
    promptSeq: null,
    turn: null,
    turnStartSeq: null,
    turnEndSeq: null,
    reason: null,
    reply: null,
    candidateReply: null,
    assistantSeqs: [],
    ambiguityReasons: [],
    /** 需要更多历史证据才能判定（调用方应先补页）。 */
    needsBackfill: false,
    ...extra,
  }
}

/**
 * 在给定 seq 之前查找最后一个满足条件的事件。
 * @param {any[]} ordered - 升序事件。
 * @param {number} seq - 上界（不含）。
 * @param {(event: any) => boolean} predicate - 判定。
 * @returns {any|undefined} 命中事件。
 */
function lastBefore(ordered, seq, predicate) {
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const event = ordered[index]
    if (event.seq >= seq) continue
    if (predicate(event)) return event
  }
  return undefined
}

/**
 * 判断分析结果是否已是终态（可停止等待）。
 *
 * `needsBackfill` 为真时**不是**终态：调用方应先补页再重新判定。
 * @param {any} result - {@link analyze} 的结果。
 * @returns {boolean} 终态为 true。
 */
export function isFinalPhase(result) {
  if (result?.needsBackfill === true) return false
  return result.phase === PHASE.COMPLETED
    || result.phase === PHASE.FAILED
    || result.phase === PHASE.CANCELLED
    || result.phase === PHASE.UNCERTAIN
}
