/**
 * Offline benchmark runner: `npm run bench`.
 * Executes every scenario through the real orchestrator with deterministic fakes and writes
 * benchmark/results.json and benchmark/REPORT.md from the measured results.
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCENARIOS, type Scenario } from './scenarios.js';
import { MockSearchProvider, routeByKeyword, ScriptedLLM } from '../tests/helpers/fakes.js';
import { makeApp, seedConversation } from '../tests/helpers/harness.js';
import type { AgentEvent } from '../server/types.js';
import type { RunResult } from '../server/agent/orchestrator.js';
import { extractMoneyAmounts, nearlyEqual } from '../server/utils/text.js';
import { groundedAmounts } from '../server/agent/orchestrator.js';
import { sameEntity } from '../server/utils/entityNames.js';

interface Check {
  metric: string;
  pass: boolean;
  detail: string;
}
interface ScenarioResult {
  id: string;
  name: string;
  mandatory: boolean;
  pass: boolean;
  checks: Check[];
  latencyMs: number;
  toolCalls: number;
  budget: number;
  citations: number;
  officialCitations: number;
  citationsInResults: number;
  proposedClaims: number;
  rejectedClaims: number;
  removedByGuard: number;
  ungroundedAmountsInFinal: number;
  queries: string[];
  queriesMentioningTarget: number;
}

async function runScenario(s: Scenario): Promise<ScenarioResult> {
  const search = new MockSearchProvider(typeof s.search === 'function' ? s.search : routeByKeyword(s.search ?? {}));
  const llm = new ScriptedLLM({ claims: s.claims ?? [], understand: s.understand, synthesize: s.synthesize });
  const app = makeApp({ llm, search, config: s.config });
  for (const c of s.seed) seedConversation(app.repos, c);

  let convId: string | null = null;
  let last!: RunResult;
  let lastEvents: AgentEvent[] = [];
  const started = performance.now();
  let turnStart = started;
  for (const turn of s.turns) {
    const events: AgentEvent[] = [];
    turnStart = performance.now();
    last = await app.orchestrator.run({ conversationId: convId, message: turn, timezone: 'Asia/Kolkata', requestId: `bench-${s.id}`, signal: new AbortController().signal, emit: (e) => events.push(e) });
    convId = last.conversation.id;
    lastEvents = events;
  }
  const latencyMs = Math.round(performance.now() - turnStart);
  void started;
  const r = last;
  const e = s.expect;
  const checks: Check[] = [];
  const add = (metric: string, pass: boolean, detail: string) => checks.push({ metric, pass, detail });

  const content = r.assistantMessage.content;
  if (e.referencedTitles) {
    const got = (r.context?.referenced ?? []).map((x) => x.conversation.title);
    add('historical_retrieval', JSON.stringify(got) === JSON.stringify(e.referencedTitles), `expected ${JSON.stringify(e.referencedTitles)}, got ${JSON.stringify(got)}`);
  }
  if (e.timeLabel) {
    const label = r.understanding?.timeRefs[0]?.label ?? null;
    add('time_interpretation', label === e.timeLabel, `expected ${e.timeLabel}, got ${label}`);
  }
  if (e.targets) {
    const got = r.plan?.targetEntities ?? [];
    const tp = got.filter((g) => e.targets!.some((t) => sameEntity(t, g))).length;
    add('entity_extraction', tp === e.targets.length && got.length === e.targets.length, `expected ${e.targets.join(', ')}; got ${got.join(', ') || '(none)'}`);
  }
  if (e.changes) {
    for (const exp of e.changes) {
      const hit = r.changes.some((c) => sameEntity(c.entity, exp.entity) && c.changeType === exp.changeType);
      add('change_detection', hit, `${exp.entity}: expected ${exp.changeType}; got ${r.changes.filter((c) => sameEntity(c.entity, exp.entity)).map((c) => c.changeType).join(', ') || '(none)'}`);
    }
  }
  if (e.verdict !== undefined) add('verdict', r.verdict === e.verdict, `expected ${e.verdict}, got ${r.verdict}`);
  if (e.toolCalls !== undefined) add('tool_calls', r.toolCalls === e.toolCalls, `expected ${e.toolCalls}, got ${r.toolCalls}`);
  if (e.maxToolCalls !== undefined) add('tool_budget', r.toolCalls <= e.maxToolCalls, `${r.toolCalls} ≤ ${e.maxToolCalls}`);
  if (e.disambiguation !== undefined) add('disambiguation', !!r.assistantMessage.metadata.disambiguation === e.disambiguation, `expected ${e.disambiguation}`);
  for (const inc of e.contentIncludes ?? []) add('answer_content', content.includes(inc), `includes "${inc}"`);
  for (const exc of e.contentExcludes ?? []) add('answer_content', !content.includes(exc), `excludes "${exc}"`);
  if (e.rejectedAtLeast !== undefined) add('unsupported_rejection', r.rejected >= e.rejectedAtLeast, `rejected ${r.rejected} ≥ ${e.rejectedAtLeast}`);

  // Measured quality metrics (computed for every scenario)
  const sources = r.assistantMessage.metadata.sources ?? [];
  const returned = new Set(search.calls.length ? app.db.prepare('SELECT results_json FROM search_cache').all().flatMap((x: any) => JSON.parse(x.results_json).map((y: any) => y.url)) : []);
  const current = sources.filter((c) => c.sourceType !== 'historical_record');
  const allowed = r.context ? groundedAmounts(s.turns.at(-1)!, r.context, r.claims, r.changes) : [];
  const ungrounded = extractMoneyAmounts(content).filter((a) => !allowed.some((b) => nearlyEqual(a, b)));
  const queries = (r.assistantMessage.metadata.searchQueries ?? []) as string[];
  const targets = r.plan?.targetEntities ?? [];
  void lastEvents;

  const result: ScenarioResult = {
    id: s.id,
    name: s.name,
    mandatory: !!s.mandatory,
    pass: checks.every((c) => c.pass),
    checks,
    latencyMs,
    toolCalls: r.toolCalls,
    budget: s.config?.maxToolCalls ?? 4,
    citations: current.length,
    officialCitations: current.filter((c) => c.sourceType.startsWith('official')).length,
    citationsInResults: current.filter((c) => returned.has(c.url)).length,
    proposedClaims: r.claims.length + r.rejected,
    rejectedClaims: r.rejected,
    removedByGuard: (r.assistantMessage.metadata.removedUnsupported ?? []).length,
    ungroundedAmountsInFinal: ungrounded.length,
    queries,
    queriesMentioningTarget: queries.filter((q) => targets.some((t) => q.toLowerCase().includes(t.toLowerCase().split(' ')[0]!))).length,
  };
  app.db.close();
  return result;
}

const pct = (a: number, b: number) => (b === 0 ? 'n/a' : `${((100 * a) / b).toFixed(1)}%`);

async function main() {
  const results: ScenarioResult[] = [];
  for (const s of SCENARIOS) results.push(await runScenario(s));

  const byMetric = new Map<string, { pass: number; total: number }>();
  for (const r of results)
    for (const c of r.checks) {
      const m = byMetric.get(c.metric) ?? { pass: 0, total: 0 };
      m.total++;
      if (c.pass) m.pass++;
      byMetric.set(c.metric, m);
    }
  const sum = (f: (r: ScenarioResult) => number) => results.reduce((a, r) => a + f(r), 0);
  const searched = results.filter((r) => r.toolCalls > 0);
  const lat = results.map((r) => r.latencyMs).sort((a, b) => a - b);
  const p50 = lat[Math.floor(lat.length / 2)]!;
  const p95 = lat[Math.min(lat.length - 1, Math.ceil(lat.length * 0.95) - 1)]!;

  const summary = {
    executedAt: new Date().toISOString(),
    mode: 'offline (scripted model stages + synthetic search fixtures)',
    scenarios: results.length,
    passed: results.filter((r) => r.pass).length,
    mandatoryPassed: `${results.filter((r) => r.mandatory && r.pass).length}/${results.filter((r) => r.mandatory).length}`,
    metrics: Object.fromEntries([...byMetric].map(([k, v]) => [k, `${v.pass}/${v.total}`])),
    citationAccuracy: `${sum((r) => r.citationsInResults)}/${sum((r) => r.citations)} cited URLs were returned by web_search in the same request`,
    sourceQuality: `${sum((r) => r.officialCitations)}/${sum((r) => r.citations)} citations are official vendor sources`,
    searchRelevance: `${sum((r) => r.queriesMentioningTarget)}/${sum((r) => r.queries.length)} queries name a target entity (scenarios with targets)`,
    unsupportedClaimRate: `${sum((r) => r.rejectedClaims)} claims rejected by the verifier, ${sum((r) => r.proposedClaims - r.rejectedClaims)} kept after verification and de-duplication; ${sum((r) => r.removedByGuard)} statements/links removed by the output guard; ${sum((r) => r.ungroundedAmountsInFinal)} ungrounded amounts in final answers`,
    toolCallEfficiency: `${sum((r) => r.toolCalls)} searches across ${searched.length} searching scenarios (mean ${(sum((r) => r.toolCalls) / Math.max(1, searched.length)).toFixed(2)}); max per request ${Math.max(...results.map((r) => r.toolCalls))} (budget 4); ${results.filter((r) => r.toolCalls === 0).length} scenarios correctly needed none`,
    latency: `p50 ${p50} ms, p95 ${p95} ms (pipeline overhead only — no network or model latency)`,
  };
  const here = dirname(fileURLToPath(import.meta.url));
  writeFileSync(join(here, 'results.json'), JSON.stringify({ summary, results }, null, 2));

  const md: string[] = [];
  md.push('# ECHO benchmark report', '');
  md.push(`Generated by \`npm run bench\` on ${summary.executedAt}. **Mode:** ${summary.mode}.`, '');
  md.push(
    '> These numbers come from executing the real pipeline (memory retrieval, date resolution, query allocation, tool budget, verifier, change detector, output guard, persistence) on synthetic fixtures. Model stages are scripted, so they **do not** measure an LLM\'s extraction or writing quality, and latency excludes network/model time. A live evaluation requires API keys (see README).',
    '',
  );
  md.push('> Source quality and search relevance are largely properties of the fixtures and of the deterministic query allocator in this mode; they become informative only in a live run.', '');
  md.push('## Summary', '');
  md.push(`- Scenarios passed: **${summary.passed}/${summary.scenarios}** (mandatory benchmarks A/B/C: ${summary.mandatoryPassed})`);
  for (const [k, v] of Object.entries(summary.metrics)) md.push(`- ${k.replace(/_/g, ' ')}: ${v} checks passed`);
  md.push(`- Citation accuracy: ${summary.citationAccuracy}`);
  md.push(`- Source quality: ${summary.sourceQuality}`);
  md.push(`- Search relevance: ${summary.searchRelevance}`);
  md.push(`- Unsupported-claim handling: ${summary.unsupportedClaimRate}`);
  md.push(`- Tool-call efficiency: ${summary.toolCallEfficiency}`);
  md.push(`- Latency: ${summary.latency}`, '');
  md.push('## Scenarios', '');
  md.push('| ID | Scenario | Result | Searches | Citations (official) | Claims rejected / kept+rejected | Checks |');
  md.push('|---|---|---|---|---|---|---|');
  for (const r of results) {
    md.push(`| ${r.id}${r.mandatory ? ' ★' : ''} | ${r.name} | ${r.pass ? 'PASS' : '**FAIL**'} | ${r.toolCalls} | ${r.citations} (${r.officialCitations}) | ${r.rejectedClaims}/${r.proposedClaims} | ${r.checks.filter((c) => c.pass).length}/${r.checks.length} |`);
  }
  const failures = results.flatMap((r) => r.checks.filter((c) => !c.pass).map((c) => `- ${r.id} · ${c.metric}: ${c.detail}`));
  md.push('', '## Failed checks', '', failures.length ? failures.join('\n') : 'None.', '');
  md.push('★ = mandatory assignment benchmark.', '');
  writeFileSync(join(here, 'REPORT.md'), md.join('\n'));

  console.log(`\n${summary.passed}/${summary.scenarios} scenarios passed (mandatory ${summary.mandatoryPassed})`);
  for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.id.padEnd(4)} ${r.name}`);
  if (failures.length) console.log('\nFailed checks:\n' + failures.join('\n'));
  console.log('\nWrote benchmark/REPORT.md and benchmark/results.json');
  process.exit(results.every((r) => r.pass) ? 0 : 1);
}

void main();
