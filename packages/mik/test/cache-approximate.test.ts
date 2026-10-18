import { describe, expect, it } from "vitest"
import { createMinHashSignature as signature, estimateJaccard, extractShingles } from "../src/cache/approximate.js"

function exactJaccard(left: string, right: string): number {
  const a = extractShingles(left), b = extractShingles(right)
  const union = new Set([...a, ...b]).size
  return union ? [...a].filter(value => b.has(value)).length / union : 1
}

const similarity = (left: string, right: string) => estimateJaccard(signature(left), signature(right))
// A real long instruction: local wording changes occupy a small part of the set.
const shortInstruction = "请解释量子计算的基本原理，包括量子比特与经典比特之间的区别、叠加态如何表示信息、纠缠现象为什么产生关联，以及测量过程怎样影响计算结果。介绍常见量子门的作用，说明算法如何利用干涉提高目标答案出现的概率，并用直观例子比较经典搜索与量子搜索的步骤。讨论当前硬件面临的退相干问题、噪声来源和纠错成本，区分理论加速与实际工程优势。最后列出适合初学者学习的数学基础，给出循序渐进的练习建议，避免将研究进展描述为已经普及的商业能力。"
const instruction = shortInstruction + "补充实验设计部分，明确控制变量、重复次数、观测指标与误差范围，描述如何从有限样本估计概率分布。展示电路初始化、单比特旋转、双比特操作与最终读出之间的顺序关系，解释不同物理实现对连接拓扑和执行时间的限制。比较超导线路、离子阱和光学方案各自的优点及挑战，引用结论时区分已验证事实、合理假设与尚待检验的预测。提供课堂讨论问题，引导读者识别宣传材料中的夸大陈述，强调任何性能比较都需要公开输入规模、资源消耗和基准方法。"

describe("approximate cache lexical engine", () => {
  it("extracts unique Chinese character bigrams and English word trigrams", () => {
    expect([...extractShingles("中 文，测试！")]).toEqual(["c:中文", "c:文测", "c:测试"])
    expect([...extractShingles("The, QUICK\n brown fox!")]).toEqual(["w:the quick brown", "w:quick brown fox"])
    expect([...extractShingles("哈哈哈")]).toEqual(["c:哈哈"])
    expect(extractShingles("Ａ quick brown")).toEqual(extractShingles("a quick brown"))
  })

  it("keeps mixed scripts separate and respects supplementary Han code points", () => {
    expect([...extractShingles("中文 one two three 测试")]).toEqual(["c:中文", "w:one two three", "c:测试"])
    expect([...extractShingles("𠀀中文")]).toEqual(["c:𠀀中", "c:中文"])
  })

  it("defines empty and shorter-than-ngram inputs without merging distinct short texts", () => {
    expect(extractShingles(" \t，！？... ")).toEqual(new Set())
    expect([...extractShingles("中")]).toEqual(["c:中"])
    expect([...extractShingles("one two")]).toEqual(["w:one two"])
    expect(similarity("", "， ")).toBe(1)
    expect(similarity("", "word")).toBe(0)
    expect(similarity("中", "文")).toBe(0)
    expect(similarity("one", "two")).toBe(0)
  })

  it("produces independent deterministic 64-dimensional unsigned 64-bit signatures", () => {
    const a = signature(instruction), b = signature(instruction)
    expect(a).toEqual(b)
    expect(a).not.toBe(b)
    expect(a).toHaveLength(64)
    expect(a.every(value => typeof value === "bigint" && value >= 0n && value < (1n << 64n))).toBe(true)
    expect(new Set(a).size).toBeGreaterThan(60)
    expect(similarity("Hello, WORLD again!", "hello world again")).toBe(1)
  })

  it.each([
    ["synonymous local wording", instruction.replace("直观例子", "直观示例")],
    ["particle insertion", `${instruction}呢`],
    ["particle removal", instruction.replace("的基本原理", "基本原理")],
  ])("hits >=0.95 for %s in a long instruction with genuinely high shingle overlap", (_, changed) => {
    expect(exactJaccard(instruction, changed)).toBeGreaterThanOrEqual(0.95)
    expect(similarity(instruction, changed)).toBeGreaterThanOrEqual(0.95)
  })

  it.each([
    ["请解释一下量子计算的原理", "请简单解释一下量子计算原理？"],
    ["请解释量子计算原理", "请解释量子计算原理呢"],
    ["the quick brown fox jumps over the lazy dog", "the quick brown fox never jumps over the lazy dog"],
    [instruction, "今天晚餐需要买哪些蔬菜水果和调味品"],
  ])("rejects low lexical overlap rather than inventing semantic equivalence", (left, right) => {
    expect(exactJaccard(left, right)).toBeLessThan(0.95)
    expect(similarity(left, right)).toBeLessThan(0.95)
  })

  it("preserves a false-negative counterexample near the estimator threshold", () => {
    const changed = shortInstruction.replace("直观例子", "直观示例")
    expect(exactJaccard(shortInstruction, changed)).toBeGreaterThanOrEqual(0.95)
    expect(similarity(shortInstruction, changed)).toBe(59 / 64)
  })

  it("counts matching positions, is symmetric/bounded and rejects malformed dimensions", () => {
    const left = Array<bigint>(64).fill(1n), right = Array<bigint>(64).fill(2n)
    for (let i = 0; i < 61; i++) right[i] = 1n
    expect(estimateJaccard(left, right)).toBe(61 / 64)
    right[61] = 1n
    expect(estimateJaccard(left, right)).toBe(62 / 64)
    expect(estimateJaccard(left, right)).toBe(estimateJaccard(right, left))
    expect(left).toEqual(Array<bigint>(64).fill(1n))
    for (const text of ["", "word", instruction]) {
      const score = estimateJaccard(signature(text), right)
      expect(score).toBeGreaterThanOrEqual(0)
      expect(score).toBeLessThanOrEqual(1)
    }
    expect(() => estimateJaccard([], left)).toThrow(RangeError)
    expect(() => estimateJaccard(left, left.slice(1))).toThrow(RangeError)
  })

  it("approximates exact shingle Jaccard across a fixed nonidentical corpus", () => {
    // Independent set oracle across overlaps; guards against correlated hash orderings.
    for (const overlap of [0, 25, 50, 75, 100]) {
      const left = Array.from({ length: 100 }, (_, i) => `word${i}`).join(" ")
      const right = Array.from({ length: 100 }, (_, i) => `word${i + 100 - overlap}`).join(" ")
      expect(Math.abs(similarity(left, right) - exactJaccard(left, right))).toBeLessThan(0.2)
    }
  })

  it("handles long text and compares precomputed signatures below 100 microseconds", () => {
    const longText = Array.from({ length: 2_000 }, (_, i) => `topic${i}`).join(" ")
    const left = signature(longText), right = signature(`${longText} please`)
    expect(estimateJaccard(left, right)).toBeGreaterThanOrEqual(0.95)
    for (let i = 0; i < 2_000; i++) estimateJaccard(left, right)
    const iterations = 20_000, batches: number[] = []
    let sum = 0
    for (let batch = 0; batch < 5; batch++) {
      const start = performance.now()
      for (let i = 0; i < iterations; i++) sum += estimateJaccard(left, right)
      batches.push((performance.now() - start) * 1_000 / iterations)
    }
    expect(sum).toBeGreaterThan(0)
    console.info(`signature comparison: worst warmed batch mean ${Math.max(...batches).toFixed(3)} us/call (5 x ${iterations}); signature generation excluded`)
    expect(Math.max(...batches)).toBeLessThan(100)
  })
})
