/**
 * 针对 Codex 首轮复查（`05-Codex复查与修复要求.md`）所报缺陷的回归测试。
 *
 * 覆盖：R1 断线缺口、R2 地址与凭据边界、R3 窗口外证据补页、
 * R4 撤销归属、R5 事件内容冲突，以及额外的请求记录并发审查点。
 *
 * 这些测试全部针对模拟服务；模拟通过不等于实机通过。
 * @module zhihui-xiezuo/test/review-fixes
 */

import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { MockDsh } from './mock-dsh.js'
import { makeTempHome, runCli, writeTaskFile, writeTokenFile } from './helpers.js'
import { EXIT } from '../src/errors.js'
import { Paths, ensureHome, readCredential } from '../src/config.js'
import { assertRedirectStaysLocal, authorityOf, DshApi, isLoopbackHost, normalizeBaseUrl } from '../src/rpc.js'
import { digestOf, RequestStore, REQUEST_STATE } from '../src/store.js'
import { analyze, EventLog, isFinalPhase, PHASE } from '../src/associate.js'

/**
 * 建立已认证并已绑定的模拟环境。
 * @param {object} [options] - 传给 MockDsh 的选项。
 * @returns {Promise<{mock: MockDsh, home: string, baseUrl: string}>} 环境。
 */
async function ready(options = {}) {
  const mock = new MockDsh({ autoRun: false, ...options })
  const home = await makeTempHome()
  const { baseUrl, token } = await mock.start()
  const tokenFile = await writeTokenFile(home, token)
  const auth = await runCli(['auth', '--url', baseUrl, '--token-file', tokenFile], home)
  assert.equal(auth.exitCode, EXIT.OK, auth.stderr)
  const bind = await runCli(['bind', 'sess-alpha', '--url', baseUrl], home)
  assert.equal(bind.exitCode, EXIT.OK, bind.stderr)
  return { mock, home, baseUrl }
}

/**
 * 清理环境。
 * @param {{mock: MockDsh, home: string}} env - 环境。
 * @returns {Promise<void>} 完成后返回。
 */
async function cleanup(env) {
  for (const client of env.mock.wss?.clients ?? []) client.terminate()
  await env.mock.stop()
  await rm(env.home, { recursive: true, force: true })
}

/**
 * 用 mock 覆盖 mux：第一次订阅只发前半段快照后断开，第二次订阅发后半段。
 *
 * 两次快照各自连续，但中间缺少若干 seq —— 正是断线重连留下的内部缺口。
 * @param {MockDsh} mock - 模拟服务。
 * @param {number} headLength - 首帧快照条数。
 * @param {number} tailLength - 重连快照条数。
 * @returns {void}
 */
function installGapMux(mock, headLength, tailLength) {
  mock.handleMux = (ws, raw) => {
    const frame = JSON.parse(raw)
    if (frame.type !== 'open' || frame.endpoint !== 'session/follow') return
    mock.followOpens += 1
    ws.streamId = frame.streamId
    const events = mock.logs.get('sess-alpha') ?? []
    const first = mock.followOpens === 1
    const window = first ? events.slice(0, headLength) : events.slice(-tailLength)
    ws.send(JSON.stringify({
      type: 'item',
      streamId: frame.streamId,
      value: {
        type: 'snapshot',
        cursor: window.at(-1)?.seq ?? 0,
        records: window.map(event => ({ type: 'event', event })),
        hasMore: true,
      },
    }))
    if (first) setTimeout(() => ws.terminate(), 5)
  }
}

// ───────────────────────── R1：断线缺口 ─────────────────────────

