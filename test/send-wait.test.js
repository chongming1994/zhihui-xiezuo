/**
 * 发送与等待：接受/完成的区分、幂等重发、提交超时、关联归属。
 * @module zhihui-xiezuo/test/send-wait.test
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { MockDsh } from './mock-dsh.js'
import { makeTempHome, runCli, writeTaskFile, writeTokenFile, AUTHORIZED_TRIAL_TEXT } from './helpers.js'
import { Paths } from '../src/config.js'
import { RequestStore } from '../src/store.js'
import { EXIT } from '../src/errors.js'

/**
 * 启动模拟服务、完成认证与绑定。
 * @param {object} [options] - 模拟服务选项。
 * @param {string} [sessionId] - 绑定目标。
 * @returns {Promise<any>} 测试上下文。
 */
async function ready(options = {}, sessionId = 'sess-alpha') {
  const mock = new MockDsh(options)
  const { baseUrl, token } = await mock.start()
  const home = await makeTempHome()
  const tokenFile = await writeTokenFile(home, token)
  await runCli(['auth', '--url', baseUrl, '--token-file', tokenFile], home)
  await runCli(['bind', sessionId, '--url', baseUrl], home)
  return { mock, baseUrl, home, store: new RequestStore(new Paths(home)) }
}

test('send + wait：正常完成，回复归属正确', async () => {
  const { mock, baseUrl, home } = await ready()
  try {
    const taskFile = await writeTaskFile(home, 'task.md', '这是本机消息桥接连接测试。')
    const sent = await runCli(['send', '--file', taskFile, '--url', baseUrl, '--json'], home)
    assert.equal(sent.exitCode, EXIT.OK, sent.stderr)
    assert.equal(sent.json.accepted, true)
    assert.equal(sent.json.state, 'submitted')
    const { requestId } = sent.json

    const waited = await runCli(['wait', requestId, '--url', baseUrl, '--json'], home)
    assert.equal(waited.exitCode, EXIT.OK, waited.stderr)
    assert.equal(waited.json.phase, 'completed')
    assert.equal(waited.json.reply.text, '连接成功')
    assert.equal(waited.json.state, 'completed')
    assert.equal(waited.json.ambiguityReasons.length, 0)

    // 关联链证据：日志里确实有该 requestId 的用户消息
    const alpha = mock.logs.get('sess-alpha')
    const prompt = alpha.find(event => event.type === 'user/message' && event.data.source.rpcId === requestId)
    assert.ok(prompt !== undefined)
    assert.equal(prompt.seq, waited.json.promptSeq)
    const end = alpha.find(event => event.type === 'turn/end' && event.data.turn === waited.json.turn)
    assert.equal(end.seq, waited.json.turnEndSeq)
  } finally {
    await mock.stop()
  }
})

test('send：提交阶段不订阅、不读取历史', async () => {
  const { mock, baseUrl, home } = await ready()
  try {
    const taskFile = await writeTaskFile(home, 'task.md', '任务正文')
    await runCli(['send', '--file', taskFile, '--url', baseUrl], home)
    assert.equal(mock.followOpens, 0, 'send 不应打开 follow')
    assert.equal(mock.requestCounts.get('session/page') ?? 0, 0, 'send 不应读取历史页')
  } finally {
    await mock.stop()
  }
})

test('区分“已接受”与“已完成”：排队中返回超时而非完成', async () => {
  const { mock, baseUrl, home } = await ready({ autoRun: false })
  try {
    const taskFile = await writeTaskFile(home, 'task.md', '排队任务')
    const sent = await runCli(['send', '--file', taskFile, '--url', baseUrl, '--json'], home)
    assert.equal(sent.json.accepted, true)
    assert.equal(sent.json.state, 'submitted')

    const queued = await runCli(['wait', sent.json.requestId, '--url', baseUrl, '--timeout', '400', '--json'], home)
    assert.equal(queued.exitCode, EXIT.TIMEOUT)
    assert.equal(queued.json.phase, 'queued')
    assert.equal(queued.json.reply, null)
    assert.equal(queued.json.state, 'queued')
    assert.equal(queued.json.timedOut, true)

    mock.runTurn('sess-alpha', sent.json.requestId)
    const done = await runCli(['wait', sent.json.requestId, '--url', baseUrl, '--timeout', '5000', '--json'], home)
    assert.equal(done.exitCode, EXIT.OK, done.stderr)
    assert.equal(done.json.phase, 'completed')
    assert.equal(done.json.reply.text, '连接成功')
  } finally {
    await mock.stop()
  }
})

