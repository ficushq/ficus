/**
 * Structured logger for tau-management services.
 *
 * Usage:
 *   import { logger, createLogger } from '@/lib/infra/logger'
 *
 *   // Use global logger with prefix
 *   logger.info('webhook', 'Processing event')
 *
 *   // Create a scoped logger for a service
 *   const log = createLogger('github-webhook')
 *   log.info('Processing push to main')
 *   log.error('Command failed:', errorMsg)
 *
 *   // With color
 *   const log = createLogger('http', undefined, { color: 'cyan' })
 *   log.info('<-- GET /api/agents')
 *
 *   // With sub-prefix
 *   const log = createLogger('schedule', scheduleId.slice(0, 8))
 *   log.info('Executed action')
 */

import { ContentSafety } from '../../services/security/content-safety'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export type LogColor = 'red' | 'green' | 'yellow' | 'blue' | 'magenta' | 'cyan' | 'gray' | 'lightgray' | 'white'

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
}

/** ANSI color codes */
const COLORS: Record<LogColor | 'reset', string> = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
  lightgray: '\x1b[38;5;250m',
  white: '\x1b[37m',
}

/** Default width to pad prefixes to (covers most service names + short IDs) */
const DEFAULT_PREFIX_WIDTH = 24

/** Check if colors are enabled */
function colorsEnabled(): boolean {
  // Keep application logs stable for assertions under Bun's test runner.
  if (process.env.NODE_ENV === 'test') return false
  // Respect NO_COLOR standard (https://no-color.org/) even if the
  // surrounding test runner sets FORCE_COLOR for its own output.
  if (process.env.NO_COLOR !== undefined) return false
  // Also check FORCE_COLOR
  if (process.env.FORCE_COLOR !== undefined) return true
  // Default to enabled if stdout is a TTY
  return process.stdout?.isTTY ?? false
}

/** Get configured minimum log level from environment */
function getMinLevel(): LogLevel {
  const env = process.env.LOG_LEVEL?.toLowerCase()
  if (env && env in LOG_LEVELS) {
    return env as LogLevel
  }
  // Default to 'info' in production, 'debug' in development
  return process.env.NODE_ENV === 'production' ? 'info' : 'debug'
}

/** Check if timestamps should be included */
function shouldIncludeTimestamp(): boolean {
  // Default to true unless explicitly disabled
  return process.env.LOG_TIMESTAMPS !== 'false'
}

/** Get prefix padding width (0 = no padding) */
function getPrefixWidth(): number {
  const env = process.env.LOG_PREFIX_WIDTH
  if (env === '0' || env === 'false') return 0
  if (env) {
    const parsed = parseInt(env, 10)
    if (!isNaN(parsed)) return parsed
  }
  return DEFAULT_PREFIX_WIDTH
}

/** Format timestamp in ISO format for log lines */
function formatTimestamp(): string {
  return new Date().toISOString()
}

/** Apply color to text if colors are enabled */
function colorize(text: string, color: LogColor): string {
  if (!colorsEnabled()) return text
  return `${COLORS[color]}${text}${COLORS.reset}`
}

/** Get color for log level */
function getLevelColor(level: LogLevel): LogColor | null {
  switch (level) {
    case 'debug':
      return 'gray'
    case 'warn':
      return 'yellow'
    case 'error':
      return 'red'
    default:
      return null
  }
}

/** Format the prefix portion of the log message */
function formatPrefix(prefix: string, subPrefix?: string, color?: LogColor): string {
  const width = getPrefixWidth()
  let prefixStr: string
  if (subPrefix) {
    prefixStr = `[${prefix}:${subPrefix}]`
  } else {
    prefixStr = `[${prefix}]`
  }

  // Pad to consistent width for alignment
  if (width > 0 && prefixStr.length < width) {
    prefixStr = prefixStr.padEnd(width)
  }

  // Apply color if specified
  if (color) {
    return colorize(prefixStr, color)
  }
  return prefixStr
}

const baselineLogSafety = ContentSafety.fromSecretEntries([])
let logContentSanitizer: ((args: unknown[]) => unknown[]) | undefined

