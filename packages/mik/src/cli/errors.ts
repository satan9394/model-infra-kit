/**
 * Two error kinds so `main()` can pick an exit code and a hint:
 * `CliUsageError` is the caller's mistake (exit 2, prints usage),
 * `CliRuntimeError` is a real failure (exit 1).
 */
export class CliUsageError extends Error {
  readonly usage: string | undefined

  constructor(message: string, usage?: string) {
    super(message)
    this.name = "CliUsageError"
    this.usage = usage
  }
}

export class CliRuntimeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CliRuntimeError"
  }
}
