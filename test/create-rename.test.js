/**
 * `create` / `rename` / `sessions` / `inspect`：授权门、cwd 边界、幂等收养、
 * 冲突停机、超时未知、标题截断与 pin、精选字段。
 *
 * 全部断言只经公开 CLI 与 MockDsh，绝不连接真实 DSH。
 * @module zhihui-xiezuo/test/create-rename.test
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile, stat } from 'node:fs/promises'
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
async function initWo(home) {
  const result = await runCli(['workorder', 'init', '--goal', '创建执行会话', '--authorize', '--json'], home)
  assertOk(result, 'workorder init')
  return result.json.workOrder
}

/** 把工作单推进到 accepted（create/rename 走 mock HTTP，其余为本地步骤）。 */
async function driveToAccepted({ home, baseUrl, cwd, sessionId }) {
  const workOrder = await initWo(home)
  const id = workOrder.workOrderId
  const req = 'req-accepted'
  assertOk(await runCli(['workorder', 'negotiate', id, '--round', '1', '--request-id', req, '--json'], home), 'negotiate')
  assertOk(await runCli(['workorder', 'approve', id, '--evidence', '用户定案', '--json'], home), 'approve')
  assertOk(await runCli(['create', '--cwd', cwd, '--session-id', sessionId, '--work-order', id, '--authorize', '--url', baseUrl, '--json'], home), 'create')
  assertOk(await runCli(['rename', sessionId, '--title', '验收会话', '--work-order', id, '--authorize', '--url', baseUrl, '--json'], home), 'rename')
  assertOk(await runCli(['workorder', 'deliver', id, '--request-id', req, '--json'], home), 'deliver')
  assertOk(await runCli(['workorder', 'report', id, '--request-id', req, '--json'], home), 'report')
  assertOk(await runCli(['workorder', 'review', id, '--verdict', 'accepted', '--evidence', 'Codex 复查通过', '--json'], home), 'review accepted')
  return id
}

test('create 无 --authorize：exit 2 且零 HTTP', async () => {
  const { mock, baseUrl, home } = await ready()
  const cwd = await makeTempHome()
  try {
    const result = await runCli(['create', '--cwd', cwd, '--session-id', 'session-noauth-1', '--url', baseUrl, '--json'], home)
    assert.equal(result.exitCode, EXIT.USAGE)
    assert.equal(result.json.error.code, 'authorization_required')
    assert.equal(mock.createCalls, 0, '未授权时不得发出 session/create')
    assert.equal(mock.requestCounts.get('session/create') ?? 0, 0)
  } finally {
    await mock.stop()
  }
})

test('create：相对路径 / 不存在路径被拒，零 HTTP 且不 mkdir', async () => {
  const { mock, baseUrl, home } = await ready()
  try {
    const relative = await runCli(['create', '--cwd', 'relative/dir', '--session-id', 'session-rel-1', '--authorize', '--url', baseUrl, '--json'], home)
    assert.equal(relative.exitCode, EXIT.USAGE)
    assert.equal(relative.json.error.code, 'cwd_invalid')

    const missingDir = join(home, 'no-such-dir-xyz')
    const missing = await runCli(['create', '--cwd', missingDir, '--session-id', 'session-missing-1', '--authorize', '--url', baseUrl, '--json'], home)
    assert.equal(missing.exitCode, EXIT.USAGE)
    assert.equal(missing.json.error.code, 'cwd_not_found')

    assert.equal(mock.createCalls, 0, 'cwd 非法时不得发出 session/create')
    assert.equal((mock.mkdirCalls ?? []).length, 0, '本工具绝不代替用户 mkdir')
    await assert.rejects(stat(missingDir), '不得创建目标目录')
  } finally {
    await mock.stop()
  }
})

