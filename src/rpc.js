/**
 * DSH `/api` HTTP RPC 客户端与启动令牌换 Cookie。
 *
 * 依据（源码版本见 README / 实施报告）：
 * - 端点：`POST /api/<namespace>/<method>`
 * - 请求体：`{ type:'client-request', rpcId, method, payload:{ args } }`
 * - 响应体：`{ type:'server-response', rpcId, result:{ ok:true, value } | { ok:false, error } }`
 * - 鉴权：浏览器会话 Cookie（`dsh-auth-<hash>`），由 `GET /?token=<TOKEN>` 303 换得
 *
 * 地址边界（fail-closed，无覆盖开关）：只接受本机环回地址，且凭据的 authority
 * 必须与目标地址完全一致；两者任一不满足都在发出任何网络请求之前失败。
 * @module zhihui-xiezuo/rpc
 */

import { randomUUID } from 'node:crypto'
import { authError, BridgeError, EXIT, notFoundError } from './errors.js'
import { redactUrl } from './redact.js'

/** 默认单次请求超时。 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000

/** 允许的本机主机名（与 DSH 信任栅栏的环回判定保持一致的最小集）。 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

/**
 * 判断主机名是否是允许的本机环回地址。
 * @param {string} hostname - `URL.hostname`（IPv6 带方括号）。
 * @returns {boolean} 允许时为 true。
 */
export function isLoopbackHost(hostname) {
  return LOOPBACK_HOSTS.has(String(hostname).toLowerCase())
}

/**
 * 规范化基础地址：只接受 http/https 的本机环回地址，拒绝 userinfo、路径、查询与片段。
 *
 * 该函数**没有**放宽开关：桥接按任务书只服务本机 DSH，任何非环回地址都必须失败关闭，
 * 以免把浏览器会话 Cookie 送到别的地址。
 * @param {string} baseUrl - 原始地址。
 * @returns {string} 规范化地址（无尾斜杠）。
 */
export function normalizeBaseUrl(baseUrl) {
  let url
  try {
    url = new URL(baseUrl)
  } catch {
    throw new BridgeError('bad_url', `地址无法解析：${baseUrl}`, { exitCode: EXIT.USAGE, details: { baseUrl } })
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BridgeError('bad_url', `只支持 http/https 地址，收到 ${url.protocol}`, {
      exitCode: EXIT.USAGE,
      details: { protocol: url.protocol },
    })
  }
  if (url.username !== '' || url.password !== '') {
    throw new BridgeError('bad_url', '地址不得包含用户名或密码（userinfo）。', {
      exitCode: EXIT.USAGE,
      details: { baseUrl: redactUrl(baseUrl) },
    })
  }
  if (!isLoopbackHost(url.hostname)) {
    throw new BridgeError('non_loopback_url', `只允许本机环回地址，拒绝 ${url.hostname}。`, {
      exitCode: EXIT.USAGE,
      details: { hostname: url.hostname, allowed: [...LOOPBACK_HOSTS] },
    })
  }
  if (url.pathname !== '' && url.pathname !== '/') {
    throw new BridgeError('bad_url', `地址不得带路径，收到 ${url.pathname}`, {
      exitCode: EXIT.USAGE,
      details: { pathname: url.pathname },
    })
  }
  if (url.search !== '' || url.hash !== '') {
    throw new BridgeError('bad_url', '地址不得带查询串或片段。', {
      exitCode: EXIT.USAGE,
      details: { baseUrl: redactUrl(baseUrl) },
    })
  }
  url.search = ''
  url.hash = ''
  url.pathname = ''
  return url.href.replace(/\/$/u, '')
}

/**
 * 从 URL 取出 authority（用于凭据绑定与诊断）。
 * @param {string} baseUrl - 基础地址。
 * @returns {string} `host[:port]`。
 */
export function authorityOf(baseUrl) {
  return new URL(baseUrl).host
}

