import OverviewView from "@/components/views/overview"
import { type SearchParams } from "@/lib/range"

export const dynamic = "force-dynamic"

/** 嵌入版概览：默认近 7 天，无筛选面板；实时增量仍生效。 */
export default async function EmbedOverviewPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams
  return <OverviewView params={{ ...params, range: params.range ?? "7d" }} embedded />
}