/** Configure the process-wide pre-console content boundary after Secret Store initialization. */
export function setLogContentSanitizer(sanitizer: ((args: unknown[]) => unknown[]) | undefined): void {
  logContentSanitizer = sanitizer
}

let loggerWriteInProgress = false

function normalizeLogArgument(arg: unknown): unknown {
  if (arg instanceof URLSearchParams) return arg.toString()
  if (typeof Headers !== 'undefined' && arg instanceof Headers) return Object.fromEntries(arg.entries())
  if (typeof Request !== 'undefined' && arg instanceof Request) return { method: arg.method, url: arg.url }
  if (typeof Response !== 'undefined' && arg instanceof Response)
    return { status: arg.status, statusText: arg.statusText }
  if (typeof AbortSignal !== 'undefined' && arg instanceof AbortSignal) return { aborted: arg.aborted }
  if (arg instanceof Promise) return '[Promise]'
  return arg
}

function sanitizeLogArguments(args: unknown[]): unknown[] {
  return args.map((arg) => {
    try {
      const normalized = normalizeLogArgument(arg)
      return logContentSanitizer
        ? (logContentSanitizer([normalized])[0] ?? '[REDACTED_LOG_CONTENT]')
        : baselineLogSafety.redact(normalized)
    } catch {
      return '[REDACTED_LOG_CONTENT]'
    }
  })
}

type ConsoleSinkMethod = 'log' | 'info' | 'debug' | 'warn' | 'error' | 'trace' | 'dir'
type ConsoleSinkFunctions = Record<ConsoleSinkMethod, (...args: unknown[]) => void>
interface ConsoleSanitizerLayer {
  active: boolean
  originals: ConsoleSinkFunctions
}
const CONSOLE_SINK_METHODS: readonly ConsoleSinkMethod[] = ['log', 'info', 'debug', 'warn', 'error', 'trace', 'dir']
const consoleSanitizerLayers = new WeakMap<(...args: unknown[]) => void, ConsoleSanitizerLayer>()

function unwrapInactiveConsoleLayer(
  method: ConsoleSinkMethod,
  candidate: (...args: unknown[]) => void
): (...args: unknown[]) => void {
  let current = candidate
  for (
    let layer = consoleSanitizerLayers.get(current);
    layer && !layer.active;
    layer = consoleSanitizerLayers.get(current)
  ) {
    current = layer.originals[method]
  }
  return current
}

/**
 * Install the boundary at every Console output sink. Installations are nestable;
 * restoration may occur in any order without leaving a live or sticky layer.
 */
export function installConsoleContentSanitizer(): () => void {
  const target = console as unknown as ConsoleSinkFunctions
  const originals = Object.fromEntries(
    CONSOLE_SINK_METHODS.map((method) => [method, target[method]])
  ) as ConsoleSinkFunctions
  const layer: ConsoleSanitizerLayer = { active: true, originals }
  const wrappers = Object.fromEntries(
    CONSOLE_SINK_METHODS.map((method) => {
      const wrapper = (...args: unknown[]) =>
        originals[method](...(layer.active && !loggerWriteInProgress ? sanitizeLogArguments(args) : args))
      consoleSanitizerLayers.set(wrapper, layer)
      return [method, wrapper]
    })
  ) as ConsoleSinkFunctions
  for (const method of CONSOLE_SINK_METHODS) target[method] = wrappers[method]

  return () => {
    if (!layer.active) return
    layer.active = false
    for (const method of CONSOLE_SINK_METHODS) {
      if (target[method] === wrappers[method]) target[method] = unwrapInactiveConsoleLayer(method, originals[method])
    }
  }
}

export interface LoggerOptions {
  /** Color for the prefix and message text */
  color?: LogColor
  /**
   * Write every level to stderr (debug/info otherwise go to stdout). For output that must never
   * mix with a stdout another program parses, e.g. the setup toolkit's `FICUS_*=` result markers.
   */
  stderr?: boolean
}

