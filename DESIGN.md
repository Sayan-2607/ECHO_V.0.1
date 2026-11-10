# ECHO — Design

## 1. Architecture
A single Node/TypeScript process (Express + SQLite via better-sqlite3) serves a React/Vite client and streams agent runs over SSE. Layers are separate modules with one-way dependencies: `routes → agent/orchestrator → {memory, search, comparison, llm} → database/repositories`. External dependencies (LLM, search provider, clock, sleep) are injected in `createApp`, which is why the full pipeline runs in tests without keys or network. The model interface is OpenAI-compatible chat completions (JSON mode + streaming), so another provider is a base-URL change.

## 2. Reasoning pipeline
A **controlled pipeline**, not a free-form tool loop: `UNDERSTAND → RETRIEVE → PLAN/DECIDE → SEARCH → EVALUATE → GAPS → (SEARCH AGAIN) → VERIFY → COMPARE → SYNTHESIZE → DELIVER`. The LLM is used where language judgement is needed (intent/entities, query writing, claim extraction, prose, memory extraction); everything that must be *correct* is code: date arithmetic (`timeResolver`, Luxon, conversation timezone), retrieval, query allocation under the budget, verification, confidence, change detection, verdicts, citation/link/amount guards. Each stage emits SSE events only when it actually runs, which is what the UI shows. Round-1 searches run in parallel; the gap round is sequential because it depends on round-1 evidence. The run is bounded by `MAX_TOOL_CALLS` (enforced inside the tool), a per-search timeout with ≤2 retries on transient errors only, and a whole-request deadline.

## 3. Memory
Two levels in SQLite. **Raw**: every message with timestamp and `reply_to` (question→answer link), FTS5-indexed. **Structured**: entities (with relation *shortlisted/decided/researched/mentioned*), `memory_facts` (stated vs inferred), `research_snapshots` (attribute values with source URL, quote, observation time, origin), and a running summary — all with message provenance. Extracted items are kept only if their evidence text is found in the message they claim to come from; assistant-derived facts are always "inferred". Retrieval is targeted: a resolved date range becomes a SQL filter; inside it, candidates are ranked by topic-term and entity overlap; without a date, FTS + entity joins. Output is rendered under a token budget. This works because the benchmark questions are *anchored* (a date, a topic, named products) — exact filters beat semantic similarity there and are explainable. A vector store was rejected until a test shows paraphrase recall failing.

## 4. One external tool
`web_search(query)` (Tavily) is the only tool. Memory is an internal capability the orchestrator calls deterministically, not something the model chooses to call. Fewer tools means fewer failure modes, a budget that is easy to enforce, and a smaller prompt-injection surface (no browsing, no follow-the-link). Cost: snippets/page extracts from one provider are the only evidence; pages Tavily cannot extract are invisible.

## 5. Historical comparison
Every verified claim becomes a snapshot keyed by a **comparability key**: entity · category · plan · billing period · unit · region · currency. Comparison happens only on equal keys, so different tiers or billing periods are never compared (a near-match where one side omitted billing is compared at *low* confidence and labelled). Missing history ⇒ `baseline_unavailable`; missing evidence ⇒ `not_verified` (absence is never treated as "unchanged"). Events (launches, API/policy changes) count only if dated after the baseline; undated ones are low confidence; "coming soon/preview" text downgrades *released* to *announced*. Promotional prices never count as list-price changes. The comparison table in the UI is rendered from these records, not from model prose.

## 6. Evidence verification
The extractor must return a verbatim quote and a source id per claim. The verifier accepts a claim only if the id is a result returned in this request, the quote occurs in that result's text, a price's number occurs in the quote, the quote is not instruction-like text, and the entity is a research target. Confidence is computed from source type (official pricing/docs/changelog > announcements > publications > aggregators > community), directness, staleness and promo flags. Conflicts on a key keep the highest-priority source and disclose the others. After writing, a guard removes citations to non-existent sources, links not among the sources, and sentences with money amounts not grounded in evidence, memory, the user's message or simple derivations (deltas, × quantities, ×12).

## 7. Alternatives rejected
- **Free-form function-calling loop**: flexible, but harder to bound, test and explain; stages here are explicit and individually testable.
- **Vector DB / embeddings for memory**: no demonstrated need for anchored questions; adds a dependency and non-determinism.
- **LLM-computed dates / LLM-judged changes**: unreliable at calendar math and number comparison.
- **Redis/queues/microservices**: one user, one process; SQLite WAL suffices.

## 8. Known limitations
- Single-user: no auth or per-user isolation; any conversation can be referenced from any other.
- Grounding is lexical: a quote can exist in a page yet be about a different plan; numbers are checked, semantics are not.
- Entity matching is name-based (e.g. "Salesforce Sales Cloud" vs "Salesforce" merge; distinct products sharing a prefix may too).
- Over-budget comparisons (e.g. 5 products, 4 calls) share a query and often leave items "not verified".
- The money guard can drop a correct sentence that uses a figure the guard cannot derive.
- Benchmarks run offline with scripted model stages; they validate the engine, not a model's extraction quality. No live-model evaluation has been run.

## 9. Next week
Live evaluation harness against a pinned model with recorded search results; page-level fetching inside `web_search` for official pricing pages; per-plan structured pricing extraction with unit normalisation (per-seat vs flat, currency conversion); user accounts; semantic retrieval as a fallback only when keyword/entity retrieval returns nothing; scheduled re-checks of saved research.
