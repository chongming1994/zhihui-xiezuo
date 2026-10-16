// 修复后对照：逐项重跑 Codex 首轮复查（05-Codex复查与修复要求.md）的 5 个场景，
// 以及二轮复查（06-Codex二轮复查.md）的普通 RPC 重定向边界。
// 只启动随机环回端口模拟服务；不连接真实 DSH，不改 bridge 实现。
import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { MockDsh } from './mock-dsh.js'
import { makeTempHome, runCli, writeTaskFile, writeTokenFile } from './helpers.js'
import { analyze, EventLog } from '../src/associate.js'
import { DshApi, normalizeBaseUrl } from '../src/rpc.js'

// ── R2 ──────────────────────────────────────────────────────────────────────
let fetchCalls = 0
let rejectedBeforeFetch = false
try { normalizeBaseUrl('https://example.invalid') } catch (error) { rejectedBeforeFetch = error.code === 'non_loopback_url' }
let constructionRejected = false
try {
  new DshApi({
    baseUrl: 'http://127.0.0.1:3080',
    credential: { authority: '127.0.0.1:3080', cookieName: 'synthetic', cookieValue: 'dummy' },
    fetchImpl: async () => { fetchCalls += 1 },
  })
} catch { /* 不应发生 */ }
try {
  new DshApi({
    baseUrl: 'http://127.0.0.1:3080',
    credential: { authority: '127.0.0.1:9999', cookieName: 'synthetic', cookieValue: 'dummy' },
    fetchImpl: async () => { fetchCalls += 1 },
  })
} catch (error) { constructionRejected = error.code === 'credential_authority_mismatch' }
assert.equal(rejectedBeforeFetch, true)
assert.equal(constructionRejected, true)
assert.equal(fetchCalls, 0)
console.log(JSON.stringify({ case: 'non-loopback-and-authority-mismatch', nonLoopbackRejected: rejectedBeforeFetch, authorityMismatchRejected: constructionRejected, fetchCalls, expected: 'reject-before-fetch', ok: true }))

