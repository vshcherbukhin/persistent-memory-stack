/** A UUID retry identifier is protocol data, not a credential assignment.
 * Preserve every value for local scanning, without presenting a machine UUID as
 * an API-key assignment to Gitleaks. Other retry keys retain their original
 * context, and semantic text is never rewritten. Receipts use the original input.
 */
const generatedUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
export function knowledgePrivacyView<T extends { idempotencyKey: string }>(input: T) {
  if (!generatedUuid.test(input.idempotencyKey)) return input
  const { idempotencyKey, ...fields } = input
  return { ...fields, receiptId: idempotencyKey }
}

/** Numeric memory UUIDs can resemble credit-card numbers to Presidio. Only the
 * parsed record identity and its matching storage-identity copies are protocol
 * data. Every semantic value stays intact, including UUID literals in metadata
 * or evidence. Authentication and restoration always use the original archive.
 */
export function archivePrivacyView<T extends { id: string; revisionHistory?: Array<{ snapshot: unknown; [key: string]: unknown }> }>(input: T) {
  if (!generatedUuid.test(input.id)) return input
  const marker = '[validated memory identifier]'
  return {
    ...input,
    id: marker,
    ...(input.revisionHistory ? { revisionHistory: input.revisionHistory.map(version => {
      const snapshot = version.snapshot
      return {
        ...version,
        ...(version.memoryId === input.id ? { memoryId: marker } : {}),
        ...(snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot) && 'id' in snapshot && snapshot.id === input.id
          ? { snapshot: { ...snapshot, id: marker } } : {}),
      }
    }) } : {}),
  }
}
