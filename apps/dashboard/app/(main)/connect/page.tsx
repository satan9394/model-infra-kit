import { ConnectGenerator } from "@/components/connect-generator"
import { PageHeader } from "@/components/ui"
import { UpstreamNotice } from "@/components/upstream-notice"
import { mikServerUrl } from "@/lib/config"
import { publicBaseUrl } from "@/lib/connect"
import { getI18n } from "@/lib/i18n/server"
import { loadShell, loadModels } from "@/lib/server-data"

export const dynamic = "force-dynamic"

export default async function ConnectPage() {
  const [{ t }, shell, discovered] = await Promise.all([getI18n(), loadShell(), loadModels()])
  const enabled = new Set(shell.providers.filter((provider) => provider.enabled).map((provider) => provider.id))
  const models = shell.models.filter((model) => enabled.has(model.providerId) && model.capabilities.text).map(({ ref, displayName }) => ({ ref, displayName }))
  return <>
    <PageHeader title={t("connect.title")} description={t("connect.description")} />
    <UpstreamNotice message={shell.errors[0]} />
    <ConnectGenerator baseUrl={publicBaseUrl(mikServerUrl())} models={models} defaultModel={discovered.ok ? discovered.data.defaultModel : null} />
  </>
}
