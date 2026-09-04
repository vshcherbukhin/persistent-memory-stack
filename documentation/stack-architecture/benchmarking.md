---
nav_title: Benchmarking
nav_group: stack-architecture
nav_group_title: Stack Architecture
nav_group_order: 30
nav_order: 80
---
# Persistent Memory Benchmark Design and Research

## Introduction

Modern agentic systems must maintain continuity across tasks and sessions.  Standard retrieval‑augmented generation (RAG) uses vector similarity to fetch document chunks at query time, but **it has no notion of time or relationships**, leading to fragmented context, redundancy and contradiction【657645698076909†L170-L174】.  Graph‑based retrieval (often called GraphRAG) enriches queries with a knowledge graph and supports multi‑hop reasoning【657645698076909†L177-L227】.  However, most GraphRAG implementations operate on static corpora – they build a graph once and perform batch summarization.  For interactive agents, memory must **evolve as conversations progress**, track the validity of facts over time, and support personalized contexts.  Zep’s **Graphiti** framework is designed for this purpose.  It constructs **context graphs** where each relationship carries temporal metadata (`created_at`, `valid_at`, `invalid_at`)【46946839607673†L150-L158】, supports **episodic ingestion** with provenance【46946839607673†L151-L156】, combines semantic, keyword and graph traversal search【46946839607673†L158-L160】, and automatically invalidates facts when a newer, conflicting event arrives【192312220048382†L353-L359】.  Graphiti’s hybrid retrieval achieves sub‑200 ms latency on benchmarks such as LoCoMo and LongMemEval【46946839607673†L170-L173】.

The **Persistent Memory** system described by the user adopts this graph‑first approach: a Postgres store holds metadata and job state, a Qdrant vector index stores embeddings, FalkorDB stores the graph (via Graphiti), and MinIO stores evidence.  For any non‑trivial task the agent must first call `recall_context(query, project)`, which performs graph‑based retrieval and returns memories, graph facts, timeline entries, contradictions and follow‑up identifiers.  Vector search alone (`search_memories`) is insufficient and may miss connections.  The goal of this benchmark is to validate that an agent **actually sees the memory picture**—not just isolated memories, but relationships, graph neighbourhoods, causality, temporal order, invalidated facts, and project/team/user scopes.

## Literature Survey

### Limitations of vector‑only memory

Several sources highlight the pitfalls of using only vector search as agent memory.  A blog from Memgraph explains that RAG retrieves isolated chunks and cannot infer relationships or temporal order【657645698076909†L170-L174】, leading to fragmented context and over‑retrieval.  The **Neural Maze** article shows that vector stores easily return contradictory facts – if a person’s address changes, both old and new addresses appear because the vector index lacks time semantics【713210926143042†L49-L116】.  A guide on graph‑based agent memory further notes that vector approaches cannot perform multi‑hop reasoning or detect causal chains【962900604568637†L52-L88】.  Collectively, these sources argue for explicit graph structures and temporal metadata.

### GraphRAG and temporal knowledge graphs

GraphRAG extends RAG by retrieving not only semantically similar passages but **connected context** from a knowledge graph.  A Memgraph article summarises key differences: GraphRAG uses a knowledge graph rather than a flat vector index, supports multi‑hop reasoning and relationship awareness, and can combine semantic, keyword and graph search【657645698076909†L170-L227】.  GoodData’s overview details the GraphRAG pipeline: indexing structured and unstructured data into triples with embeddings, analysing the query to identify key entities, querying the graph to find related nodes, then generating an answer from graph‑enriched context【816942023310639†L470-L519】.  The article stresses that GraphRAG is not a replacement for RAG but an evolution – vector search can provide entry points, while the graph provides deeper reasoning【657645698076909†L205-L227】.