test('R1：重连快照之间留下缺口时必须补页，不得直接宣称完成', async () => {
  const env = await ready()
  const { mock, home, baseUrl } = env
  try {
    const file = await writeTaskFile(home, 'task.md', '缺口场景')
    const sent = await runCli(['send', '--file', file, '--url', baseUrl, '--json'], home)
    const requestId = sent.json.requestId
    // 同一回合内还有别的用户插话，且插话事件正好落在两次快照之间的缺口里。
    mock.runTurn('sess-alpha', requestId, { withUserInterjection: true })
    const total = mock.logs.get('sess-alpha').length
    // 前半段 3 条（含目标 user/message），后半段 3 条（assistant/step/end/turn/end）。
    installGapMux(mock, 3, 3)

    const waited = await runCli(['wait', requestId, '--url', baseUrl, '--timeout', '1500', '--json'], home)
    const pages = mock.requestCounts.get('session/page') ?? 0
    // 修复前：completed / exit 0 / 0 次补页（错误地把插话藏起来并宣称回复唯一归属）。
    assert.ok(pages > 0, '必须发起补页来修复内部缺口')
    assert.equal(waited.json.unresolvedGaps, 0, '缺口应被补齐')
    assert.notEqual(waited.json.phase, 'completed', '缺口内有插话时不得宣称完成')
    assert.equal(waited.json.phase, 'uncertain')
    assert.equal(waited.json.reply, null)
    assert.equal(waited.exitCode, EXIT.UNCERTAIN)
    assert.ok(total >= 6, `构造场景至少需要 6 条事件，实际 ${total}`)
  } finally {
    await cleanup(env)
  }
})

test('R1：缺口内没有插话时补页后仍能正确完成', async () => {
  const env = await ready()
  const { mock, home, baseUrl } = env
  try {
    const file = await writeTaskFile(home, 'task.md', '干净缺口')
    const sent = await runCli(['send', '--file', file, '--url', baseUrl, '--json'], home)
    const requestId = sent.json.requestId
    mock.runTurn('sess-alpha', requestId)
    installGapMux(mock, 3, 3)

    const waited = await runCli(['wait', requestId, '--url', baseUrl, '--timeout', '1500', '--json'], home)
    assert.ok((mock.requestCounts.get('session/page') ?? 0) > 0)
    assert.equal(waited.json.unresolvedGaps, 0)
    assert.equal(waited.json.phase, 'completed', waited.stdout)
    assert.equal(waited.json.reply.text, '连接成功')
    assert.equal(waited.exitCode, EXIT.OK)
  } finally {
    await cleanup(env)
  }
})

test('R1：补页失败且缺口未补齐时不得给出终态', async () => {
  const env = await ready()
  const { mock, home, baseUrl } = env
  try {
    const file = await writeTaskFile(home, 'task.md', '补页失败')
    const sent = await runCli(['send', '--file', file, '--url', baseUrl, '--json'], home)
    const requestId = sent.json.requestId
    mock.runTurn('sess-alpha', requestId)
    installGapMux(mock, 3, 3)
    mock.behavior.pageFailures = 100

    const waited = await runCli(['wait', requestId, '--url', baseUrl, '--timeout', '1500', '--json'], home)
    assert.ok(waited.json.unresolvedGaps > 0, '缺口应仍未补齐')
    assert.equal(waited.json.phase, 'uncertain')
    assert.equal(waited.json.reply, null)
    assert.equal(waited.exitCode, EXIT.UNCERTAIN)
  } finally {
    await cleanup(env)
  }
})

// ───────────────────────── R2：地址与凭据边界 ─────────────────────────

test('R2：normalizeBaseUrl 拒绝非环回地址、userinfo、路径与查询串', () => {
  assert.throws(() => normalizeBaseUrl('https://example.invalid'), /只允许本机环回地址/u)
  assert.throws(() => normalizeBaseUrl('http://10.0.0.5:3080'), /只允许本机环回地址/u)
  assert.throws(() => normalizeBaseUrl('http://user:pass@127.0.0.1:3080'), /userinfo/u)
  assert.throws(() => normalizeBaseUrl('http://127.0.0.1:3080/api'), /不得带路径/u)
  assert.throws(() => normalizeBaseUrl('http://127.0.0.1:3080/?token=x'), /查询串/u)
  assert.throws(() => normalizeBaseUrl('ftp://127.0.0.1'), /只支持 http\/https/u)
  assert.equal(normalizeBaseUrl('http://127.0.0.1:3080/'), 'http://127.0.0.1:3080')
  assert.equal(normalizeBaseUrl('http://localhost:3080'), 'http://localhost:3080')
  assert.equal(isLoopbackHost('::1'), true)
  assert.equal(isLoopbackHost('example.invalid'), false)
})

