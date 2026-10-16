/**
 * 韧性场景：断线补页与重复事件、多任务排队、用户插话、工具事件、取消/错误、脱敏。
 * @module zhihui-xiezuo/test/resilience.test
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { MockDsh } from './mock-dsh.js'
import { makeTempHome, runCli, writeTaskFile, writeTokenFile } from './helpers.js'
import { Paths } from '../src/config.js'
import { EXIT } from '../src/errors.js'

/**
 * 启动模拟服务、认证并绑定。
 * @param {object} [options] - 模拟服务选项。
 * @returns {Promise<any>} 测试上下文。
 */
async function ready(options = {}) {
  const mock = new MockDsh(options)
  const { baseUrl, token } = await mock.start()
  const home = await makeTempHome()
  const tokenFile = await writeTokenFile(home, token)
  await runCli(['auth', '--url', baseUrl, '--token-file', tokenFile], home)
  await runCli(['bind', 'sess-alpha', '--url', baseUrl], home)
  return { mock, baseUrl, home }
}

/** 等待若干毫秒。 */
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

test('断线重连后仍能取回回复，并忽略重复事件', async () => {
  const { mock, baseUrl, home } = await ready({ autoRun: false, dropSnapshots: 1, replayLastN: 3 })
  try {
    const taskFile = await writeTaskFile(home, 'task.md', '断线任务')
    const sent = await runCli(['send', '--file', taskFile, '--url', baseUrl, '--json'], home)
    const pending = runCli(['wait', sent.json.requestId, '--url', baseUrl, '--timeout', '6000', '--json'], home)
    await sleep(400)
    mock.runTurn('sess-alpha', sent.json.requestId, { replyText: '断线后依然到达' })
    const waited = await pending
    assert.equal(waited.exitCode, EXIT.OK, waited.stderr)
    assert.equal(waited.json.phase, 'completed')
    assert.equal(waited.json.reply.text, '断线后依然到达')
    assert.ok(waited.json.carrierLosses >= 1, '应记录到载体丢失')
    assert.ok(waited.json.duplicatesIgnored >= 1, '应忽略重复事件')
  } finally {
    await mock.stop()
  }
})

test('快照窗口不足时按需回补历史页', async () => {
  const { mock, baseUrl, home } = await ready({ autoRun: false, snapshotWindow: 2 })
  try {
    // 先制造一段较长的历史，让目标消息落在快照窗口之外
    const filler = randomUUID()
    mock.enqueue({ sessionId: 'sess-alpha', requestId: filler, content: [{ type: 'text', text: '旧任务' }] })
    mock.runTurn('sess-alpha', filler, { replyText: '旧回复' })
    for (let index = 0; index < 6; index += 1) {
      mock.append('sess-alpha', 'assistant/message', {
        turn: 1, step: 1,
        message: { id: `f${index}`, role: 'assistant', content: [{ type: 'text', text: `填充 ${index}` }], source: { kind: 'model' } },
        stream: [],
      })
    }
    const taskFile = await writeTaskFile(home, 'target.md', '目标任务')
    const sent = await runCli(['send', '--file', taskFile, '--url', baseUrl, '--json'], home)
    mock.runTurn('sess-alpha', sent.json.requestId, { replyText: '目标回复' })

    // 用 status --verify 触发只读核对（快照只有 2 条记录，必须回补）
    const result = await runCli(['status', sent.json.requestId, '--url', baseUrl, '--verify', '--json'], home)
    assert.equal(result.exitCode, EXIT.OK, result.stderr)
    assert.equal(result.json.verify.phase, 'completed')
    assert.equal(result.json.verify.reply.text, '目标回复')
    assert.ok((mock.requestCounts.get('session/page') ?? 0) >= 1, '应发生过补页')
  } finally {
    await mock.stop()
  }
})

test('多个排队任务各自取回自己的回复', async () => {
  const { mock, baseUrl, home } = await ready({ autoRun: false })
  try {
    const first = await writeTaskFile(home, 't1.md', '第一个任务')
    const second = await writeTaskFile(home, 't2.md', '第二个任务')
    const one = await runCli(['send', '--file', first, '--url', baseUrl, '--json'], home)
    const two = await runCli(['send', '--file', second, '--url', baseUrl, '--json'], home)
    assert.notEqual(one.json.requestId, two.json.requestId)
    mock.runTurn('sess-alpha', one.json.requestId, { replyText: '回复一' })
    mock.runTurn('sess-alpha', two.json.requestId, { replyText: '回复二' })

    const waitedOne = await runCli(['wait', one.json.requestId, '--url', baseUrl, '--json'], home)
    const waitedTwo = await runCli(['wait', two.json.requestId, '--url', baseUrl, '--json'], home)
    assert.equal(waitedOne.json.reply.text, '回复一')
    assert.equal(waitedTwo.json.reply.text, '回复二')
    assert.notEqual(waitedOne.json.turn, waitedTwo.json.turn)
  } finally {
    await mock.stop()
  }
})