Microsoft’s GraphRAG implementation focuses on **batch summarisation** of static corpora.  Graphiti, by contrast, is designed for **dynamic data**.  The Graphiti documentation emphasises temporal awareness (edges carry validity intervals and are invalidated when superseded), episodic processing with provenance, hybrid search and support for custom entity types【46946839607673†L150-L166】.  A comparison table shows that GraphRAG is primarily used for static document summarisation, whereas Graphiti handles continuous incremental updates, explicit bi‑temporal tracking and conflict resolution【46946839607673†L174-L188】.  A Neo4j blog explains that Graphiti’s bi‑temporal model tracks when a fact was observed and when it occurred; conflicts are resolved by updating or invalidating edges rather than discarding them【192312220048382†L353-L359】.  Query latency is kept low by combining semantic embeddings, BM25 search and graph traversal with no LLM calls at retrieval time【192312220048382†L369-L373】.

### Existing long‑term memory benchmarks

Benchmarks for memory systems vary widely.  **LongMemEval** tests information extraction, multi‑session reasoning, knowledge updates, temporal reasoning and abstention across chat histories up to 115 k tokens.  Its dataset includes 500 questions and categories such as single‑session, multi‑session, knowledge update and temporal reasoning【3410364952226†L274-L384】.  However, LongMemEval primarily evaluates recall of explicit facts from conversation transcripts; it does not test whether an agent can connect those facts into a coherent graph.

**BEAM (Beyond a Million Tokens)** pushes context length to millions of tokens and probes memory across ten dimensions (fact tracking, information updates, contradiction resolution, temporal order, etc.)【615664827917362†L17-L79】.  **Memora** introduces a simulation‑based benchmark for personalised agents spanning weeks to months.  It stresses memory consolidation and mutation: sessions introduce, update or delete memories, and tasks ask the agent to remember, reason and recommend.  To penalise use of obsolete memories, Memora proposes **Forgetting‑Aware Memory Accuracy (FAMA)**—a metric that rewards correct use of valid memory and penalises reliance on obsolete or deleted memory【277038165271171†L200-L232】.  Evaluations show that models frequently reuse obsolete information despite extended context windows【277038165271171†L200-L232】.

Other works explore reasoning over temporal knowledge graphs.  **TempAgent** integrates temporal constraints into retrieval for temporal knowledge graph question answering, achieving significant improvements over standard ReAct agents【427178122059899†L23-L40】.  A survey on **Temporal Knowledge Graph Reasoning (TKGR)** identifies techniques like dynamic graph neural networks, path‑memory reasoning and contrastive frameworks to infer missing or future facts【824235431013539†L40-L84】; these emphasise the difficulty of modelling evolving relationships.

### Evaluation metrics for retrieval‑augmented systems

Traditional NLP metrics like BLEU and ROUGE are insufficient for RAG because they do not consider whether the answer is grounded in the retrieved context.  The **RAGAS** framework introduces metrics such as *faithfulness* (factual accuracy given retrieved documents), *answer relevancy*, *context precision* (how much of the retrieved context is relevant) and *context recall*【832587206488703†L60-L106】.  RAGAS emphasises evaluating both retrieval quality and answer grounding【832587206488703†L122-L176】.  These ideas inspire our scoring rubric for persistent memory.

### Lessons learned

Research highlights several best practices for agent memory systems:

1. **Explicit time and provenance matter.**  Graphiti stores validity intervals and provenance episodes【46946839607673†L151-L156】 and invalidates outdated facts when new ones arrive【192312220048382†L353-L359】.  Benchmarks like Memora show that agents often reuse obsolete memory without penalties【277038165271171†L200-L232】, so evaluations should penalise such behaviour.
2. **Hybrid retrieval is essential.**  Combining vector search for entry points with graph search for relationships improves recall and reasoning【657645698076909†L170-L227】.  Graphiti’s hybrid search prevents LLM bottlenecks and achieves low latency【192312220048382†L369-L373】.
3. **Multi‑hop and temporal reasoning require dedicated tests.**  GraphRAG excels at multi‑hop queries, whereas RAG handles single‑hop factual queries better【484167017442911†L92-L116】.  Temporal reasoning benchmarks like TempAgent highlight the need to filter retrieval by time.【427178122059899†L23-L40】
4. **Benchmarks must account for updates and contradictions.**  Without temporal metadata, vector stores return outdated facts【713210926143042†L49-L116】.  FAMA penalises reliance on obsolete memory【277038165271171†L200-L232】.  Graphiti automatically invalidates edges when conflicts arise【192312220048382†L353-L359】.
5. **Project and user scoping ensures privacy and relevance.**  The persistent memory stack includes team/project/user namespaces.  Benchmarks should verify that the agent respects these scopes and does not leak unrelated information.

