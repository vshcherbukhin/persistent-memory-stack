/** Community upgrades preserve legacy graphs without inference or cleanup. */
import { Prisma, runInTenant, type Tx } from '@pm/db'
import { withSystemTenant } from '../tenant.ts'

export async function inspectCommunityGraphCompatibility() {
  return withSystemTenant(() => runInTenant(async (tx: Tx) => {
    const personal = {ownershipState:'personal',deletedAt:null}
    const [personalMemories,legacyPreserved,classified,classifiedGraphPending] = await Promise.all([
      tx.memory.count({where:personal}),
      tx.memory.count({where:{...personal,knowledge:{equals:Prisma.DbNull}}}),
      tx.memory.count({where:{...personal,knowledge:{not:Prisma.DbNull}}}),
      tx.memory.count({where:{...personal,knowledge:{not:Prisma.DbNull},graphStatus:{in:['pending','failed']}}}),
    ])
    return {state:'legacy_preserved' as const,metrics:{personalMemories,legacyPreserved,classified,classifiedGraphPending,providerCalls:0,legacyGroupsPurged:0}}
  }))
}
