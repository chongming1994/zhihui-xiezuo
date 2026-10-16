/**
 * 桥接工具的错误类型与退出码。
 *
 * 退出码是给调用方（Codex 等）用的稳定契约：0 成功、非 0 表示具体失败类别。
 * 区分“已接受”与“已完成”由请求状态承担，不由退出码承担。
 * @module zhihui-xiezuo/errors
 */

/** 稳定退出码。 */
export const EXIT = {
  /** 命令成功。 */
  OK: 0,
  /** 未分类错误。 */
  ERROR: 1,
  /** 用法错误。 */
  USAGE: 2,
  /** 认证缺失、失败，或信任校验拒绝（HTTP 401/403）。 */
  AUTH: 3,
  /** 目标不存在（会话、请求记录）。 */
  NOT_FOUND: 4,
  /** 本地等待超时（不代表远端失败或取消）。 */
  TIMEOUT: 5,
  /** 关联无法证明，结果不确定。 */
  UNCERTAIN: 6,
  /** 提交结果未知（请求已发出但没有拿到确定回执）。 */
  SUBMISSION_UNKNOWN: 7,
}

/**
 * 带稳定错误码与退出码的桥接错误。
 */
export class BridgeError extends Error {
  /**
   * @param {string} code - 机器可读错误码，例如 `auth_required`。
   * @param {string} message - 面向人的中文说明。
   * @param {object} [options] - 退出码与附加字段。
   * @param {number} [options.exitCode] - 进程退出码，默认 {@link EXIT.ERROR}。
   * @param {object} [options.details] - 附加的结构化细节（不得含秘密）。
   * @param {Error} [options.cause] - 原始错误。
   */
  constructor(code, message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'BridgeError'
    this.code = code
    this.exitCode = options.exitCode ?? EXIT.ERROR
    this.details = options.details ?? {}
  }
}

/** 认证缺失或失败。 */
export function authError(code, message, details) {
  return new BridgeError(code, message, { exitCode: EXIT.AUTH, details })
}

/** 目标不存在。 */
export function notFoundError(code, message, details) {
  return new BridgeError(code, message, { exitCode: EXIT.NOT_FOUND, details })
}

/** 用法错误。 */
export function usageError(message, details) {
  return new BridgeError('usage', message, { exitCode: EXIT.USAGE, details })
}

/**
 * 把任意抛出物规范化为 {@link BridgeError}。
 * @param {unknown} error - 捕获到的值。
 * @returns {BridgeError} 规范化错误。
 */
export function asBridgeError(error) {
  if (error instanceof BridgeError) return error
  const message = error instanceof Error ? error.message : String(error)
  return new BridgeError('internal', message, { cause: error instanceof Error ? error : undefined })
}