test('create 成功：预存 sessionId、cwd 正确、记录 agentPreset、工作单 created、sessions 可见', async () => {
  const { mock, baseUrl, home } = await ready()
  const cwd = await makeTempHome()
  try {
    const workOrder = await initWo(home)
    const created = assertOk(await runCli([
      'create', '--cwd', cwd, '--session-id', 'session-created-1',
      '--work-order', workOrder.workOrderId, '--authorize', '--url', baseUrl, '--json',
    ], home), 'create')

    assert.equal(created.sessionId, 'session-created-1')
    assert.equal(created.cwd, cwd)
    assert.equal(created.reused, false)
    assert.equal(created.recorded, 'created')
    assert.ok('agentPreset' in created, 'JSON 必须带 agentPreset 字段')
    assert.equal(created.workOrderId, workOrder.workOrderId)

    assert.equal(mock.createdSessions.length, 1)
    assert.equal(mock.createdSessions[0].sessionId, 'session-created-1')
    assert.equal(mock.createdSessions[0].cwd, cwd, 'cwd 必须原样传给服务端')
    assert.deepEqual(mock.mkdirCalls, [cwd], 'mock 只记录、不真建目录')

    const stored = await readWo(home, workOrder.workOrderId)
    assert.equal(stored.executor.sessionId, 'session-created-1')
    assert.equal(stored.executor.cwd, cwd)
    assert.equal(stored.executor.creation.state, 'created')
    assert.equal(stored.executor.agentPreset, created.agentPreset)
    assert.equal(stored.status, 'executor_created')
    assert.equal(stored.phases.find(phase => phase.name === 'executor_create').state, 'done')

    const sessions = assertOk(await runCli(['sessions', '--url', baseUrl, '--json'], home), 'sessions')
    assert.ok(sessions.sessions.some(row => row.sessionId === 'session-created-1'), '新会话必须可见')
  } finally {
    await mock.stop()
  }
})

test('同一 sessionId 连续两次 create：只产生一个会话，第二次 reused:true', async () => {
  const { mock, baseUrl, home } = await ready()
  const cwd = await makeTempHome()
  try {
    const workOrder = await initWo(home)
    const args = [
      'create', '--cwd', cwd, '--session-id', 'session-reuse-1',
      '--work-order', workOrder.workOrderId, '--authorize', '--url', baseUrl, '--json',
    ]
    const first = assertOk(await runCli(args, home), 'create #1')
    assert.equal(first.reused, false)
    const second = assertOk(await runCli(args, home), 'create #2')
    assert.equal(second.reused, true, '同 ID 再调必须是收养')
    assert.equal(second.sessionId, 'session-reuse-1')

    assert.equal(mock.createdSessions.length, 1, '不得产生第二个会话')
    assert.equal(mock.createdSessions[0].sessionId, 'session-reuse-1')
    assert.equal(mock.createCalls, 2, '两次请求都应到达服务端（幂等由服务端收养保证）')
  } finally {
    await mock.stop()
  }
})

test('同 ID 不同 cwd（无工作单）→ session/conflict，无新会话', async () => {
  const { mock, baseUrl, home } = await ready()
  const cwdA = await makeTempHome()
  const cwdB = await makeTempHome()
  try {
    assertOk(await runCli([
      'create', '--cwd', cwdA, '--session-id', 'session-conflict-1', '--authorize', '--url', baseUrl, '--json',
    ], home), 'create A')

    const conflict = await runCli([
      'create', '--cwd', cwdB, '--session-id', 'session-conflict-1', '--authorize', '--url', baseUrl, '--json',
    ], home)
    assert.equal(conflict.exitCode, EXIT.ERROR)
    assert.equal(conflict.json.error.code, 'session/conflict')
    assert.equal(mock.createdSessions.length, 1, '冲突时不得新建会话')
    assert.equal(mock.sessions.find(session => session.sessionId === 'session-conflict-1').cwd, cwdA, '既有会话 cwd 不得被改写')
  } finally {
    await mock.stop()
  }
})