/** Core logging function */
function log(
  level: LogLevel,
  prefix: string,
  subPrefix: string | undefined,
  args: unknown[],
  options?: LoggerOptions
): void {
  const minLevel = getMinLevel()
  if (LOG_LEVELS[level] < LOG_LEVELS[minLevel]) {
    return
  }
  const safeArgs = sanitizeLogArguments(args)

  // Determine prefix color: use explicit color, or level color for warn/error, fallback to lightgray
  const levelColor = getLevelColor(level)
  const prefixColor = options?.color ?? levelColor ?? 'lightgray'

  const prefixStr = formatPrefix(prefix, subPrefix, prefixColor)
  const parts: unknown[] = []

  if (shouldIncludeTimestamp()) {
    const timestamp = formatTimestamp()
    // Dim the timestamp
    parts.push(colorsEnabled() ? colorize(timestamp, 'gray') : timestamp)
  }
  parts.push(prefixStr)

  // Determine message color: custom color, or level color for warn/error, fallback to lightgray
  const messageColor = options?.color ?? levelColor ?? 'lightgray'

  if (messageColor && safeArgs.length > 0) {
    // Color string arguments
    const colored = safeArgs.map((arg) => {
      if (typeof arg === 'string') {
        return colorize(arg, messageColor)
      }
      return arg
    })
    parts.push(...colored)
  } else {
    parts.push(...safeArgs)
  }

  loggerWriteInProgress = true
  try {
    switch (level) {
      case 'debug':
      case 'info':
        if (options?.stderr) console.error(...parts)
        else console.log(...parts)
        break
      case 'warn':
        console.warn(...parts)
        break
      case 'error':
        console.error(...parts)
        break
    }
  } finally {
    loggerWriteInProgress = false
  }
}

/** Scoped logger instance for a specific service/component */
export interface ScopedLogger {
  debug: (...args: unknown[]) => void
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
  /** Create a child logger with an additional sub-prefix */
  child: (subPrefix: string) => ScopedLogger
}

/**
 * Create a scoped logger with a prefix.
 *
 * @param prefix - Main prefix for log messages (e.g., 'webhook', 'sandbox')
 * @param subPrefix - Optional sub-prefix (e.g., agent ID, execution ID)
 * @param options - Logger options (color, etc.)
 *
 * @example
 * const log = createLogger('github-webhook')
 * log.info('Processing push')
 * // => 2024-02-28T17:30:00.000Z [github-webhook] Processing push
 *
 * @example
 * const log = createLogger('http', undefined, { color: 'cyan' })
 * log.info('<-- GET /api/agents')
 * // => 2024-02-28T17:30:00.000Z [http] <-- GET /api/agents (in cyan)
 *
 * @example
 * const log = createLogger('execution', exec.id.slice(0, 8))
 * log.error('Failed:', error)
 * // => 2024-02-28T17:30:00.000Z [execution:abc12345] Failed: Error...
 */
export function createLogger(prefix: string, subPrefix?: string, options?: LoggerOptions): ScopedLogger {
  return {
    debug: (...args: unknown[]) => log('debug', prefix, subPrefix, args, options),
    info: (...args: unknown[]) => log('info', prefix, subPrefix, args, options),
    warn: (...args: unknown[]) => log('warn', prefix, subPrefix, args, options),
    error: (...args: unknown[]) => log('error', prefix, subPrefix, args, options),
    child: (childSubPrefix: string) => {
      const newSubPrefix = subPrefix ? `${subPrefix}:${childSubPrefix}` : childSubPrefix
      return createLogger(prefix, newSubPrefix, options)
    },
  }
}

/**
 * Global logger for ad-hoc logging with prefixes.
 *
 * @example
 * logger.info('webhook', 'Received event')
 * logger.error('db', 'Connection failed:', error)
 */
export const logger = {
  debug: (prefix: string, ...args: unknown[]) => log('debug', prefix, undefined, args),
  info: (prefix: string, ...args: unknown[]) => log('info', prefix, undefined, args),
  warn: (prefix: string, ...args: unknown[]) => log('warn', prefix, undefined, args),
  error: (prefix: string, ...args: unknown[]) => log('error', prefix, undefined, args),
}
