import { WebhooksPanel } from "@/components/webhooks-panel"
import { PageHeader } from "@/components/ui"
import { getI18n } from "@/lib/i18n/server"

export default async function WebhooksPage() {
  const { t } = await getI18n()
  return <>
    <PageHeader title={t("webhooks.title")} description={t("webhooks.description")} />
    <WebhooksPanel />
  </>
}
