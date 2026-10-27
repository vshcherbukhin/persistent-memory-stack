import { notFound } from 'next/navigation'

export const dynamic = 'force-dynamic'

/** Community has no multi-user or shared partition administration. */
export default function RetiredAdministrationPage() {
  notFound()
}
