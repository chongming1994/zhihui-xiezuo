/**
 * 敏感信息脱敏。所有面向用户、日志与 JSON 的输出都必须先过这里。
 *
 * 目标：令牌、Cookie、含 token 的 URL、完整请求头都不出现在任何输出中。
 * @module zhihui-xiezuo/redact
 */

/** 需要整体替换的请求头名（小写）。 */
const SENSITIVE_HEADERS = new Set(['cookie', 'set-cookie', 'authorization', 'proxy-authorization'])

/** 需要保留“存在性”的请求头名（小写）。 */
const PRESENCE_HEADERS = new Set(['host', 'origin', 'referer', 'content-type'])

/** 形如 `token=<值>`、`?token=<值>`、`api_key=<值>` 的片段（含行首无分隔符的情形）。 */
const SECRET_PARAM = /(^|[?&\s])((?:token|access_token|api_key|secret|password|key)=)[^&#\s]*/gimu
const COOKIE_PAIR = /\b(dsh-auth-[A-Za-z0-9_-]+|v1)\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gu
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/giu

/**
 * 去掉 URL 中的令牌参数，只保留来源与路径。
 * @param {string} value - 可能含令牌的 URL。
 * @returns {string} 脱敏后的 URL。
 */
export function redactUrl(value) {
  if (typeof value !== 'string') return String(value)
  try {
    const url = new URL(value)
    for (const key of [...url.searchParams.keys()]) {
      if (/token|key|secret|password/i.test(key)) url.searchParams.set(key, '<REDACTED>')
    }
    return url.href
  } catch {
    return value.replace(SECRET_PARAM, '$1$2<REDACTED>')
  }
}

/**
 * 脱敏任意文本中的令牌与 Cookie 形态串。
 * @param {string} value - 原始文本。
 * @returns {string} 脱敏后的文本。
 */
export function redactText(value) {
  if (typeof value !== 'string') return String(value)
  return value
    .replace(SECRET_PARAM, '$1$2<REDACTED>')
    .replace(COOKIE_PAIR, '<REDACTED-COOKIE>')
    .replace(BEARER, '$1 <REDACTED>')
}

/**
 * 把请求头映射转换为可安全输出的摘要：敏感头只报告存在性，其余按需保留。
 * @param {Record<string, unknown>} headers - 原始请求头。
 * @returns {Record<string, string>} 脱敏后的摘要。
 */
export function redactHeaders(headers) {
  /** @type {Record<string, string>} */
  const out = {}
  for (const [rawName, rawValue] of Object.entries(headers ?? {})) {
    const name = rawName.toLowerCase()
    if (SENSITIVE_HEADERS.has(name)) {
      const present = Array.isArray(rawValue) ? rawValue.length > 0 : rawValue !== undefined && rawValue !== null
      out[rawName] = present ? '<REDACTED>' : '<absent>'
      continue
    }
    if (!PRESENCE_HEADERS.has(name)) continue
    out[rawName] = redactText(Array.isArray(rawValue) ? rawValue.join(', ') : String(rawValue))
  }
  return out
}

/**
 * 判断一个对象里是否出现了疑似秘密的键名（用于测试断言输出不含秘密）。
 * @param {unknown} value - 待检查的值。
 * @returns {string[]} 命中的键路径。
 */
export function findSecretKeys(value) {
  /** @type {string[]} */
  const hits = []
  const walk = (node, path) => {
    if (node === null || typeof node !== 'object') return
    for (const [key, child] of Object.entries(node)) {
      const next = path === '' ? key : `${path}.${key}`
      if (/^(cookie|set-cookie|authorization|token|secret|password|signingKey)$/i.test(key)) hits.push(next)
      walk(child, next)
    }
  }
  walk(value, '')
  return hits
}
