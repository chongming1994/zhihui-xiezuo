/**
 * 认证、检查、会话列举与绑定：对模拟服务的行为验证。
 * @module zhihui-xiezuo/test/auth-check.test
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chmod, readFile } from 'node:fs/promises'
import { MockDsh } from './mock-dsh.js'
import { makeTempHome, modeOf, runCli, writeTokenFile } from './helpers.js'
import { Paths, readConfig, readCredential } from '../src/config.js'
import { EXIT } from '../src/errors.js'

/** 启动模拟服务与临时目录。 */
async function setup(options = {}) {
  const mock = new MockDsh(options)
  const { baseUrl, token } = await mock.start()
  const home = await makeTempHome()
  return { mock, baseUrl, token, home }
}

test('auth：正常令牌换 Cookie，输出不含令牌与 Cookie 值', async () => {
  const { mock, baseUrl, token, home } = await setup()
  try {
    const file = await writeTokenFile(home, token)
    const result = await runCli(['auth', '--url', baseUrl, '--token-file', file], home)
    assert.equal(result.exitCode, EXIT.OK, result.stderr)
    assert.ok(!result.stdout.includes(token), '输出不得包含令牌')
    assert.ok(!result.stdout.includes(mock.cookieValue), '输出不得包含 Cookie 值')
    assert.match(result.stdout, /认证成功/u)
    const paths = new Paths(home)
    assert.equal(await modeOf(paths.credential), '600')
    const credential = await readCredential(paths)
    assert.equal(credential.cookieName, mock.cookieName)
    assert.equal(credential.cookieValue, mock.cookieValue)
    const config = await readConfig(paths)
    assert.equal(config.baseUrl, baseUrl)
    assert.equal(config.bound, null)
  } finally {
    await mock.stop()
  }
})

test('auth：错误令牌明确失败，不写入任何凭据', async () => {
  const { mock, baseUrl, home } = await setup()
  try {
    const file = await writeTokenFile(home, 'wrong-token-value')
    const result = await runCli(['auth', '--url', baseUrl, '--token-file', file, '--json'], home)
    assert.equal(result.exitCode, EXIT.AUTH)
    assert.equal(result.json.ok, false)
    assert.equal(result.json.error.code, 'token_rejected')
    assert.equal(await readCredential(new Paths(home)), null)
  } finally {
    await mock.stop()
  }
})

test('auth：拒绝权限过宽的令牌文件', async () => {
  const { mock, baseUrl, home } = await setup()
  try {
    const file = await writeTokenFile(home, 'whatever')
    await chmod(file, 0o644)
    const result = await runCli(['auth', '--url', baseUrl, '--token-file', file], home)
    assert.equal(result.exitCode, EXIT.USAGE)
    assert.match(result.stderr, /权限/u)
  } finally {
    await mock.stop()
  }
})

test('auth：令牌文件不存在时给出明确错误', async () => {
  const { mock, baseUrl, home } = await setup()
  try {
    const result = await runCli(['auth', '--url', baseUrl, '--token-file', `${home}/nope`], home)
    assert.equal(result.exitCode, EXIT.USAGE)
    assert.match(result.stderr, /不存在/u)
  } finally {
    await mock.stop()
  }
})

test('check：未认证时失败且提示先认证', async () => {
  const { mock, baseUrl, home } = await setup()
  try {
    const result = await runCli(['check', '--url', baseUrl, '--json'], home)
    assert.equal(result.exitCode, EXIT.AUTH)
    assert.equal(result.json.error.code, 'auth_required')
  } finally {
    await mock.stop()
  }
})

test('check：认证后通过并记录接口字段', async () => {
  const { mock, baseUrl, token, home } = await setup()
  try {
    const file = await writeTokenFile(home, token)
    await runCli(['auth', '--url', baseUrl, '--token-file', file], home)
    const result = await runCli(['check', '--url', baseUrl, '--json'], home)
    assert.equal(result.exitCode, EXIT.OK, result.stderr)
    assert.equal(result.json.ok, true)
    assert.equal(result.json.contract.sessionCount, 2)
    for (const field of ['sessionId', 'running', 'agentAvailable', 'updatedAt']) {
      assert.ok(result.json.contract.sessionSummaryFields.includes(field), `缺少字段 ${field}`)
    }
    assert.deepEqual(result.json.contract.missingFields, [])
    assert.ok(!result.stdout.includes(mock.cookieValue))
  } finally {
    await mock.stop()
  }
})

