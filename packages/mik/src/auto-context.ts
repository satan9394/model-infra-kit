import { AsyncLocalStorage } from "node:async_hooks"

// Server-originated provider calls must not re-enter the local gateway when a
// host runs its gateway and the opt-in client adapter in the same process.
export const autoBypass = new AsyncLocalStorage<boolean>()
