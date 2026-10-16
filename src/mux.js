/**
 * `/api/remote.mux` WebSocket 多路复用客户端与 `session/follow` 逻辑流。
 *
 * 依据：
 * - 路径常量 `REMOTE_STREAM_MUX_PATH = '/api/remote.mux'`
 * - 客户端帧：`{type:'open',streamId,endpoint,payload:{args}}`、`{type:'item',...}`、`{type:'end'}`、`{type:'cancel'}`
 * - 服务端帧：`{type:'item',streamId,value}`、`{type:'error',streamId,error}`、`{type:'end',streamId}`
 * - 升级同样经过 `connection.admit()`：必须携带会话 Cookie
 * @module zhihui-xiezuo/mux
 */

import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import { authError, BridgeError, EXIT } from './errors.js'
import { normalizeBaseUrl } from './rpc.js'

/** 默认重连上限（连续失败次数）。 */
export const DEFAULT_MAX_RECONNECTS = 5

/** 简单的异步队列，用于把 ws 回调桥接到 async 迭代器。 */
class AsyncQueue {
  constructor() {
    /** @type {any[]} */
    this.items = []
    /** @type {null | (() => void)} */
    this.waiter = null
    this.done = false
  }

  /**
   * 入队一项。
   * @param {any} item - 队列项。
   * @returns {void}
   */
  push(item) {
    if (this.done) return
    this.items.push(item)
    this.waiter?.()
    this.waiter = null
  }

  /** 结束队列。 @returns {void} */
  end() {
    this.done = true
    this.waiter?.()
    this.waiter = null
  }

  /**
   * 取下一项。
   * @returns {Promise<any>} 队列项。
   */
  async next() {
    for (;;) {
      if (this.items.length > 0) return this.items.shift()
      if (this.done) return { kind: 'closed' }
      await new Promise((resolve) => { this.waiter = resolve })
    }
  }
}

/**
 * 把基础地址转换为 mux 的 WebSocket 地址。
 * @param {string} baseUrl - 基础地址。
 * @returns {string} `ws(s)://host/api/remote.mux`。
 */
export function muxUrl(baseUrl) {
  const url = new URL(normalizeBaseUrl(baseUrl))
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = '/api/remote.mux'
  return url.href
}

/**
 * 打开一条逻辑流并返回帧迭代器。单次连接，不含重连。
 * @param {object} options - 打开参数。
 * @param {string} options.baseUrl - 基础地址。
 * @param {{cookieName: string, cookieValue: string}|null} options.credential - 会话凭据。
 * @param {string} options.endpoint - 逻辑端点，例如 `session/follow`。
 * @param {object} options.args - Remote 参数对象。
 * @param {AbortSignal} [options.signal] - 取消信号。
 * @returns {{ frames: AsyncGenerator<any>, close: () => void }} 帧流与关闭函数。
 */
export function openStream(options) {
  const queue = new AsyncQueue()
  const streamId = randomUUID()
  const headers = {}
  if (options.credential !== null) {
    headers.cookie = `${options.credential.cookieName}=${options.credential.cookieValue}`
  }
  const socket = new WebSocket(muxUrl(options.baseUrl), { headers })
  /** @type {Error|null} */
  let upgradeError = null

  socket.on('upgrade', (response) => {
    const status = response.statusCode ?? 0
    if (status === 401) {
      upgradeError = authError('auth_required', 'WebSocket 升级被拒绝（HTTP 401）：凭据缺失或已失效。', { status })
    } else if (status === 403) {
      upgradeError = authError('trust_rejected', 'WebSocket 升级被拒绝（HTTP 403）：信任校验未通过。', { status })
    } else if (status !== 101) {
      upgradeError = new BridgeError('upgrade_failed', `WebSocket 升级返回 HTTP ${status}。`, {
        details: { status },
      })
    }
  })
  socket.on('open', () => {
    socket.send(JSON.stringify({
      type: 'open',
      streamId,
      endpoint: options.endpoint,
      payload: { args: options.args },
    }))
  })
  socket.on('message', (data, isBinary) => {
    if (isBinary) return
    let message
    try {
      message = JSON.parse(String(data))
    } catch {
      queue.push({ kind: 'protocol_error', message: '收到无法解析的 mux 帧。' })
      return
    }
    if (message === null || typeof message !== 'object' || message.streamId !== streamId) return
    if (message.type === 'item') queue.push({ kind: 'item', value: message.value })
    else if (message.type === 'error') queue.push({ kind: 'error', error: message.error ?? {} })
    else if (message.type === 'end') queue.push({ kind: 'end' })
  })
  socket.on('close', (code) => {
    queue.push({ kind: 'closed', code, error: upgradeError })
    queue.end()
  })
  socket.on('error', (error) => {
    if (upgradeError === null && !socket.readyState) upgradeError = error
    queue.push({ kind: 'closed', code: null, error: upgradeError ?? error })
    queue.end()
  })
  const onAbort = () => { try { socket.close() } catch { /* 已关闭 */ } }
  options.signal?.addEventListener('abort', onAbort, { once: true })

  async function* frames() {
    try {
      for (;;) {
        const item = await queue.next()
        if (item.kind === 'closed') {
          if (item.error !== null && item.error !== undefined) throw item.error
          return
        }
        yield item
      }
    } finally {
      options.signal?.removeEventListener('abort', onAbort)
      try { socket.close() } catch { /* 已关闭 */ }
    }
  }

  return {
    frames: frames(),
    close: () => { try { socket.close() } catch { /* 已关闭 */ } },
  }
}