test('check：HTTP 401 与 403 分别给出认证/信任失败', async () => {
  const { mock, baseUrl, token, home } = await setup()
  try {
    const file = await writeTokenFile(home, token)
    await runCli(['auth', '--url', baseUrl, '--token-file', file], home)
    mock.behavior.forceStatus = 401
    const unauthorized = await runCli(['check', '--url', baseUrl, '--json'], home)
    assert.equal(unauthorized.exitCode, EXIT.AUTH)
    assert.equal(unauthorized.json.error.code, 'auth_required')
    mock.behavior.forceStatus = 403
    const forbidden = await runCli(['check', '--url', baseUrl, '--json'], home)
    assert.equal(forbidden.exitCode, EXIT.AUTH)
    assert.equal(forbidden.json.error.code, 'trust_rejected')
    mock.behavior.forceStatus = null
  } finally {
    await mock.stop()
  }
})

test('check：凭据过期时明确要求重新认证', async () => {
  const { mock, baseUrl, token, home } = await setup()
  try {
    const file = await writeTokenFile(home, token)
    await runCli(['auth', '--url', baseUrl, '--token-file', file], home)
    const paths = new Paths(home)
    const credential = await readCredential(paths)
    const { writeJsonAtomic } = await import('../src/config.js')
    await writeJsonAtomic(paths.credential, { ...credential, expiresAt: Date.now() - 1000 })
    const result = await runCli(['check', '--url', baseUrl, '--json'], home)
    assert.equal(result.exitCode, EXIT.AUTH)
    assert.equal(result.json.error.code, 'credential_expired')
  } finally {
    await mock.stop()
  }
})

test('sessions：只输出摘要，不包含聊天正文', async () => {
  const { mock, baseUrl, token, home } = await setup()
  try {
    mock.append('sess-beta', 'user/message', {
      id: 'm1', role: 'user', content: [{ type: 'text', text: '这是不该被列出的私密正文' }], source: { kind: 'user' },
    })
    const file = await writeTokenFile(home, token)
    await runCli(['auth', '--url', baseUrl, '--token-file', file], home)
    const result = await runCli(['sessions', '--url', baseUrl, '--json'], home)
    assert.equal(result.exitCode, EXIT.OK, result.stderr)
    assert.equal(result.json.sessions.length, 2)
    assert.ok(!result.stdout.includes('私密正文'))
    assert.ok(result.json.sessions.every(row => 'sessionId' in row && 'running' in row))
  } finally {
    await mock.stop()
  }
})

test('bind：存在的会话可绑定，不存在的会话明确失败且不落盘', async () => {
  const { mock, baseUrl, token, home } = await setup()
  try {
    const file = await writeTokenFile(home, token)
    await runCli(['auth', '--url', baseUrl, '--token-file', file], home)
    const bad = await runCli(['bind', 'sess-does-not-exist', '--url', baseUrl, '--json'], home)
    assert.equal(bad.exitCode, EXIT.NOT_FOUND)
    assert.equal(bad.json.error.code, 'session_not_found')
    assert.equal((await readConfig(new Paths(home))).bound, null)

    const good = await runCli(['bind', 'sess-beta', '--url', baseUrl, '--json'], home)
    assert.equal(good.exitCode, EXIT.OK, good.stderr)
    assert.equal(good.json.bound.sessionId, 'sess-beta')
    assert.equal((await readConfig(new Paths(home))).bound.sessionId, 'sess-beta')

    const listed = await runCli(['sessions', '--url', baseUrl, '--json'], home)
    assert.equal(listed.json.boundSessionId, 'sess-beta')
  } finally {
    await mock.stop()
  }
})

test('bind：缺少位置参数时是用法错误', async () => {
  const { mock, baseUrl, home } = await setup()
  try {
    const result = await runCli(['bind', '--url', baseUrl], home)
    assert.equal(result.exitCode, EXIT.USAGE)
  } finally {
    await mock.stop()
  }
})

test('凭据文件内容确实保存在 0600 文件中（并非常量）', async () => {
  const { mock, baseUrl, token, home } = await setup()
  try {
    const file = await writeTokenFile(home, token)
    await runCli(['auth', '--url', baseUrl, '--token-file', file], home)
    const raw = await readFile(new Paths(home).credential, 'utf8')
    assert.ok(raw.includes(mock.cookieValue))
    assert.equal(await modeOf(new Paths(home).credential), '600')
  } finally {
    await mock.stop()
  }
})
