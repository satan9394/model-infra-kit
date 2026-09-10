import { ProvidersClient } from "@/components/providers-client"
import { ErrorBanner, PageHeader } from "@/components/ui"
import { loadShell } from "@/lib/server-data"

export const dynamic = "force-dynamic"

export default async function ProvidersPage() {
  const shell = await loadShell()

  return (
    <>
      <PageHeader
        title="供应商"
        description="连接状态、模型发现与启用开关。密钥只以引用形式存在于 mik 侧，看板看不到明文。"
      />
      {shell.errors.length > 0 ? <ErrorBanner message={shell.errors[0] ?? "未知错误"} /> : null}
      <ProvidersClient providers={shell.providers} />
    </>
  )
}