test('服务端 cwd 冲突（工作单未记录 cwd）→ session/conflict、工作单 blocked、phase failed', async () => {
  const { mock, baseUrl, home } = await ready()
  const cwdA = await makeTempHome()
  const cwdB = await makeTempHome()
  try {
    // 先在服务端建好会话，再把该身份登记进工作单（不写 cwd，避免本地 RPC 前拦截）。
    assertOk(await runCli([
      'create', '--cwd', cwdA, '--session-id', 'session-conflict-2', '--authorize', '--url', baseUrl, '--json',
    ], home), 'create A')

    const workOrder = await initWo(home)
    const id = workOrder.workOrderId
    assertOk(await runCli([
      'workorder', 'attach', id, '--session', 'session-conflict-2',
      '--creation-state', 'created', '--evidence', '已核对创建回执', '--json',
    ], home), 'attach')
    assert.equal((await readWo(home, id)).executor.cwd, null)

    const conflict = await runCli([
      'create', '--cwd', cwdB, '--session-id', 'session-conflict-2',
      '--work-order', id, '--authorize', '--url', baseUrl, '--json',
    ], home)
    assert.equal(conflict.exitCode, EXIT.ERROR)
    assert.equal(conflict.json.error.code, 'session/conflict')
    assert.equal(mock.createdSessions.length, 1, '冲突时不得新建会话')

    const stored = await readWo(home, id)
    assert.equal(stored.status, 'blocked')
    assert.equal(stored.executor.creation.state, 'conflict')
    assert.equal(stored.phases.find(phase => phase.name === 'executor_create').state, 'failed')
  } finally {
    await mock.stop()
  }
})

test('create 超时 → exit 7、creation.state=unknown；同 ID 再 create 仍只有一个会话', async () => {
  const { mock, baseUrl, home } = await ready({ createDelayMs: 900 })
  const cwd = await makeTempHome()
  try {
    const workOrder = await initWo(home)
    const timedOut = await runCli([
      'create', '--cwd', cwd, '--session-id', 'session-slow-1',
      '--work-order', workOrder.workOrderId, '--authorize', '--url', baseUrl,
      '--http-timeout', '150', '--json',
    ], home)
    assert.equal(timedOut.exitCode, EXIT.SUBMISSION_UNKNOWN)
    let stored = await readWo(home, workOrder.workOrderId)
    assert.equal(stored.executor.creation.state, 'unknown')
    assert.equal(stored.executor.sessionId, 'session-slow-1', '未知提交必须保留稳定身份')

    mock.behavior.createDelayMs = 0
    const again = assertOk(await runCli([
      'create', '--cwd', cwd, '--session-id', 'session-slow-1',
      '--work-order', workOrder.workOrderId, '--authorize', '--url', baseUrl, '--json',
    ], home), 'create 恢复')
    assert.equal(again.sessionId, 'session-slow-1')
    assert.equal(mock.createdSessions.length, 1, '恢复不得产生第二个 sessionId')
    stored = await readWo(home, workOrder.workOrderId)
    assert.equal(stored.executor.creation.state, 'created')
  } finally {
    await mock.stop()
  }
})

