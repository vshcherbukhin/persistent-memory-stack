import assert from 'node:assert/strict'
import test from 'node:test'
import { scoreAgentAnswer } from './run-recall-agent-sample.mjs'

test('agent answer scoring requires expected terms and rejects obsolete claims', () => {
  assert.deepEqual(
    scoreAgentAnswer('person_alice belongs to team_sales.', ['person_alice', 'team_sales'], ['team_marketing']),
    { pass: true, missing: [], forbidden: [], anyMatched: true },
  )
  assert.deepEqual(
    scoreAgentAnswer('person_alice belongs to team_marketing.', ['person_alice', 'team_sales'], ['team_marketing']),
    { pass: false, missing: ['team_sales'], forbidden: ['team_marketing'], anyMatched: true },
  )
  assert.equal(scoreAgentAnswer('No, product_widgeon does not belong here.', ['product_widgeon'], [], ['unknown', 'does not belong']).pass, true)
  assert.equal(scoreAgentAnswer('product_widgeon belongs here.', ['product_widgeon'], [], ['unknown', 'does not belong']).pass, false)
})