test('未绑定会话时 send 拒绝执行', async () => {
  const mock = new MockDsh()
  const { baseUrl, token } = await mock.start()
  const home = await makeTempHome()
  try {
    const tokenFile = await writeTokenFile(home, token)
    await runCli(['auth', '--url', baseUrl, '--token-file', tokenFile], home)
    const taskFile = await writeTaskFile(home, 'task.md', 'x')
    const result = await runCli(['send', '--file', taskFile, '--url', baseUrl, '--json'], home)
    assert.equal(result.exitCode, EXIT.USAGE)
    assert.equal(result.json.error.code, 'no_bound_session')
  } finally {
    await mock.stop()
  }
})

test('会话不存在时返回 not-found，不产生请求记录', async () => {
  const { mock, baseUrl, home, store } = await ready()
  try {
    const taskFile = await writeTaskFile(home, 'task.md', 'x')
    const result = await runCli([
      'send', '--file', taskFile, '--session', 'sess-missing', '--url', baseUrl, '--json',
    ], home)
    assert.equal(result.exitCode, EXIT.NOT_FOUND)
    assert.equal(result.json.error.code, 'session/not-found')
    const records = await store.list()
    assert.equal(records.length, 1)
    assert.equal(records[0].state, 'failed')
  } finally {
    await mock.stop()
  }
})

test('提交超时记为 submission_unknown（退出码 7），随后可恢复', async () => {
  const { mock, baseUrl, home, store } = await ready({ promptDelayMs: 700 })
  try {
    const taskFile = await writeTaskFile(home, 'task.md', '超时任务')
    const sent = await runCli([
      'send', '--file', taskFile, '--url', baseUrl, '--http-timeout', '120', '--json',
    ], home)
    assert.equal(sent.exitCode, EXIT.SUBMISSION_UNKNOWN)
    assert.equal(sent.json.error.details.state, 'submission_unknown')
    assert.equal(sent.json.error.details.accepted, false)
    assert.equal(sent.json.error.code, 'request_timeout')
    const record = await store.require(sent.json.requestId)
    assert.equal(record.state, 'submission_unknown')
    assert.equal(record.text, '超时任务')

    // 同一 requestId、同一会话、同一内容重发：DSH 幂等返回 accepted
    const retry = await runCli([
      'send', '--file', taskFile, '--request-id', sent.json.requestId, '--url', baseUrl, '--http-timeout', '5000', '--json',
    ], home)
    assert.equal(retry.exitCode, EXIT.OK, retry.stderr)
    assert.equal(retry.json.requestId, sent.json.requestId)
    const splices = mock.logs.get('sess-alpha')
      .filter(event => event.type === 'agent/inbox/spliced'
        && event.data.inserted.some(message => message.source?.rpcId === sent.json.requestId))
    assert.equal(splices.length, 1, '重发不得造成重复入队')

    const waited = await runCli(['wait', sent.json.requestId, '--url', baseUrl, '--timeout', '5000', '--json'], home)
    assert.equal(waited.exitCode, EXIT.OK, waited.stderr)
    assert.equal(waited.json.phase, 'completed')
  } finally {
    await mock.stop()
  }
})

test('同一 requestId 换内容或换会话时拒绝重发', async () => {
  const { mock, baseUrl, home } = await ready()
  try {
    const first = await writeTaskFile(home, 'a.md', '内容 A')
    const second = await writeTaskFile(home, 'b.md', '内容 B')
    const requestId = randomUUID()
    const ok = await runCli(['send', '--file', first, '--request-id', requestId, '--url', baseUrl, '--json'], home)
    assert.equal(ok.exitCode, EXIT.OK)

    const contentConflict = await runCli([
      'send', '--file', second, '--request-id', requestId, '--url', baseUrl, '--json',
    ], home)
    assert.equal(contentConflict.exitCode, EXIT.USAGE)
    assert.equal(contentConflict.json.error.code, 'request_id_content_conflict')

    const sessionConflict = await runCli([
      'send', '--file', first, '--request-id', requestId, '--session', 'sess-beta', '--url', baseUrl, '--json',
    ], home)
    assert.equal(sessionConflict.exitCode, EXIT.USAGE)
    assert.equal(sessionConflict.json.error.code, 'usage')
  } finally {
    await mock.stop()
  }
})

test('订阅前回合已结束时仍能取回正确回复', async () => {
  const { mock, baseUrl, home } = await ready()
  try {
    const taskFile = await writeTaskFile(home, 'task.md', '已经跑完的任务')
    const sent = await runCli(['send', '--file', taskFile, '--url', baseUrl, '--json'], home)
    // autoRun 已同步跑完，wait 订阅时回合早已结束
    await new Promise(resolve => setTimeout(resolve, 20))
    const waited = await runCli(['wait', sent.json.requestId, '--url', baseUrl, '--timeout', '5000', '--json'], home)
    assert.equal(waited.exitCode, EXIT.OK, waited.stderr)
    assert.equal(waited.json.phase, 'completed')
    assert.equal(waited.json.reply.text, '连接成功')
  } finally {
    await mock.stop()
  }
})

