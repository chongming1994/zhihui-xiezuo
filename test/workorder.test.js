/**
 * 工作单：目录/文件权限、原子写与并发、状态机、证据门、协商轮数、投递门、
 * 密钥守卫与只读恢复计划。
 *
 * 全部断言只经公开 CLI 与临时 home，不接触真实 DSH。
 * @module zhihui-xiezuo/test/workorder.test
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { assertMode, makeTempHome, runCli } from './helpers.js'
import { EXIT } from '../src/errors.js'

/** 契约 §2 的阶段名固定集合。 */
const PHASE_NAMES = ['negotiation', 'approval', 'executor_create', 'rename', 'delivery', 'execution', 'report', 'review', 'fix']
/** 契约 §2 的阶段状态固定集合。 */
const PHASE_STATES = ['pending', 'active', 'done', 'failed', 'unknown', 'needs_user', 'blocked']

/** 工作单文件路径。 */
function woPath(home, id) {
  return join(home, 'workorders', `${id}.json`)
}

/** 读取工作单 JSON。 */
async function readWo(home, id) {
  return JSON.parse(await readFile(woPath(home, id), 'utf8'))
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

/** 断言命令成功并返回 JSON。 */
function assertOk(result, label) {
  assert.equal(result.exitCode, EXIT.OK, `${label} 应成功：${result.stderr}${result.stdout}`)
  assert.equal(result.json?.ok, true, `${label} 的 JSON 应为 ok:true`)
  return result.json
}

/** 新建一个工作单并返回记录。 */
async function initWo(home, extra = []) {
  const result = await runCli(['workorder', 'init', '--goal', '协作目标', '--scope', '桥接', '--json', ...extra], home)
  assertOk(result, 'workorder init')
  return result.json.workOrder
}

test('init：目录 0700、文件 0600、无 .tmp 残留、字段齐全；无 --authorize 为 draft', async () => {
  const home = await makeTempHome()
  const record = await initWo(home, [
    '--authorize', '--reason', '用户已授权', '--coordinator', 'sess-coord', '--max-rounds', '3',
  ])
  const dir = join(home, 'workorders')
  await assertMode(dir, '700', '工作单目录必须是 0700')

  const file = woPath(home, record.workOrderId)
  await assertMode(file, '600', '工作单文件必须是 0600')

  const entries = await readdir(dir)
  assert.ok(entries.every(name => !name.includes('.tmp')), `目录不得残留 .tmp：${entries.join(', ')}`)

  const stored = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(stored.version, 1)
  assert.equal(stored.workOrderId, record.workOrderId)
  assert.equal(stored.goal, '协作目标')
  assert.deepEqual(stored.scope, ['桥接'])
  assert.equal(stored.authorization.granted, true)
  assert.equal(stored.authorization.source, 'user')
  assert.equal(stored.authorization.note, '用户已授权')
  assert.equal(stored.status, 'negotiating')
  assert.equal(stored.negotiation.maxRounds, 3)
  assert.equal(stored.coordinator.sessionId, 'sess-coord')
  assert.equal(stored.executor.creation.state, 'none')
  assert.equal(stored.executor.rename.state, 'none')
  assert.equal(stored.delivery.state, 'none')
  assert.equal(stored.review.verdict, 'none')
  assert.ok(Array.isArray(stored.phases) && stored.phases.length > 0, '必须初始化 phases')
  assert.deepEqual(
    stored.phases.map(phase => phase.name).sort(),
    [...PHASE_NAMES].sort(),
    'phases 必须覆盖固定阶段名集合',
  )
  assert.ok(stored.phases.every(phase => PHASE_STATES.includes(phase.state)))

  // 无 --authorize：只读准备态，不得自称已授权。
  const draft = await initWo(home)
  assert.equal(draft.status, 'draft')
  assert.equal(draft.authorization.granted, false)
  assert.equal(draft.authorization.grantedAt, null)
})

test('并发 phase 写同一工作单：两个更新都落盘、JSON 仍可解析', async () => {
  const home = await makeTempHome()
  const record = await initWo(home, ['--authorize'])
  const id = record.workOrderId

  const [left, right] = await Promise.all([
    runCli(['workorder', 'phase', id, '--name', 'report', '--state', 'active', '--request-id', 'req-conc-1', '--json'], home),
    runCli(['workorder', 'phase', id, '--name', 'delivery', '--state', 'active', '--request-id', 'req-conc-2', '--json'], home),
  ])
  assertOk(left, '并发 phase #1')
  assertOk(right, '并发 phase #2')

  const stored = await readWo(home, id)
  assert.equal(stored.phases.find(phase => phase.name === 'report').requestId, 'req-conc-1')
  assert.equal(stored.phases.find(phase => phase.name === 'delivery').requestId, 'req-conc-2')
  assert.equal(stored.phases.find(phase => phase.name === 'report').state, 'active')
  assert.equal(stored.phases.find(phase => phase.name === 'delivery').state, 'active')
})

test('非法转移：draft 直接 review accepted 被拒且文件不变', async () => {
  const home = await makeTempHome()
  const record = await initWo(home)
  const id = record.workOrderId
  const file = woPath(home, id)
  const before = await readFile(file, 'utf8')

  const result = await runCli(['workorder', 'review', id, '--verdict', 'accepted', '--evidence', '自封通过', '--json'], home)
  assert.equal(result.exitCode, EXIT.USAGE)
  assert.equal(result.json.error.code, 'invalid_transition')
  assert.equal(await readFile(file, 'utf8'), before, '被拒的转移不得写盘')
  assert.equal((await readWo(home, id)).status, 'draft')
})

test('phase --state done 缺 evidence/request-id → evidence_required 且不落盘', async () => {
  const home = await makeTempHome()
  const record = await initWo(home, ['--authorize'])
  const id = record.workOrderId
  const file = woPath(home, id)
  const before = await readFile(file, 'utf8')

  const result = await runCli(['workorder', 'phase', id, '--name', 'report', '--state', 'done', '--json'], home)
  assert.equal(result.exitCode, EXIT.USAGE)
  assert.equal(result.json.error.code, 'evidence_required')
  assert.equal(await readFile(file, 'utf8'), before, '证据不足时不得写盘')
})

test('report 只登记为 reported；只有 review accepted 才 accepted，accepted 为终态', async () => {
  const home = await makeTempHome()
  const record = await initWo(home, ['--authorize'])
  const id = record.workOrderId
  const file = woPath(home, id)
  const req = 'req-a5'

  assertOk(await runCli(['workorder', 'negotiate', id, '--round', '1', '--request-id', req, '--json'], home), 'negotiate')
  assertOk(await runCli(['workorder', 'approve', id, '--evidence', '用户定案', '--json'], home), 'approve')
  assertOk(await runCli(['workorder', 'deliver', id, '--request-id', req, '--session', 'session-local-a5', '--json'], home), 'deliver')
  assertOk(await runCli(['workorder', 'report', id, '--request-id', req, '--json'], home), 'report')

  let stored = await readWo(home, id)
  assert.equal(stored.status, 'reported', 'DSH 报告只能到 reported')
  assert.notEqual(stored.status, 'accepted', 'report 不得自动验收')
  assert.equal(stored.review.verdict, 'none')

  assertOk(
    await runCli(['workorder', 'review', id, '--verdict', 'accepted', '--evidence', 'Codex 复查通过', '--by', 'codex', '--json'], home),
    'review accepted',
  )
  stored = await readWo(home, id)
  assert.equal(stored.status, 'accepted')
  assert.equal(stored.review.verdict, 'accepted')
  assert.equal(stored.review.by, 'codex')

  const before = await readFile(file, 'utf8')
  const mutate = await runCli(['workorder', 'phase', id, '--name', 'fix', '--state', 'active', '--request-id', 'req-after', '--json'], home)
  assert.equal(mutate.exitCode, EXIT.USAGE, 'accepted 是终态，不能再改')
  assert.equal(mutate.json.error.code, 'work_order_accepted')
  assert.equal(await readFile(file, 'utf8'), before)
})

test('negotiate 超轮数：无 --user-decision 拒绝且不写 rounds；带决定放行并记录', async () => {
  const home = await makeTempHome()
  const record = await initWo(home, ['--authorize', '--max-rounds', '2'])
  const id = record.workOrderId
  const file = woPath(home, id)

  assertOk(await runCli(['workorder', 'negotiate', id, '--round', '1', '--request-id', 'req-r1', '--json'], home), 'round1')
  assertOk(await runCli(['workorder', 'negotiate', id, '--round', '2', '--request-id', 'req-r2', '--json'], home), 'round2')
  assert.equal((await readWo(home, id)).negotiation.rounds.length, 2)

  const before = await readFile(file, 'utf8')
  const third = await runCli(['workorder', 'negotiate', id, '--round', '3', '--request-id', 'req-r3', '--json'], home)
  assert.equal(third.exitCode, EXIT.USAGE, '超过 maxRounds 且无用户决定必须拒绝')
  assert.equal(third.json.error.code, 'negotiation_limit')
  assert.equal(await readFile(file, 'utf8'), before, '被拒的协商不得写入 rounds')
  assert.equal((await readWo(home, id)).negotiation.rounds.length, 2)

  assertOk(
    await runCli(['workorder', 'negotiate', id, '--round', '3', '--request-id', 'req-r3', '--user-decision', '用户同意进入第三轮', '--json'], home),
    'round3 with user decision',
  )
  const stored = await readWo(home, id)
  assert.equal(stored.negotiation.rounds.length, 3)
  assert.equal(stored.negotiation.rounds[2].requestId, 'req-r3')
  assert.equal(stored.negotiation.rounds[2].userDecision, '用户同意进入第三轮')
})

test('needs_user / blocked 时 deliver 被拒 work_order_blocked 且不落盘', async () => {
  const home = await makeTempHome()
  const record = await initWo(home, ['--authorize'])
  const id = record.workOrderId

  assertOk(
    await runCli(['workorder', 'phase', id, '--name', 'negotiation', '--state', 'needs_user', '--evidence', '需要用户决定', '--json'], home),
    'phase needs_user',
  )
  assert.equal((await readWo(home, id)).status, 'needs_user')
  const needsUserFile = woPath(home, id)
  const needsUserBefore = await readFile(needsUserFile, 'utf8')
  const blockedByUser = await runCli(['workorder', 'deliver', id, '--request-id', 'req-block-1', '--json'], home)
  assert.equal(blockedByUser.exitCode, EXIT.USAGE)
  assert.equal(blockedByUser.json.error.code, 'work_order_blocked')
  assert.equal((await readWo(home, id)).delivery.state, 'none')

  const reportBlocked = await runCli(['workorder', 'report', id, '--request-id', 'req-block-1', '--json'], home)
  assert.equal(reportBlocked.exitCode, EXIT.USAGE)
  assert.equal(reportBlocked.json.error.code, 'work_order_blocked')
  assert.equal(await readFile(needsUserFile, 'utf8'), needsUserBefore, '被阻塞时 deliver/report 都不得落盘')

  assertOk(
    await runCli(['workorder', 'phase', id, '--name', 'negotiation', '--state', 'blocked', '--evidence', '等待人工处理', '--json'], home),
    'phase blocked',
  )
  assert.equal((await readWo(home, id)).status, 'blocked')
  const blocked = await runCli(['workorder', 'deliver', id, '--request-id', 'req-block-2', '--json'], home)
  assert.equal(blocked.exitCode, EXIT.USAGE)
  assert.equal(blocked.json.error.code, 'work_order_blocked')
  assert.equal((await readWo(home, id)).delivery.state, 'none')
})

test('密钥守卫：dsh-auth- / token= 输入被拒且不落盘；工作单文本无凭据字段', async () => {
  const home = await makeTempHome()
  const dir = join(home, 'workorders')

  const cookieHit = await runCli(['workorder', 'init', '--goal', '目标', '--scope', 'dsh-auth-abcdef123456', '--authorize', '--json'], home)
  assert.equal(cookieHit.exitCode, EXIT.ERROR)
  assert.equal(cookieHit.json.error.code, 'workorder_secret_rejected')

  const tokenHit = await runCli(['workorder', 'init', '--goal', 'token=abcdefgh', '--authorize', '--json'], home)
  assert.equal(tokenHit.exitCode, EXIT.ERROR)
  assert.equal(tokenHit.json.error.code, 'workorder_secret_rejected')

  assert.deepEqual(await readdir(dir), [], '命中凭据特征时不得落盘任何工作单')

  const record = await initWo(home, ['--authorize'])
  const text = await readFile(woPath(home, record.workOrderId), 'utf8').then(value => value.toLowerCase())
  for (const marker of ['dsh-auth-', 'token=', 'cookie', 'password', 'secret', 'credential']) {
    assert.ok(!text.includes(marker), `工作单 JSON 不得含凭据字段：${marker}`)
  }
})

test('recover：creation none/unknown 与 delivery unknown/failed 的计划正确且只读', async () => {
  const home = await makeTempHome()

  // 情形一：creation none —— 用预存 sessionId 创建（收养），禁止生成新 ID。
  const noneWo = await initWo(home, ['--authorize'])
  const noneFile = woPath(home, noneWo.workOrderId)
  const noneBefore = await readFile(noneFile, 'utf8')
  const nonePlan = assertOk(await runCli(['workorder', 'recover', noneWo.workOrderId, '--json'], home), 'recover creation none')
  assert.equal(nonePlan.recovery.steps.creation, 'none')
  assert.equal(nonePlan.recovery.nextActions[0].action, 'create_adopt')
  assert.ok(nonePlan.recovery.forbidden.includes('不得生成新的 sessionId'))
  assert.equal(await readFile(noneFile, 'utf8'), noneBefore, 'recover 必须只读')

  // 情形二：creation unknown —— 只能同 ID 收养/重试，禁止新 ID。
  const unknownWo = await initWo(home, ['--authorize'])
  const unknownId = unknownWo.workOrderId
  assertOk(await runCli([
    'workorder', 'attach', unknownId, '--session', 'session-rec-unknown',
    '--cwd', '/tmp', '--creation-state', 'unknown', '--evidence', '创建回执未确认', '--json',
  ], home), 'attach creation unknown')
  assert.equal((await readWo(home, unknownId)).executor.creation.state, 'unknown')
  const unknownPlan = assertOk(await runCli(['workorder', 'recover', unknownId, '--json'], home), 'recover creation unknown')
  assert.equal(unknownPlan.recovery.steps.creation, 'unknown')
  const createAction = unknownPlan.recovery.nextActions.find(action => action.action === 'create_adopt')
  assert.ok(createAction !== undefined, 'creation unknown 必须给出 create 收养动作')
  assert.ok(createAction.command.includes('create'))
  assert.ok(createAction.command.includes('--session-id session-rec-unknown'))
  assert.ok(unknownPlan.recovery.forbidden.includes('不得生成新的 sessionId'))

  // 情形三：delivery unknown —— 只允许 status/wait 同 requestId，禁止重发。
  const deliveryWo = await initWo(home, ['--authorize'])
  const deliveryId = deliveryWo.workOrderId
  assertOk(await runCli([
    'workorder', 'attach', deliveryId, '--session', 'session-deliv-unknown',
    '--cwd', '/tmp', '--creation-state', 'created', '--evidence', '已核对创建回执', '--json',
  ], home), 'attach creation created')
  assertOk(await runCli([
    'workorder', 'deliver', deliveryId, '--request-id', 'req-deliv-unknown',
    '--session', 'session-deliv-unknown', '--state', 'unknown', '--json',
  ], home), 'deliver unknown')
  assert.equal((await readWo(home, deliveryId)).delivery.state, 'unknown')

  const deliveryFile = woPath(home, deliveryId)
  const deliveryBefore = await readFile(deliveryFile, 'utf8')
  const deliveryPlan = assertOk(await runCli(['workorder', 'recover', deliveryId, '--json'], home), 'recover delivery unknown')
  assert.equal(deliveryPlan.recovery.steps.delivery, 'unknown')
  assert.ok(
    deliveryPlan.recovery.nextActions.every(action => ['observe_only', 'status', 'wait'].includes(action.action)),
    `投递未知时只允许观察：${JSON.stringify(deliveryPlan.recovery.nextActions)}`,
  )
  assert.ok(
    deliveryPlan.recovery.nextActions.some(action => String(action.command).includes('status') || String(action.command).includes('wait')),
    '必须给出按同一 requestId 查询/等待的动作',
  )
  assert.ok(
    deliveryPlan.recovery.forbidden.some(item => item.includes('不得重发')),
    '投递未知必须显式禁止重发',
  )
  assert.equal(await readFile(deliveryFile, 'utf8'), deliveryBefore, 'recover 必须只读')

  // 情形四：delivery failed —— 先核对再决定，不得未核对自动重发。
  const failedWo = await initWo(home, ['--authorize'])
  const failedId = failedWo.workOrderId
  assertOk(await runCli([
    'workorder', 'attach', failedId, '--session', 'session-deliv-failed',
    '--cwd', '/tmp', '--creation-state', 'created', '--evidence', '已核对创建回执', '--json',
  ], home), 'attach for delivery failed')
  assertOk(await runCli([
    'workorder', 'deliver', failedId, '--request-id', 'req-deliv-failed', '--state', 'failed', '--json',
  ], home), 'deliver failed')
  const failedPlan = assertOk(await runCli(['workorder', 'recover', failedId, '--json'], home), 'recover delivery failed')
  assert.equal(failedPlan.recovery.steps.delivery, 'failed')
  assert.ok(failedPlan.recovery.nextActions.every(action => action.action !== 'none'))
  assert.ok(
    failedPlan.recovery.forbidden.some(item => item.includes('不得在未核对前自动重发')),
    '投递失败必须先核对，不得自动重发',
  )
})

/** 把工作单推进到 accepted（全程零 HTTP）。 */
async function driveToAccepted(home, id) {
  const req = 'req-f2'
  assertOk(await runCli(['workorder', 'negotiate', id, '--round', '1', '--request-id', req, '--json'], home), 'negotiate')
  assertOk(await runCli(['workorder', 'approve', id, '--evidence', '用户定案', '--json'], home), 'approve')
  assertOk(await runCli(['workorder', 'deliver', id, '--request-id', req, '--session', 'session-local-f2', '--json'], home), 'deliver')
  assertOk(await runCli(['workorder', 'report', id, '--request-id', req, '--json'], home), 'report')
  assertOk(await runCli(['workorder', 'review', id, '--verdict', 'accepted', '--evidence', 'Codex 复查通过', '--json'], home), 'review accepted')
}

test('accepted 终态：所有工作单写命令被拒 work_order_accepted，文件字节不变', async () => {
  const home = await makeTempHome()
  const record = await initWo(home, ['--authorize'])
  const id = record.workOrderId
  await driveToAccepted(home, id)
  assert.equal((await readWo(home, id)).status, 'accepted')

  const file = woPath(home, id)
  const before = await readFile(file, 'utf8')

  const attempts = [
    ['deliver', ['workorder', 'deliver', id, '--request-id', 'req-after', '--state', 'failed', '--json']],
    ['attach', ['workorder', 'attach', id, '--session', 'session-after', '--cwd', '/tmp', '--creation-state', 'created', '--evidence', 'e', '--json']],
    ['negotiate', ['workorder', 'negotiate', id, '--round', '1', '--request-id', 'req-after', '--user-decision', '用户要求继续', '--json']],
    ['phase', ['workorder', 'phase', id, '--name', 'fix', '--state', 'active', '--request-id', 'req-after', '--json']],
    ['review', ['workorder', 'review', id, '--verdict', 'rejected', '--evidence', 'e', '--json']],
  ]
  for (const [label, args] of attempts) {
    const result = await runCli(args, home)
    assert.equal(result.exitCode, EXIT.USAGE, `${label} 必须被拒：${result.stdout}${result.stderr}`)
    assert.equal(result.json.error.code, 'work_order_accepted', `${label} 应返回 work_order_accepted`)
    assert.equal(await readFile(file, 'utf8'), before, `${label} 不得改动 accepted 工作单`)
  }

  // 只读命令在终态仍必须可用。
  assertOk(await runCli(['workorder', 'show', id, '--json'], home), 'show accepted')
  assertOk(await runCli(['workorder', 'recover', id, '--json'], home), 'recover accepted')
  assertOk(await runCli(['workorder', 'list', '--json'], home), 'list accepted')
})

test('工作单 ID 路径穿越被拒 work_order_id_invalid，不读取状态目录外文件', async () => {
  const home = await makeTempHome()
  const canary = join(home, 'canary-outside.json')
  await writeFile(canary, JSON.stringify({ canary: 'OUTSIDE-CANARY-MARKER' }), 'utf8')

  const attempts = [
    ['show ../canary-outside', ['workorder', 'show', '../canary-outside', '--json']],
    ['show ../../etc/passwd', ['workorder', 'show', '../../etc/passwd', '--json']],
    ['show wo-../../canary-outside', ['workorder', 'show', 'wo-../../canary-outside', '--json']],
    ['recover ../canary-outside', ['workorder', 'recover', '../canary-outside', '--json']],
    ['phase ../canary-outside', ['workorder', 'phase', '../canary-outside', '--name', 'fix', '--state', 'active', '--json']],
    ['attach ../canary-outside', ['workorder', 'attach', '../canary-outside', '--session', 'session-x', '--json']],
  ]
  for (const [label, args] of attempts) {
    const result = await runCli(args, home)
    assert.equal(result.exitCode, EXIT.USAGE, `${label} 必须被拒：${result.stdout}${result.stderr}`)
    assert.equal(result.json.error.code, 'work_order_id_invalid', `${label} 应返回 work_order_id_invalid`)
    assert.ok(
      !`${result.stdout}${result.stderr}`.includes('OUTSIDE-CANARY-MARKER'),
      `${label} 不得读取状态目录外的文件`,
    )
  }

  // 合法格式但不存在 → 目标不存在（证明格式校验不会吞掉 not_found 语义）。
  const missing = await runCli(['workorder', 'show', 'wo-does-not-exist', '--json'], home)
  assert.equal(missing.exitCode, EXIT.NOT_FOUND)
  assert.equal(missing.json.error.code, 'work_order_not_found')
})

test('recover：delivery=preparing（进程崩溃遗留）视为只观察，禁止重发', async () => {
  const home = await makeTempHome()
  const record = await initWo(home, ['--authorize'])
  const id = record.workOrderId
  assertOk(await runCli([
    'workorder', 'attach', id, '--session', 'session-crash',
    '--cwd', '/tmp', '--creation-state', 'created', '--evidence', '已核对创建回执', '--json',
  ], home), 'attach')
  await patchWo(home, id, (draft) => {
    draft.delivery = {
      state: 'preparing', requestId: 'req-crash', sessionId: 'session-crash',
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
})

test('recover：delivered 优先 wait（不再提示 rename）；report 完成 → codex_review', async () => {
  const home = await makeTempHome()
  const record = await initWo(home, ['--authorize'])
  const id = record.workOrderId
  const req = 'req-recover-order'
  assertOk(await runCli([
    'workorder', 'attach', id, '--session', 'session-recover-order',
    '--cwd', '/tmp', '--creation-state', 'created', '--evidence', '已核对创建回执', '--json',
  ], home), 'attach')
  assertOk(await runCli(['workorder', 'deliver', id, '--request-id', req, '--json'], home), 'deliver')

  // 投递已完成时，rename（仍是 none）属外观性步骤，nextActions 只能给 wait。
  const delivered = assertOk(await runCli(['workorder', 'recover', id, '--json'], home), 'recover delivered')
  assert.equal(delivered.recovery.steps.delivery, 'delivered')
  assert.equal(delivered.recovery.steps.rename, 'none')
  assert.deepEqual(
    delivered.recovery.nextActions.map(action => action.action),
    ['wait'],
    `已投递未报告只能给 wait：${JSON.stringify(delivered.recovery.nextActions)}`,
  )
  assert.ok(
    delivered.recovery.forbidden.some(item => item.includes('不得重新 send')),
    '已投递必须禁止重新 send',
  )

  assertOk(await runCli(['workorder', 'report', id, '--request-id', req, '--json'], home), 'report')
  const reported = assertOk(await runCli(['workorder', 'recover', id, '--json'], home), 'recover reported')
  assert.equal(reported.recovery.steps.report, 'done')
  assert.deepEqual(
    reported.recovery.nextActions.map(action => action.action),
    ['codex_review'],
    `报告完成只差独立复查：${JSON.stringify(reported.recovery.nextActions)}`,
  )
  assert.ok(
    reported.recovery.forbidden.some(item => item.includes('不得自动 accepted')),
    '复查阶段必须禁止自动验收',
  )
})
