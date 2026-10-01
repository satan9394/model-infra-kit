import { getI18n } from "@/lib/i18n/server"
import { ProvidersClient } from "@/components/providers-client"
import { PageHeader } from "@/components/ui"
import { UpstreamNotice } from "@/components/upstream-notice"
import { loadShell } from "@/lib/server-data"

export const dynamic = "force-dynamic"

export default async function ProvidersPage() {
  const { t } = await getI18n()

  const shell = await loadShell()

  return (
    <>
      <PageHeader
        title={t("s87")}
        description={t("s370")}
      />
      <UpstreamNotice message={shell.errors[0]} />
      <ProvidersClient providers={shell.providers} />
    </>
  )
}