/**
 * 远端业务失败（`result.ok === false`）。
 */
export class RemoteFailure extends Error {
  /**
   * @param {{code: string, message: string, details?: object}} failure - 远端错误字段。
   */
  constructor(failure) {
    super(`${failure.code}: ${failure.message}`)
    this.name = 'RemoteFailure'
    this.remoteCode = failure.code
    this.remoteMessage = failure.message
    this.remoteDetails = failure.details ?? {}
  }

  /**
   * 映射为带退出码的桥接错误。
   * @returns {BridgeError} 规范化错误。
   */
  toBridgeError() {
    if (this.remoteCode === 'session/not-found' || this.remoteCode === 'session/queue-item-not-found') {
      return notFoundError(this.remoteCode, this.remoteMessage, this.remoteDetails)
    }
    if (this.remoteCode === 'session/writer-held') {
      return new BridgeError(this.remoteCode, `目标会话被另一个 DSH 进程持有写租约：${this.remoteMessage}`, {
        exitCode: EXIT.ERROR,
        details: this.remoteDetails,
      })
    }
    return new BridgeError(this.remoteCode, this.remoteMessage, { details: this.remoteDetails })
  }
}

/**
 * 校验凭据与目标地址是否匹配；不匹配时在发出任何请求之前失败。
 * @param {string} baseUrl - 已规范化的目标地址。
 * @param {{authority?: string}|null} credential - 凭据。
 * @returns {void} 匹配时正常返回。
 */
export function assertCredentialMatches(baseUrl, credential) {
  if (credential === null || credential === undefined) return
  const authority = authorityOf(baseUrl)
  if (typeof credential.authority !== 'string' || credential.authority !== authority) {
    throw new BridgeError(
      'credential_authority_mismatch',
      `本地凭据属于 ${String(credential.authority)}，与目标地址 ${authority} 不一致；已拒绝发送凭据。请先对目标地址重新执行 auth。`,
      { exitCode: EXIT.AUTH, details: { credentialAuthority: credential.authority ?? null, targetAuthority: authority } },
    )
  }
}

/**
 * `/api` 一元 RPC 客户端。
 */