test('rename：80 字节截断与回读、pin 后 autoTitle 不覆盖、空标题零 HTTP、activated 语义', async () => {
  const { mock, baseUrl, home } = await ready()
  const cwd = await makeTempHome()
  const sid = 'session-ren-1'
  try {
    assertOk(await runCli(['create', '--cwd', cwd, '--session-id', sid, '--authorize', '--url', baseUrl, '--json'], home), 'create')

    const longTitle = '中'.repeat(40) // 120 UTF-8 字节
    const renamed = assertOk(await runCli(['rename', sid, '--title', longTitle, '--authorize', '--url', baseUrl, '--json'], home), 'rename')
    assert.equal(renamed.titleRequested, longTitle)
    assert.ok(Buffer.byteLength(renamed.title, 'utf8') <= 80, '返回标题不得超过 80 字节')
    assert.notEqual(renamed.title, longTitle)
    assert.equal(renamed.truncated, true)
    assert.equal(renamed.titleReadBack, renamed.title, 'readBack 必须与远端返回一致')
    assert.ok(longTitle.startsWith(renamed.titleReadBack), '截断结果必须是请求标题的前缀')
    assert.equal(renamed.activated, true, 'rename 会激活会话，必须显式标注')
    assert.ok(mock.activatedSessions.includes(sid))

    const mockSession = mock.sessions.find(session => session.sessionId === sid)
    assert.equal(mockSession.projections.values.title, renamed.titleReadBack, 'readBack 必须与 mock 一致')

    // pin：显式改名后，模拟的自动命名不得再覆盖标题。
    assert.equal(mockSession.titlePinned, true, 'rename 成功后必须 pin 住标题')
    mock.behavior.autoTitle = '自动标题-不应覆盖'
    const changed = mock.applyAutoTitle()
    assert.ok(changed.length > 0, 'autoTitle 开关必须确实会改写未 pin 的会话')
    assert.ok(!changed.includes(sid), '已 pin 的会话不得被 autoTitle 改写')
    const sessions = assertOk(await runCli(['sessions', '--url', baseUrl, '--json'], home), 'sessions')
    const row = sessions.sessions.find(session => session.sessionId === sid)
    assert.equal(row.title, renamed.title, 'pin 后标题不得被 autoTitle 覆盖')

    const before = mock.requestCounts.get('session/rename') ?? 0
    const empty = await runCli(['rename', sid, '--title', '   ', '--authorize', '--url', baseUrl, '--json'], home)
    assert.equal(empty.exitCode, EXIT.USAGE)
    assert.equal(empty.json.error.code, 'title_invalid')
    assert.equal(mock.requestCounts.get('session/rename') ?? 0, before, '空标题不得发出 session/rename')
  } finally {
    await mock.stop()
  }
})

test('rename 无 --authorize：exit 2 且零 HTTP', async () => {
  const { mock, baseUrl, home } = await ready()
  try {
    const result = await runCli(['rename', 'sess-alpha', '--title', '新标题', '--url', baseUrl, '--json'], home)
    assert.equal(result.exitCode, EXIT.USAGE)
    assert.equal(result.json.error.code, 'authorization_required')
    assert.equal(mock.requestCounts.get('session/rename') ?? 0, 0)
  } finally {
    await mock.stop()
  }
})

test('sessions/inspect：精选字段、无 projections 全量与聊天正文；inspect 不存在 exit 4', async () => {
  const mock = new MockDsh({
    sessions: [{
      sessionId: 'sess-proj-1',
      running: false,
      agentAvailable: true,
      blank: false,
      updatedAt: Date.now(),
      cwd: '/tmp',
      origin: 'user',
      parentSessionId: 'sess-parent-1',
      projections: {
        values: {
          title: '精选标题',
          agentPreset: 'standard',
          permissions: { currentValue: 'workspace-write' },
          extraProjection: '不应出现的-projection-全量内容',
        },
      },
    }],
  })
  const { baseUrl, token } = await mock.start()
  const home = await makeTempHome()
  try {
    const tokenFile = await writeTokenFile(home, token)
    await runCli(['auth', '--url', baseUrl, '--token-file', tokenFile], home)
    mock.append('sess-proj-1', 'user/message', {
      id: 'm1', role: 'user', content: [{ type: 'text', text: '不应出现的聊天正文' }], source: { kind: 'user' },
    })

    const sessions = assertOk(await runCli(['sessions', '--url', baseUrl, '--json'], home), 'sessions')
    const row = sessions.sessions.find(session => session.sessionId === 'sess-proj-1')
    assert.equal(row.title, '精选标题')
    assert.equal(row.agentPreset, 'standard')
    assert.equal(row.permissions, 'workspace-write')
    assert.equal(row.parentSessionId, 'sess-parent-1')
    assert.equal(row.projections, undefined, 'sessions 不得 dump projections 全量')
    assert.ok(!sessions.sessions.some(session => JSON.stringify(session).includes('不应出现')), '不得输出 projection 全量/聊天正文')

    const inspected = assertOk(await runCli(['inspect', 'sess-proj-1', '--url', baseUrl, '--json'], home), 'inspect 存在')
    assert.equal(inspected.command, 'inspect')
    assert.equal(inspected.session.sessionId, 'sess-proj-1')
    assert.equal(inspected.session.title, '精选标题')
    assert.equal(inspected.session.permissions, 'workspace-write')
    assert.equal(inspected.baseUrl, baseUrl)

    const missing = await runCli(['inspect', 'sess-does-not-exist', '--url', baseUrl, '--json'], home)
    assert.equal(missing.exitCode, EXIT.NOT_FOUND)
    assert.equal(missing.json.error.code, 'session_not_found')
  } finally {
    await mock.stop()
  }
})

