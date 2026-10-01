import { cookies } from "next/headers"
import { resolveLang, translator } from "./core"

export async function getI18n() {
  const lang = resolveLang((await cookies()).get("mik_dashboard_lang")?.value)
  return { lang, t: translator(lang) }
}