export class DshApi {
  /**
   * @param {object} options - 连接参数。
   * @param {string} options.baseUrl - 基础地址（必须是本机环回）。
   * @param {{authority: string, cookieName: string, cookieValue: string}|null} [options.credential] - 会话凭据。
   * @param {number} [options.timeoutMs] - 默认超时。
   * @param {typeof fetch} [options.fetchImpl] - 注入的 fetch（测试用）。
   */
  constructor(options) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl)
    this.authority = authorityOf(this.baseUrl)
    this.credential = options.credential ?? null
    // 构造即校验：凭据与地址不匹配时不会进入任何 call()。
    assertCredentialMatches(this.baseUrl, this.credential)
    this.timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
  }

  /**
   * 发送一个 Remote 一元调用。
   * @param {string} method - `<namespace>/<method>`，例如 `session/list`。
   * @param {object} args - 参数对象，字段名与 Host 方法参数名一致。
   * @param {object} [options] - 调用选项。
   * @param {number} [options.timeoutMs] - 本次超时。
   * @param {AbortSignal} [options.signal] - 外部取消。
   * @returns {Promise<any>} `result.value`。
   */
  async call(method, args, options = {}) {
    // 纵深防御：每次调用前再次确认边界未被绕过。
    assertCredentialMatches(this.baseUrl, this.credential)
    const rpcId = randomUUID()
    const body = JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } })
    const timeoutMs = options.timeoutMs ?? this.timeoutMs
    const signals = [AbortSignal.timeout(timeoutMs)]
    if (options.signal !== undefined) signals.push(options.signal)
    const signal = AbortSignal.any(signals)
    /** @type {Record<string,string>} */
    const headers = { 'content-type': 'application/json' }
    if (this.credential !== null) {
      headers.cookie = `${this.credential.cookieName}=${this.credential.cookieValue}`
    }
    let response
    try {
      response = await this.fetchImpl(`${this.baseUrl}/api/${method}`, {
        method: 'POST',
        headers,
        body,
        signal,
        // 边界关键：绝不自动跟随重定向。默认的 follow 会把 POST 正文
        // （任务正文、含 Cookie 的请求头）转发到 Location 指向的另一个 authority。
        // DSH 的 /api 契约不需要重定向，因此一律直接拒绝。
        redirect: 'manual',
      })
    } catch (error) {
      if (signal.aborted && !options.signal?.aborted) {
        throw new BridgeError('request_timeout', `${method} 请求超时（${timeoutMs} ms）。`, {
          exitCode: EXIT.TIMEOUT,
          details: { method, timeoutMs },
          cause: error,
        })
      }
      throw new BridgeError('transport_failure', `${method} 传输失败：${error instanceof Error ? error.message : String(error)}`, {
        details: { method },
        cause: error instanceof Error ? error : undefined,
      })
    }
    // 任何 3xx 都视为越界尝试：不做信封校验、不重试、不跟随。
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      throw authError(
        'redirect_refused',
        `${method} 返回 HTTP ${response.status} 重定向，已拒绝跟随（避免把请求与任务正文转发到别的地址）。`
        + (location === null ? '' : ` Location：${redactUrl(location)}`),
        {
          status: response.status,
          method,
          baseUrl: this.baseUrl,
          location: location === null ? null : redactUrl(location),
          redirectFollowed: false,
        },
      )
    }
    if (response.status === 401) {
      throw authError('auth_required', 'DSH 拒绝了请求（HTTP 401）：缺少或已失效的浏览器会话凭据。请重新运行 `auth`。', {
        status: 401,
        method,
      })
    }
    if (response.status === 403) {
      throw authError('trust_rejected', 'DSH 拒绝了请求（HTTP 403）：Host/Origin 信任校验未通过。请确认地址是本机环回地址。', {
        status: 403,
        method,
        baseUrl: this.baseUrl,
      })
    }
    if (!response.ok) {
      throw new BridgeError('http_error', `${method} 返回 HTTP ${response.status}。`, {
        details: { status: response.status, method },
      })
    }
    let envelope
    try {
      envelope = await response.json()
    } catch (error) {
      throw new BridgeError('bad_envelope', `${method} 的响应不是合法 JSON。`, { details: { method }, cause: error })
    }
    if (envelope === null || typeof envelope !== 'object' || envelope.type !== 'server-response') {
      throw new BridgeError('bad_envelope', `${method} 的响应不是 server-response 信封。`, { details: { method } })
    }
    if (envelope.rpcId !== rpcId) {
      throw new BridgeError('rpc_mismatch', `${method} 的响应 rpcId 不匹配。`, { details: { method } })
    }
    const result = envelope.result
    if (result === null || typeof result !== 'object') {
      throw new BridgeError('bad_envelope', `${method} 的响应缺少 result。`, { details: { method } })
    }
    if (result.ok !== true) {
      const failure = result.error ?? { code: 'unknown', message: 'DSH 返回了未分类失败。' }
      throw new RemoteFailure(failure).toBridgeError()
    }
    return result.value
  }
}

/**
 * 解析 `Set-Cookie`，取出本部署的会话 Cookie。
 * @param {string[]} setCookies - 响应中的全部 Set-Cookie。
 * @returns {{cookieName: string, cookieValue: string, expiresAt: number|null}|null} 解析结果。
 */
