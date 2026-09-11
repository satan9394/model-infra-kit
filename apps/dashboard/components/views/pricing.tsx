import { LiveRefresh } from "@/components/live-refresh"
import { PricingClient } from "@/components/pricing-client"
import { PageHeader } from "@/components/ui"
import { UpstreamNotice } from "@/components/upstream-notice"
import { loadPricing, loadShell } from "@/lib/server-data"

export interface ViewProps {
  embedded?: boolean
}

export default async function PricingView({ embedded }: ViewProps = {}) {
  const [pricing, shell] = await Promise.all([loadPricing(), loadShell()])

  const errors = [...shell.errors]
  if (!pricing.ok) errors.push(pricing.error)

  return (
    <>
      <PageHeader
        title="价格表"
        description="目录同步状态与手动覆盖价。手动价在 mik 内优先级最高，撤销后回落到上游目录。"
        actions={<LiveRefresh topics={["pricing.updated"]} />}
      />
      {/* EVO-G09 A1: neutral guide first, error banner only after a failed retry. */}
      <UpstreamNotice message={errors[0]} />
      {!embedded ? null : <p className="mb-4 text-xs text-slate-500">嵌入视图 · 价格与同步状态</p>}
      <PricingClient
        state={pricing.ok ? pricing.data.state : null}
        overrides={pricing.ok ? pricing.data.overrides : []}
        models={shell.models}
      />
    </>
  )
}