test('sessions 不输出聊天正文（回归既有约束）', async () => {
  const { mock, baseUrl, home } = await ready()
  try {
    mock.append('sess-beta', 'user/message', {
      id: 'm2', role: 'user', content: [{ type: 'text', text: '私密任务正文不应被列出' }], source: { kind: 'user' },
    })
    const sessions = await runCli(['sessions', '--url', baseUrl, '--json'], home)
    assert.equal(sessions.exitCode, EXIT.OK, sessions.stderr)
    assert.ok(!sessions.stdout.includes('私密任务正文不应被列出'))
  } finally {
    await mock.stop()
  }
})

test('R7：同一工作单两次 create 都不传 --session-id → 同一身份、只一个会话、第二次 reused', async () => {
  const { mock, baseUrl, home } = await ready()
  const cwd = await makeTempHome()
  try {
    const workOrder = await initWo(home)
    const id = workOrder.workOrderId
    const args = ['create', '--cwd', cwd, '--work-order', id, '--authorize', '--url', baseUrl, '--json']

    const first = assertOk(await runCli(args, home), 'create #1')
    assert.ok(/^session-/.test(first.sessionId), `应生成 session-<id>：${first.sessionId}`)
    assert.equal(first.reused, false)

    const second = assertOk(await runCli(args, home), 'create #2')
    assert.equal(second.sessionId, first.sessionId, '缺 --session-id 必须复用工作单已保存身份')
    assert.equal(second.reused, true, '本次调用前已保存该 sessionId → reused:true')
    assert.equal(mock.createdSessions.length, 1, '不得产生第二个会话')
    assert.ok(mock.createCalls >= 1 && mock.createCalls <= 2, `create HTTP 次数应为 1（跳过）或 2（收养）：${mock.createCalls}`)
    assert.equal((await readWo(home, id)).executor.sessionId, first.sessionId)
  } finally {
    await mock.stop()
  }
})

test('R7：显式 --session-id 与工作单已保存身份不同 → session_identity_mismatch 且零 HTTP、记录不被覆盖', async () => {
  const { mock, baseUrl, home } = await ready()
  const cwd = await makeTempHome()
  try {
    const workOrder = await initWo(home)
    const id = workOrder.workOrderId
    assertOk(await runCli(['create', '--cwd', cwd, '--session-id', 'session-owner-1', '--work-order', id, '--authorize', '--url', baseUrl, '--json'], home), 'create owner')

    const file = woPath(home, id)
    const before = await readFile(file, 'utf8')
    const callsBefore = mock.createCalls
    const conflict = await runCli([
      'create', '--cwd', cwd, '--session-id', 'session-other-9', '--work-order', id, '--authorize', '--url', baseUrl, '--json',
    ], home)
    assert.equal(conflict.exitCode, EXIT.USAGE)
    assert.equal(conflict.json.error.code, 'session_identity_mismatch')
    assert.equal(mock.createCalls, callsBefore, '身份冲突必须在 RPC 之前拒绝')
    assert.equal(await readFile(file, 'utf8'), before, '原记录不得被覆盖')
    assert.equal(mock.createdSessions.length, 1)
  } finally {
    await mock.stop()
  }
})