test('R2：凭据 authority 与目标地址不一致时在发请求之前失败', async () => {
  let fetchCalls = 0
  const build = () => new DshApi({
    baseUrl: 'http://127.0.0.1:3080',
    credential: { authority: '127.0.0.1:9999', cookieName: 'dsh-auth-x', cookieValue: 'v1.a.b' },
    fetchImpl: async () => { fetchCalls += 1; throw new Error('不应被调用') },
  })
  // 构造阶段即失败：根本拿不到可以发请求的客户端。
  assert.throws(build, (error) => error.code === 'credential_authority_mismatch')
  assert.equal(fetchCalls, 0, '不匹配的凭据绝不能发出任何请求')
})

test('R2：非环回地址在发出任何请求之前被拒绝', async () => {
  let fetchCalls = 0
  assert.throws(() => new DshApi({
    baseUrl: 'https://example.invalid',
    credential: { authority: '127.0.0.1:3080', cookieName: 'dsh-auth-x', cookieValue: 'v1.a.b' },
    fetchImpl: async () => { fetchCalls += 1 },
  }), /只允许本机环回地址/u)
  assert.equal(fetchCalls, 0)
})

test('R2：令牌交换的重定向不得越过本机边界', () => {
  assert.doesNotThrow(() => assertRedirectStaysLocal('./', 'http://127.0.0.1:3080'))
  assert.doesNotThrow(() => assertRedirectStaysLocal('http://127.0.0.1:3080/', 'http://127.0.0.1:3080'))
  assert.throws(() => assertRedirectStaysLocal('http://evil.example/', 'http://127.0.0.1:3080'), /本机之外/u)
  assert.throws(() => assertRedirectStaysLocal('http://127.0.0.1:9999/', 'http://127.0.0.1:3080'), /本机之外/u)
})

