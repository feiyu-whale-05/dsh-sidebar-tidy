/**
 * dsh-sidebar-tidy — Host half.
 *
 * 这个插件的主体在浏览器端（client.js）。Host 半侧只负责一件事：
 * **把客户端日志落盘**，目录固定为
 *   {logDir}/host-YYYY-MM-DD.jsonl
 * 默认 logDir 为 `D:\DSH-plugins\log\dsh-sidebar-tidy`。
 *
 * 客户端 → Host 的通道使用 DSH 官方的 Connection 共享 `/api` 通道：
 *   Host:   ctx.connection.fetch.register({ path: '/api/dsh-sidebar-tidy/log', ... })
 *   Client: ctx.connection.rpc.call('/api', 'dsh-sidebar-tidy/log', { records, page })
 * 这条通道自带 Host/Origin 校验、浏览器 Cookie 鉴权与 RPC 信封校验，不需要
 * 另写 webServer 路由或自己注入 token。
 *
 * 不用 `connection.rpc.handle`：当前 DSH 版本里它会在注册 webServer 路由时
 * 用 Connection 服务自己的 Context 访问 `webServer`，该 Context 未注入
 * webServer，直接抛 `cannot get property "webServer" without inject`。
 *
 * 日志设计（本机插件约定）：
 *   - 每行一个 JSON；每天一个文件 host-YYYY-MM-DD.jsonl。
 *   - 单文件超过 5 MiB 自动改名为 host-YYYY-MM-DD.<timestamp>.jsonl。
 *   - 字段：ts / app / level / source / event / msg / data / page / clientTime。
 *   - 客户端消息中的换行会被压平，避免伪造多行；字段长度有上限。
 *   - 目录/写入不可用时自动降级为 ctx.logger 控制台日志，不影响插件本身。
 *
 * 配置（cordis.patch.yml 的 config）：
 *   logDir        日志目录；默认 D:/DSH-plugins/log/dsh-sidebar-tidy
 *   enabled       false 关闭文件日志
 *   level         debug | info | warn | error，默认 debug
 *   maxFileBytes  单文件上限，默认 5 MiB（256 KiB – 128 MiB）
 *   maxRecords    单次 RPC 最多接收多少条，默认 200（1 – 500）
 */

import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'dsh-sidebar-tidy'

const VERSION = '0.2.2-rc.3'
/**
 * 使用 Connection 的共享 `/api` 通道（不是 `rpc.handle`）：
 * `rpc.handle` 内部会用 Connection 服务自己的 Context 去注册 webServer 路由，
 * 该 Context 没有 inject webServer，会在当前 DSH 版本直接抛
 * `cannot get property "webServer" without inject`。共享通道的 exact Fetch
 * 路由由 `/api` 统一完成鉴权，官方 feature 包（file-upload / plugin-manager）
 * 也走这条路径。
 */
const API_CHANNEL = '/api'
const LOG_ENDPOINT = 'dsh-sidebar-tidy/log'
const LOG_ROUTE = '/api/dsh-sidebar-tidy/log'
const LEVELS = ['debug', 'info', 'warn', 'error']
const LEVEL_RANK = { debug: 10, info: 20, warn: 30, error: 40 }
const APP = 'dsh-sidebar-tidy'
const DEFAULT_LOG_DIR = process.platform === 'win32'
  ? 'D:/DSH-plugins/log/dsh-sidebar-tidy'
  : join(homedir(), '.dsh-sidebar-tidy', 'log')

/* ── 小工具 ─────────────────────────────────────────────────────────────── */

function clampInt(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(Math.max(Math.trunc(number), min), max)
}

