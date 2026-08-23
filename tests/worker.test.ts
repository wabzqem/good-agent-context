import { describe, expect, it } from "vitest";
import { createWorker, type Env } from "../apps/worker/src/index";

const env: Env = {
  LOCAL_DEVELOPMENT: "true",
  DEVELOPMENT_AUTH_TOKEN: "local-token",
  NAMESPACE_ID: "acme",
  VESPA_ENDPOINT: "http://vespa.test:8080",
};

function memory(memory_id: string, overrides: Record<string, unknown> = {}) {
  return {
    memory_id,
    revision: 1,
    namespace_id: "acme",
    scope_id: "capability:payments",
    scope_kind: "capability",
    kind: "architecture",
    title: "Gateway owns agent authentication",
    body: "Coding agents call the authenticated gateway instead of Vespa.",
    tags: ["gateway"],
    source_paths: [],
    created_at: 1770000000,
    updated_at: 1770000000,
    status: "active",
    supersedes_ids: [],
    derived_from_memory_ids: [],
    useful_count: 0,
    last_useful_at: 0,
    content_hash: "sha256:test",
    ...overrides,
  };
}

function fakeVespa(initial: Record<string, Record<string, unknown>>) {
  const records = new Map(Object.entries(initial));
  const requests: Array<{ url: URL; init?: RequestInit }> = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
    requests.push({ url, init });
    if (url.pathname.startsWith("/document/v1/gac/scope/")) return new Response("{}", { status: 404 });
    if (url.pathname === "/search/") {
      const children = [...records.values()]
        .filter((fields) => fields.namespace_id === "acme" && fields.scope_id === "capability:payments" && fields.status !== "withdrawn")
        .map((fields, index) => ({ relevance: 1 - index * 0.1, fields: { ...fields, matchfeatures: { lifecycle_weight: fields.status === "superseded" ? 0.03 : 1 } } }));
      return Response.json({ root: { children } });
    }
    const id = decodeURIComponent(url.pathname.split("/").at(-1)!);
    const existing = records.get(id);
    if (init?.method === "POST") {
      const payload = JSON.parse(String(init.body)) as { fields: Record<string, unknown> };
      records.set(id, payload.fields);
      return Response.json({ pathId: id });
    }
    if (init?.method === "PUT") {
      if (!existing) return new Response("{}", { status: 404 });
      const payload = JSON.parse(String(init.body)) as { fields: Record<string, { increment?: number; assign?: unknown }> };
      for (const [field, update] of Object.entries(payload.fields)) {
        if (update.increment !== undefined) existing[field] = Number(existing[field] ?? 0) + update.increment;
        if (update.assign !== undefined) existing[field] = update.assign;
      }
      return Response.json({ pathId: id });
    }
    if (existing) return Response.json({ fields: existing });
    return new Response("{}", { status: 404 });
  };
  return { fetch: fetch as typeof fetch, records, requests };
}

function request(path: string, method = "GET", body?: unknown, authorized = true): Request {
  return new Request(`https://api.example${path}`, {
    method,
    headers: { ...(authorized ? { authorization: "Bearer local-token" } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("Good Agent Context Worker", () => {
  it("requires a local bearer token before reading", async () => {
    const vespa = fakeVespa({});
    const worker = createWorker({ fetch: vespa.fetch });
    const response = await worker.fetch(request("/v1/recall", "POST", { query: "gateway", scope_id: "capability:payments" }, false), env);
    expect(response.status).toBe(401);
  });

  it("fails closed when production Access JWT verification is not configured", async () => {
    const vespa = fakeVespa({});
    const worker = createWorker({ fetch: vespa.fetch });
    const response = await worker.fetch(
      new Request("https://api.example/v1/recall", { method: "POST", body: JSON.stringify({ query: "gateway", scope_id: "capability:payments" }) }),
      { ...env, LOCAL_DEVELOPMENT: "false", DEVELOPMENT_AUTH_TOKEN: undefined },
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "authentication_not_configured" } });
  });

  it("injects fixed Vespa recall parameters instead of accepting YQL", async () => {
    const vespa = fakeVespa({ "mem-gateway": memory("mem-gateway") });
    const worker = createWorker({ fetch: vespa.fetch });
    const response = await worker.fetch(request("/v1/recall", "POST", { query: "gateway authentication", scope_id: "capability:payments", limit: 3 }), env);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ memories: [{ memory_id: "mem-gateway" }], scope_ids: ["capability:payments"] });
    const search = vespa.requests.find((entry) => entry.url.pathname === "/search/")!.url;
    expect(search.searchParams.get("queryProfile")).toBe("recall");
    expect(search.searchParams.get("namespace_id")).toBe("acme");
    expect(search.searchParams.get("scope_id")).toBe("capability:payments");
    expect(search.searchParams.has("yql")).toBe(false);
    expect(vespa.requests.some((entry) => entry.url.pathname.includes("/scope/"))).toBe(false);
  });

  it("writes a validated memory with server-derived namespace", async () => {
    const vespa = fakeVespa({});
    const worker = createWorker({ fetch: vespa.fetch, now: () => 1_770_000_000_000 });
    const response = await worker.fetch(request("/v1/memories", "POST", {
      memory_id: "mem-created", scope_id: "capability:payments", scope_kind: "capability", kind: "architecture",
      title: "Gateway is the Vespa boundary", body: "Agent clients use the gateway to access durable memory rather than calling Vespa directly.",
    }), env);
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ memory: { memory_id: "mem-created", namespace_id: "acme" }, duplicate_candidates: [] });
    expect(vespa.records.get("mem-created")).toMatchObject({ namespace_id: "acme", status: "active", useful_count: 0 });
  });

  it("updates aggregate usefulness and supersession without a second document collection", async () => {
    const vespa = fakeVespa({
      old: memory("old"),
      successor: memory("successor", { title: "Current gateway boundary" }),
    });
    const worker = createWorker({ fetch: vespa.fetch, now: () => 1_770_000_000_000 });
    const useful = await worker.fetch(request("/v1/memories/old/usefulness", "PUT"), env);
    await expect(useful.json()).resolves.toMatchObject({ memory_id: "old", useful_count: 1, last_useful_at: 1770000000 });
    const superseded = await worker.fetch(request("/v1/memories/old/supersede", "POST", { expected_revision: 1, successor_memory_id: "successor" }), env);
    expect(superseded.status).toBe(200);
    expect(vespa.records.get("old")).toMatchObject({ status: "superseded", superseded_by: "successor", revision: 2 });
    expect(vespa.requests.every((entry) => !entry.url.pathname.includes("memory_revision") && !entry.url.pathname.includes("memory_usefulness"))).toBe(true);
  });

  it("does not let a client choose arbitrary document-sync roots", async () => {
    const vespa = fakeVespa({});
    const worker = createWorker({ fetch: vespa.fetch });
    const response = await worker.fetch(request("/v1/documents/sync", "POST", {
      documents: [{ scope_id: "capability:payments", kind: "specification", title: "Untrusted", chunks: ["text"], chunk_headings: ["Heading"], repository_id: "other", source_path: "private/spec.md", source_revision: "abc", source_content_hash: "sha256:test" }],
    }), env);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "reference_sync_not_configured" } });
  });
});