test('R7：工作单已保存 cwd 不同 → work_order_cwd_mismatch 且零 HTTP', async () => {
  const { mock, baseUrl, home } = await ready()
  const cwdA = await makeTempHome()
  const cwdB = await makeTempHome()
  try {
    const workOrder = await initWo(home)
    const id = workOrder.workOrderId
    assertOk(await runCli(['create', '--cwd', cwdA, '--work-order', id, '--authorize', '--url', baseUrl, '--json'], home), 'create A')

    const callsBefore = mock.createCalls
    const mismatch = await runCli(['create', '--cwd', cwdB, '--work-order', id, '--authorize', '--url', baseUrl, '--json'], home)
    assert.equal(mismatch.exitCode, EXIT.USAGE)
    assert.equal(mismatch.json.error.code, 'work_order_cwd_mismatch')
    assert.equal(mock.createCalls, callsBefore, 'cwd 冲突必须在 RPC 之前拒绝')
    assert.equal(mock.createdSessions.length, 1)
    assert.equal((await readWo(home, id)).executor.cwd, cwdA, '已保存 cwd 不得被改写')
  } finally {
    await mock.stop()
  }
})

test('R7：工作单已保存地址与当前 --url 不同 → work_order_address_mismatch 且零 HTTP', async () => {
  const { mock, baseUrl, home } = await ready()
  const cwd = await makeTempHome()
  try {
    // 工作单记录另一个（本机）地址；init 不发 HTTP，不会连过去。
    const otherUrl = 'http://127.0.0.1:9'
    const init = await runCli(['workorder', 'init', '--goal', '地址校验', '--authorize', '--url', otherUrl, '--json'], home)
    assertOk(init, 'init at other url')
    const id = init.json.workOrder.workOrderId
    assert.notEqual(init.json.workOrder.coordinator.baseUrl, baseUrl, '前置：工作单地址应不同于当前地址')

    const result = await runCli(['create', '--cwd', cwd, '--work-order', id, '--authorize', '--url', baseUrl, '--json'], home)
    assert.equal(result.exitCode, EXIT.USAGE)
    assert.equal(result.json.error.code, 'work_order_address_mismatch')
    assert.equal(mock.createCalls, 0, '地址冲突必须在 RPC 之前拒绝')
  } finally {
    await mock.stop()
  }
})

test('R7：并发两次 create（都不传 --session-id）落到同一 sessionId', async () => {
  const { mock, baseUrl, home } = await ready()
  const cwd = await makeTempHome()
  try {
    const workOrder = await initWo(home)
    const id = workOrder.workOrderId
    const args = ['create', '--cwd', cwd, '--work-order', id, '--authorize', '--url', baseUrl, '--json']
    const [left, right] = await Promise.all([runCli(args, home), runCli(args, home)])
    const first = assertOk(left, '并发 create #1')
    const second = assertOk(right, '并发 create #2')
    assert.equal(first.sessionId, second.sessionId, '锁内必须选定同一身份')
    assert.equal(mock.createdSessions.length, 1, '并发不得产生第二个会话')
  } finally {
    await mock.stop()
  }
})

test('R7：blocked / needs_user 时 create 被拒且零 HTTP', async () => {
  const { mock, baseUrl, home } = await ready()
  const cwd = await makeTempHome()
  try {
    const blockedWo = await initWo(home)
    assertOk(await runCli(['workorder', 'phase', blockedWo.workOrderId, '--name', 'negotiation', '--state', 'blocked', '--evidence', '等待人工', '--json'], home), 'phase blocked')
    const blocked = await runCli(['create', '--cwd', cwd, '--work-order', blockedWo.workOrderId, '--authorize', '--url', baseUrl, '--json'], home)
    assert.equal(blocked.exitCode, EXIT.USAGE)
    assert.equal(blocked.json.error.code, 'work_order_blocked')

    const needsWo = await initWo(home)
    assertOk(await runCli(['workorder', 'phase', needsWo.workOrderId, '--name', 'negotiation', '--state', 'needs_user', '--evidence', '需用户决定', '--json'], home), 'phase needs_user')
    const needs = await runCli(['create', '--cwd', cwd, '--work-order', needsWo.workOrderId, '--authorize', '--url', baseUrl, '--json'], home)
    assert.equal(needs.exitCode, EXIT.USAGE)
    assert.equal(needs.json.error.code, 'work_order_blocked')

    assert.equal(mock.createCalls, 0, '被阻塞的工作单不得触发 session/create')
  } finally {
    await mock.stop()
  }
})

