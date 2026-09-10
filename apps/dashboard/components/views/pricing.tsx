import { LiveRefresh } from "@/components/live-refresh"
import { PricingClient } from "@/components/pricing-client"
import { ErrorBanner, PageHeader } from "@/components/ui"
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
      {!embedded ? null : <p className="mb-4 text-xs text-slate-500">嵌入视图 · 价格与同步状态</p>}
      {errors.length > 0 ? <ErrorBanner message={errors[0] ?? "未知错误"} /> : null}
      <PricingClient
        state={pricing.ok ? pricing.data.state : null}
        overrides={pricing.ok ? pricing.data.overrides : []}
        models={shell.models}
      />
    </>
  )
}