const SEGMENT = /^[A-Za-z0-9._~:@-]+$/
const MODEL_REF = /^[A-Za-z0-9._~:@/-]+$/

/** Namespace slashes are allowed only inside the encoded model-ref segment. */
export function isMikProxyPath(path: string[]): boolean {
  if (path.length === 0) return false
  return path.every((segment, index) => {
    if (!segment || segment.split("/").some((part) => !part || part === "." || part === "..")) return false
    if (path[0] === "models" && index === 1 && segment.includes(":")) {
      const separator = segment.indexOf(":")
      const provider = segment.slice(0, separator)
      const model = segment.slice(separator + 1)
      return SEGMENT.test(provider) && provider !== "." && provider !== ".." && MODEL_REF.test(model) && model.split("/").every((part) => part && part !== "." && part !== "..")
    }
    return SEGMENT.test(segment)
  })
}
