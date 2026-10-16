/**
 * 纯逻辑单元测试：关联分析、脱敏、存储并发。
 * @module zhihui-xiezuo/test/unit.test
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chmod, stat } from 'node:fs/promises'
import { analyze, EventLog, extractText, isFinalPhase, PHASE, replayInbox } from '../src/associate.js'
import { findSecretKeys, redactHeaders, redactText, redactUrl } from '../src/redact.js'
import { Paths, ensureHome, readCredential, readJson, writeCredential } from '../src/config.js'
import { RequestStore, REQUEST_STATE, digestOf, withLock } from '../src/store.js'
import { makeTempHome, modeOf } from './helpers.js'

/** 构造事件序列生成器。 */
function series() {
  let seq = 0
  return (type, data) => ({ type, seq: (seq += 1), time: 1_700_000_000_000 + seq, data })
}

/** 构造一条用户消息事件负载。 */
function userMessage(rpcId, text = '任务') {
  return { id: `m-${rpcId}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user', rpcId } }
}

/** 构造一条助手消息事件负载。 */
function assistantMessage(turn, text) {
  return {
    turn,
    step: 1,
    message: { id: `a-${turn}`, role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model' } },
    stream: [],
  }
}

test('关联：正常回合能被完整归属', () => {
  const ev = series()
  const events = [
    ev('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [userMessage('r1')] }),
    ev('turn/start', { turn: 7 }),
    ev('user/message', userMessage('r1')),
    ev('step/start', { turn: 7, step: 1 }),
    ev('assistant/message', assistantMessage(7, '连接成功')),
    ev('step/end', { turn: 7, step: 1 }),
    ev('turn/end', { turn: 7, reason: { kind: 'completed' } }),
  ]
  const result = analyze(events, 'r1')
  assert.equal(result.phase, PHASE.COMPLETED)
  assert.equal(result.turn, 7)
  assert.equal(result.reply.text, '连接成功')
  assert.equal(result.promptSeq, 3)
  assert.equal(result.turnEndSeq, 7)
  assert.deepEqual(result.ambiguityReasons, [])
  assert.ok(isFinalPhase(result))
})

test('关联：仅有排队记录时是 queued，不是 running/completed', () => {
  const ev = series()
  const events = [ev('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [userMessage('r2')] })]
  const result = analyze(events, 'r2')
  assert.equal(result.phase, PHASE.QUEUED)
  assert.equal(result.reply, null)
  assert.equal(isFinalPhase(result), false)
})

test('关联：回合未结束时是 running', () => {
  const ev = series()
  const events = [
    ev('turn/start', { turn: 2 }),
    ev('user/message', userMessage('r3')),
    ev('assistant/message', assistantMessage(2, '部分输出')),
  ]
  const result = analyze(events, 'r3')
  assert.equal(result.phase, PHASE.RUNNING)
  assert.equal(result.reply, null)
  assert.equal(isFinalPhase(result), false)
})

test('关联：取消与错误分别映射为 cancelled / failed', () => {
  const ev = series()
  const cancelled = [
    ev('turn/start', { turn: 1 }),
    ev('user/message', userMessage('c1')),
    ev('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } }),
  ]
  assert.equal(analyze(cancelled, 'c1').phase, PHASE.CANCELLED)

  const ev2 = series()
  const failed = [
    ev2('turn/start', { turn: 1 }),
    ev2('user/message', userMessage('e1')),
    ev2('turn/end', { turn: 1, reason: { kind: 'error', error: { message: 'boom', code: 'X' } } }),
  ]
  const result = analyze(failed, 'e1')
  assert.equal(result.phase, PHASE.FAILED)
  assert.equal(result.reply, null)
})

test('关联：同一回合出现别的用户消息时返回不确定，不冒用回复', () => {
  const ev = series()
  const events = [
    ev('turn/start', { turn: 4 }),
    ev('user/message', userMessage('mine')),
    ev('user/message', userMessage('other')),
    ev('assistant/message', assistantMessage(4, '别人的答案')),
    ev('turn/end', { turn: 4, reason: { kind: 'completed' } }),
  ]
  const result = analyze(events, 'mine')
  assert.equal(result.phase, PHASE.UNCERTAIN)
  assert.equal(result.reply, null)
  assert.equal(result.candidateReply.text, '别人的答案')
  assert.match(result.ambiguityReasons.join(''), /其它用户消息/u)
})

test('关联：注入的合成用户消息（kind 非 user）不触发不确定', () => {
  const ev = series()
  const events = [
    ev('turn/start', { turn: 5 }),
    ev('user/message', userMessage('mine')),
    ev('user/message', {
      id: 'ctx',
      role: 'user',
      content: [{ type: 'text', text: '上下文注入' }],
      source: { kind: 'skill-invocation', name: 'x' },
    }),
    ev('assistant/message', assistantMessage(5, '好')),
    ev('turn/end', { turn: 5, reason: { kind: 'completed' } }),
  ]
  const result = analyze(events, 'mine')
  assert.equal(result.phase, PHASE.COMPLETED)
  assert.equal(result.reply.text, '好')
})

test('关联：多个排队任务各自归属自己的回合', () => {
  const ev = series()
  const events = [
    ev('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [userMessage('t1', '第一个')] }),
    ev('agent/inbox/spliced', { target: 'next-turn', start: 1, inserted: [userMessage('t2', '第二个')] }),
    ev('turn/start', { turn: 1 }),
    ev('user/message', userMessage('t1', '第一个')),
    ev('assistant/message', assistantMessage(1, '回复一')),
    ev('turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ev('turn/start', { turn: 2 }),
    ev('user/message', userMessage('t2', '第二个')),
    ev('assistant/message', assistantMessage(2, '回复二')),
    ev('turn/end', { turn: 2, reason: { kind: 'completed' } }),
  ]
  assert.equal(analyze(events, 't1').reply.text, '回复一')
  assert.equal(analyze(events, 't2').reply.text, '回复二')
  assert.equal(analyze(events, 't1').turn, 1)
  assert.equal(analyze(events, 't2').turn, 2)
})

test('关联：工具中间事件与失败尝试不影响最终回复归属', () => {
  const ev = series()
  const events = [
    ev('turn/start', { turn: 3 }),
    ev('user/message', userMessage('r9')),
    ev('assistant/attempt', { turn: 3, step: 1, stream: [] }),
    ev('tool/call', { turn: 3, step: 1, callId: 'c1', name: 'bash', arguments: '{}' }),
    ev('tool/result', { turn: 3, step: 1, callId: 'c1', ok: true }),
    ev('assistant/message', assistantMessage(3, '最终答案')),
    ev('turn/end', { turn: 3, reason: { kind: 'completed' } }),
  ]
  const result = analyze(events, 'r9')
  assert.equal(result.phase, PHASE.COMPLETED)
  assert.equal(result.reply.text, '最终答案')
})

test('关联：找不到 turn/start 时返回不确定而不是猜一个回合', () => {
  const ev = series()
  const events = [
    ev('user/message', userMessage('orphan')),
    ev('assistant/message', assistantMessage(1, '孤儿回复')),
    ev('turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ]
  const result = analyze(events, 'orphan')
  assert.equal(result.phase, PHASE.UNCERTAIN)
  assert.equal(result.reply, null)
})

test('关联：目标自己的排队消息被撤销时判定为 cancelled', () => {
  const ev = series()
  const message = userMessage('gone')
  const events = [
    ev('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [message] }),
    ev('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [], outcome: 'canceled' }),
  ]
  const result = analyze(events, 'gone')
  // 目标消息确实被插入过、且被同队列的一次 splice 移除，队列历史自空开始 → 可证明撤销。
  assert.equal(result.phase, PHASE.CANCELLED)
  assert.equal(replayInbox(events, 'gone').present, false)
  assert.equal(replayInbox(events, 'gone').cancelled, true)
})

test('关联：无关消息被撤销不得推断目标已取消（R4）', () => {
  const ev = series()
  const events = [
    ev('agent/inbox/spliced', {
      target: 'next-turn', start: 0, inserted: [userMessage('other')],
    }),
    ev('agent/inbox/spliced', {
      target: 'next-turn', start: 0, removedCount: 1, inserted: [], outcome: 'canceled',
    }),
  ]
  const inbox = replayInbox(events, 'never-seen')
  assert.equal(inbox.present, false)
  assert.equal(inbox.cancelled, false)
  assert.equal(analyze(events, 'never-seen').phase, PHASE.NOT_FOUND)
})

test('关联：队列此前有未知内容时仍能锚定下标并正确判定（R4）', () => {
  const ev = series()
  const message = userMessage('gone')
  const events = [
    // 插入发生在 start=3：说明队列此前已有 3 条我们没看到的消息。
    // 因为 start 是真实绝对下标，目标消息的下标可精确锚定为 3。
    ev('agent/inbox/spliced', {
      target: 'next-turn', start: 3, removedCount: 0, inserted: [message],
    }),
    // 移除的是下标 0..1 的两条（不是目标）→ 目标只是前移到下标 1，仍在队列里。
    ev('agent/inbox/spliced', {
      target: 'next-turn', start: 0, removedCount: 2, inserted: [], outcome: 'canceled',
    }),
  ]
  const inbox = replayInbox(events, 'gone')
  assert.equal(inbox.indexTracked, true)
  assert.equal(inbox.present, true)
  assert.equal(inbox.cancelled, false)
  assert.equal(analyze(events, 'gone').phase, PHASE.QUEUED)
})

test('关联：撤销范围覆盖目标下标时判定为 cancelled（R4）', () => {
  const ev = series()
  const message = userMessage('gone')
  const events = [
    ev('agent/inbox/spliced', { target: 'next-turn', start: 3, removedCount: 0, inserted: [message] }),
    // 从下标 0 起移除 4 条 → 覆盖下标 3 的目标消息。
    ev('agent/inbox/spliced', {
      target: 'next-turn', start: 0, removedCount: 4, inserted: [], outcome: 'canceled',
    }),
  ]
  assert.equal(analyze(events, 'gone').phase, PHASE.CANCELLED)
})

test('关联：看不到插入时不推断目标被撤销（R4）', () => {
  const ev = series()
  const events = [
    // 只看到一次撤销，目标消息的插入落在窗口之外 → 无证据。
    ev('agent/inbox/spliced', {
      target: 'next-turn', start: 0, removedCount: 2, inserted: [userMessage('other')], outcome: 'canceled',
    }),
  ]
  const inbox = replayInbox(events, 'never-seen')
  assert.equal(inbox.indexTracked, false)
  assert.equal(inbox.cancelled, false)
  assert.equal(analyze(events, 'never-seen').phase, PHASE.NOT_FOUND)
})

test('关联：目标消息完全在窗口外时是 not_found（需调用方补页）', () => {
  const ev = series()
  const events = [
    ev('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [userMessage('other')] }),
  ]
  assert.equal(analyze(events, 'target').phase, PHASE.NOT_FOUND)
})

test('关联：完全没有证据时是 not_found', () => {
  assert.equal(analyze([], 'nope').phase, PHASE.NOT_FOUND)
})

test('EventLog：按 seq 去重、识别缺口、冲突计数', () => {
  const log = new EventLog()
  assert.equal(log.add({ type: 'a', seq: 1, data: {} }), 'new')
  assert.equal(log.add({ type: 'a', seq: 1, data: {} }), 'duplicate')
  assert.equal(log.add({ type: 'b', seq: 1, data: {} }), 'conflict')
  assert.equal(log.add({ type: 'c', seq: 3, data: {} }), 'new')
  assert.equal(log.add({ type: 'x', seq: 'bad' }), 'invalid')
  assert.deepEqual(log.missingSeqs(), [2])
  assert.equal(log.duplicates, 1)
  assert.equal(log.conflicts, 1)
  assert.equal(log.maxSeq, 3)
})

test('extractText：只取 text 块', () => {
  assert.equal(extractText([
    { type: 'reasoning', text: '思考' },
    { type: 'text', text: '第一行' },
    { type: 'tool-call', id: 'c', name: 'x', arguments: '{}' },
    { type: 'text', text: '第二行' },
  ]), '第一行\n第二行')
  assert.equal(extractText(null), '')
})

test('脱敏：URL、请求头与文本中的秘密都被遮蔽', () => {
  assert.equal(redactUrl('http://127.0.0.1:3080/?token=SECRETVALUE'), 'http://127.0.0.1:3080/?token=%3CREDACTED%3E')
  const headers = redactHeaders({ cookie: 'dsh-auth-x=v1.aaa.bbb', host: '127.0.0.1:3080', 'x-other': 'y' })
  assert.equal(headers.cookie, '<REDACTED>')
  assert.equal(headers.host, '127.0.0.1:3080')
  assert.equal(headers['x-other'], undefined)
  assert.match(redactText('token=abc123 后面还有字'), /<REDACTED>/u)
  assert.match(redactText('dsh-auth-abc.v1.aaa.bbb'), /REDACTED/u)
  assert.deepEqual(findSecretKeys({ a: { cookie: 'x' } }), ['a.cookie'])
})

test('存储：请求记录 0600、目录 0700、摘要稳定', async () => {
  const home = await makeTempHome()
  const paths = new Paths(home)
  await ensureHome(paths)
  assert.equal(await modeOf(home), '700')
  const store = new RequestStore(paths)
  const { record } = await store.createOrGet({
    requestId: 'req-1', sessionId: 'sess-alpha', baseUrl: 'http://127.0.0.1:3080', mode: 'queue', text: '你好',
  })
  assert.equal(record.state, REQUEST_STATE.PREPARED)
  assert.equal(await modeOf(paths.request(record.requestId)), '600')
  assert.equal(record.contentDigest, digestOf('你好'))
  assert.notEqual(digestOf('你好'), digestOf('你好 '))
})

test('存储：凭据单独保存且为 0600', async () => {
  const home = await makeTempHome()
  const paths = new Paths(home)
  await ensureHome(paths)
  await writeCredential(paths, { authority: '127.0.0.1:3080', cookieName: 'dsh-auth-x', cookieValue: 'v1.a.b' })
  assert.equal(await modeOf(paths.credential), '600')
  const read = await readCredential(paths)
  assert.equal(read.cookieName, 'dsh-auth-x')
  const config = await readJson(paths.config, null)
  assert.equal(config, null)
})

test('存储：并发更新不丢写', async () => {
  const home = await makeTempHome()
  const paths = new Paths(home)
  await ensureHome(paths)
  const store = new RequestStore(paths)
  const { record } = await store.createOrGet({
    requestId: 'req-2', sessionId: 's', baseUrl: 'http://127.0.0.1:3080', mode: 'queue', text: 't',
  })
  await Promise.all(Array.from({ length: 20 }, (_, index) => store.update(record.requestId, (current) => {
    current.notes = [...(current.notes ?? []), { at: 'x', note: `n${index}` }]
    return current
  })))
  const final = await store.require(record.requestId)
  assert.equal(final.notes.length, 20)
  assert.equal(new Set(final.notes.map(note => note.note)).size, 20)
})

test('存储：锁超时前能顺序进入临界区', async () => {
  const home = await makeTempHome()
  const paths = new Paths(home)
  await ensureHome(paths)
  const order = []
  await Promise.all([1, 2, 3].map(index => withLock(paths, 'demo', async () => {
    order.push(`in${index}`)
    await new Promise(resolve => setTimeout(resolve, 10))
    order.push(`out${index}`)
  })))
  assert.equal(order.length, 6)
  // 互斥性：每个 inN 必须紧跟着 outN，不能交叉。
  for (let index = 0; index < order.length; index += 2) {
    const enter = order[index]
    const leave = order[index + 1]
    assert.match(enter, /^in\d$/u)
    assert.equal(leave, enter.replace('in', 'out'))
  }
})

test('配置：损坏的 JSON 回退为默认值而不是崩溃', async () => {
  const home = await makeTempHome()
  const paths = new Paths(home)
  await ensureHome(paths)
  await chmod(home, 0o700)
  const { writeFile } = await import('node:fs/promises')
  await writeFile(paths.config, '{ not json', 'utf8')
  assert.equal(await readJson(paths.config, 'fallback'), 'fallback')
  assert.ok((await stat(paths.config)).isFile())
})
