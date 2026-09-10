import TrendsView from "@/components/views/trends"
import { type SearchParams } from "@/lib/range"

export const dynamic = "force-dynamic"

export default async function EmbedTrendsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams
  return <TrendsView params={{ ...params, range: params.range ?? "7d" }} embedded />
}