// ── R4 ──────────────────────────────────────────────────────────────────────
const ev = (seq, type, data) => ({ seq, type, data })
const unrelatedCancel = analyze([
  ev(1, 'agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [{ id: 'other', source: { rpcId: 'other' } }] }),
  ev(2, 'agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [], outcome: 'canceled' }),
], 'never-seen')
assert.equal(unrelatedCancel.phase, 'not_found')
console.log(JSON.stringify({ case: 'unrelated-cancel', actual: unrelatedCancel.phase, expected: 'not_found', ok: true }))

// ── R5 ──────────────────────────────────────────────────────────────────────
const conflict = new EventLog()
conflict.add(ev(1, 'user/message', { source: { rpcId: 'one' } }))
const changed = conflict.add(ev(1, 'user/message', { source: { rpcId: 'two' } }))
assert.equal(changed, 'conflict')
assert.equal(conflict.conflicts, 1)
console.log(JSON.stringify({ case: 'same-type-changed-payload', actual: changed, conflicts: conflict.conflicts, expected: 'conflict', ok: true }))

// ── R1 / R3 ─────────────────────────────────────────────────────────────────
async function scenario(kind) {
  const mock = new MockDsh({ autoRun: false })
  const home = await makeTempHome()
  const { baseUrl, token } = await mock.start()
  try {
    const tokenFile = await writeTokenFile(home, token)
    assert.equal((await runCli(['auth', '--url', baseUrl, '--token-file', tokenFile], home)).exitCode, 0)
    await runCli(['bind', 'sess-alpha', '--url', baseUrl], home)
    const file = await writeTaskFile(home, 'task.md', 'isolated mock task')
    const sent = await runCli(['send', '--file', file, '--url', baseUrl, '--json'], home)
    const requestId = sent.json.requestId
    mock.runTurn('sess-alpha', requestId, { withUserInterjection: kind === 'gap' })
    if (kind === 'partial') mock.behavior.snapshotWindow = 5
    if (kind === 'gap') {
      mock.handleMux = (ws, raw) => {
        const frame = JSON.parse(raw)
        if (frame.type !== 'open') return
        mock.followOpens += 1
        ws.streamId = frame.streamId
        const first = mock.followOpens === 1
        const events = mock.logs.get('sess-alpha')
        const window = first ? events.slice(0, 3) : events.slice(-3)
        ws.send(JSON.stringify({ type: 'item', streamId: frame.streamId, value: {
          type: 'snapshot', cursor: window.at(-1).seq, records: window.map(event => ({ type: 'event', event })), hasMore: true,
        } }))
        if (first) setTimeout(() => ws.terminate(), 5)
      }
    }
    const result = await runCli(['wait', requestId, '--url', baseUrl, '--timeout', '1500', '--json'], home)
    const pages = mock.requestCounts.get('session/page') ?? 0
    const truth = analyze(mock.logs.get('sess-alpha'), requestId).phase
    if (kind === 'gap') {
      // 缺口里藏着另一条用户插话 → 修复后必须补页并判不确定，不得宣称完成。
      assert.ok(pages > 0, 'must backfill the gap')
      assert.equal(result.json.unresolvedGaps, 0)
      assert.equal(result.json.phase, 'uncertain')
      assert.equal(result.exitCode, 6)
      assert.equal(truth, 'uncertain')
    } else {
      // 回合起点在窗口外 → 修复后补页取回起点，得到 completed。
      assert.ok(pages > 0, 'must backfill the turn start')
      assert.equal(result.json.phase, 'completed')
      assert.equal(result.exitCode, 0)
      assert.equal(truth, 'completed')
    }
    console.log(JSON.stringify({ case: kind, actual: result.json.phase, exitCode: result.exitCode, pageCalls: pages, unresolvedGaps: result.json.unresolvedGaps, expected: kind === 'gap' ? 'uncertain-after-repair' : 'completed-after-backfill', ok: true }))
  } finally {
    for (const client of mock.wss.clients) client.terminate()
    await mock.stop()
    await rm(home, { recursive: true, force: true })
  }
}
await scenario('gap')
await scenario('partial')

// ── R6（二轮）：普通 RPC 不得自动跟随重定向 ──────────────────────────────────
{
  let targetRequests = 0
  let targetTaskBody = false
  const target = createServer((req, res) => {
    targetRequests += 1
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      if (body.includes('synthetic-task-marker')) targetTaskBody = true
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
    })
  })
  await new Promise(resolve => target.listen(0, '127.0.0.1', resolve))
  const targetPort = target.address().port
  const source = createServer((_req, res) => {
    res.writeHead(307, { location: `http://127.0.0.1:${targetPort}/api/session/prompt` })
    res.end()
  })
  await new Promise(resolve => source.listen(0, '127.0.0.1', resolve))
  try {
    const baseUrl = `http://127.0.0.1:${source.address().port}`
    const api = new DshApi({
      baseUrl,
      credential: { authority: new URL(baseUrl).host, baseUrl, cookieName: 'synthetic', cookieValue: 'dummy' },
    })
    let errorCode = null
    try {
      await api.call('session/prompt', {
        request: { requestId: 'synthetic', sessionId: 'synthetic', mode: 'queue', content: [{ type: 'text', text: 'synthetic-task-marker' }] },
      })
    } catch (error) { errorCode = error.code }
    assert.equal(errorCode, 'redirect_refused')
    assert.equal(targetRequests, 0)
    assert.equal(targetTaskBody, false)
    console.log(JSON.stringify({ case: 'rpc-cross-authority-307', redirectTargetReceivedTask: targetTaskBody, redirectTargetRequests: targetRequests, errorCode, expected: 'redirect-refused-before-forward', ok: true }))
  } finally {
    await Promise.all([
      new Promise(resolve => source.close(resolve)),
      new Promise(resolve => target.close(resolve)),
    ])
  }
}

console.log(JSON.stringify({ summary: 'all review findings (round 1 + round 2) no longer reproduce', ok: true }))
