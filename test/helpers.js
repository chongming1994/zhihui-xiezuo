/**
 * 测试辅助：临时状态目录、CLI 运行器、模拟服务生命周期。
 * @module zhihui-xiezuo/test/helpers
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { main } from '../src/cli.js'

/**
 * 当前是否运行在 Windows 上。
 *
 * 用途：把「权限位」这类只有 POSIX 才有意义的断言与平台相关的验证分支区分开。
 */
export const IS_WINDOWS = process.platform === 'win32'

/**
 * 建立隔离的临时状态目录。
 * @returns {Promise<string>} 目录路径。
 */
export async function makeTempHome() {
  return await mkdtemp(join(tmpdir(), 'zhihui-xiezuo-test-'))
}

/**
 * 在进程内运行 CLI 并捕获输出。
 * @param {string[]} args - 参数。
 * @param {string} home - 状态目录。
 * @returns {Promise<{exitCode: number, stdout: string, stderr: string, json: any}>} 运行结果。
 */
export async function runCli(args, home) {
  const out = []
  const err = []
  const exitCode = await main([...args, '--home', home], {
    out: line => out.push(line),
    err: line => err.push(line),
  })
  const stdout = out.join('\n')
  let json = null
  try {
    json = JSON.parse(stdout)
  } catch {
    json = null
  }
  return { exitCode, stdout, stderr: err.join('\n'), json }
}

/**
 * 写入一个受保护的令牌文件。
 * @param {string} dir - 目录。
 * @param {string} token - 令牌。
 * @returns {Promise<string>} 文件路径。
 */
export async function writeTokenFile(dir, token) {
  const file = join(dir, 'token')
  await writeFile(file, `${token}\n`, { mode: 0o600 })
  await chmod(file, 0o600)
  return file
}

/**
 * 写入一个任务文件。
 * @param {string} dir - 目录。
 * @param {string} name - 文件名。
 * @param {string} text - 内容。
 * @returns {Promise<string>} 文件路径。
 */
export async function writeTaskFile(dir, name, text) {
  const file = join(dir, name)
  await writeFile(file, text, 'utf8')
  return file
}

/**
 * 读取文件权限位。
 * @param {string} file - 路径。
 * @returns {Promise<string>} 八进制权限。
 */
export async function modeOf(file) {
  const info = await stat(file)
  return (info.mode & 0o777).toString(8)
}

/**
 * 断言一个文件/目录的权限位，按平台分派。
 *
 * - POSIX：精确断言 `mode & 0o777` 等于 `expected`（强度不因跨平台而放松）。
 * - Windows：`fs.stat().mode` 由 libuv 合成，恒为 `0o666`（只读时 `0o444`），与真实访问权限
 *   无关，mode 位断言必然失败也无意义。Windows 上的权限由 ACL 保证，见 `src/secret-input.js`
 *   的 win32 分支（用 `icacls` 判断宽泛主体）。因此这里退化为断言**路径存在**；调用方在该
 *   测试里对内容/可读性/字段的其它断言照旧全部保留。
 * @param {string} file - 路径。
 * @param {string} expected - POSIX 期望的八进制权限，如 `'600'`。
 * @param {string} [message] - 断言失败时的说明。
 * @returns {Promise<void>} 通过时正常返回。
 */
export async function assertMode(file, expected, message) {
  if (IS_WINDOWS) {
    // Windows 上 mode 由 libuv 合成，恒为 666，权限由 ACL 保证，见 src/secret-input.js。
    await stat(file)
    return
  }
  assert.equal(await modeOf(file), expected, message)
}

export { readFile }

/**
 * 授权的最小实机试发文本（**逐字**，不得改写）。
 *
 * 权威来源：本机消息桥接实施任务书第 60 行。
 * 注意引号是**全角** `U+201C` / `U+201D`，不是半角 `"`；试发文件
 * `实机最小试发.txt` 与该句逐字节一致（仅多一个结尾换行）。
 */
export const AUTHORIZED_TRIAL_TEXT = '这是本机消息桥接连接测试。请仅回复“连接成功”，不要调用任何工具，不修改文件或配置。'
