#!/usr/bin/env node
/**
 * zhihui-xiezuo 命令行入口。
 *
 * Windows 说明：本文件顶部的 shebang 只在 POSIX 上生效；在 Windows 上由
 * `npm install -g` / `npm link` 依据 package.json 的 `bin` 字段生成
 * `zhihui-xiezuo.cmd` / `-shell.cmd` shim，无需额外处理。
 * @module zhihui-xiezuo/bin
 */

import { main } from '../src/cli.js'

const exitCode = await main(process.argv.slice(2))
process.exitCode = exitCode