test('F2：accepted 后 create/rename/send --work-order 被拒 work_order_accepted 且零 HTTP', async () => {
  const { mock, baseUrl, home } = await ready()
  const cwd = await makeTempHome()
  const sid = 'session-acc-1'
  try {
    const id = await driveToAccepted({ home, baseUrl, cwd, sessionId: sid })
    assert.equal((await readWo(home, id)).status, 'accepted')

    const file = woPath(home, id)
    const before = await readFile(file, 'utf8')
    const createCalls = mock.createCalls
    const renameCalls = mock.requestCounts.get('session/rename') ?? 0
    const promptCalls = mock.requestCounts.get('session/prompt') ?? 0

    const created = await runCli(['create', '--cwd', cwd, '--work-order', id, '--authorize', '--url', baseUrl, '--json'], home)
    assert.equal(created.exitCode, EXIT.USAGE)
    assert.equal(created.json.error.code, 'work_order_accepted')

    const renamed = await runCli(['rename', sid, '--title', '不应生效', '--work-order', id, '--authorize', '--url', baseUrl, '--json'], home)
    assert.equal(renamed.exitCode, EXIT.USAGE)
    assert.equal(renamed.json.error.code, 'work_order_accepted')

    const taskFile = await writeTaskFile(home, 'task.md', '不应发送')
    const sent = await runCli(['send', '--file', taskFile, '--work-order', id, '--authorize', '--url', baseUrl, '--json'], home)
    assert.equal(sent.exitCode, EXIT.USAGE)
    assert.equal(sent.json.error.code, 'work_order_accepted')

    assert.equal(mock.createCalls, createCalls, 'accepted 后 create 必须零 HTTP')
    assert.equal(mock.requestCounts.get('session/rename') ?? 0, renameCalls, 'accepted 后 rename 必须零 HTTP')
    assert.equal(mock.requestCounts.get('session/prompt') ?? 0, promptCalls, 'accepted 后 send 必须零 HTTP')
    assert.equal(await readFile(file, 'utf8'), before, 'accepted 工作单不得被任何写命令改动')
  } finally {
    await mock.stop()
  }
})

test('F3：create 超时 unknown 后同 ID 恢复 reused=true 且仍只一个会话', async () => {
  const { mock, baseUrl, home } = await ready({ createDelayMs: 900 })
  const cwd = await makeTempHome()
  try {
    const workOrder = await initWo(home)
    const id = workOrder.workOrderId
    const timedOut = await runCli([
      'create', '--cwd', cwd, '--work-order', id, '--authorize', '--url', baseUrl, '--http-timeout', '150', '--json',
    ], home)
    assert.equal(timedOut.exitCode, EXIT.SUBMISSION_UNKNOWN)
    const firstId = timedOut.json.sessionId
    assert.ok(/^session-/.test(firstId), `超时也必须保留稳定身份：${firstId}`)
    assert.equal((await readWo(home, id)).executor.creation.state, 'unknown')

    mock.behavior.createDelayMs = 0
    const recovered = assertOk(await runCli([
      'create', '--cwd', cwd, '--work-order', id, '--authorize', '--url', baseUrl, '--json',
    ], home), 'create recovery')
    assert.equal(recovered.sessionId, firstId, '恢复必须复用 unknown 时保存的同一身份')
    assert.equal(recovered.reused, true, '本次调用前已保存该 sessionId → reused:true')
    assert.equal(mock.createdSessions.length, 1, '恢复不得产生第二个 sessionId')
  } finally {
    await mock.stop()
  }
})