test('用户插话导致归属不唯一时返回不确定，不冒用回复', async () => {
  const { mock, baseUrl, home } = await ready({ autoRun: false })
  try {
    const taskFile = await writeTaskFile(home, 'task.md', '会被插话的任务')
    const sent = await runCli(['send', '--file', taskFile, '--url', baseUrl, '--json'], home)
    mock.runTurn('sess-alpha', sent.json.requestId, { withUserInterjection: true, replyText: '回合里的回答' })
    const waited = await runCli(['wait', sent.json.requestId, '--url', baseUrl, '--json'], home)
    assert.equal(waited.exitCode, EXIT.UNCERTAIN)
    assert.equal(waited.json.ok, false)
    assert.equal(waited.json.error.code, 'association_uncertain')
    assert.equal(waited.json.phase, 'uncertain')
    assert.equal(waited.json.reply, null)
    assert.equal(waited.json.candidateReply.text, '回合里的回答')
    assert.match(waited.json.ambiguityReasons.join(''), /其它用户消息/u)
  } finally {
    await mock.stop()
  }
})

test('工具中间事件不影响最终回复归属', async () => {
  const { mock, baseUrl, home } = await ready({ autoRun: false })
  try {
    const taskFile = await writeTaskFile(home, 'task.md', '会用工具的任务')
    const sent = await runCli(['send', '--file', taskFile, '--url', baseUrl, '--json'], home)
    mock.runTurn('sess-alpha', sent.json.requestId, {
      extraEvents: [
        { type: 'tool/call', data: { callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' } },
        { type: 'tool/result', data: { callId: 'c1', ok: true, message: 'ok' } },
        { type: 'assistant/attempt', data: { stream: [] } },
      ],
      replyText: '工具跑完后的结论',
    })
    const waited = await runCli(['wait', sent.json.requestId, '--url', baseUrl, '--json'], home)
    assert.equal(waited.exitCode, EXIT.OK, waited.stderr)
    assert.equal(waited.json.reply.text, '工具跑完后的结论')
  } finally {
    await mock.stop()
  }
})

test('回合被取消映射为 cancelled（退出码 1），且不冒用回复', async () => {
  const { mock, baseUrl, home } = await ready({ autoRun: false })
  try {
    const taskFile = await writeTaskFile(home, 'task.md', '会被取消的任务')
    const sent = await runCli(['send', '--file', taskFile, '--url', baseUrl, '--json'], home)
    mock.runTurn('sess-alpha', sent.json.requestId, {
      endReason: { kind: 'aborted', reason: { kind: 'user' } },
    })
    const waited = await runCli(['wait', sent.json.requestId, '--url', baseUrl, '--json'], home)
    assert.equal(waited.exitCode, EXIT.ERROR)
    assert.equal(waited.json.phase, 'cancelled')
    assert.equal(waited.json.error.code, 'task_cancelled')
    assert.equal(waited.json.state, 'cancelled')
  } finally {
    await mock.stop()
  }
})

test('回合失败映射为 failed（退出码 1）', async () => {
  const { mock, baseUrl, home } = await ready({ autoRun: false })
  try {
    const taskFile = await writeTaskFile(home, 'task.md', '会失败的任务')
    const sent = await runCli(['send', '--file', taskFile, '--url', baseUrl, '--json'], home)
    mock.runTurn('sess-alpha', sent.json.requestId, {
      endReason: { kind: 'error', error: { message: '模型不可用', code: 'LLM_UNAVAILABLE' } },
    })
    const waited = await runCli(['wait', sent.json.requestId, '--url', baseUrl, '--json'], home)
    assert.equal(waited.exitCode, EXIT.ERROR)
    assert.equal(waited.json.phase, 'failed')
    assert.equal(waited.json.error.code, 'task_failed')
    assert.equal(waited.json.reply, null)
  } finally {
    await mock.stop()
  }
})

test('wait 超时只停止本地等待：不取消、不重发、不激活新任务', async () => {
  const { mock, baseUrl, home } = await ready({ autoRun: false })
  try {
    const taskFile = await writeTaskFile(home, 'task.md', '长时间任务')
    const sent = await runCli(['send', '--file', taskFile, '--url', baseUrl, '--json'], home)
    const before = (mock.requestCounts.get('session/prompt') ?? 0)
    const waited = await runCli(['wait', sent.json.requestId, '--url', baseUrl, '--timeout', '300', '--json'], home)
    assert.equal(waited.exitCode, EXIT.TIMEOUT)
    assert.equal(waited.json.error.code, 'wait_timeout')
    assert.equal(mock.requestCounts.get('session/prompt') ?? 0, before, 'wait 不得再提交任务')
    assert.equal(mock.requestCounts.get('session/cancel') ?? 0, 0, 'wait 不得取消 DSH 任务')
    // 远端照常继续，稍后重跑 wait 能拿到结果
    mock.runTurn('sess-alpha', sent.json.requestId, { replyText: '晚到的回复' })
    const again = await runCli(['wait', sent.json.requestId, '--url', baseUrl, '--json'], home)
    assert.equal(again.exitCode, EXIT.OK, again.stderr)
    assert.equal(again.json.reply.text, '晚到的回复')
  } finally {
    await mock.stop()
  }
})

test('请求记录不保存 Cookie、不保存秘密请求头', async () => {
  const { mock, baseUrl, home } = await ready()
  try {
    const taskFile = await writeTaskFile(home, 'task.md', '记录检查任务')
    const sent = await runCli(['send', '--file', taskFile, '--url', baseUrl, '--json'], home)
    await runCli(['wait', sent.json.requestId, '--url', baseUrl, '--json'], home)
    const raw = await readFile(new Paths(home).request(sent.json.requestId), 'utf8')
    assert.ok(!raw.includes(mock.cookieValue), '请求记录不得含 Cookie 值')
    assert.ok(!raw.includes(mock.token), '请求记录不得含启动令牌')
    const parsed = JSON.parse(raw)
    assert.equal(parsed.text, '记录检查任务')
    assert.equal(Object.keys(parsed).some(key => /cookie|authorization|token/i.test(key)), false)
  } finally {
    await mock.stop()
  }
})

test('所有命令输出都不泄露 Cookie 值', async () => {
  const { mock, baseUrl, home } = await ready()
  try {
    const taskFile = await writeTaskFile(home, 'task.md', '输出检查任务')
    const sent = await runCli(['send', '--file', taskFile, '--url', baseUrl, '--json'], home)
    const outputs = []
    outputs.push(await runCli(['check', '--url', baseUrl, '--json'], home))
    outputs.push(await runCli(['sessions', '--url', baseUrl, '--json'], home))
    outputs.push(await runCli(['status', sent.json.requestId, '--url', baseUrl, '--json'], home))
    outputs.push(await runCli(['wait', sent.json.requestId, '--url', baseUrl, '--json'], home))
    for (const result of outputs) {
      assert.ok(!result.stdout.includes(mock.cookieValue), '输出不得包含 Cookie 值')
      assert.ok(!result.stdout.includes(mock.token), '输出不得包含启动令牌')
      assert.ok(!result.stderr.includes(mock.cookieValue), '错误输出不得包含 Cookie 值')
    }
  } finally {
    await mock.stop()
  }
})

test('桥接不订阅审批通道：既不接收也不代替用户批准', async () => {
  const { mock, baseUrl, home } = await ready()
  try {
    const taskFile = await writeTaskFile(home, 'task.md', '需要审批的任务')
    const sent = await runCli(['send', '--file', taskFile, '--url', baseUrl, '--json'], home)
    await runCli(['wait', sent.json.requestId, '--url', baseUrl, '--json'], home)
    // `$events` 是审批请求（approval/request）与提问的转发通道；
    // 桥接只使用 session/follow，因此不可能自动批准任何请求。
    assert.equal(mock.eventStreamOpens, 0, '桥接不得订阅 $events 审批通道')
  } finally {
    await mock.stop()
  }
})

test('地址被信任栅栏拒绝时明确失败（不绕过校验）', async () => {
  const { mock, baseUrl, home } = await ready()
  try {
    mock.behavior.forceStatus = 403
    const result = await runCli(['sessions', '--url', baseUrl, '--json'], home)
    assert.equal(result.exitCode, EXIT.AUTH)
    assert.equal(result.json.error.code, 'trust_rejected')
    // 桥接没有提供任何“忽略校验”的开关
    const help = await runCli(['--help'], home)
    assert.ok(!/--insecure|--no-verify|--skip-auth/u.test(help.stdout))
  } finally {
    await mock.stop()
  }
})