## Benchmark Taxonomy for Persistent Memory

The proposed benchmark tests whether an agent using Persistent Memory can recall and reason over a dynamic graph.  Each category focuses on a different capability:

| Capability | Goal | What to test |
|---|---|---|
| **Semantic recall** | Retrieve memories semantically related to the query using vector search. | Does the agent surface the most relevant memory chunks? |
| **Graph relationship recall** | Recall direct relationships (edges) between entities. | When asked “Who manages Project X?”, does the agent recall the direct *manages* relation? |
| **Multi‑hop relationship recall** | Traverse multiple edges to infer indirect connections. | For example, “Which supplier affects delivery delays?” requiring *Project → Part → Supplier* reasoning. |
| **Entity neighborhood expansion** | Expand from a seed entity to its neighbourhood. | Given an entity, the agent should retrieve adjacent facts and entities without being asked explicitly. |
| **Temporal ordering** | Respect the order of events and update operations. | Can the agent identify the latest address, or describe the sequence of assignments? |
| **Contradiction / supersession handling** | Identify when an older fact is invalidated by a newer one. | When two memories conflict, the agent should note that one is superseded and avoid using it. |
| **Project/team/user scoping** | Respect namespace boundaries. | Agents should only access memories within the specified project/team and should not leak cross‑project data. |
| **Update/delete/import lifecycle** | Verify that create, update, delete and import operations are reflected in the graph and that outdated data is invalidated. | When a memory is updated, the old fact should be marked invalid and not surfaced as current. |
| **Evidence/file provenance** | Retrieve evidence files associated with memories and mention their origin. | The agent should cite the source of information (e.g., file name or episode ID) in its answer. |
| **Tool‑protocol compliance** | Ensure the agent calls tools correctly (`tool_search` for schemas and `recall_context` for memory). | Agents should not rely solely on `search_memories` and must begin with `recall_context`.

Each benchmark instance will combine multiple capabilities, forcing the agent to reason over graph structure and time.

## Seed Dataset

The benchmark includes a **seed dataset** of memories intentionally engineered to exercise the taxonomy.  It comprises 9 memory items (M1–M9) stored under a project `demo_project` and includes six entities: **Alice**, **Bob**, **Charlie**, **Marketing**, **Sales**, **Widget**.  Memories contain structured metadata (id, timestamp, actor, content) and unstructured content for embedding.  The data includes:

1. **M1 (2026‑05‑01)**: Alice joins the **Marketing** team and is assigned to the **Widget** product.  (Entities: Alice, Marketing, Widget).
2. **M2 (2026‑05‑15)**: **Bob** joins Marketing to assist Alice on Widget.  (Entities: Bob, Marketing, Widget).
3. **M3 (2026‑06‑10)**: **Alice** moves from Marketing to the **Sales** team.
4. **M4 (2026‑06‑12)**: The **Widget** product is delayed because Supplier Z is late.  (Entities: Widget, Supplier Z).
5. **M5 (2026‑07‑01)**: **Charlie** is hired to replace Alice in Marketing and inherits the Widget project.
6. **M6 (2026‑07‑15)**: Sales team celebrates record Q2 revenue; includes Alice’s contribution.
7. **M7 (2026‑07‑20)**: An update states that Supplier Z delivered the missing parts and the Widget delay is resolved.  This **invalidates** the “delay” fact from M4.
8. **M8 (2026‑08‑01)**: Alice changes her surname to *Alice Smith*.  (Name update).
9. **M9 (2026‑08‑05)**: **Distractor** memory: another project describes a *Widgeon* product, with a similar name but unrelated.  This item is semantically similar to “Widget” but stored under a different project (`other_project`) and therefore graph‑disconnected.