test('R8：工作单已绑定身份时 rename/attach/deliver 错目标被拒且零 HTTP；无工作单 rename 仍可用', async () => {
  const { mock, baseUrl, home } = await ready()
  const cwd = await makeTempHome()
  const owner = 'session-owner-1'
  try {
    const workOrder = await initWo(home)
    const id = workOrder.workOrderId
    assertOk(await runCli(['create', '--cwd', cwd, '--session-id', owner, '--work-order', id, '--authorize', '--url', baseUrl, '--json'], home), 'create owner')

    const beta = mock.sessions.find(session => session.sessionId === 'sess-beta')
    const betaTitleBefore = beta.projections.values.title ?? null
    const file = woPath(home, id)
    const before = await readFile(file, 'utf8')
    const renameCalls = mock.requestCounts.get('session/rename') ?? 0

    const renameWrong = await runCli(['rename', 'sess-beta', '--title', '不应生效', '--work-order', id, '--authorize', '--url', baseUrl, '--json'], home)
    assert.equal(renameWrong.exitCode, EXIT.USAGE)
    assert.equal(renameWrong.json.error.code, 'session_identity_mismatch')
    assert.equal(mock.requestCounts.get('session/rename') ?? 0, renameCalls, '错目标 rename 必须零 HTTP')
    assert.equal(mock.sessions.find(session => session.sessionId === 'sess-beta').projections.values.title ?? null, betaTitleBefore, '目标会话不得被改名')

    const attachWrong = await runCli(['workorder', 'attach', id, '--session', 'session-other-2', '--cwd', '/tmp', '--json'], home)
    assert.equal(attachWrong.exitCode, EXIT.USAGE)
    assert.equal(attachWrong.json.error.code, 'session_identity_mismatch')

    const deliverWrong = await runCli(['workorder', 'deliver', id, '--request-id', 'req-r8', '--session', 'session-other-2', '--json'], home)
    assert.equal(deliverWrong.exitCode, EXIT.USAGE)
    assert.equal(deliverWrong.json.error.code, 'session_identity_mismatch')

    assert.equal(await readFile(file, 'utf8'), before, '被拒的写操作不得改动工作单')
    assert.equal((await readWo(home, id)).executor.sessionId, owner, '工作单身份不得漂移')

    // 无工作单的 rename 仍保留「用户明确指目标」的能力。
    const freeRename = assertOk(await runCli(['rename', 'sess-alpha', '--title', '无工作单标题', '--authorize', '--url', baseUrl, '--json'], home), 'rename without workorder')
    assert.equal(freeRename.sessionId, 'sess-alpha')
    assert.equal(freeRename.activated, true)
  } finally {
    await mock.stop()
  }
})

test('R8：blocked / needs_user 时 rename --work-order 被拒 work_order_blocked，零 HTTP 且标题不变', async () => {
  const { mock, baseUrl, home } = await ready()
  const cwd = await makeTempHome()
  const cases = [
    ['blocked', 'session-rename-blocked'],
    ['needs_user', 'session-rename-needs'],
  ]
  try {
    for (const [state, sid] of cases) {
      const workOrder = await initWo(home)
      const id = workOrder.workOrderId
      assertOk(await runCli([
        'create', '--cwd', cwd, '--session-id', sid, '--work-order', id, '--authorize', '--url', baseUrl, '--json',
      ], home), `create ${state}`)
      assertOk(await runCli([
        'workorder', 'phase', id, '--name', 'negotiation', '--state', state, '--evidence', '人工介入', '--json',
      ], home), `phase ${state}`)

      const titleBefore = mock.sessions.find(session => session.sessionId === sid).projections.values.title ?? null
      const renameCalls = mock.requestCounts.get('session/rename') ?? 0
      const result = await runCli([
        'rename', sid, '--title', '不应生效', '--work-order', id, '--authorize', '--url', baseUrl, '--json',
      ], home)
      assert.equal(result.exitCode, EXIT.USAGE, `${state} 时 rename 必须被拒：${result.stdout}${result.stderr}`)
      assert.equal(result.json.error.code, 'work_order_blocked', `${state} 应返回 work_order_blocked`)
      assert.equal(mock.requestCounts.get('session/rename') ?? 0, renameCalls, `${state} 时 rename 必须零 HTTP`)
      assert.equal(
        mock.sessions.find(session => session.sessionId === sid).projections.values.title ?? null,
        titleBefore,
        `${state} 时标题不得被改`,
      )
    }
  } finally {
    await mock.stop()
  }
})
