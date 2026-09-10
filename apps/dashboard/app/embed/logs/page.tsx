import LogsView from "@/components/views/logs"
import { type SearchParams } from "@/lib/range"

export const dynamic = "force-dynamic"

export default async function EmbedLogsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams
  return <LogsView params={{ ...params, range: params.range ?? "7d" }} embedded />
}