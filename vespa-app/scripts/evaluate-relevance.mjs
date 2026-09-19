#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const scriptDirectory = new URL(".", import.meta.url).pathname;
const defaults = {
  endpoint: process.env.VESPA_ENDPOINT ?? "http://127.0.0.1:8080",
  fixtures: resolve(scriptDirectory, "../tests/relevance/memory-cases.json"),
};

function usage() {
  console.error("Usage: evaluate-relevance.mjs [--endpoint URL] [--fixtures PATH] [--output PATH]");
  process.exit(64);
}

function parseArguments(argumentsList) {
  const options = { ...defaults };
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--endpoint") options.endpoint = argumentsList[++index] ?? usage();
    else if (argument === "--fixtures") options.fixtures = resolve(argumentsList[++index] ?? usage());
    else if (argument === "--output") options.output = resolve(argumentsList[++index] ?? usage());
    else if (argument === "--help") usage();
    else usage();
  }
  return options;
}

function percentile(values, fraction) {
  if (values.length === 0) return 0;
  return [...values].sort((left, right) => left - right)[Math.ceil(values.length * fraction) - 1];
}

function dcg(ids, grades, k) {
  return ids.slice(0, k).reduce((total, id, index) => {
    const grade = grades.get(id) ?? 0;
    return total + ((2 ** grade - 1) / Math.log2(index + 2));
  }, 0);
}

function ndcg(ids, grades, k) {
  const ideal = [...grades.entries()].sort((left, right) => right[1] - left[1]).map(([id]) => id);
  const idealScore = dcg(ideal, grades, k);
  return idealScore === 0 ? 0 : dcg(ids, grades, k) / idealScore;
}

async function query(endpoint, profile, queryText, scopeId) {
  const parameters = new URLSearchParams({
    queryProfile: profile,
    query: queryText,
    namespace_id: "acme",
    scope_id: scopeId,
    "input.query(query_embedding)": `embed(e5, ${JSON.stringify(queryText)})`,
  });
  const startedAt = performance.now();
  const response = await fetch(`${endpoint.replace(/\/$/, "")}/search/?${parameters}`);
  const latencyMs = performance.now() - startedAt;
  const body = await response.json().catch(() => undefined);
  if (!response.ok) throw new Error(`${profile} query failed with HTTP ${response.status}: ${JSON.stringify(body)}`);
  const hits = Array.isArray(body?.root?.children) ? body.root.children.filter((hit) => hit?.fields?.memory_id) : [];
  return { hits, latencyMs };
}

function verifyScopeAndForbidden(caseDefinition, hits) {
  for (const hit of hits) {
    if (hit.fields.scope_id !== caseDefinition.scope_id) {
      throw new Error(`${caseDefinition.id}: scope leakage returned ${hit.fields.memory_id} from ${hit.fields.scope_id}.`);
    }
    if (caseDefinition.forbidden_ids?.includes(hit.fields.memory_id)) {
      throw new Error(`${caseDefinition.id}: forbidden memory ${hit.fields.memory_id} was returned.`);
    }
  }
}

async function evaluateProfile(endpoint, profile, cases, k) {
  const measurements = [];
  let recallTotal = 0;
  let ndcgTotal = 0;
  for (const caseDefinition of cases) {
    const { hits, latencyMs } = await query(endpoint, profile, caseDefinition.query, caseDefinition.scope_id);
    verifyScopeAndForbidden(caseDefinition, hits);
    const ids = hits.map((hit) => hit.fields.memory_id);
    const grades = new Map(caseDefinition.relevant.map((entry) => [entry.memory_id, entry.grade]));
    const relevantIds = [...grades.keys()];
    recallTotal += relevantIds.filter((id) => ids.slice(0, k).includes(id)).length / relevantIds.length;
    ndcgTotal += ndcg(ids, grades, k);
    measurements.push({ id: caseDefinition.id, latency_ms: Number(latencyMs.toFixed(1)), ids });
  }
  return {
    recall_at_k: Number((recallTotal / cases.length).toFixed(4)),
    ndcg_at_k: Number((ndcgTotal / cases.length).toFixed(4)),
    mean_latency_ms: Number((measurements.reduce((total, measurement) => total + measurement.latency_ms, 0) / measurements.length).toFixed(1)),
    p95_latency_ms: Number(percentile(measurements.map((measurement) => measurement.latency_ms), 0.95).toFixed(1)),
    cases: measurements,
  };
}

async function verifySupersededProminence(endpoint, checks) {
  const results = [];
  for (const check of checks) {
    const { hits } = await query(endpoint, check.profile, check.query, check.scope_id);
    const active = hits.find((hit) => hit.fields.memory_id === check.active_id);
    const superseded = hits.find((hit) => hit.fields.memory_id === check.superseded_id);
    if (!active || !superseded) throw new Error(`superseded check did not return both ${check.active_id} and ${check.superseded_id}.`);
    const ratio = superseded.relevance / active.relevance;
    if (ratio > check.max_relevance_ratio) {
      throw new Error(`superseded prominence ${ratio.toFixed(4)} exceeds ${check.max_relevance_ratio} for ${check.superseded_id}.`);
    }
    results.push({ active_id: check.active_id, superseded_id: check.superseded_id, relevance_ratio: Number(ratio.toFixed(4)) });
  }
  return results;
}

const options = parseArguments(process.argv.slice(2));
const fixture = JSON.parse(await readFile(options.fixtures, "utf8"));
if (!Array.isArray(fixture.cases) || fixture.cases.length === 0 || !Array.isArray(fixture.profiles)) {
  throw new Error("Evaluation fixture requires non-empty cases and profiles arrays.");
}

const report = {
  fixture_version: fixture.version,
  endpoint: options.endpoint,
  k: fixture.k,
  profiles: Object.fromEntries(await Promise.all(fixture.profiles.map(async (profile) => [profile, await evaluateProfile(options.endpoint, profile, fixture.cases, fixture.k)]))),
  superseded_prominence: await verifySupersededProminence(options.endpoint, fixture.superseded_checks ?? []),
  safety_checks: { scope_leakage: 0, forbidden_memory_hits: 0 },
};
const output = `${JSON.stringify(report, null, 2)}\n`;
if (options.output) await writeFile(options.output, output);
process.stdout.write(output);