These memories yield over ten graph facts:

* `Alice -> member_of -> Marketing` (valid from 2026‑05‑01 to 2026‑06‑10).
* `Alice -> member_of -> Sales` (valid from 2026‑06‑10 onwards).
* `Bob -> member_of -> Marketing` (ongoing).
* `Charlie -> member_of -> Marketing` (from 2026‑07‑01).
* `Alice -> works_on -> Widget` (start 2026‑05‑01; end 2026‑06‑10).
* `Bob -> works_on -> Widget` (from 2026‑05‑15).
* `Charlie -> works_on -> Widget` (from 2026‑07‑01).
* `Widget -> delayed_by -> Supplier Z` (valid 2026‑06‑12 to 2026‑07‑20).
* `Widget -> normal_status -> Supplier Z` (valid from 2026‑07‑20).
* `Alice -> has_name -> Alice Smith` (valid from 2026‑08‑01; invalidates previous name).
* `Widgeon` is unrelated and appears only in M9.

Two **multi‑hop paths** illustrate indirect reasoning:

1. `Bob → works_on → Widget → delayed_by → Supplier Z` — the agent must infer that Bob’s project is delayed due to Supplier Z.
2. `Alice (now in Sales) → previously member_of → Marketing → works_on → Widget` — the agent should find that she previously worked on Widget despite moving teams.

**Time‑ordered changes** include Alice’s team change and the resolution of the Widget delay.  **Contradiction** arises because M4 asserts that Widget is delayed while M7 asserts the delay has been resolved.  **Deletion/update case** is M8 where Alice’s surname changes; the previous `has_name` edge becomes invalid.

## Expected Graph Truth Table

The table below summarises the ground truth for each fact.  Validity intervals follow the Graphiti convention (`valid_at`, `invalid_at`).  For brevity, timestamps are expressed as ISO dates.

| Fact (subject→relation→object) | valid_at | invalid_at | Nearest memories | Graph expansions | Contradictions/Supersession |
|---|---|---|---|---|---|
| Alice → member_of → Marketing | 2026‑05‑01 | 2026‑06‑10 | M1 | Expand to Widget via **works_on**; expand to Bob via shared team | superseded by Alice → member_of → Sales |
| Alice → member_of → Sales | 2026‑06‑10 | — | M3 | Expand to Sales team events (M6) | — |
| Bob → member_of → Marketing | 2026‑05‑15 | — | M2 | Expand to Widget via works_on; expand to Alice/Charlie via team | — |
| Charlie → member_of → Marketing | 2026‑07‑01 | — | M5 | Expand to Widget via works_on | — |
| Alice → works_on → Widget | 2026‑05‑01 | 2026‑06‑10 | M1 | Expand to Supplier Z via Widget delay; expand to Bob via shared project | superseded by Charlie working on Widget |
| Bob → works_on → Widget | 2026‑05‑15 | — | M2 | Expand to Supplier Z via Widget delay/resolution | — |
| Charlie → works_on → Widget | 2026‑07‑01 | — | M5 | Expand to Supplier Z via Widget status | — |
| Widget → delayed_by → Supplier Z | 2026‑06‑12 | 2026‑07‑20 | M4 | Expand to Alice and Bob via works_on; expand to Marketing via team | contradicted by Widget → normal_status → Supplier Z |
| Widget → normal_status → Supplier Z | 2026‑07‑20 | — | M7 | Expand to same as above | supersedes the previous delay fact |
| Alice → has_name → Alice Smith | 2026‑08‑01 | — | M8 | Expand to Sales team; previous name is invalid | supersedes previous name |

The **distractor** memory M9 (Widgeon) is not part of this table; any question about Widget should not include Widgeon because it belongs to a different project and is graph‑disconnected.

## Agent Benchmark Prompts

The benchmark uses two evaluation prompts tailored for different agent runtimes (Codex and Claude).  Each prompt must force the agent to use persistent memory correctly: load schema via `tool_search` if necessary, call `recall_context` first, then reason over the graph.  The agent should enumerate retrieved memories, explain graph connections, timelines, contradictions, and acknowledge uncertainties.