test('R2：CLI 拒绝非环回 --url，且不会用到任何凭据', async () => {
  const home = await makeTempHome()
  try {
    const check = await runCli(['check', '--url', 'http://10.0.0.5:3080', '--json'], home)
    assert.equal(check.exitCode, EXIT.USAGE)
    assert.equal(check.json.error.code, 'non_loopback_url')
    const auth = await runCli(['auth', '--url', 'https://example.invalid', '--token-file', '/nonexistent', '--json'], home)
    assert.equal(auth.exitCode, EXIT.USAGE)
    assert.equal(auth.json.error.code, 'non_loopback_url')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('R2：绑定属于别的地址时 send 失败关闭，不复用旧 Cookie', async () => {
  const env = await ready()
  const { mock, home, baseUrl } = env
  try {
    const file = await writeTaskFile(home, 'task.md', '地址不匹配')
    // 伪造一个指向别的 authority 的绑定。
    const paths = new Paths(home)
    const store = new RequestStore(paths)
    const configPath = paths.config
    const { readJson, writeJsonAtomic } = await import('../src/config.js')
    const config = await readJson(configPath, {})
    config.bound = { sessionId: 'sess-alpha', baseUrl: 'http://127.0.0.1:1', boundAt: new Date().toISOString() }
    await writeJsonAtomic(configPath, config)
    const sent = await runCli(['send', '--file', file, '--url', baseUrl, '--json'], home)
    assert.equal(sent.exitCode, EXIT.USAGE)
    assert.equal(sent.json.error.code, 'bound_address_mismatch')
    // 显式 --session 时不受旧绑定影响，但仍要求凭据 authority 匹配（此处匹配）。
    const explicit = await runCli(['send', '--file', file, '--session', 'sess-alpha', '--url', baseUrl, '--json'], home)
    assert.equal(explicit.exitCode, EXIT.OK, explicit.stderr)
    assert.equal((await store.list()).length, 1)
  } finally {
    await cleanup(env)
  }
})

test('R2：请求记录属于别的地址时 wait 失败关闭', async () => {
  const env = await ready()
  const { home, baseUrl } = env
  try {
    const file = await writeTaskFile(home, 'task.md', '记录地址不匹配')
    const sent = await runCli(['send', '--file', file, '--url', baseUrl, '--json'], home)
    const paths = new Paths(home)
    const { readJson, writeJsonAtomic } = await import('../src/config.js')
    const recordPath = paths.request(sent.json.requestId)
    const record = await readJson(recordPath, null)
    record.baseUrl = 'http://127.0.0.1:1'
    await writeJsonAtomic(recordPath, record)
    const waited = await runCli(['wait', sent.json.requestId, '--url', baseUrl, '--timeout', '500', '--json'], home)
    assert.equal(waited.exitCode, EXIT.USAGE)
    assert.equal(waited.json.error.code, 'request_address_mismatch')
  } finally {
    await cleanup(env)
  }
})

test('R2：auth 换到别的 authority 时清除旧绑定', async () => {
  const first = await ready()
  try {
    // 用第二个实例（不同端口 → 不同 authority）重新 auth。
    const second = new MockDsh({ autoRun: false })
    const { baseUrl: secondUrl, token: secondToken } = await second.start()
    try {
      const tokenFile = await writeTokenFile(first.home, secondToken)
      const auth = await runCli(['auth', '--url', secondUrl, '--token-file', tokenFile, '--json'], first.home)
      assert.equal(auth.exitCode, EXIT.OK, auth.stderr)
      assert.equal(auth.json.bindingCleared, true)
      const { readConfig } = await import('../src/config.js')
      const config = await readConfig(new Paths(first.home))
      assert.equal(config.bound, null)
      assert.equal(config.baseUrl, secondUrl)
    } finally {
      await second.stop()
    }
  } finally {
    await cleanup(first)
  }
})

// ───────────────────────── R3：窗口外证据补页 ─────────────────────────

test('R3：目标消息在窗口内、回合起点在窗口外时按需补页并完成', async () => {
  const env = await ready({ maxMessages: 2 })
  const { mock, home, baseUrl } = env
  try {
    const file = await writeTaskFile(home, 'task.md', '窗口内目标')
    const sent = await runCli(['send', '--file', file, '--url', baseUrl, '--json'], home)
    const requestId = sent.json.requestId
    mock.runTurn('sess-alpha', requestId)
    const waited = await runCli(['wait', requestId, '--url', baseUrl, '--timeout', '1500', '--json'], home)
    // 修复前：直接判 uncertain / exit 6 / 0 次补页。
    assert.ok((mock.requestCounts.get('session/page') ?? 0) > 0, '必须补页取回回合起点')
    assert.equal(waited.json.phase, 'completed', waited.stdout)
    assert.equal(waited.json.reply.text, '连接成功')
    assert.equal(waited.exitCode, EXIT.OK)
  } finally {
    await cleanup(env)
  }
})

test('R3：目标完全在窗口外时立即补页，不耗尽等待上限', async () => {
  const env = await ready({ maxMessages: 1 })
  const { mock, home, baseUrl } = env
  try {
    const file = await writeTaskFile(home, 'task.md', '窗口外目标')
    const sent = await runCli(['send', '--file', file, '--url', baseUrl, '--json'], home)
    const requestId = sent.json.requestId
    mock.runTurn('sess-alpha', requestId)
    const started = Date.now()
    const waited = await runCli(['wait', requestId, '--url', baseUrl, '--timeout', '30000', '--json'], home)
    const elapsed = Date.now() - started
    assert.equal(waited.json.phase, 'completed', waited.stdout)
    assert.equal(waited.exitCode, EXIT.OK)
    assert.ok(elapsed < 10_000, `应立即补页而不是等满超时，实际 ${elapsed} ms`)
  } finally {
    await cleanup(env)
  }
})

test('R3：status --verify 同样会补页取回回合起点', async () => {
  const env = await ready({ maxMessages: 1 })
  const { mock, home, baseUrl } = env
  try {
    const file = await writeTaskFile(home, 'task.md', 'verify 补页')
    const sent = await runCli(['send', '--file', file, '--url', baseUrl, '--json'], home)
    const requestId = sent.json.requestId
    mock.runTurn('sess-alpha', requestId)
    const status = await runCli(['status', requestId, '--url', baseUrl, '--verify', '--json'], home)
    assert.equal(status.exitCode, EXIT.OK, status.stderr)
    assert.equal(status.json.verify.phase, 'completed', status.stdout)
    assert.ok((mock.requestCounts.get('session/page') ?? 0) > 0)
  } finally {
    await cleanup(env)
  }
})

// ───────────────────────── R5：事件内容冲突 ─────────────────────────

test('R5：同 seq 同内容算重复、同 seq 不同内容算冲突', () => {
  const log = new EventLog()
  const event = { type: 'user/message', seq: 1, data: { source: { rpcId: 'one' } } }
  assert.equal(log.add(event), 'new')
  assert.equal(log.add({ type: 'user/message', seq: 1, data: { source: { rpcId: 'one' } } }), 'duplicate')
  assert.equal(log.conflicts, 0)
  assert.equal(log.add({ type: 'user/message', seq: 1, data: { source: { rpcId: 'two' } } }), 'conflict')
  assert.equal(log.conflicts, 1)
  assert.deepEqual(log.conflictSeqs, [1])
  // 类型不同也是冲突。
  assert.equal(log.add({ type: 'assistant/message', seq: 1, data: { source: { rpcId: 'one' } } }), 'conflict')
  assert.equal(log.conflicts, 2)
  // 键顺序不同但内容相同不算冲突。
  const ordered = new EventLog()
  ordered.add({ type: 'x', seq: 2, data: { a: 1, b: 2 } })
  assert.equal(ordered.add({ type: 'x', seq: 2, data: { b: 2, a: 1 } }), 'duplicate')
  assert.equal(ordered.conflicts, 0)
})

test('R5：存在内容冲突时不得给出终态，只能不确定', () => {
  const events = [
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    { type: 'user/message', seq: 2, data: { id: 'm1', source: { kind: 'user', rpcId: 'r' } } },
    { type: 'assistant/message', seq: 3, data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '回复' }] } } },
    { type: 'turn/end', seq: 4, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  const clean = analyze(events, 'r')
  assert.equal(clean.phase, PHASE.COMPLETED)
  assert.equal(clean.reply.text, '回复')
  const conflicted = analyze(events, 'r', { conflicts: 1 })
  assert.equal(conflicted.phase, PHASE.UNCERTAIN)
  assert.equal(conflicted.reply, null)
  assert.equal(conflicted.candidateReply.text, '回复')
  assert.equal(isFinalPhase(conflicted), true)
  // 有缺口时同样不得给出终态。
  const gapped = analyze(events, 'r', { gaps: [3] })
  assert.equal(gapped.phase, PHASE.UNCERTAIN)
  assert.equal(gapped.reply, null)
})

test('R5：wait 观测到同 seq 冲突事件时返回不确定', async () => {
  const env = await ready()
  const { mock, home, baseUrl } = env
  try {
    const file = await writeTaskFile(home, 'task.md', '冲突场景')
    const sent = await runCli(['send', '--file', file, '--url', baseUrl, '--json'], home)
    const requestId = sent.json.requestId
    mock.runTurn('sess-alpha', requestId)
    const events = mock.logs.get('sess-alpha')
    const victim = events.find(event => event.type === 'user/message')
    mock.handleMux = (ws, raw) => {
      const frame = JSON.parse(raw)
      if (frame.type !== 'open' || frame.endpoint !== 'session/follow') return
      mock.followOpens += 1
      ws.streamId = frame.streamId
      const records = events.map(event => ({ type: 'event', event }))
      records.push({
        type: 'event',
        event: { ...victim, data: { ...victim.data, content: [{ type: 'text', text: '被篡改的内容' }] } },
      })
      ws.send(JSON.stringify({
        type: 'item',
        streamId: frame.streamId,
        value: { type: 'snapshot', cursor: events.at(-1).seq, records, hasMore: false },
      }))
    }
    const waited = await runCli(['wait', requestId, '--url', baseUrl, '--timeout', '1500', '--json'], home)
    assert.equal(waited.json.conflictsDetected, 1)
    assert.equal(waited.json.phase, 'uncertain')
    assert.equal(waited.json.reply, null)
    assert.equal(waited.exitCode, EXIT.UNCERTAIN)
  } finally {
    await cleanup(env)
  }
})

// ───────────────────────── 并发：请求记录 ─────────────────────────

test('并发：同 requestId 不同内容并发创建只有一次成功', async () => {
  const home = await makeTempHome()
  try {
    const paths = new Paths(home)
    await ensureHome(paths)
    const store = new RequestStore(paths)
    const base = { requestId: 'race-1', sessionId: 's1', baseUrl: 'http://127.0.0.1:3080', mode: 'queue' }
    const results = await Promise.allSettled([
      store.createOrGet({ ...base, text: '内容 A' }),
      store.createOrGet({ ...base, text: '内容 B' }),
    ])
    const fulfilled = results.filter(result => result.status === 'fulfilled')
    assert.equal(fulfilled.length, 1, '只能有一次成功')
    assert.equal(results.filter(result => result.status === 'rejected').length, 1)
    const final = await store.require('race-1')
    assert.equal(final.text, fulfilled[0].value.record.text)
    assert.equal(final.contentDigest, digestOf(final.text))
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('并发：同 requestId 不同会话并发创建只有一次成功', async () => {
  const home = await makeTempHome()
  try {
    const paths = new Paths(home)
    await ensureHome(paths)
    const store = new RequestStore(paths)
    const base = { requestId: 'race-2', baseUrl: 'http://127.0.0.1:3080', mode: 'queue', text: '同一份内容' }
    const results = await Promise.allSettled([
      store.createOrGet({ ...base, sessionId: 'sess-alpha' }),
      store.createOrGet({ ...base, sessionId: 'sess-beta' }),
    ])
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
    const final = await store.require('race-2')
    assert.ok(['sess-alpha', 'sess-beta'].includes(final.sessionId))
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('并发：提交回执不得覆盖更强的观测状态', async () => {
  const home = await makeTempHome()
  try {
    const paths = new Paths(home)
    await ensureHome(paths)
    const store = new RequestStore(paths)
    const base = { requestId: 'race-3', sessionId: 's1', baseUrl: 'http://127.0.0.1:3080', mode: 'queue', text: 't' }
    await store.createOrGet(base)
    await store.applyObservation('race-3', { state: REQUEST_STATE.COMPLETED })
    const late = await store.applySubmission('race-3', { state: REQUEST_STATE.SUBMITTED, outcome: 'submitted' })
    assert.equal(late.applied, false)
    assert.equal((await store.require('race-3')).state, REQUEST_STATE.COMPLETED)
    // 反向：状态仍是 prepared 时，提交回执必须生效。
    await store.createOrGet({ ...base, requestId: 'race-4' })
    const early = await store.applySubmission('race-4', { state: REQUEST_STATE.SUBMITTED, outcome: 'submitted' })
    assert.equal(early.applied, true)
    assert.equal((await store.require('race-4')).state, REQUEST_STATE.SUBMITTED)
    // 观测到 queued 比“仅拿到提交回执”更强，允许前进。
    const forward = await store.applyObservation('race-4', { state: REQUEST_STATE.QUEUED })
    assert.equal(forward.applied, true)
    assert.equal((await store.require('race-4')).state, REQUEST_STATE.QUEUED)
    // 但不允许从 queued 回退到 submitted。
    const back = await store.applyObservation('race-4', { state: REQUEST_STATE.SUBMITTED })
    assert.equal(back.applied, false)
    assert.equal((await store.require('race-4')).state, REQUEST_STATE.QUEUED)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('并发：send 的回执晚于 wait 的终态时不回退状态', async () => {
  const env = await ready({ promptDelayMs: 700 })
  const { mock, home, baseUrl } = env
  try {
    const requestId = randomUUID()
    // 先让日志里已经存在该 requestId 的完整回合，wait 才能先完成。
    mock.enqueue({ sessionId: 'sess-alpha', requestId, content: [{ type: 'text', text: '并发任务' }] })
    mock.runTurn('sess-alpha', requestId)
    const file = await writeTaskFile(home, 'task.md', '并发任务')
    const sending = runCli([
      'send', '--file', file, '--request-id', requestId, '--url', baseUrl, '--json',
    ], home)
    // 等 send 落盘并进入 HTTP 等待（mock 会延迟 700 ms 才回执）。
    await new Promise(resolve => setTimeout(resolve, 120))
    const waited = await runCli(['wait', requestId, '--url', baseUrl, '--timeout', '5000', '--json'], home)
    assert.equal(waited.json.phase, 'completed', waited.stdout)
    const sent = await sending
    assert.equal(sent.exitCode, EXIT.OK, sent.stderr)
    const store = new RequestStore(new Paths(home))
    const record = await store.require(requestId)
    assert.equal(record.state, REQUEST_STATE.COMPLETED, '晚到的提交回执不得把终态回退成 submitted')
    assert.equal(record.reply.text, '连接成功')
  } finally {
    await cleanup(env)
  }
})

// ───────────────────── R6：普通 RPC 的重定向边界 ─────────────────────

/**
 * 建立「重定向源 + 记录型目标」两个环回服务，用于验证请求不会跨地址转发。
 * @param {number} status - 源服务返回的 3xx 状态码。
 * @param {boolean} [selfTarget] - Location 是否指回源服务自身（同 authority）。
 * @returns {Promise<{seen: {targetRequests: number, sourceRequests: number, taskBody: boolean, cookie: boolean}, baseUrl: string, close: () => Promise<void>}>} 环境。
 */
async function makeRedirectPair(status, selfTarget = false) {
  const seen = { targetRequests: 0, sourceRequests: 0, targetTaskBody: false, targetCookie: false, sourceTaskBody: false }
  const target = createServer((req, res) => {
    seen.targetRequests += 1
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      if (body.includes('synthetic-task-marker')) seen.targetTaskBody = true
      if (String(req.headers.cookie ?? '').includes('dummy')) seen.targetCookie = true
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
    })
  })
  await new Promise(resolve => target.listen(0, '127.0.0.1', resolve))
  const targetPort = target.address().port
  const source = createServer((req, res) => {
    seen.sourceRequests += 1
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      if (body.includes('synthetic-task-marker')) seen.sourceTaskBody = true
      const port = selfTarget ? source.address().port : targetPort
      res.writeHead(status, { location: `http://127.0.0.1:${port}/api/session/prompt` })
      res.end()
    })
  })
  await new Promise(resolve => source.listen(0, '127.0.0.1', resolve))
  return {
    seen,
    baseUrl: `http://127.0.0.1:${source.address().port}`,
    close: async () => {
      await Promise.all([
        new Promise(resolve => source.close(resolve)),
        new Promise(resolve => target.close(resolve)),
      ])
    },
  }
}

/**
 * 对给定地址发一次带正文的 RPC，返回错误。
 * @param {string} baseUrl - 地址。
 * @returns {Promise<any>} 捕获到的错误（成功时为 null）。
 */
async function callPromptExpectingError(baseUrl) {
  const api = new DshApi({
    baseUrl,
    credential: { authority: authorityOf(baseUrl), baseUrl, cookieName: 'synthetic', cookieValue: 'dummy' },
  })
  return await api.call('session/prompt', {
    request: {
      requestId: 'synthetic',
      sessionId: 'synthetic',
      mode: 'queue',
      content: [{ type: 'text', text: 'synthetic-task-marker' }],
    },
  }).then(() => null, error => error)
}

for (const status of [301, 302, 303, 307, 308]) {
  test(`R6：普通 RPC 的 HTTP ${status} 重定向被拒绝，目标地址收不到任何请求`, async () => {
    const pair = await makeRedirectPair(status)
    try {
      const error = await callPromptExpectingError(pair.baseUrl)
      assert.equal(error?.code, 'redirect_refused')
      assert.equal(error?.exitCode, EXIT.AUTH)
      assert.equal(error?.details?.redirectFollowed, false)
      assert.equal(error?.details?.status, status)
      // 修复前：Node fetch 默认 follow，会把 POST 正文转发到 Location 指向的地址。
      assert.equal(pair.seen.targetRequests, 0, '重定向目标不得收到任何请求')
      assert.equal(pair.seen.targetTaskBody, false, '任务正文不得跨地址转发')
      assert.equal(pair.seen.targetCookie, false, '凭据不得跨地址转发')
      assert.equal(pair.seen.sourceTaskBody, true, '正文只应到达最初那一个地址')
    } finally {
      await pair.close()
    }
  })
}

test('R6：同 authority 的重定向同样被拒绝（不做任何跟随）', async () => {
  const pair = await makeRedirectPair(307, true)
  try {
    const error = await callPromptExpectingError(pair.baseUrl)
    assert.equal(error?.code, 'redirect_refused')
    assert.equal(pair.seen.sourceRequests, 1, '只允许发生最初那一次请求，不得跟随重定向')
  } finally {
    await pair.close()
  }
})

test('R6：重定向错误里的 Location 也会脱敏', async () => {
  const seen = { requests: 0 }
  const target = createServer((_req, res) => { seen.requests += 1; res.writeHead(200).end('{}') })
  await new Promise(resolve => target.listen(0, '127.0.0.1', resolve))
  const targetPort = target.address().port
  const source = createServer((_req, res) => {
    res.writeHead(307, { location: `http://127.0.0.1:${targetPort}/api/session/prompt?token=SUPERSECRETTOKEN` })
    res.end()
  })
  await new Promise(resolve => source.listen(0, '127.0.0.1', resolve))
  try {
    const baseUrl = `http://127.0.0.1:${source.address().port}`
    const error = await callPromptExpectingError(baseUrl)
    assert.equal(error?.code, 'redirect_refused')
    assert.ok(!error.message.includes('SUPERSECRETTOKEN'), '错误消息不得回显令牌')
    assert.ok(!JSON.stringify(error.details).includes('SUPERSECRETTOKEN'), 'details 不得回显令牌')
    assert.equal(seen.requests, 0)
  } finally {
    await Promise.all([
      new Promise(resolve => source.close(resolve)),
      new Promise(resolve => target.close(resolve)),
    ])
  }
})

// ───────────────────────── 分页契约保真度 ─────────────────────────

test('分页契约：maxMessages 只计 user/assistant 消息并返回连续区间', async () => {
  const env = await ready()
  const { mock, home, baseUrl } = env
  try {
    const paths = new Paths(home)
    const credential = await readCredential(paths)
    const api = new DshApi({ baseUrl, credential })
    const address = { kind: 'session', sessionId: 'sess-alpha' }
    mock.append('sess-alpha', 'agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [] })
    mock.append('sess-alpha', 'turn/start', { turn: 1 })
    mock.append('sess-alpha', 'user/message', { id: 'u1', role: 'user', content: [{ type: 'text', text: '问' }], source: { kind: 'user', rpcId: 'r1' } })
    for (let step = 2; step <= 9; step += 1) mock.append('sess-alpha', 'step/start', { turn: 1, step })
    mock.append('sess-alpha', 'assistant/message', { turn: 1, step: 1, message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: '答' }] }, stream: [] })
    mock.append('sess-alpha', 'step/end', { turn: 1, step: 1 })
    mock.append('sess-alpha', 'turn/end', { turn: 1, reason: { kind: 'completed' } })

    const two = await api.call('session/page', { request: { address, maxMessages: 2 } })
    const twoEvents = two.records.map(record => record.event)
    const seqs = twoEvents.map(event => event.seq)
    // 连续：没有内部空洞。
    assert.deepEqual(seqs, seqs.map((_, index) => seqs[0] + index))
    const twoTypes = twoEvents.map(event => event.type)
    assert.equal(twoTypes.filter(type => type === 'user/message').length, 1)
    assert.equal(twoTypes.filter(type => type === 'assistant/message').length, 1)
    // 非消息事件落在同一连续区间里，不被单独裁掉。
    assert.ok(twoTypes.includes('step/start'), '非消息事件应随区间一起返回')
    assert.ok(twoTypes.includes('step/end'))
    assert.ok(twoTypes.includes('turn/end'))
    // cut 落在 user/message 上：更早的 inbox 与 turn/start 不在本页。
    assert.equal(twoTypes.includes('turn/start'), false)
    assert.equal(two.hasMore, true)

    const one = await api.call('session/page', { request: { address, maxMessages: 1 } })
    const oneTypes = one.records.map(record => record.event.type)
    assert.equal(oneTypes.filter(type => type === 'user/message').length, 0)
    assert.equal(oneTypes.filter(type => type === 'assistant/message').length, 1)

    const bounded = await api.call('session/page', { request: { address, maxMessages: 50, beforeSeq: 3 } })
    assert.ok(bounded.records.every(record => record.event.seq < 3), 'beforeSeq 必须是排他上界')
    assert.equal(bounded.records.length, 2)
  } finally {
    await cleanup(env)
  }
})
