import fs from "node:fs"
import { syncBuiltinESMExports } from "node:module"

// ponytail: keep verification scratch directories instead of deleting them.
fs.rmSync = (path, options = {}) => {
  if (!fs.existsSync(path) && options.force) return
  if (fs.statSync(path).isDirectory()) return
  throw new Error("Verification guard: file deletion requires Windows Recycle Bin")
}
fs.unlinkSync = () => { throw new Error("Verification guard: unlink disabled") }
syncBuiltinESMExports()
