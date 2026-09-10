import PricingView from "@/components/views/pricing"

export const dynamic = "force-dynamic"

export default async function EmbedPricingPage() {
  return <PricingView embedded />
}