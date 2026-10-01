import { getI18n } from "@/lib/i18n/server"
import { LiveRefresh } from "@/components/live-refresh"
import { PricingClient } from "@/components/pricing-client"
import { PageHeader } from "@/components/ui"
import { UpstreamNotice } from "@/components/upstream-notice"
import { loadPricing, loadShell } from "@/lib/server-data"

export interface ViewProps {
  embedded?: boolean
}

export default async function PricingView({ embedded }: ViewProps = {}) {
  const { t } = await getI18n()

  const [pricing, shell] = await Promise.all([loadPricing(), loadShell()])

  const errors = [...shell.errors]
  if (!pricing.ok) errors.push(pricing.error)

  return (
    <>
      <PageHeader
        title={t("s136")}
        description={t("s324")}
        actions={<LiveRefresh topics={["pricing.updated"]} />}
      />
      {/* EVO-G09 A1: neutral guide first, error banner only after a failed retry. */}
      <UpstreamNotice message={errors[0]} />
      {!embedded ? null : <p className="mb-4 text-xs text-subtle"> {t("s325")} </p>}
      <PricingClient
        state={pricing.ok ? pricing.data.state : null}
        overrides={pricing.ok ? pricing.data.overrides : []}
        models={shell.models}
      />
    </>
  )
}