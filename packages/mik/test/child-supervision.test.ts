import { spawn } from "node:child_process"
import { EventEmitter } from "node:events"
import { afterEach, describe, expect, it, vi } from "vitest"
import { SIGKILL_GRACE_MS, superviseChild, type SupervisedChild } from "../src/cli/child-supervision.js"

/** A child process stand-in: records every signal it is sent, never really dies. */
class FakeChild extends EventEmitter implements SupervisedChild {
  pid?: number
  readonly signals: NodeJS.Signals[] = []

  constructor(pid?: number) {
    super()
    this.pid = pid
  }

  kill = (signal?: NodeJS.Signals): boolean => {
    // `child.kill()` with no argument means SIGTERM; record what the OS would get.
    this.signals.push(signal ?? "SIGTERM")
    return true
  }
}

/** A `process` stand-in: real signal semantics (once/off) without touching the parent's own. */
class FakeProcess extends EventEmitter {
  platform: NodeJS.Platform

  constructor(platform: NodeJS.Platform = "linux") {
    super()
    this.platform = platform
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("superviseChild", () => {
  it("SIGINT on win32 kills the whole tree via taskkill and never signal-1s the child", () => {
    const child = new FakeChild(4242)
    const host = new FakeProcess("win32")
    const execTaskkill = vi.fn<(pid: number) => void>()
    const dispose = superviseChild(child, { processObject: host, execTaskkill })
    try {
      host.emit("SIGINT")
      expect(execTaskkill).toHaveBeenCalledTimes(1)
      expect(execTaskkill).toHaveBeenCalledWith(4242)
      // `pnpm → next` means the direct child is only half the tree; taskkill owns it.
      expect(child.signals).toEqual([])
    } finally {
      dispose()
    }
  })

  it("SIGINT off win32 sends SIGTERM then escalates to SIGKILL after the grace period", () => {
    vi.useFakeTimers()
    const child = new FakeChild(99)
    const host = new FakeProcess("linux")
    const dispose = superviseChild(child, { processObject: host })
    try {
      host.emit("SIGINT")
      expect(child.signals).toEqual(["SIGTERM"])

      vi.advanceTimersByTime(SIGKILL_GRACE_MS - 1)
      expect(child.signals).toEqual(["SIGTERM"])

      vi.advanceTimersByTime(1)
      expect(child.signals).toEqual(["SIGTERM", "SIGKILL"])
    } finally {
      dispose()
    }
  })

  it("SIGTERM behaves like SIGINT off win32", () => {
    vi.useFakeTimers()
    const child = new FakeChild(7)
    const host = new FakeProcess("darwin")
    const dispose = superviseChild(child, { processObject: host })
    try {
      expect(host.listenerCount("SIGTERM")).toBe(1)
      host.emit("SIGTERM")
      expect(child.signals).toEqual(["SIGTERM"])
      vi.advanceTimersByTime(SIGKILL_GRACE_MS)
      expect(child.signals).toEqual(["SIGTERM", "SIGKILL"])
    } finally {
      dispose()
    }
  })

  it("parent exit runs a single synchronous kill and stays idempotent", () => {
    const child = new FakeChild(1234)
    const host = new FakeProcess("linux")
    const dispose = superviseChild(child, { processObject: host })
    try {
      host.emit("exit")
      expect(child.signals).toEqual(["SIGTERM"])

      // A second exit (and a late signal) must not signal twice or throw.
      expect(() => host.emit("exit")).not.toThrow()
      expect(() => host.emit("SIGINT")).not.toThrow()
      expect(child.signals).toEqual(["SIGTERM"])
    } finally {
      dispose()
    }
  })

  it("is idempotent across repeated signals and stops swallowing the second one", () => {
    vi.useFakeTimers()
    const child = new FakeChild(55)
    const host = new FakeProcess("linux")
    const dispose = superviseChild(child, { processObject: host })
    try {
      host.emit("SIGINT")
      // The listener is gone after the first delivery, so a second Ctrl+C keeps
      // its default meaning (immediate exit) instead of being eaten by us.
      expect(host.listenerCount("SIGINT")).toBe(0)

      expect(() => host.emit("SIGINT")).not.toThrow()
      vi.advanceTimersByTime(SIGKILL_GRACE_MS)
      expect(child.signals).toEqual(["SIGTERM", "SIGKILL"])
    } finally {
      dispose()
    }
  })

  it("warns and falls back to kill() when taskkill fails", () => {
    const child = new FakeChild(8080)
    const host = new FakeProcess("win32")
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const execTaskkill = vi.fn<(pid: number) => void>(() => {
      throw new Error("taskkill exited with status 1")
    })
    const dispose = superviseChild(child, { processObject: host, execTaskkill })
    try {
      expect(() => host.emit("SIGINT")).not.toThrow()
      expect(warn).toHaveBeenCalledTimes(1)
      expect(child.signals).toEqual(["SIGKILL"])
    } finally {
      dispose()
    }
  })

  it("dispose detaches the listeners and cancels the pending escalation", () => {
    vi.useFakeTimers()
    const child = new FakeChild(3)
    const host = new FakeProcess("linux")
    const dispose = superviseChild(child, { processObject: host })

    host.emit("SIGINT")
    expect(child.signals).toEqual(["SIGTERM"])

    dispose()
    expect(host.listenerCount("SIGINT")).toBe(0)
    expect(host.listenerCount("SIGTERM")).toBe(0)
    expect(host.listenerCount("exit")).toBe(0)

    vi.advanceTimersByTime(SIGKILL_GRACE_MS * 10)
    expect(child.signals).toEqual(["SIGTERM"])

    // dispose() is itself idempotent.
    expect(() => dispose()).not.toThrow()
    expect(() => host.emit("exit")).not.toThrow()
  })

  // Integration: no Next.js, but a *real* child and the production defaults
  // (`taskkill /T /F` on win32, SIGTERM → SIGKILL elsewhere). Proves the kill
  // actually reaches a live OS process, which a fake child cannot show.
  it("reclaims a real child process through the production termination path", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })
    const exited = new Promise<number | null>((resolve) => {
      child.once("exit", (code) => resolve(code))
    })
    const host = new FakeProcess(process.platform)
    const dispose = superviseChild(child, { processObject: host })
    try {
      await new Promise((resolve) => setTimeout(resolve, 250))
      host.emit("SIGINT")
      const outcome = await Promise.race([
        exited,
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 5_000)),
      ])
      expect(outcome).not.toBe("timeout")
      // POSIX reports a signal death through `signalCode` and leaves `exitCode`
      // null; Windows' `taskkill` path yields an exit code. Either proves the
      // process is gone, so assert on both rather than on one platform's shape.
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
    } finally {
      dispose()
      if (child.exitCode === null) child.kill("SIGKILL")
    }
  }, 20_000)
})