function messageOf(error) {
  if (error === null || error === undefined) return 'unknown error'
  if (typeof error === 'string') return error
  if (typeof error.message === 'string' && error.message !== '') return error.message
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

function pad(value, width = 2) {
  return String(value).padStart(width, '0')
}

/** 本地时区 ISO 时间，例如 2026-11-14T14:40:00.123+08:00。 */
function localTime(date) {
  const offsetMinutes = -date.getTimezoneOffset()
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const absolute = Math.abs(offsetMinutes)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
    + `${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`
}

function dayKey(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** 压缩空白并截断，保证一条日志只占一行。 */
function oneLine(value, limit) {
  const collapsed = String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim()
  return collapsed.length > limit ? collapsed.slice(0, limit) + '…' : collapsed
}

function resolveConfig(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  return {
    logDir: typeof source.logDir === 'string' && source.logDir.trim() !== '' ? source.logDir.trim() : DEFAULT_LOG_DIR,
    enabled: source.enabled !== false,
    level: LEVELS.includes(source.level) ? source.level : 'debug',
    maxFileBytes: clampInt(source.maxFileBytes, 256 * 1024, 128 * 1024 * 1024, 5 * 1024 * 1024),
    maxRecords: clampInt(source.maxRecords, 1, 500, 200),
  }
}

/* ── 文件日志 ───────────────────────────────────────────────────────────── */

/**
 * 每日单文件日志器。
 * @param {object} ctx - Host 插件上下文（只用可选的 ctx.logger 做降级提示）。
 * @param {ReturnType<typeof resolveConfig>} settings - 已归一化的配置。
 */
function createFileLogger(ctx, settings) {
  const instanceId = Math.random().toString(36).slice(2, 10)
  const dir = settings.logDir
  let disabled = !settings.enabled
  let warned = false

  const warnOnce = (message, error) => {
    if (warned) return
    warned = true
    try {
      ctx.logger?.warn?.(`[dsh-sidebar-tidy] ${message}: ${messageOf(error)}`)
    } catch {
      // 日志系统的错误不能反过来影响插件
    }
  }

  const ensureDirectory = () => {
    if (disabled) return false
    try {
      mkdirSync(dir, { recursive: true })
      return true
    } catch (error) {
      disabled = true
      warnOnce(`cannot create log directory ${dir}`, error)
      return false
    }
  }

  const rotate = (file) => {
    try {
      if (statSync(file).size <= settings.maxFileBytes) return
      const backup = file.replace(/\.jsonl$/u, `.${Date.now()}.jsonl`)
      renameSync(file, backup)
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        // 轮转失败不应丢日志，继续追加
        warnOnce(`cannot rotate ${file}`, error)
      }
    }
  }

  const write = (record) => {
    if (disabled) return false
    if (LEVEL_RANK[record.level] < LEVEL_RANK[settings.level]) return false
    if (!ensureDirectory()) return false
    const now = new Date()
    try {
      const file = join(dir, `host-${dayKey(now)}.jsonl`)
      rotate(file)
      appendFileSync(file, serializeRecord(record, now) + '\n', 'utf8')
      return true
    } catch (error) {
      disabled = true
      warnOnce(`cannot append to ${dir}`, error)
      return false
    }
  }

  const log = (level, source, event, message, data) => write({ level, source, event, message, data })

  return { instanceId, dir, write, log, isEnabled: () => !disabled }
}

/** 把一条记录序列化成单行 JSON；循环引用/函数/超长字段都不会抛错。 */
function serializeRecord(record, now) {
  const time = record.time instanceof Date && !Number.isNaN(record.time.getTime()) ? record.time : now
  const output = {
    ts: time.toISOString(),
    app: APP,
    level: String(record.level ?? 'info').toLowerCase(),
    source: String(record.source ?? 'host'),
    event: String(record.event ?? 'event'),
    msg: oneLine(record.message ?? '', 2000),
  }
  if (record.data !== undefined) output.data = record.data
  if (record.page !== undefined) output.page = record.page
  if (record.clientTime !== undefined) output.clientTime = record.clientTime
  try {
    const seen = new WeakSet()
    const text = JSON.stringify(output, (key, item) => {
      if (typeof item === 'bigint') return item.toString()
      if (typeof item === 'function' || typeof item === 'symbol') return undefined
      if (typeof item === 'object' && item !== null) {
        if (seen.has(item)) return '[circular]'
        seen.add(item)
      }
      if (typeof item === 'string' && item.length > 2000) return item.slice(0, 2000) + '…'
      return item
    })
    if (typeof text === 'string' && text.length <= 64 * 1024) return text
  } catch {
    // 序列化失败时退回最小字段，保证仍是一行合法 JSON
  }
  return JSON.stringify({
    ts: time.toISOString(),
    app: APP,
    level: String(record.level ?? 'info').toLowerCase(),
    source: String(record.source ?? 'host'),
    event: String(record.event ?? 'event'),
    msg: oneLine(record.message ?? '', 500),
    truncated: true,
  })
}

/* ── 客户端日志接收 ─────────────────────────────────────────────────────── */

function normalizePage(raw) {
  if (raw === null || typeof raw !== 'object') return undefined
  const page = {
    id: typeof raw.id === 'string' ? oneLine(raw.id, 40) : undefined,
    path: typeof raw.path === 'string' ? oneLine(raw.path, 200) : undefined,
    locale: typeof raw.locale === 'string' ? oneLine(raw.locale, 20) : undefined,
    dark: typeof raw.dark === 'boolean' ? raw.dark : undefined,
  }
  return Object.values(page).some((value) => value !== undefined) ? page : undefined
}

function normalizeClientRecord(raw, page) {
  if (raw === null || typeof raw !== 'object') return null
  const level = LEVELS.includes(raw.level) ? raw.level : 'info'
  const event = typeof raw.event === 'string' && /^[A-Za-z0-9._:-]{1,80}$/.test(raw.event)
    ? raw.event
    : 'client.event'
  const message = oneLine(typeof raw.message === 'string' ? raw.message : '', 2000)
  const now = Date.now()
  const time = Number.isFinite(raw.time) ? new Date(raw.time) : new Date(now)
  const record = { level, source: 'client', event, message, data: raw.data, page }
  if (Math.abs(now - time.getTime()) > 60_000) record.clientTime = localTime(time)
  return record
}

function acceptClientLogs(payload, logger, settings) {
  const records = Array.isArray(payload?.records) ? payload.records.slice(0, settings.maxRecords) : []
  const page = normalizePage(payload?.page)
  let accepted = 0
  for (const raw of records) {
    const record = normalizeClientRecord(raw, page)
    if (record !== null && logger.write(record)) accepted += 1
  }
  logger.log('debug', 'host', 'client.batch', 'received client log batch', {
    received: records.length,
    accepted,
    pid: process.pid,
    instanceId: logger.instanceId,
  })
  return { accepted, received: records.length }
}

/** 构造 Connection 的 `server-response` 信封（client 端 rpc.call 会校验 rpcId）。 */
function rpcResponse(rpcId, result) {
  return new Response(JSON.stringify({ type: 'server-response', rpcId, result }), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

async function handleLogFetch(request, logger, settings) {
  if (String(request.method).toUpperCase() !== 'POST') {
    return new Response('method not allowed', { status: 405, headers: { allow: 'POST' } })
  }
  const declaredLength = Number(request.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > 512 * 1024) {
    return new Response('payload too large', { status: 413 })
  }
  let envelope
  try {
    envelope = await request.json()
  } catch {
    return new Response('invalid JSON envelope', { status: 400 })
  }
  const rpcId = typeof envelope?.rpcId === 'string' ? envelope.rpcId : 'invalid-request'
  if (envelope?.type !== 'client-request' || envelope?.method !== LOG_ENDPOINT) {
    return rpcResponse(rpcId, {
      ok: false,
      error: { code: 'unknown-endpoint', message: `unknown endpoint: ${String(envelope?.method)}`, details: {} },
    })
  }
  try {
    return rpcResponse(rpcId, { ok: true, value: acceptClientLogs(envelope.payload, logger, settings) })
  } catch (error) {
    logger.log('error', 'host', 'client.batch.failed', 'cannot accept client log batch', { error: messageOf(error) })
    return rpcResponse(rpcId, { ok: false, error: { code: 'log/rejected', message: messageOf(error), details: {} } })
  }
}

/* ── 插件入口 ───────────────────────────────────────────────────────────── */

/**
 * 注册客户端日志通道并记录 Host 生命周期。
 * @param {object} ctx - Host 插件上下文。
 * @param {object} [config] - patch 行里的 config。
 */
export function apply(ctx, config) {
  const settings = resolveConfig(config)
  const logger = createFileLogger(ctx, settings)
  const pid = process.pid

  logger.log('info', 'host', 'plugin.apply', 'dsh-sidebar-tidy host half activated', {
    version: VERSION,
    pid,
    instanceId: logger.instanceId,
    logDir: settings.logDir,
    level: settings.level,
    enabled: settings.enabled,
  })
  try {
    ctx.logger?.info?.(`[dsh-sidebar-tidy] host half active; logs → ${settings.logDir}`)
  } catch {
    // 控制台日志不可用时忽略
  }

  try {
    ctx.inject(['connection'], (scope) => {
      try {
        const connection = scope.connection
        logger.log('info', 'host', 'rpc.inject', 'connection service available to plugin', {
          hasConnection: connection !== undefined && connection !== null,
          hasFetch: typeof connection?.fetch?.register === 'function',
        })
        if (connection === undefined || connection === null || typeof connection.fetch?.register !== 'function') {
          logger.log('warn', 'host', 'rpc.unavailable', 'connection.fetch.register unavailable; client file logging disabled', {})
          return
        }

        scope.effect(() => {
          const dispose = connection.fetch.register({
            path: LOG_ROUTE,
            methods: ['POST'],
            requestBody: 'buffered',
            fetch: (request) => handleLogFetch(request, logger, settings),
          })
          logger.log('info', 'host', 'rpc.registered', `client log route ready: ${LOG_ROUTE}`, {
            pid,
            instanceId: logger.instanceId,
            channel: API_CHANNEL,
            endpoint: LOG_ENDPOINT,
          })
          return async () => {
            try {
              await dispose()
            } finally {
              logger.log('info', 'host', 'rpc.disposed', 'client log route removed', { pid, instanceId: logger.instanceId })
            }
          }
        }, 'dsh-sidebar-tidy: client log route')
      } catch (error) {
        logger.log('error', 'host', 'rpc.register.failed', 'cannot register client log route', {
          error: messageOf(error),
          stack: error instanceof Error ? String(error.stack ?? '').slice(0, 2000) : undefined,
        })
      }
    })
  } catch (error) {
    logger.log('error', 'host', 'rpc.inject.failed', 'ctx.inject(connection) failed', {
      error: messageOf(error),
      stack: error instanceof Error ? String(error.stack ?? '').slice(0, 2000) : undefined,
    })
  }

  ctx.effect(() => () => {
    logger.log('info', 'host', 'plugin.dispose', 'dsh-sidebar-tidy host half disposed', { pid, instanceId: logger.instanceId })
  }, 'dsh-sidebar-tidy: dispose log')
}
