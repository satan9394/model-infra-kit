"use client"

import { useI18n } from "@/lib/i18n/provider"

export function RouteLoading() {
  const { t } = useI18n()
  return <div role="status" aria-live="polite" className="p-6 text-sm text-muted-foreground" data-testid="route-loading">
    <div aria-hidden="true" className="fixed inset-x-0 top-0 z-50 h-1 bg-primary" />
    {t("s79")}
  </div>
}
