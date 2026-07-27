export interface Logger {
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
  debug(...args: unknown[]): void
}

export function createLogger(scope = 'QingBot'): Logger {
  const prefix = `[${scope}]`
  return {
    info: (...args) => console.log(prefix, ...args),
    warn: (...args) => console.warn(prefix, ...args),
    error: (...args) => console.error(prefix, ...args),
    debug: (...args) => {
      if (process.env.QINGBOT_DEBUG) console.debug(prefix, ...args)
    },
  }
}