export function parseSessionCookie(setCookies) {
  for (const raw of setCookies) {
    const [pair] = raw.split(';')
    const at = pair.indexOf('=')
    if (at === -1) continue
    const name = pair.slice(0, at).trim()
    const value = pair.slice(at + 1).trim()
    if (!name.startsWith('dsh-auth-') || value === '') continue
    let expiresAt = null
    const maxAge = /;\s*max-age=(\d+)/iu.exec(raw)
    if (maxAge !== null) expiresAt = Date.now() + Number(maxAge[1]) * 1000
    else {
      const expires = /;\s*expires=([^;]+)/iu.exec(raw)
      if (expires !== null) {
        const parsed = Date.parse(expires[1])
        if (!Number.isNaN(parsed)) expiresAt = parsed
      }
    }
    return { cookieName: name, cookieValue: value, expiresAt }
  }
  return null
}

/**
 * 校验令牌交换的重定向没有越过本机边界。
 * @param {string|null} location - 响应的 Location 头。
 * @param {string} baseUrl - 目标基础地址。
 * @returns {void} 安全时正常返回。
 */
export function assertRedirectStaysLocal(location, baseUrl) {
  if (location === null || location === '') return
  let target
  try {
    target = new URL(location, `${baseUrl}/`)
  } catch {
    throw authError('token_exchange_bad_redirect', `令牌交换返回了无法解析的 Location。`, { location })
  }
  if (!isLoopbackHost(target.hostname) || target.host !== authorityOf(baseUrl)) {
    throw authError('token_exchange_cross_origin', '令牌交换的 Location 指向了本机之外的地址，已拒绝。', {
      locationHost: target.host,
      targetAuthority: authorityOf(baseUrl),
    })
  }
}

/**
 * 用启动令牌换取浏览器会话 Cookie。令牌只在内存中流转，不写入日志、不出现在输出。
 * @param {object} options - 交换参数。
 * @param {string} options.baseUrl - 基础地址（必须是本机环回）。
 * @param {string} options.token - 启动令牌。
 * @param {number} [options.timeoutMs] - 超时。
 * @param {typeof fetch} [options.fetchImpl] - 注入的 fetch（测试用）。
 * @returns {Promise<{credential: object, observed: object}>} 凭据与可安全输出的观测。
 */
export async function exchangeToken(options) {
  const baseUrl = normalizeBaseUrl(options.baseUrl)
  const authority = authorityOf(baseUrl)
  const url = new URL(baseUrl)
  url.pathname = '/'
  url.searchParams.set('token', options.token)
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  const doFetch = options.fetchImpl ?? globalThis.fetch
  let response
  try {
    response = await doFetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    throw new BridgeError('transport_failure', `令牌交换请求失败：${error instanceof Error ? error.message : String(error)}`, {
      details: { baseUrl },
      cause: error instanceof Error ? error : undefined,
    })
  }
  // 无论成功失败，都不把带令牌的 URL 写进任何输出。
  const observed = {
    status: response.status,
    location: response.headers.get('location') ?? null,
    url: redactUrl(url.href),
  }
  if (response.status === 401) {
    throw authError('token_rejected', '启动令牌被拒绝（HTTP 401）。令牌是进程级的，DSH 重启后会变化，请使用当前实例打印的 URL。', observed)
  }
  if (response.status === 403) {
    throw authError('trust_rejected', '令牌交换被信任校验拒绝（HTTP 403）。请确认访问的是本机环回地址。', observed)
  }
  if (response.status !== 303) {
    throw authError('token_exchange_unexpected', `令牌交换返回了意外的 HTTP ${response.status}，期望 303。`, observed)
  }
  assertRedirectStaysLocal(observed.location, baseUrl)
  const setCookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : []
  const parsed = parseSessionCookie(setCookies)
  if (parsed === null) {
    throw authError('token_exchange_no_cookie', '令牌交换没有返回可识别的会话 Cookie。', observed)
  }
  return {
    credential: {
      authority,
      baseUrl,
      cookieName: parsed.cookieName,
      cookieValue: parsed.cookieValue,
      expiresAt: parsed.expiresAt,
      obtainedAt: new Date().toISOString(),
    },
    observed,
  }
}