test('不会取用其它会话的回复', async () => {
  const { mock, baseUrl, home } = await ready()
  try {
    const taskFile = await writeTaskFile(home, 'task.md', 'alpha 的任务')
    const sent = await runCli(['send', '--file', taskFile, '--url', baseUrl, '--json'], home)
    // 另一个会话产生一条完全不同的回复
    const other = randomUUID()
    mock.enqueue({ sessionId: 'sess-beta', requestId: other, content: [{ type: 'text', text: 'beta 的任务' }] })
    mock.runTurn('sess-beta', other, { replyText: '这是 beta 的回复' })

    const waited = await runCli(['wait', sent.json.requestId, '--url', baseUrl, '--json'], home)
    assert.equal(waited.exitCode, EXIT.OK, waited.stderr)
    assert.equal(waited.json.sessionId, 'sess-alpha')
    assert.equal(waited.json.reply.text, '连接成功')
    assert.notEqual(waited.json.reply.text, '这是 beta 的回复')
  } finally {
    await mock.stop()
  }
})

test('status：读取本地记录并做只读核对', async () => {
  const { mock, baseUrl, home } = await ready()
  try {
    const taskFile = await writeTaskFile(home, 'task.md', '状态查询任务')
    const sent = await runCli(['send', '--file', taskFile, '--url', baseUrl, '--json'], home)
    await runCli(['wait', sent.json.requestId, '--url', baseUrl, '--json'], home)
    const status = await runCli(['status', sent.json.requestId, '--url', baseUrl, '--json'], home)
    assert.equal(status.exitCode, EXIT.OK, status.stderr)
    assert.equal(status.json.request.state, 'completed')
    assert.equal(status.json.request.reply.text, '连接成功')
    assert.equal(status.json.crossCheck.sessionVisible, true)
    assert.equal(status.json.request.text, undefined, 'status 不得回显任务正文')
  } finally {
    await mock.stop()
  }
})

test('status：未知 requestId 返回 not-found', async () => {
  const { mock, baseUrl, home } = await ready()
  try {
    const result = await runCli(['status', 'no-such-request', '--url', baseUrl, '--json'], home)
    assert.equal(result.exitCode, EXIT.NOT_FOUND)
    assert.equal(result.json.error.code, 'request_not_found')
  } finally {
    await mock.stop()
  }
})

test('授权试发文本逐字保真：引号必须是全角，且与任务书一致', () => {
  // 权威来源：资料快照/DSH消息桥接实施任务书.md:60（授权的最小试发内容）。
  // 这里刻意把整句写成字面量再比对，防止常量被“顺手”改成半角引号或改写措辞。
  const fromTaskBook = '这是本机消息桥接连接测试。请仅回复“连接成功”，不要调用任何工具，不修改文件或配置。'
  assert.equal(AUTHORIZED_TRIAL_TEXT, fromTaskBook)
  assert.ok(AUTHORIZED_TRIAL_TEXT.includes('\u201C连接成功\u201D'), '必须是全角引号 U+201C / U+201D')
  assert.ok(!AUTHORIZED_TRIAL_TEXT.includes('"'), '不得出现半角引号')
})

test('send 原样发送文件内容：不 trim、不改写、含结尾换行', async () => {
  const { mock, baseUrl, home } = await ready()
  try {
    // 与 Codex 的实机最小试发文件同样带一个结尾换行。
    const fileText = `${AUTHORIZED_TRIAL_TEXT}\n`
    const taskFile = await writeTaskFile(home, 'trial.txt', fileText)
    const sent = await runCli(['send', '--file', taskFile, '--url', baseUrl, '--json'], home)
    assert.equal(sent.exitCode, EXIT.OK, sent.stderr)

    const events = mock.logs.get('sess-alpha') ?? []
    const delivered = events.find(event => event.type === 'user/message')
    const text = delivered.data.content.map(block => block.text).join('')
    assert.equal(text, fileText, '送到会话的正文必须与文件字节完全一致')
    assert.ok(text.endsWith('\n'), '结尾换行不得被吞掉')

    const waited = await runCli(['wait', sent.json.requestId, '--url', baseUrl, '--json'], home)
    assert.equal(waited.exitCode, EXIT.OK, waited.stderr)
    assert.equal(waited.json.phase, 'completed')
  } finally {
    await mock.stop()
  }
})

test('send 拒绝只有空白字符的任务文件', async () => {
  const { mock, baseUrl, home } = await ready()
  try {
    const taskFile = await writeTaskFile(home, 'blank.txt', '   \n\n\t ')
    const sent = await runCli(['send', '--file', taskFile, '--url', baseUrl, '--json'], home)
    assert.equal(sent.exitCode, EXIT.USAGE)
    assert.equal(sent.json.ok, false)
    assert.equal(sent.json.error.code, 'usage')
  } finally {
    await mock.stop()
  }
})
