import { QuotasPanel } from "@/components/quotas-panel"
import { PageHeader } from "@/components/ui"
import { getI18n } from "@/lib/i18n/server"

export default async function QuotasPage() {
  const { t } = await getI18n()
  return <>
    <PageHeader title={t("quotas.title")} description={t("quotas.description")} />
    <QuotasPanel />
  </>
}
