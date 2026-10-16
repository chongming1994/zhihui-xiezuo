/**
 * 桥接工具的本机状态目录：配置、凭据、请求记录。
 *
 * 目录 0700，敏感文件 0600，写入原子化（同目录临时文件 + fsync + rename）。
 * 凭据（Cookie）与配置分开保存，配置里永远不出现秘密。
 *
 * 跨平台说明：POSIX 上靠 `chmod` 收紧权限；Windows 上文件/目录权限由 **ACL** 决定，
 * `chmod` 只能切换只读位，无法把访问权限收到「仅当前用户」。因此本包在 Windows 上
 * **不自动收紧 ACL**（`restrictMode()` 在 win32 上不调用 `chmod`），需要更强隔离的
 * 用户请自行执行 `icacls <路径> /inheritance:r /grant:r "%USERNAME%:F"`。
 * 状态目录默认位于用户目录之下，继承用户目录的 ACL，通常已只有本人可读。
 * @module zhihui-xiezuo/config
 */

import { constants as fsConstants } from 'node:fs'
import { chmod, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * 按平台收紧一个文件/目录的权限位。
 *
 * - POSIX：直接 `chmod(path, mode)`，与历史行为一致（目录 0700、文件 0600）。
 * - win32：**不调用 `chmod`**。Windows 上 `chmod` 只切只读位，既拦不住其他本机用户，
 *   也会让 0600/0700 的意图落空；真正的隔离靠 ACL。本包不做自动 ACL 收紧
 *   （详见模块头注释），需要时由用户自行 `icacls`。
 * @param {string} path - 目标路径。
 * @param {number} mode - POSIX 权限位，如 `0o600`。
 * @returns {Promise<void>} 完成后返回。
 */
export async function restrictMode(path, mode) {
  if (process.platform === 'win32') return
  await chmod(path, mode)
}

/** 默认地址：仅本机 DSH。 */
export const DEFAULT_BASE_URL = 'http://127.0.0.1:3080'

/** 状态目录版本号，写入每个文件以便未来迁移。 */
export const STATE_VERSION = 1

/**
 * 平台自适应地解析状态目录的默认位置。
 * - win32：`%LOCALAPPDATA%\zhihui-xiezuo`，`LOCALAPPDATA` 缺失时回退 `homedir()/AppData/Local`。
 * - 其它：`~/.local/share/zhihui-xiezuo`（XDG 布局）。
 * @param {NodeJS.Platform} [platform] - 平台，默认取 `process.platform`（测试可注入）。
 * @param {Record<string, string|undefined>} [env] - 环境变量表，默认取 `process.env`。
 * @param {string} [home] - 用户目录，默认取 `homedir()`。
 * @returns {string} 绝对路径。
 */
export function defaultHome(platform = process.platform, env = process.env, home = homedir()) {
  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA
    if (typeof localAppData === 'string' && localAppData !== '') return join(localAppData, 'zhihui-xiezuo')
    return join(home, 'AppData', 'Local', 'zhihui-xiezuo')
  }
  return join(home, '.local', 'share', 'zhihui-xiezuo')
}

/**
 * 解析状态目录。优先级：显式覆盖 → `ZHIHUI_XIEZUO_HOME` → `DSH_BRIDGE_HOME`（旧变量，向后兼容）
 * → 平台默认目录。注意 `DSH_BRIDGE_HOME` 在本版本起指向新目录名的语义保持不变：
 * 该变量只是「显式指定目录」，不参与默认目录名的推导。
 * @param {string} [override] - `--home` 覆盖值。
 * @returns {string} 绝对路径。
 */
export function resolveHome(override) {
  if (override !== undefined && override !== '') return override
  const fromEnv = process.env.ZHIHUI_XIEZUO_HOME
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  // 向后兼容：旧版本用 DSH_BRIDGE_HOME 指定状态目录，继续认这个变量。
  const legacyEnv = process.env.DSH_BRIDGE_HOME
  if (legacyEnv !== undefined && legacyEnv !== '') return legacyEnv
  return defaultHome()
}

/** 状态目录内的固定路径。 */
export class Paths {
  /**
   * @param {string} home - 状态目录。
   */
  constructor(home) {
    this.home = home
    this.config = join(home, 'config.json')
    this.credential = join(home, 'credential.json')
    this.requests = join(home, 'requests')
    /** 协作工作单（机读，0600）。 */
    this.workorders = join(home, 'workorders')
    this.locks = join(home, 'locks')
    this.audit = join(home, 'audit.log')
  }