/**
 * `session/follow` 的逻辑流：首次打开给出完整 snapshot，其后是无缝持久事件帧。
 *
 * 载体丢失时自动重新打开（新 snapshot），由调用方按 `seq` 去重；连续失败超过上限则抛出。
 * @param {object} options - 订阅参数。
 * @param {string} options.baseUrl - 基础地址。
 * @param {object} options.credential - 会话凭据。
 * @param {object} options.request - `SessionFollowRequest`，例如 `{ address: { kind:'session', sessionId } }`。
 * @param {AbortSignal} options.signal - 取消信号。
 * @param {(info: object) => void} [options.onCarrierLoss] - 载体丢失回调。
 * @param {number} [options.maxReconnects] - 连续失败上限。
 * @returns {AsyncGenerator<{kind: string, value?: any, error?: any, generation?: number}>} 帧流。
 */
export async function* followSessionStream(options) {
  const maxReconnects = options.maxReconnects ?? DEFAULT_MAX_RECONNECTS
  let generation = 0
  let consecutiveFailures = 0
  let delayMs = 200
  for (;;) {
    if (options.signal.aborted) return
    generation += 1
    const stream = openStream({
      baseUrl: options.baseUrl,
      credential: options.credential,
      endpoint: 'session/follow',
      args: { request: options.request },
      signal: options.signal,
    })
    let openedSnapshot = false
    try {
      for await (const frame of stream.frames) {
        if (frame.kind === 'item') {
          const value = frame.value
          if (value !== null && typeof value === 'object' && value.type === 'snapshot') {
            openedSnapshot = true
            consecutiveFailures = 0
            delayMs = 200
          }
          yield { kind: 'item', value, generation }
          continue
        }
        if (frame.kind === 'error') {
          throw new BridgeError('stream_error', `DSH 逻辑流返回错误：${frame.error?.code ?? 'unknown'} ${frame.error?.message ?? ''}`, {
            details: { remoteCode: frame.error?.code ?? null },
          })
        }
        if (frame.kind === 'end') {
          // 服务端主动结束：按载体丢失处理并重连。
          break
        }
        if (frame.kind === 'protocol_error') {
          throw new BridgeError('protocol_error', frame.message)
        }
      }
    } catch (error) {
      if (options.signal.aborted) return
      if (error instanceof BridgeError && (error.exitCode === EXIT.AUTH)) throw error
      if (error instanceof BridgeError && error.code === 'stream_error') throw error
      options.onCarrierLoss?.({ generation, error })
    }
    if (options.signal.aborted) return
    if (!openedSnapshot) {
      consecutiveFailures += 1
      if (consecutiveFailures > maxReconnects) {
        throw new BridgeError('stream_unavailable', `连续 ${consecutiveFailures} 次无法建立订阅。`, {
          details: { attempts: consecutiveFailures },
        })
      }
    } else {
      options.onCarrierLoss?.({ generation, error: null })
    }
    await new Promise(resolve => setTimeout(resolve, delayMs))
    delayMs = Math.min(delayMs * 2, 2_000)
  }
}
