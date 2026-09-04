#!/usr/bin/env node
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'

const ROOT = resolve(new URL('..', import.meta.url).pathname)

function parseArgs(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index]?.startsWith('--')) continue
    values[argv[index].slice(2)] = argv[index + 1]
    index += 1
  }
  return values
}

function parseDotEnv(source) {
  return Object.fromEntries(source.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (!match) return []
    return [[match[1], match[2].replace(/^(['"])(.*)\1$/, '$2')]]
  }))
}

function isOat(token) {
  return token.includes('sk-ant-oat')
}

export function scoreAgentAnswer(answer, expectedInclude, expectedExclude, expectedAny = []) {
  const normalized = answer.toLowerCase()
  const missing = expectedInclude.filter((term) => !normalized.includes(term.toLowerCase()))
  const forbidden = expectedExclude.filter((term) => normalized.includes(term.toLowerCase()))
  const anyMatched = expectedAny.length === 0 || expectedAny.some((term) => normalized.includes(term.toLowerCase()))
  return { pass: missing.length === 0 && forbidden.length === 0 && anyMatched, missing, forbidden, anyMatched }
}

async function anthropicAnswer({ apiKey, model, prompt }) {
  const client = isOat(apiKey)
    ? new Anthropic({
        apiKey: null,
        authToken: apiKey,
        maxRetries: 6,
        defaultHeaders: {
          'anthropic-beta': 'oauth-2025-04-20',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
      })
    : new Anthropic({ apiKey, maxRetries: 6 })
  const response = await client.messages.create({
    model,
    max_tokens: 256,
    temperature: 0,
    system: 'Answer only from the supplied Persistent Memory recall context. Preserve exact entity tokens and dates. Distinguish current facts from superseded history. If the answer is absent, say unknown. Cite relevant memory IDs when available.',
    messages: [{ role: 'user', content: prompt }],
  })
  const answer = response.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n')
  return {
    answer,
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    },
  }
}

async function openAiAnswer({ apiKey, model, prompt }) {
  const client = new OpenAI({ apiKey })
  const response = await client.chat.completions.create({
    model,
    temperature: 0,
    max_tokens: 256,
    messages: [
      { role: 'system', content: 'Answer only from the supplied Persistent Memory recall context. Preserve exact entity tokens and dates. Distinguish current facts from superseded history. If the answer is absent, say unknown. Cite relevant memory IDs when available.' },
      { role: 'user', content: prompt },
    ],
  })
  return {
    answer: response.choices[0]?.message?.content ?? '',
    usage: {
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: response.usage?.completion_tokens ?? 0,
    },
  }
}

export async function runAgentSamples({ samples, env }) {
  const provider = env.PM_AGENT_EVAL_PROVIDER ?? env.EXTRACTION_PROVIDER ?? 'anthropic'
  const model = env.PM_AGENT_EVAL_MODEL ?? env.EXTRACTION_MODEL
  if (!model) throw new Error('Agent sample requires PM_AGENT_EVAL_MODEL or EXTRACTION_MODEL.')
  if (provider !== 'anthropic' && provider !== 'openai') throw new Error(`Unsupported agent sample provider: ${provider}`)
  const apiKey = provider === 'anthropic' ? env.ANTHROPIC_API_KEY : env.OPENAI_API_KEY
  if (!apiKey) throw new Error(`Agent sample requires ${provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'}.`)

  const results = []
  for (const sample of samples) {
    const prompt = `Question:\n${sample.query}\n\nRecall context JSON:\n${JSON.stringify(sample.context)}`
    const response = provider === 'anthropic'
      ? await anthropicAnswer({ apiKey, model, prompt })
      : await openAiAnswer({ apiKey, model, prompt })
    const score = scoreAgentAnswer(response.answer, sample.expectedInclude, sample.expectedExclude, sample.expectedAny)
    results.push({
      id: sample.id,
      query: sample.query,
      inputBytes: Buffer.byteLength(prompt, 'utf8'),
      ...response.usage,
      ...score,
      answer: response.answer,
    })
  }
  return {
    schemaVersion: 1,
    provider,
    model,
    status: results.every((result) => result.pass) ? 'pass' : 'fail',
    sampleCount: results.length,
    passed: results.filter((result) => result.pass).length,
    inputTokens: results.reduce((sum, result) => sum + result.inputTokens, 0),
    outputTokens: results.reduce((sum, result) => sum + result.outputTokens, 0),
    results,
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const samplesPath = resolve(ROOT, args.samples ?? '.local/benchmark-results/recall-context-agent-samples-latest.json')
  const envPath = resolve(ROOT, args.env ?? '.env.persistent-memory')
  const outputPath = resolve(ROOT, args.output ?? '.local/benchmark-results/recall-context-agent-eval-latest.json')
  const source = JSON.parse(readFileSync(samplesPath, 'utf8'))
  if (source?.schemaVersion !== 1 || !Array.isArray(source?.samples) || source.samples.length === 0) {
    throw new Error('Agent sample input is missing or malformed.')
  }
  const result = await runAgentSamples({ samples: source.samples, env: parseDotEnv(readFileSync(envPath, 'utf8')) })
  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  process.stdout.write(`${outputPath}\n`)
  if (result.status !== 'pass') process.exitCode = 1
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
