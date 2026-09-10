import { LiveRefresh } from "@/components/live-refresh"
import { ModelsClient } from "@/components/models-client"
import { ErrorBanner, PageHeader } from "@/components/ui"
import { loadModelsWithPricing, loadShell } from "@/lib/server-data"

export const dynamic = "force-dynamic"

export default async function ModelsPage() {
  // Prices are only attached by `GET /api/models/:ref`, so the catalogue is
  // enriched here rather than in `loadShell` (which every page would pay for).
  const [shell, catalog] = await Promise.all([loadShell(), loadModelsWithPricing()])

  const errors = [...shell.errors]
  if (!catalog.ok) errors.push(catalog.error)

  return (
    <>
      <PageHeader
        title="模型目录"
        description="能力位、上下文窗口、价格与来源，全部来自 mik 的目录同步结果"
        actions={<LiveRefresh topics={["catalog.updated", "pricing.updated"]} />}
      />
      {errors.length > 0 ? <ErrorBanner message={errors[0] ?? "未知错误"} /> : null}
      <ModelsClient models={catalog.ok ? catalog.data.models : shell.models} providers={shell.providers} />
    </>
  )
}
