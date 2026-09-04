/** @pm/shared/switch — dimension/provider migration (named-vector switch tool). */
export {
  planSwitch,
  step1AddVector,
  step3Reembed,
  step4FlipTarget,
  step5DropOld,
  writeTargetVectors,
} from './migration.ts'
export type { SwitchPlan, ReembedDeps } from './migration.ts'
export { runSwitch } from './run.ts'
export type { RunSwitchHooks, SwitchResult } from './run.ts'
