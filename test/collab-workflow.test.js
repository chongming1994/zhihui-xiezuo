/**
 * 协作工作流端到端：init → negotiate → approve → create → rename → deliver → send → wait
 * → report → review，以及未授权停机、改名失败恢复、投递未知不重发、报告≠验收、
 * 标题改动不漂移与并发工作单写。
 *
 * 全部断言只经公开 CLI 与 MockDsh，绝不连接真实 DSH。
 * @module zhihui-xiezuo/test/collab-workflow.test
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { MockDsh } from './mock-dsh.js'
import { makeTempHome, runCli, writeTaskFile, writeTokenFile } from './helpers.js'
import { EXIT } from '../src/errors.js'

/** 启动模拟服务并完成认证。 */
async function ready(options = {}) {
  const mock = new MockDsh(options)
  const { baseUrl, token } = await mock.start()
  const home = await makeTempHome()
  const tokenFile = await writeTokenFile(home, token)
  const auth = await runCli(['auth', '--url', baseUrl, '--token-file', tokenFile], home)
  assert.equal(auth.exitCode, EXIT.OK, auth.stderr)
  return { mock, baseUrl, home }
}

/** 断言命令成功并返回 JSON。 */
function assertOk(result, label) {
  assert.equal(result.exitCode, EXIT.OK, `${label} 应成功：${result.stderr}${result.stdout}`)
  assert.equal(result.json?.ok, true, `${label} 的 JSON 应为 ok:true`)
  return result.json
}

/** 工作单文件路径。 */
function woPath(home, id) {
  return join(home, 'workorders', `${id}.json`)
}

/** 读取工作单 JSON。 */
async function readWo(home, id) {
  return JSON.parse(await readFile(woPath(home, id), 'utf8'))
}

/** 新建一个已授权工作单并返回记录。 */
async function initWo(home, extra = []) {
  const result = await runCli(['workorder', 'init', '--goal', '协作目标', '--scope', '桥接', '--authorize', '--json', ...extra], home)
  assertOk(result, 'workorder init')
  return result.json.workOrder
}

/** 把工作单推进到「执行会话已创建 + 已改名 + 已投递」。 */
async function driveToDelivered({ home, baseUrl, workOrderId, sessionId, cwd, requestId, title = '执行会话标题' }) {
  assertOk(await runCli(['workorder', 'negotiate', workOrderId, '--round', '1', '--request-id', requestId, '--json'], home), 'negotiate')
  assertOk(await runCli(['workorder', 'approve', workOrderId, '--evidence', '用户定案', '--json'], home), 'approve')
  assertOk(await runCli([
    'create', '--cwd', cwd, '--session-id', sessionId,
    '--work-order', workOrderId, '--authorize', '--url', baseUrl, '--json',
  ], home), 'create')
  assertOk(await runCli([
    'rename', sessionId, '--title', title, '--work-order', workOrderId, '--authorize', '--url', baseUrl, '--json',
  ], home), 'rename')
  assertOk(await runCli(['workorder', 'deliver', workOrderId, '--request-id', requestId, '--session', sessionId, '--json'], home), 'deliver')
}

/**
 * 直接改写工作单文件：仅用于模拟「进程在 send 中途崩溃、留下 preparing」这类
 * 无法由任何 CLI 命令产生的历史状态。
 * @param {string} home - 状态目录。
 * @param {string} id - 工作单 ID。
 * @param {(record: any) => void} mutate - 变更函数。
 * @returns {Promise<any>} 改写后的记录。
 */
