/**
 * 秘密输入：启动令牌只能经交互输入或受保护文件读入，绝不接受命令行参数。
 *
 * 权限校验按平台分派：
 * - POSIX：沿用 `stat().mode` 位校验，要求不含 group/other 位（行为保持不变）。
 * - Windows：`fs.stat().mode` 由 libuv 合成，恒为 `0o666`（只读时 `0o444`），mode 位校验
 *   会把每个文件都判成过于宽松。因此改用 `icacls` 输出判断是否存在「宽泛主体」的 ACE；
 *   `icacls` 不可用或输出无法解析时降级放行，并向 stderr 打印一条警告。
 * @module zhihui-xiezuo/secret-input
 */

import { readFile, stat } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { BridgeError, EXIT } from './errors.js'

const execFileAsync = promisify(execFile)

/**
 * Windows 上被视为「过于宽松」的主体（按 RDN 末段比较，忽略域/机器前缀）。
 * 命中即拒绝：这些主体允许本机其他用户读取。
 */
const WINDOWS_BROAD_PRINCIPALS = new Set([
  'EVERYONE',
  'USERS',
  'AUTHENTICATED USERS',
  'INTERACTIVE',
  'ANONYMOUS LOGON',
  'DOMAIN USERS',
])

/**
 * 解析 `icacls <file>` 的输出，返回每个 ACE 的主体名（未做去重）。
 *
 * 典型输出：
 * ```text
 * C:\Users\me\token BUILTIN\Administrators:(F)
 *                   NT AUTHORITY\SYSTEM:(F)
 *                   BUILTIN\Users:(RX)
 * ```
 * ACE 行的特征是 `<主体>:(<权限标志>)`，因此以 `:(` 切分主体。
 * @param {string} stdout - `icacls` 的标准输出。
 * @returns {string[]} 主体名列表；无法识别出任何 ACE 时返回空数组。
 */
export function parseIcaclsPrincipals(stdout) {
  const principals = []
  for (const rawLine of String(stdout).split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '') continue
    const marker = line.indexOf(':(')
    if (marker <= 0) continue
    let principal = line.slice(0, marker).trim()
    // 第一行带文件名前缀，形如 `C:\path\to\token BUILTIN\Administrators`，
    // 主体名里不会出现空白，取最后一个空白分隔片段即可。
    if (principal.includes(' ') && principal.includes('\\')) {
      principal = principal.slice(principal.lastIndexOf(' ') + 1)
    }
    if (principal !== '') principals.push(principal)
  }
  return principals
}

/**
 * 判断一个主体名是否属于「宽泛主体」（允许本机其他用户读取）。
 * @param {string} principal - 主体名，如 `BUILTIN\Users`。
 * @returns {boolean} 过宽时为 true。
 */
export function isBroadPrincipal(principal) {
  const upper = String(principal).toUpperCase()
  const rdn = upper.includes('\\') ? upper.slice(upper.lastIndexOf('\\') + 1) : upper
  return WINDOWS_BROAD_PRINCIPALS.has(rdn)
}

/**
 * Windows 上的令牌文件 ACL 校验。
 *
 * 解析不出任何 ACE（`icacls` 缺失、输出格式变化、本地化输出等）时降级放行，
 * 并打印一条 stderr 警告说明 Windows 上无法用 mode 位校验、建议放在用户目录下。
 * @param {string} file - 文件路径。
 * @returns {Promise<void>} 通过时正常返回，过宽时抛出 `token_file_permissions`。
 */