### Prompt for Codex (ModelContextProtocol)

```
Your task is to answer questions about project `demo_project` using the persistent-memory tools.  **First**, call `tool_search` to load any deferred persistent-memory MCP schemas.  **Next**, call `recall_context(query, project="demo_project")` with your natural‑language query.  Do **not** rely on `search_memories` alone.  Analyse the returned memories and graph facts: list the relevant entities, relationships, timestamps, and any contradictions (facts invalidated by newer information).  Use this information to answer the question.  If you see a contradicting fact (e.g., an outdated delay), explain which fact is superseded.  If any required information is missing, explicitly state that it is unknown rather than hallucinating.  Finally, provide a concise answer grounded in the retrieved context and cite the memory IDs.

Question: **Who currently works on the Widget product and why was the project previously delayed?  Also, what team is Alice now part of and when did she leave Marketing?**
```

This prompt checks semantic recall (find memories about Widget), graph relationship recall (works_on edges), multi‑hop reasoning (identify Supplier Z via Widget), temporal ordering (resolve current vs past delay), contradiction handling (note that delay was resolved), and timeline queries about Alice’s team change.

### Prompt for Claude (Anthropic)

```
You are assisting with project `demo_project`.  Before answering, call `recall_context` (after loading schemas if needed) to obtain the relevant memory graph.  Use the graph connections, timelines and contradiction indicators to answer the following.

Prompt: **List the members of the Marketing team over time and describe any hand‑overs on the Widget project.  Explain why Supplier Z is mentioned and whether that fact is still valid.  If a fact has been superseded, identify the new fact.**

Instructions:
1. Use `recall_context` to fetch the context for the above query.
2. Inspect the returned graph: note entities, relationships and `valid_at`/`invalid_at` timestamps.
3. Identify multi‑hop paths (e.g., team → project → supplier).
4. When writing your answer, explain the temporal sequence and mention any superseded facts.
5. Do not include information outside the `demo_project` scope.  If something is uncertain, say so explicitly.
```

This prompt evaluates graph expansion (Marketing → Widget → Supplier Z), temporal ordering, contradiction detection and scope enforcement.

## Automated Test Design

### P0 token-economics regression suite

The measured before/after results for the 4.0.34 release are published in the
[4.0.34 Token Economics Report](../benchmark_reports/4.0.34-token-economics.md).

The release harness also runs a before/after regression suite against clean,
separately named disposable stacks. Its evidence is written under
`.local/benchmark-results/` and is intentionally not committed. The suite measures:

- result bytes and `js-tiktoken` estimates for 24 recall queries (p50, p95, max,
  and total), unique/duplicate fact occupancy, previews, omissions, and dangling
  references;
- expected-memory hit rate, mean reciprocal rank, project leakage, and six real
  agent answers that cover temporal state, contradictions, multi-hop relations,
  and abstention on the cross-project distractor;
- model usage by update operation, distinguishing exact no-op, session-only, same
  project, identical metadata, metadata-only, and real content changes;
- the isolated integration suite and disposable-stack cleanup evidence.

The comparison fails unless recall stays at 24/24 with zero scope leaks and no
dangling references, the agent sample stays 6/6, hit rate remains 100%, MRR does
not fall, p95 stays within 16 KiB, max stays within 24 KiB, recall bytes fall at
least 40%, estimated tokens at least 35%, duplicate-fact bytes at least 80%, and
agent input tokens at least 35%. MRR must remain at least 0.80 and within 0.03 of
the baseline; this keeps one-query rank jitter visible without equating a rank
1-to-2 fluctuation with lost evidence. Exact/same-value/session-only updates must use
zero model tokens; metadata-only updates must validate but skip embeddings and
Graphiti; content changes must retain both embedding and graph work.

After producing baseline and after evidence with
`scripts/run-system-health-benchmark.mjs`, run:

```bash
node scripts/p0-token-quality-comparison.mjs
```