async function patchWo(home, id, mutate) {
  const record = await readWo(home, id)
  mutate(record)
  await writeFile(woPath(home, id), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
  return record
}

/** 建立「已授权 + 执行会话已创建」的工作单，供 send --work-order 测试使用。 */
async function setupExecutor({ home, baseUrl, cwd, sessionId }) {
  const workOrder = await initWo(home)
  const id = workOrder.workOrderId
  assertOk(await runCli([
    'create', '--cwd', cwd, '--session-id', sessionId,
    '--work-order', id, '--authorize', '--url', baseUrl, '--json',
  ], home), 'create')
  return id
}

test('全链路：init→negotiate→approve→create→rename→deliver→send→wait→report→review accepted', async () => {
  const { mock, baseUrl, home } = await ready()
  const cwd = await makeTempHome()
  const req = 'req-flow-1'
  const sid = 'session-flow-1'
  try {
    const workOrder = await initWo(home)
    const id = workOrder.workOrderId

    assertOk(await runCli(['workorder', 'negotiate', id, '--round', '1', '--request-id', req, '--proposal', 'p.md', '--decision', 'd.md', '--json'], home), 'negotiate')
    assert.equal((await readWo(home, id)).negotiation.rounds[0].requestId, req)

    assertOk(await runCli(['workorder', 'approve', id, '--evidence', '用户定案', '--json'], home), 'approve')
    assert.equal((await readWo(home, id)).status, 'approved')

    const created = assertOk(await runCli([
      'create', '--cwd', cwd, '--session-id', sid, '--work-order', id, '--authorize', '--url', baseUrl, '--json',
    ], home), 'create')
    assert.equal(created.sessionId, sid)
    assert.equal(created.agentPreset, null, 'bridge 故意不传 preset')
    assert.equal((await readWo(home, id)).executor.creation.state, 'created')

    const renamed = assertOk(await runCli([
      'rename', sid, '--title', '执行会话标题', '--work-order', id, '--authorize', '--url', baseUrl, '--json',
    ], home), 'rename')
    assert.equal(renamed.activated, true)
    assert.equal((await readWo(home, id)).executor.rename.state, 'renamed')

    assertOk(await runCli(['workorder', 'deliver', id, '--request-id', req, '--session', sid, '--json'], home), 'deliver')

    const taskFile = await writeTaskFile(home, 'task.md', '请执行协作任务')
    const sent = assertOk(await runCli([
      'send', '--file', taskFile, '--request-id', req, '--session', sid, '--url', baseUrl, '--json',
    ], home), 'send')
    assert.equal(sent.requestId, req)
    assert.equal(sent.accepted, true)
    assert.equal(sent.sessionId, sid)

    const waited = assertOk(await runCli(['wait', req, '--url', baseUrl, '--json'], home), 'wait')
    assert.equal(waited.phase, 'completed')

    assertOk(await runCli(['workorder', 'report', id, '--request-id', req, '--json'], home), 'report')
    let stored = await readWo(home, id)
    assert.equal(stored.status, 'reported')
    assert.equal(stored.review.verdict, 'none')

    assertOk(await runCli(['workorder', 'review', id, '--verdict', 'accepted', '--evidence', 'Codex 复查通过', '--by', 'codex', '--json'], home), 'review accepted')
    stored = await readWo(home, id)
    assert.equal(stored.status, 'accepted')
    assert.equal(stored.review.verdict, 'accepted')

    // 每步 requestId / sessionId 都被记录。
    assert.equal(stored.negotiation.rounds[0].requestId, req)
    assert.equal(stored.delivery.requestId, req)
    assert.equal(stored.delivery.sessionId, sid)
    assert.equal(stored.phases.find(phase => phase.name === 'delivery').requestId, req)
    assert.equal(stored.executor.sessionId, sid)
    assert.equal(stored.executor.creation.state, 'created')
    assert.equal(stored.executor.rename.state, 'renamed')
  } finally {
    await mock.stop()
  }
})

test('未授权工作单：create 被拒 work_order_unauthorized 且零 HTTP', async () => {
  const { mock, baseUrl, home } = await ready()
  const cwd = await makeTempHome()
  try {
    const result = await runCli(['workorder', 'init', '--goal', '未授权目标', '--json'], home)
    assertOk(result, 'init 无授权')
    const id = result.json.workOrder.workOrderId
    assert.equal(result.json.workOrder.authorization.granted, false)

    const created = await runCli([
      'create', '--cwd', cwd, '--session-id', 'session-unauth-1', '--work-order', id, '--authorize', '--url', baseUrl, '--json',
    ], home)
    assert.equal(created.exitCode, EXIT.USAGE)
    assert.equal(created.json.error.code, 'work_order_unauthorized')
    assert.equal(mock.createCalls, 0, '未授权工作单不得触发 session/create')
    assert.equal(mock.requestCounts.get('session/create') ?? 0, 0)
    assert.equal((await readWo(home, id)).executor.sessionId, null)
  } finally {
    await mock.stop()
  }
})

test('创建成功但 rename 失败 → recover 给出同 sessionId 的改名恢复动作', async () => {
  const { mock, baseUrl, home } = await ready()
  const cwd = await makeTempHome()
  const sid = 'session-c3-1'
  try {
    const workOrder = await initWo(home)
    const id = workOrder.workOrderId
    assertOk(await runCli([
      'create', '--cwd', cwd, '--session-id', sid, '--work-order', id, '--authorize', '--url', baseUrl, '--json',
    ], home), 'create')

    mock.behavior.forceStatus = 500
    const renameFailed = await runCli(['rename', sid, '--title', '执行会话标题', '--work-order', id, '--authorize', '--url', baseUrl, '--json'], home)
    mock.behavior.forceStatus = null
    assert.notEqual(renameFailed.exitCode, EXIT.OK, 'rename 必须失败')
    assert.equal((await readWo(home, id)).executor.rename.state, 'failed')
    assert.equal(mock.createdSessions.length, 1, '改名失败不得新建会话')

    const plan = assertOk(await runCli(['workorder', 'recover', id, '--json'], home), 'recover')
    assert.equal(plan.recovery.steps.creation, 'created')
    assert.equal(plan.recovery.steps.rename, 'failed')
    const action = plan.recovery.nextActions.find(item => item.action === 'rename')
    assert.ok(action !== undefined, '应给出 rename 恢复动作')
    assert.ok(action.command.includes(sid), '恢复动作必须复用同一 sessionId')
    assert.ok(plan.recovery.forbidden.some(item => item.includes('不得新建执行会话')))
  } finally {
    await mock.stop()
  }
})

test('投递未知：recover 只给 status/wait，重复 recover 不再增加 session/prompt', async () => {
  const { mock, baseUrl, home } = await ready()
  const cwd = await makeTempHome()
  const sid = 'session-deliv-unknown'
  const req = 'req-deliv-unknown'
  try {
    const workOrder = await initWo(home)
    const id = workOrder.workOrderId
    await driveToDelivered({ home, baseUrl, workOrderId: id, sessionId: sid, cwd, requestId: req })

    // 构造“已投递但结果未知”（例如 send 超时 exit 7 后 skill 登记）：只允许按同一 requestId 查询/等待。
    assertOk(await runCli([
      'workorder', 'deliver', id, '--request-id', req, '--session', sid, '--state', 'unknown', '--json',
    ], home), 'deliver unknown')
    assert.equal((await readWo(home, id)).delivery.state, 'unknown')

    const file = woPath(home, id)
    const before = await readFile(file, 'utf8')
    const promptCallsBefore = mock.requestCounts.get('session/prompt') ?? 0

    const first = assertOk(await runCli(['workorder', 'recover', id, '--json'], home), 'recover #1')
    assert.equal(first.recovery.steps.delivery, 'unknown')
    assert.ok(
      first.recovery.nextActions.every(action => ['observe_only', 'status', 'wait'].includes(action.action)),
      `投递未知只允许观察：${JSON.stringify(first.recovery.nextActions)}`,
    )
    assert.ok(
      first.recovery.nextActions.some(action => String(action.command).includes('status') || String(action.command).includes('wait')),
      '必须给出按同一 requestId 的查询/等待动作',
    )
    assert.ok(first.recovery.forbidden.some(item => item.includes('不得重发')), '必须显式禁止重发')

    const second = assertOk(await runCli(['workorder', 'recover', id, '--json'], home), 'recover #2')
    assert.equal(second.recovery.steps.delivery, 'unknown')
    assert.equal(await readFile(file, 'utf8'), before, 'recover 必须只读')
    assert.equal(
      mock.requestCounts.get('session/prompt') ?? 0,
      promptCallsBefore,
      '重复 recover 不得产生任何 session/prompt',
    )
  } finally {
    await mock.stop()
  }
})

test('report 后未 review：status 不是 accepted；wait 拿到 completed 也不改变', async () => {
  const { mock, baseUrl, home } = await ready()
  const cwd = await makeTempHome()
  const sid = 'session-c4-1'
  const req = 'req-c4'
  try {
    const workOrder = await initWo(home)
    const id = workOrder.workOrderId
    await driveToDelivered({ home, baseUrl, workOrderId: id, sessionId: sid, cwd, requestId: req })

    const taskFile = await writeTaskFile(home, 'task.md', '协作任务正文')
    assertOk(await runCli(['send', '--file', taskFile, '--request-id', req, '--session', sid, '--url', baseUrl, '--json'], home), 'send')
    assertOk(await runCli(['workorder', 'report', id, '--request-id', req, '--json'], home), 'report')

    let stored = await readWo(home, id)
    assert.equal(stored.status, 'reported')
    assert.notEqual(stored.status, 'accepted')
    assert.equal(stored.review.verdict, 'none')

    const waited = assertOk(await runCli(['wait', req, '--url', baseUrl, '--json'], home), 'wait')
    assert.equal(waited.phase, 'completed')

    stored = await readWo(home, id)
    assert.equal(stored.status, 'reported', 'turn/end 与 report 都不得自动进入 accepted')
    assert.notEqual(stored.status, 'accepted')
  } finally {
    await mock.stop()
  }
})

test('标题改动不漂移：rename 之后 deliver/send/recover 仍以 sessionId 为身份', async () => {
  const { mock, baseUrl, home } = await ready()
  const cwd = await makeTempHome()
  const sid = 'session-drift-1'
  const req = 'req-drift'
  try {
    const workOrder = await initWo(home)
    const id = workOrder.workOrderId
    assertOk(await runCli([
      'create', '--cwd', cwd, '--session-id', sid, '--work-order', id, '--authorize', '--url', baseUrl, '--json',
    ], home), 'create')

    const title = '被改动的显示标题'
    assertOk(await runCli(['rename', sid, '--title', title, '--work-order', id, '--authorize', '--url', baseUrl, '--json'], home), 'rename')

    let stored = await readWo(home, id)
    assert.equal(stored.executor.sessionId, sid, '身份仍是 sessionId')
    assert.equal(stored.executor.titleReadBack, title)

    assertOk(await runCli(['workorder', 'deliver', id, '--request-id', req, '--session', sid, '--json'], home), 'deliver')
    const taskFile = await writeTaskFile(home, 'task.md', '漂移检查')
    const sent = assertOk(await runCli([
      'send', '--file', taskFile, '--request-id', req, '--session', sid, '--url', baseUrl, '--json',
    ], home), 'send')
    assert.equal(sent.sessionId, sid, '发送目标必须是 sessionId，不是标题')
    assert.ok((mock.logs.get(sid) ?? []).some(event => event.type === 'user/message'), '消息必须落到该 sessionId 的日志')

    stored = await readWo(home, id)
    assert.equal(stored.executor.sessionId, sid, '标题变化后工作单身份不得漂移')
    assert.equal(stored.delivery.sessionId, sid)

    const plan = assertOk(await runCli(['workorder', 'recover', id, '--json'], home), 'recover')
    assert.equal(plan.recovery.steps.delivery, 'delivered')
    const waitAction = plan.recovery.nextActions.find(action => action.action === 'wait')
    assert.ok(waitAction !== undefined, '已投递未报告应给出 wait')
    assert.ok(waitAction.command.includes(req), '恢复必须按同一 requestId 等待，不依赖标题')
  } finally {
    await mock.stop()
  }
})

test('并发工作单写：同一工作单两个 phase 更新都落盘且状态合法', async () => {
  const home = await makeTempHome()
  const workOrder = await initWo(home)
  const id = workOrder.workOrderId

  const [left, right] = await Promise.all([
    runCli(['workorder', 'phase', id, '--name', 'report', '--state', 'active', '--request-id', 'req-cc-1', '--json'], home),
    runCli(['workorder', 'phase', id, '--name', 'delivery', '--state', 'active', '--request-id', 'req-cc-2', '--json'], home),
  ])
  assertOk(left, '并发 phase #1')
  assertOk(right, '并发 phase #2')

  const stored = await readWo(home, id)
  assert.equal(stored.phases.find(phase => phase.name === 'report').requestId, 'req-cc-1')
  assert.equal(stored.phases.find(phase => phase.name === 'delivery').requestId, 'req-cc-2')
  assert.ok(
    ['negotiating', 'negotiated', 'approved', 'executor_created', 'task_delivered', 'executing', 'reported', 'reviewing', 'fixing'].includes(stored.status),
    `状态必须合法：${stored.status}`,
  )
})

test('R9：send --work-order 正常路径记录 preparing→delivered，重复 send 只观察', async () => {
  const { mock, baseUrl, home } = await ready()
  const cwd = await makeTempHome()
  const sid = 'session-send-1'
  try {
    const id = await setupExecutor({ home, baseUrl, cwd, sessionId: sid })
    const taskFile = await writeTaskFile(home, 'task.md', '执行协作任务')

    const sent = assertOk(await runCli([
      'send', '--file', taskFile, '--work-order', id, '--authorize', '--url', baseUrl, '--json',
    ], home), 'send --work-order')
    assert.ok(typeof sent.requestId === 'string' && sent.requestId !== '', 'JSON 必须带 requestId')
    assert.equal(sent.deliveryState, 'delivered')
    assert.equal(sent.observeOnly, false)
    assert.equal(sent.alreadyDelivered, false)
    assert.equal(sent.sent, true)
    assert.equal(sent.attempt, 1)
    assert.equal(mock.requestCounts.get('session/prompt') ?? 0, 1)

    let stored = await readWo(home, id)
    assert.equal(stored.delivery.state, 'delivered')
    assert.equal(stored.delivery.requestId, sent.requestId, '工作单必须记录同一 requestId')
    assert.equal(stored.status, 'task_delivered')
    assert.equal(stored.phases.find(phase => phase.name === 'delivery').state, 'done')

    const again = assertOk(await runCli([
      'send', '--file', taskFile, '--work-order', id, '--authorize', '--url', baseUrl, '--json',
    ], home), 'send again')
    assert.equal(again.alreadyDelivered, true)
    assert.equal(again.sent, false, '重复 send 不得再发 HTTP')
    assert.equal(typeof again.observeOnly, 'boolean', 'JSON 必须带 observeOnly')
    assert.equal(again.requestId, sent.requestId)
    assert.equal(mock.requestCounts.get('session/prompt') ?? 0, 1, '已投递不得再发第二次')
    stored = await readWo(home, id)
    assert.equal(stored.delivery.state, 'delivered')
    assert.equal(stored.delivery.requestId, sent.requestId)
  } finally {
    await mock.stop()
  }
})

test('R9：delivery=unknown 后再 send 被拒（exit 6、只观察、零新增 prompt）', async () => {
  const { mock, baseUrl, home } = await ready()
  const cwd = await makeTempHome()
  const sid = 'session-send-unknown'
  try {
    const id = await setupExecutor({ home, baseUrl, cwd, sessionId: sid })
    const taskFile = await writeTaskFile(home, 'task.md', '执行协作任务')
    const sent = assertOk(await runCli([
      'send', '--file', taskFile, '--work-order', id, '--authorize', '--url', baseUrl, '--json',
    ], home), 'send --work-order')

    assertOk(await runCli([
      'workorder', 'deliver', id, '--request-id', sent.requestId, '--state', 'unknown', '--json',
    ], home), 'mark delivery unknown')
    const prompts = mock.requestCounts.get('session/prompt') ?? 0

    const blocked = await runCli([
      'send', '--file', taskFile, '--work-order', id, '--authorize', '--url', baseUrl, '--json',
    ], home)
    assert.equal(blocked.exitCode, EXIT.UNCERTAIN)
    assert.equal(blocked.json.observeOnly, true)
    assert.equal(blocked.json.requestId, sent.requestId, '必须返回已有 requestId')
    assert.equal(mock.requestCounts.get('session/prompt') ?? 0, prompts, 'unknown 状态不得再发')
    assert.equal((await readWo(home, id)).delivery.state, 'unknown')
  } finally {
    await mock.stop()
  }
})

test('R9：崩溃遗留 delivery=preparing → recover 只观察、send 拒绝', async () => {
  const { mock, baseUrl, home } = await ready()
  const cwd = await makeTempHome()
  const sid = 'session-send-crash'
  try {
    const id = await setupExecutor({ home, baseUrl, cwd, sessionId: sid })
    const taskFile = await writeTaskFile(home, 'task.md', '执行协作任务')
    await patchWo(home, id, (draft) => {
      draft.delivery = {
        state: 'preparing', requestId: 'req-crash', sessionId: sid,
        at: new Date().toISOString(), error: null,
      }
    })

    const file = woPath(home, id)
    const before = await readFile(file, 'utf8')
    const plan = assertOk(await runCli(['workorder', 'recover', id, '--json'], home), 'recover preparing')
    assert.equal(plan.recovery.steps.delivery, 'preparing')
    assert.ok(
      plan.recovery.nextActions.every(action => ['observe_only', 'status', 'wait'].includes(action.action)),
      `崩溃遗留的 preparing 只允许观察：${JSON.stringify(plan.recovery.nextActions)}`,
    )
    assert.ok(plan.recovery.forbidden.some(item => item.includes('不得重发')), 'preparing 必须禁止重发')
    assert.equal(await readFile(file, 'utf8'), before, 'recover 必须只读')

    const prompts = mock.requestCounts.get('session/prompt') ?? 0
    const blocked = await runCli([
      'send', '--file', taskFile, '--work-order', id, '--authorize', '--url', baseUrl, '--json',
    ], home)
    assert.equal(blocked.exitCode, EXIT.UNCERTAIN)
    assert.equal(blocked.json.observeOnly, true)
    assert.equal(blocked.json.requestId, 'req-crash')
    assert.equal(mock.requestCounts.get('session/prompt') ?? 0, prompts, 'preparing 状态不得再发')
  } finally {
    await mock.stop()
  }
})

test('R9：并发两次 send --work-order 只发一次（prompt 计数 1）', async () => {
  const { mock, baseUrl, home } = await ready()
  const cwd = await makeTempHome()
  const sid = 'session-send-conc'
  try {
    const id = await setupExecutor({ home, baseUrl, cwd, sessionId: sid })
    const taskFile = await writeTaskFile(home, 'task.md', '执行协作任务')
    const args = ['send', '--file', taskFile, '--work-order', id, '--authorize', '--url', baseUrl, '--json']
    const [left, right] = await Promise.all([runCli(args, home), runCli(args, home)])

    for (const [label, result] of [['#1', left], ['#2', right]]) {
      assert.ok(
        result.exitCode === EXIT.OK || result.exitCode === EXIT.UNCERTAIN,
        `并发 send ${label} 只能是成功或只观察：${result.exitCode} ${result.stdout}${result.stderr}`,
      )
    }
    assert.ok([left, right].some(result => result.exitCode === EXIT.OK), '至少一次真正投递')
    assert.equal(mock.requestCounts.get('session/prompt') ?? 0, 1, '并发只允许发一次')

    const ids = [left, right].map(result => result.json?.requestId).filter(value => typeof value === 'string')
    assert.ok(ids.length >= 1)
    assert.equal(new Set(ids).size, 1, '两次必须返回同一 requestId')
    const stored = await readWo(home, id)
    assert.equal(stored.delivery.state, 'delivered')
    assert.equal(stored.delivery.requestId, ids[0])
  } finally {
    await mock.stop()
  }
})

test('R9：远端失败 → delivery=failed；再 send 无 --new-attempt 被拒，带 --new-attempt 才重发', async () => {
  const { mock, baseUrl, home } = await ready()
  const cwd = await makeTempHome()
  const sid = 'session-send-fail'
  try {
    const id = await setupExecutor({ home, baseUrl, cwd, sessionId: sid })
    const taskFile = await writeTaskFile(home, 'task.md', '执行协作任务')
    mock.behavior.forceRemoteError = { code: 'session/not-found', message: 'mock forced failure' }

    const failed = await runCli([
      'send', '--file', taskFile, '--work-order', id, '--authorize', '--url', baseUrl, '--json',
    ], home)
    mock.behavior.forceRemoteError = null
    assert.notEqual(failed.exitCode, EXIT.OK, '远端失败不得当成功')

    const stored = await readWo(home, id)
    assert.equal(stored.delivery.state, 'failed')
    assert.ok(typeof stored.delivery.requestId === 'string' && stored.delivery.requestId !== '', '失败也要留下 requestId 证据')

    // 契约 §3.5.3：失败后不带 --new-attempt 不得自动重发。
    const prompts = mock.requestCounts.get('session/prompt') ?? 0
    const retry = await runCli([
      'send', '--file', taskFile, '--work-order', id, '--authorize', '--url', baseUrl, '--json',
    ], home)
    assert.equal(retry.exitCode, EXIT.USAGE)
    assert.equal(retry.json.error.code, 'delivery_failed_needs_new_attempt')
    assert.equal(mock.requestCounts.get('session/prompt') ?? 0, prompts, '失败后不得自动重发')
    assert.equal((await readWo(home, id)).delivery.state, 'failed', '被拒的重发不得改写 delivery')

    // 显式 --new-attempt 才允许新一轮投递。
    const second = assertOk(await runCli([
      'send', '--file', taskFile, '--work-order', id, '--authorize', '--url', baseUrl, '--new-attempt', '--json',
    ], home), 'send --new-attempt after failure')
    assert.equal(second.deliveryState, 'delivered')
    assert.equal(second.attempt, 2)
    assert.equal(mock.requestCounts.get('session/prompt') ?? 0, prompts + 1)
  } finally {
    await mock.stop()
  }
})

test('R9：send --work-order 错 --session / 错地址 被拒且零 HTTP', async () => {
  const { mock, baseUrl, home } = await ready()
  const cwd = await makeTempHome()
  const sid = 'session-send-guard'
  try {
    const id = await setupExecutor({ home, baseUrl, cwd, sessionId: sid })
    const taskFile = await writeTaskFile(home, 'task.md', '执行协作任务')

    const wrongSession = await runCli([
      'send', '--file', taskFile, '--work-order', id, '--session', 'session-other-9',
      '--authorize', '--url', baseUrl, '--json',
    ], home)
    assert.equal(wrongSession.exitCode, EXIT.USAGE)
    assert.equal(wrongSession.json.error.code, 'session_identity_mismatch')
    assert.equal(mock.requestCounts.get('session/prompt') ?? 0, 0, '身份不符必须零 HTTP')

    // 工作单记录另一个地址：send 必须零 HTTP 拒绝。
    const other = await runCli(['workorder', 'init', '--goal', '地址守卫', '--authorize', '--url', 'http://127.0.0.1:9', '--json'], home)
    assertOk(other, 'init at other url')
    const otherId = other.json.workOrder.workOrderId
    assertOk(await runCli([
      'workorder', 'attach', otherId, '--session', 'session-addr-guard',
      '--cwd', cwd, '--creation-state', 'created', '--evidence', '已核对创建回执', '--json',
    ], home), 'attach')

    const wrongAddress = await runCli([
      'send', '--file', taskFile, '--work-order', otherId, '--authorize', '--url', baseUrl, '--json',
    ], home)
    assert.equal(wrongAddress.exitCode, EXIT.USAGE)
    assert.equal(wrongAddress.json.error.code, 'work_order_address_mismatch')
    assert.equal(mock.requestCounts.get('session/prompt') ?? 0, 0, '地址不符必须零 HTTP')
  } finally {
    await mock.stop()
  }
})

test('R9：--new-attempt 递增 attempt 并保留旧 attempt 证据', async () => {
  const { mock, baseUrl, home } = await ready()
  const cwd = await makeTempHome()
  const sid = 'session-send-attempt'
  try {
    const id = await setupExecutor({ home, baseUrl, cwd, sessionId: sid })
    const taskFile = await writeTaskFile(home, 'task.md', '执行协作任务')

    const first = assertOk(await runCli([
      'send', '--file', taskFile, '--work-order', id, '--authorize', '--url', baseUrl, '--json',
    ], home), 'send attempt #1')
    assert.equal(first.attempt, 1)
    const firstStored = await readWo(home, id)
    assert.ok(Array.isArray(firstStored.delivery.attempts), 'delivery.attempts 必须是数组')
    assert.equal(firstStored.delivery.attempts.length, 1)

    // 契约 §3.5.3：delivery.contentDigest 落盘，且摘要只取决于任务内容。
    const digest = firstStored.delivery.contentDigest
    assert.match(digest, /^sha256:[0-9a-f]{64}$/u, `contentDigest 格式错误：${digest}`)
    const expectedDigest = `sha256:${createHash('sha256').update(await readFile(taskFile, 'utf8')).digest('hex')}`
    assert.equal(digest, expectedDigest, 'contentDigest 必须是任务文件内容的 sha256')

    const second = assertOk(await runCli([
      'send', '--file', taskFile, '--work-order', id, '--authorize', '--url', baseUrl, '--new-attempt', '--json',
    ], home), 'send attempt #2')
    assert.equal(second.attempt, 2)
    assert.notEqual(second.requestId, first.requestId, '新 attempt 必须使用新 requestId')

    const secondStored = await readWo(home, id)
    assert.equal(secondStored.delivery.attempts.length, 2, '旧 attempt 证据必须保留')
    assert.ok(JSON.stringify(secondStored.delivery.attempts).includes(first.requestId), '旧 requestId 必须留在 attempts 里')
    assert.equal(secondStored.delivery.requestId, second.requestId)
    assert.equal(secondStored.delivery.state, 'delivered')
    assert.equal(secondStored.delivery.contentDigest, digest, '同一任务文件不同 attempt 的 digest 必须相同')
    assert.ok(
      secondStored.delivery.attempts.every(attempt => attempt.contentDigest === digest),
      `每次 attempt 都要带同一 contentDigest：${JSON.stringify(secondStored.delivery.attempts)}`,
    )
    assert.equal(mock.requestCounts.get('session/prompt') ?? 0, 2, '--new-attempt 必须真的再发一次')
  } finally {
    await mock.stop()
  }
})