  /** @param {string} requestId - 请求身份。 @returns {string} 该请求的记录路径。 */
  request(requestId) {
    return join(this.requests, `${requestId}.json`)
  }
}

/**
 * 确保状态目录存在且权限为 0700。
 * @param {Paths} paths - 路径集合。
 * @returns {Promise<void>} 完成后返回。
 */
export async function ensureHome(paths) {
  for (const dir of [paths.home, paths.requests, paths.workorders, paths.locks]) {
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await restrictMode(dir, 0o700)
  }
}

/**
 * 原子写入一个 0600 文件：同目录临时文件写入并 fsync 后 rename。
 * @param {string} file - 目标路径。
 * @param {string} content - 文件内容。
 * @returns {Promise<void>} 完成后返回。
 */
export async function writeFileAtomic(file, content) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  const handle = await open(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600)
  try {
    await handle.writeFile(content, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await restrictMode(tmp, 0o600)
  await rename(tmp, file)
  await restrictMode(file, 0o600)
}

/**
 * 读取 JSON 文件；不存在或损坏时返回回退值。
 * @param {string} file - 文件路径。
 * @param {unknown} fallback - 回退值。
 * @returns {Promise<any>} 解析结果或回退值。
 */
export async function readJson(file, fallback) {
  try {
    const raw = await readFile(file, 'utf8')
    return JSON.parse(raw)
  } catch (error) {
    if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return fallback
    if (error instanceof SyntaxError) return fallback
    throw error
  }
}

/**
 * 原子写入 JSON 文件。
 * @param {string} file - 目标路径。
 * @param {unknown} value - 待序列化的值。
 * @returns {Promise<void>} 完成后返回。
 */
export async function writeJsonAtomic(file, value) {
  await writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`)
}

/** 默认配置。 */
export function defaultConfig() {
  return {
    version: STATE_VERSION,
    baseUrl: DEFAULT_BASE_URL,
    /** 用户显式绑定的会话；永远不推断。 */
    bound: null,
    /** 最近一次 `check` 观测到的接口字段，用于兼容性判断。 */
    contract: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

/**
 * 读取配置。
 * @param {Paths} paths - 路径集合。
 * @returns {Promise<any>} 配置对象。
 */
export async function readConfig(paths) {
  const stored = await readJson(paths.config, null)
  if (stored === null || typeof stored !== 'object') return defaultConfig()
  return { ...defaultConfig(), ...stored }
}

/**
 * 合并写入配置。
 * @param {Paths} paths - 路径集合。
 * @param {object} patch - 要合并的字段。
 * @returns {Promise<any>} 合并后的配置。
 */
export async function updateConfig(paths, patch) {
  const current = await readConfig(paths)
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() }
  await writeJsonAtomic(paths.config, next)
  return next
}

/**
 * 读取凭据文件。返回 null 表示尚未认证。
 * @param {Paths} paths - 路径集合。
 * @returns {Promise<any>} 凭据或 null。
 */
export async function readCredential(paths) {
  const stored = await readJson(paths.credential, null)
  if (stored === null || typeof stored !== 'object') return null
  if (typeof stored.cookieName !== 'string' || typeof stored.cookieValue !== 'string') return null
  return stored
}

/**
 * 写入凭据（0600，原子）。
 * @param {Paths} paths - 路径集合。
 * @param {object} credential - 凭据内容。
 * @returns {Promise<void>} 完成后返回。
 */
export async function writeCredential(paths, credential) {
  await writeJsonAtomic(paths.credential, { version: STATE_VERSION, ...credential })
}

/**
 * 删除凭据文件（用于失效清理）。
 * @param {Paths} paths - 路径集合。
 * @returns {Promise<void>} 完成后返回。
 */
export async function clearCredential(paths) {
  await rm(paths.credential, { force: true })
}

/**
 * 判断凭据是否已过期。
 * @param {any} credential - 凭据。
 * @param {number} [now] - 当前毫秒时间。
 * @returns {boolean} 已过期时为 true。
 */
export function credentialExpired(credential, now = Date.now()) {
  if (credential === null || typeof credential !== 'object') return true
  if (typeof credential.expiresAt !== 'number') return false
  return credential.expiresAt <= now
}

/**
 * 返回文件是否存在的布尔值。
 * @param {string} file - 路径。
 * @returns {Promise<boolean>} 存在为 true。
 */
export async function exists(file) {
  try {
    await stat(file)
    return true
  } catch {
    return false
  }
}
