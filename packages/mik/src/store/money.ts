/** USD → integer micro-USD. All aggregation happens in this unit. */
export function toMicroUsd(usd: number): number {
  if (!Number.isFinite(usd)) return 0
  return Math.round(usd * 1_000_000)
}

/** Integer micro-USD → USD. */
export function fromMicroUsd(micro: number): number {
  return micro / 1_000_000
}

/** `YYYY-MM-DD` in local time, matching how rollups are keyed. */
export function localDateKey(ts: number): string {
  const date = new Date(ts)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

/** Start of the local day containing `ts`. */
export function startOfLocalDay(ts: number): number {
  const date = new Date(ts)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/** `YYYY-MM-DDTHH:00` in local time, for sub-day buckets. */
export function localHourKey(ts: number): string {
  const date = new Date(ts)
  const day = localDateKey(ts)
  return `${day}T${String(date.getHours()).padStart(2, "0")}:00`
}
