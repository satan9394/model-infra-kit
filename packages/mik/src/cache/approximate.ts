const DIMENSIONS = 64
const MAX_HASH = (1n << 64n) - 1n
const STEP = 0x9e3779b97f4a7c15n

/** Internal, lexical fingerprint; not an embedding or a cache-replay authorization. */
export type MinHashSignature = readonly bigint[]

/**
 * NFKC + lowercase; punctuation/whitespace separate English words and are ignored
 * between Han characters. Script changes end a run. Short runs use their entire
 * content so distinct one-character/one-word inputs do not become empty matches.
 * Shingles are unique and script-prefixed; Han uses Unicode code points.
 */
export function extractShingles(text: string): Set<string> {
  const shingles = new Set<string>()
  let kind = "", run: string[] = []
  function flush(): void {
    if (!run.length) return
    const width = kind === "c" ? 2 : 3
    const separator = kind === "c" ? "" : " "
    if (run.length < width) shingles.add(`${kind}:${run.join(separator)}`)
    else for (let i = 0; i <= run.length - width; i++) {
      shingles.add(`${kind}:${run.slice(i, i + width).join(separator)}`)
    }
    run = []
  }
  for (const token of text.normalize("NFKC").toLowerCase().matchAll(/\p{Script=Han}+|[\p{Script=Latin}\p{N}]+/gu)) {
    const nextKind = /^\p{Script=Han}/u.test(token[0]) ? "c" : "w"
    if (nextKind !== kind) { flush(); kind = nextKind }
    if (kind === "c") for (const character of token[0]) run.push(character)
    else run.push(token[0])
  }
  flush()
  return shingles
}

function hash64(text: string): bigint {
  let hash = 0xcbf29ce484222325n
  for (let i = 0; i < text.length; i++) {
    hash = ((hash ^ BigInt(text.charCodeAt(i))) * 0x100000001b3n) & MAX_HASH
  }
  return hash
}

// SplitMix64's avalanche gives each fixed seed a different shingle ordering.
function permute(hash: bigint): bigint {
  let value = hash & MAX_HASH
  value = ((value ^ (value >> 30n)) * 0xbf58476d1ce4e5b9n) & MAX_HASH
  value = ((value ^ (value >> 27n)) * 0x94d049bb133111ebn) & MAX_HASH
  return (value ^ (value >> 31n)) & MAX_HASH
}

/** 64 deterministic unsigned 64-bit minima. Empty input has all-ones minima. */
export function createMinHashSignature(text: string): MinHashSignature {
  const signature = Array<bigint>(DIMENSIONS).fill(MAX_HASH)
  for (const shingle of extractShingles(text)) {
    const hash = hash64(shingle)
    for (let i = 0; i < DIMENSIONS; i++) {
      const candidate = permute(hash + STEP * BigInt(i + 1))
      if (candidate < signature[i]!) signature[i] = candidate
    }
  }
  return signature
}

/**
 * Estimate shingle-set Jaccard by equal-position matches (increments of 1/64).
 * Empty/empty is 1, empty/nonempty is 0. No allocation, tokenization or I/O.
 * ponytail: lexical overlap cannot guarantee semantic equivalence or safe replay.
 */
export function estimateJaccard(left: MinHashSignature, right: MinHashSignature): number {
  if (left.length !== DIMENSIONS || right.length !== DIMENSIONS) {
    throw new RangeError("MinHash signatures must contain exactly 64 dimensions")
  }
  let matches = 0
  for (let i = 0; i < DIMENSIONS; i++) if (left[i] === right[i]) matches++
  return matches / DIMENSIONS
}
