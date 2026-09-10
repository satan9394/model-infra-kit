import OverviewView from "@/components/views/overview"
import { type SearchParams } from "@/lib/range"

export const dynamic = "force-dynamic"

export default async function OverviewPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams
  return <OverviewView params={params} />
}