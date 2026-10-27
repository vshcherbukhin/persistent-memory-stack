import { notFound } from 'next/navigation'

export const dynamic = 'force-dynamic'

/** Community has no active sharing/connector operations. */
export default function RetiredSharingPage() {
  notFound()
}
