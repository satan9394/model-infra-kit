import { getI18n } from "@/lib/i18n/server"
import { LiveRefresh } from "@/components/live-refresh"
import { ModelsClient } from "@/components/views/models"
import { PageHeader } from "@/components/ui"
import { UpstreamNotice } from "@/components/upstream-notice"
import { loadModelCatalog, loadModelsWithPricing, loadShell } from "@/lib/server-data"

export const dynamic = "force-dynamic"

export default async function ModelsPage() {
  const { t } = await getI18n()

  // Prices are only attached by `GET /api/models/:ref`, so the catalogue is
  // enriched here rather than in `loadShell` (which every page would pay for).
  const [shell, catalog, modelCatalog] = await Promise.all([loadShell(), loadModelsWithPricing(), loadModelCatalog()])

  const errors = [...shell.errors]
  if (!catalog.ok) errors.push(catalog.error)
  if (!modelCatalog.ok) errors.push(modelCatalog.error)

  return (
    <>
      <PageHeader
        title={t("s134")}
        description={t("s369")}
        actions={<LiveRefresh topics={["catalog.updated", "pricing.updated"]} />}
      />
      <UpstreamNotice message={errors[0]} />
      <ModelsClient
        models={catalog.ok ? catalog.data.models : shell.models}
        defaultModel={catalog.ok ? catalog.data.defaultModel : undefined}
        providers={shell.providers}
        catalogModels={modelCatalog.ok ? modelCatalog.data.models : []}
        catalogBindings={modelCatalog.ok ? modelCatalog.data.bindings : []}
      />
    </>
  )
}
