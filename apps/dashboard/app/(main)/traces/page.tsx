import TracesView from "@/components/views/traces"
import { type SearchParams } from "@/lib/range"

export const dynamic = "force-dynamic"

export default async function TracesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams
  return <TracesView params={params} />
}