async function assertWindowsTokenFileAcl(file) {
  let stdout = ''
  try {
    const result = await execFileAsync('icacls', [file], { windowsHide: true })
    stdout = String(result.stdout ?? '')
  } catch (error) {
    process.stderr.write(
      `警告：无法执行 icacls 校验令牌文件权限（${error instanceof Error ? error.message : String(error)}）；`
      + '已放行。Windows 上本工具无法用 POSIX mode 位校验令牌文件，建议把令牌文件放在你的用户目录下。\n',
    )
    return
  }
  const principals = parseIcaclsPrincipals(stdout)
  if (principals.length === 0) {
    process.stderr.write(
      `警告：无法解析 icacls 对 ${file} 的输出，无法确认权限；已放行。`
      + 'Windows 上本工具不做自动 ACL 收紧，建议把令牌文件放在你的用户目录下，'
      + `必要时自行执行：icacls "${file}" /inheritance:r /grant:r "%USERNAME%:R"\n`,
    )
    return
  }
  const broad = principals.filter(isBroadPrincipal)
  if (broad.length > 0) {
    throw new BridgeError(
      'token_file_permissions',
      `令牌文件权限过于宽松：ACL 中存在宽泛主体 ${broad.join('、')}，其他本机用户可能读到令牌。`
      + `请先收紧，例如：icacls "${file}" /inheritance:r /grant:r "%USERNAME%:R"`,
      { exitCode: EXIT.USAGE, details: { file, broadPrincipals: broad, principals } },
    )
  }
}

/**
 * 从受保护文件读取令牌。POSIX 要求权限不含 group/other 位；Windows 走 ACL 校验。
 * @param {string} file - 文件路径。
 * @returns {Promise<string>} 去掉首尾空白的令牌。
 */
export async function readTokenFile(file) {
  let info
  try {
    info = await stat(file)
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.code === 'ENOENT') {
      throw new BridgeError('token_file_missing', `令牌文件不存在：${file}`, {
        exitCode: EXIT.USAGE,
        details: { file },
      })
    }
    throw error
  }
  if (!info.isFile()) {
    throw new BridgeError('token_file_not_file', `令牌路径不是普通文件：${file}`, { exitCode: EXIT.USAGE })
  }
  if (process.platform === 'win32') {
    await assertWindowsTokenFileAcl(file)
  } else {
    const mode = info.mode & 0o777
    if ((mode & 0o077) !== 0) {
      throw new BridgeError('token_file_permissions', `令牌文件权限过于宽松（${mode.toString(8)}），请先执行 chmod 600 ${file}。`, {
        exitCode: EXIT.USAGE,
        details: { file, mode: mode.toString(8) },
      })
    }
  }
  const raw = await readFile(file, 'utf8')
  return raw.trim()
}

/**
 * 从终端无回显读取令牌；非 TTY 时按行读取标准输入。
 * @param {string} prompt - 提示语。
 * @returns {Promise<string>} 令牌。
 */
export async function readTokenInteractive(prompt) {
  const stdin = process.stdin
  if (stdin.isTTY !== true) {
    const chunks = []
    for await (const chunk of stdin) chunks.push(chunk)
    const text = Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8').trim()
    if (text === '') throw new BridgeError('token_empty', '标准输入没有读到令牌。', { exitCode: EXIT.USAGE })
    return text.split('\n')[0].trim()
  }
  process.stderr.write(prompt)
  return await new Promise((resolve, reject) => {
    let value = ''
    const wasRaw = stdin.isRaw === true
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')
    const finish = (error) => {
      stdin.setRawMode(wasRaw)
      stdin.pause()
      stdin.off('data', onData)
      process.stderr.write('\n')
      if (error !== undefined) reject(error)
      else resolve(value.trim())
    }
    const onData = (chunk) => {
      for (const char of String(chunk)) {
        if (char === '\r' || char === '\n') {
          if (value.trim() === '') {
            finish(new BridgeError('token_empty', '没有输入令牌。', { exitCode: EXIT.USAGE }))
            return
          }
          finish(undefined)
          return
        }
        if (char === '\u0003') {
          finish(new BridgeError('cancelled', '已取消。', { exitCode: EXIT.ERROR }))
          return
        }
        if (char === '\u007f' || char === '\b') {
          value = value.slice(0, -1)
          continue
        }
        value += char
      }
    }
    stdin.on('data', onData)
  })
}
