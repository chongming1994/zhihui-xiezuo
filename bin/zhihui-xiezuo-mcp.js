#!/usr/bin/env node
/**
 * zhihui-xiezuo MCP（stdio）入口。
 *
 * stdout 是 JSON-RPC 协议通道，本进程不往 stdout 写任何非协议内容；
 * 诊断信息一律走 stderr。
 * @module zhihui-xiezuo/bin-mcp
 */

import { main } from '../src/mcp-server.js'

await main()