This writes `p0-token-quality-comparison.json` and `.md` and exits non-zero when
any quality, isolation, budget, or update-routing gate regresses.

### Seeding the dataset

1. **Create memories via API/MCP:**  Use the API service to `createMemory` for each memory (M1–M9) under the correct project and actor.  Provide timestamps and metadata so Graphiti can build edges with validity intervals.  For M7, supply metadata indicating it updates/resolves the earlier delay; for M8, mark it as an update to the previous `has_name` fact.  For M9, set the project to `other_project`.
2. **Wait for sync:**  Because embeddings and graph updates are asynchronous, wait for the worker service to process jobs.  Poll the job state in Postgres or wait until `search_memories` returns the vector and `recall_context` returns the graph facts.  In tests, add a retry loop with exponential back‑off.
3. **Verify ingestion:**  After seeding, call `recall_context("Widget status", project="demo_project")` to confirm that edges and validity windows appear as expected.  Ensure that `Widget → delayed_by → Supplier Z` is marked `invalid_at=2026-07-20` after M7.

### Test scenarios

Use a testing framework like **Vitest** in TypeScript.  Each test case should spin up a fresh project namespace to avoid contamination.  Suggested structure:

```ts
import { createMemory, recallContext, deleteMemory } from "persistent-memory-sdk";

describe("Persistent Memory Benchmark", () => {
  beforeAll(async () => {
    // seed memories M1–M9
  });
  afterAll(async () => {
    // clean up: delete project or individual memories
  });

  test("graph recall vs vector recall", async () => {
    const vectorResults = await searchMemories({ query: "Widget", project: "demo_project" });
    const graphResults = await recallContext({ query: "Widget", project: "demo_project" });
    // assert that graphResults include relationships and entities beyond vectorResults
    expect(graphResults.entities).toContain("Supplier Z");
    expect(graphResults.facts.find(f => f.relation === "delayed_by")).toBeDefined();
  });

  test("temporal ordering and supersession", async () => {
    const ctx = await recallContext({ query: "Widget delay", project: "demo_project" });
    const delay = ctx.facts.find(f => f.relation === "delayed_by");
    const normal = ctx.facts.find(f => f.relation === "normal_status");
    expect(delay.invalid_at).toBe("2026-07-20");
    expect(normal.valid_at).toBe("2026-07-20");
  });

  test("multi-hop reasoning", async () => {
    const ctx = await recallContext({ query: "Bob and Supplier Z", project: "demo_project" });
    // The graph should reveal Bob→Widget→Supplier Z path
    const hasPath = ctx.paths.some(p => p.includes("Bob") && p.includes("Supplier Z"));
    expect(hasPath).toBe(true);
  });

  test("scope enforcement", async () => {
    const ctx = await recallContext({ query: "Widgeon", project: "demo_project" });
    // Widgeon belongs to other_project, so there should be no results
    expect(ctx.memories.length).toBe(0);
  });
});
```

### Cleaning up

After each test suite, remove all seeded memories or delete the project namespace via the API.  This ensures that subsequent runs start from a clean slate and prevents interference across tests.

## Scoring Rubric

Evaluation should combine **pass/fail checks** for tool usage and graph retrieval, plus graded quality dimensions.  Suggested metrics:

| Metric | Description | Scoring |
|---|---|---|
| **Tool Protocol Compliance** | Did the agent call `recall_context` (and `tool_search` if needed) before answering? | Pass/fail.  Fail if the agent only uses `search_memories` or omits graph retrieval. |
| **Semantic Recall** | Fraction of relevant memories retrieved. | Acceptable ≥90%.  Computed as context recall (RAGAS) between returned memories and ground truth. |
| **Graph Relationship Recall** | Fraction of relevant edges (facts) returned in the graph context. | Acceptable ≥85%.  The agent must mention at least one multi‑hop connection when the question requires it. |
| **Temporal Accuracy** | Correct identification of the latest valid fact vs obsolete ones. | Acceptable ≥90%.  Penalties for citing invalidated facts.  Use FAMA‑like weighting: if the answer uses an outdated fact, apply a penalty. |
| **Contradiction Handling** | Does the agent explicitly note when a fact has been superseded? | Qualitative: score 2 (excellent) if contradictions are explicitly explained, 1 if mentioned but not explained, 0 if ignored. |
| **Scope Respect** | Does the agent avoid using data outside the specified project/team/user? | Pass/fail.  Any leakage fails. |
| **Explanation Quality** | Clarity and completeness of the agent’s answer. | Rate from 0–5.  Agents should list entities, relationships, and times and mention unknowns. |

**Failure categories**: (1) *Vector‑only retrieval*: The agent claims to recall memory but only returns isolated memories. (2) *Missing connections*: The agent omits multi‑hop relationships present in the graph. (3) *Temporal error*: The agent mixes outdated and current facts without noting supersession. (4) *Protocol violation*: The agent does not call `recall_context`. (5) *Scope leak*: The agent answers using data from another project (e.g., Widgeon). (6) *Hallucination*: The agent fabricates facts not present in the memory graph or evidence files.

Scores can be aggregated into an overall grade.  For example, require that **protocol compliance**, **scope respect** and **temporal accuracy** must all pass; otherwise the agent fails.  For graded metrics, compute a weighted average, with higher weight on temporal accuracy and contradiction handling.  Agents must meet minimum thresholds (e.g., average ≥80%) to pass the benchmark.

## Golden Benchmark Prompt

To perform a final evaluation, a “golden benchmark prompt” synthesises multiple tasks and requires the agent to demonstrate full memory comprehension.  This prompt should be run in a fresh session with no prior context.  It tests retrieval, graph expansion, multi‑hop reasoning, temporal ordering, contradiction handling, scope enforcement and evidence provenance.

```
You are a knowledge‑based agent assisting with project `demo_project`.  You have access to persistent-memory tools.  **Follow these steps carefully**:
1. Call `tool_search` to load any deferred persistent-memory schemas.
2. Call `recall_context(query, project="demo_project")` with the query below.
3. Examine the returned memories and graph facts.  Identify entities, relationships (including multi‑hop paths), and `valid_at`/`invalid_at` timestamps.  Detect any contradictions where a fact has been invalidated by a newer fact.
4. Use the evidence (memory IDs and file references) to ground your answer.  If some information is missing, say so explicitly.
5. Compose a detailed answer describing current and historical states, the timeline of changes, and any superseded facts.  Respect project scopes and do not include unrelated data.

Query: **Provide a chronological narrative of the Widget product within `demo_project`: who has worked on it, which teams they belonged to at each stage, any delays and their resolutions, and any changes in the participants’ names or roles.  Explain any contradictions or superseded facts and cite the memory IDs used.**
```

This golden prompt requires the agent to:

* Retrieve all memories and graph facts related to Widget (M1–M7, M8).
* Expand the graph to find team memberships, supplier relationships and name changes.
* Identify that the delay announced in M4 was resolved in M7 and should not be considered current.
* Note that Alice’s surname changed in M8 and that her membership in Marketing is invalid after 2026‑06‑10.
* Exclude the distractor memory M9 (other project).
* Provide a timeline and mention uncertainties (e.g., if any memory is missing).
* Use memory IDs in citations.

## Conclusion

This benchmark plan draws on the latest research in agent memory, graph retrieval, temporal reasoning and evaluation metrics.  It leverages Graphiti’s capabilities—bi‑temporal tracking, episodic ingestion, hybrid search and conflict resolution—to build a realistic test of an agent’s **memory comprehension**.  By seeding a dataset with updates, deletions, contradictions and multi‑hop relationships, and designing prompts that force agents to call `recall_context` and examine graph connections, the benchmark can detect whether an agent merely retrieves isolated memories or genuinely understands the evolving memory graph.  The scoring rubric combines RAGAS‑style retrieval metrics with FAMA‑like penalties for outdated facts and ensures that agents adhere to tool protocols and privacy scopes.  A golden prompt synthesises the tasks into a comprehensive evaluation.  This design is practical to implement on the current stack and will surface the key failure modes that vector‑only approaches miss.
