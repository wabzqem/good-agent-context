import type {
  ApiErrorBody,
  CreateMemoryRequest,
  Memory,
  MemoryLifecycleRequest,
  MemoryResult,
  MemoryView,
  RecallResponse,
  RememberResponse,
  ReferenceDocument,
  ReferenceDocumentResult,
  SearchDocumentsResponse,
} from "@good-agent-context/contracts";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { RequestProblem, isRecord, parseCreateMemory, parseMemoryLifecycle, parseSearch, parseSupersede, requiredString, scopedId } from "./validation";

export type NamespaceRole = "reader" | "contributor" | "curator";

export interface Env {
  LOCAL_DEVELOPMENT: string;
  DEVELOPMENT_AUTH_TOKEN?: string;
  /** Local-only role assigned after DEVELOPMENT_AUTH_TOKEN has been verified. */
  DEVELOPMENT_AUTH_ROLE?: NamespaceRole;
  /** Cloudflare Access team domain, including https:// and no path. */
  ACCESS_TEAM_DOMAIN?: string;
  /** Audience (AUD) of the Cloudflare Access application protecting this Worker. */
  ACCESS_AUD?: string;
  /** Optional distinct Cloudflare Access application audience for curator operations. */
  CURATOR_ACCESS_AUD?: string;
  /** Default user role for an accepted primary Access audience. */
  DEFAULT_ROLE?: NamespaceRole;
  /** JSON object mapping verified Access service-token client IDs to namespace roles. */
  SERVICE_TOKEN_ROLES_JSON?: string;
  NAMESPACE_ID: string;
  VESPA_ENDPOINT: string;
  REFERENCE_SOURCES_JSON?: string;
  VESPA_MTLS?: { fetch: FetchLike };
}

type FetchLike = typeof fetch;

interface Dependencies {
  fetch: FetchLike;
  now: () => number;
}

const jsonHeaders = { "content-type": "application/json; charset=utf-8" };
const accessJwksByTeamDomain = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function json(value: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(value), { status, headers: { ...jsonHeaders, ...headers } });
}

function error(status: number, code: string, message: string, headers?: HeadersInit): Response {
  return json({ error: { code, message } } satisfies ApiErrorBody, status, headers);
}

async function requestJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new RequestProblem(400, "invalid_json", "Request body must be valid JSON.");
  }
}

function documentUrl(env: Env, documentType: string, documentId: string): URL {
  const endpoint = env.VESPA_ENDPOINT.endsWith("/") ? env.VESPA_ENDPOINT : `${env.VESPA_ENDPOINT}/`;
  return new URL(`document/v1/gac/${documentType}/docid/${encodeURIComponent(documentId)}`, endpoint);
}

function searchUrl(env: Env): URL {
  const endpoint = env.VESPA_ENDPOINT.endsWith("/") ? env.VESPA_ENDPOINT : `${env.VESPA_ENDPOINT}/`;
  return new URL("search/", endpoint);
}

async function vespaJson(fetchImpl: FetchLike, input: URL, init?: RequestInit): Promise<{ status: number; body: unknown }> {
  let response: Response;
  try {
    response = await fetchImpl(input, init);
  } catch {
    throw new RequestProblem(502, "vespa_unavailable", "Vespa is unavailable.");
  }
  const body = await response.json().catch(() => undefined);
  return { status: response.status, body };
}

function fieldsFrom(body: unknown): Record<string, unknown> | undefined {
  return isRecord(body) && isRecord(body.fields) ? body.fields : undefined;
}

function toNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

type RankedMemoryResult = MemoryResult & { relevance: number };
type RankedReferenceDocumentResult = ReferenceDocumentResult & { document_id: string; relevance: number };

function memoryView(memory: Memory): MemoryView {
  return {
    memory_id: memory.memory_id,
    revision: memory.revision,
    scope_id: memory.scope_id,
    kind: memory.kind,
    title: memory.title,
    body: memory.body,
    tags: memory.tags,
    repository_id: memory.repository_id,
    source_paths: memory.source_paths,
    source_commit: memory.source_commit,
    status: memory.status,
    superseded_by: memory.superseded_by,
  };
}

function withoutMemoryRank({ relevance: _relevance, ...memory }: RankedMemoryResult): MemoryResult {
  return memory;
}

function withoutDocumentRank({ document_id: _documentId, relevance: _relevance, ...document }: RankedReferenceDocumentResult): ReferenceDocumentResult {
  return document;
}

function memoryResult(hit: unknown): RankedMemoryResult | undefined {
  if (!isRecord(hit) || !isRecord(hit.fields)) return undefined;
  const fields = hit.fields;
  const memoryId = fields.memory_id;
  if (typeof memoryId !== "string") return undefined;
  return {
    memory_id: memoryId,
    revision: toNumber(fields.revision),
    scope_id: typeof fields.scope_id === "string" ? fields.scope_id : "",
    kind: (typeof fields.kind === "string" ? fields.kind : "implementation") as MemoryResult["kind"],
    title: typeof fields.title === "string" ? fields.title : "",
    body: typeof fields.body === "string" ? fields.body : "",
    tags: toStringArray(fields.tags),
    repository_id: typeof fields.repository_id === "string" ? fields.repository_id : undefined,
    source_paths: toStringArray(fields.source_paths),
    source_commit: typeof fields.source_commit === "string" ? fields.source_commit : undefined,
    status: (typeof fields.status === "string" ? fields.status : "active") as MemoryResult["status"],
    superseded_by: typeof fields.superseded_by === "string" ? fields.superseded_by : undefined,
    relevance: toNumber(hit.relevance),
  };
}

function referenceResult(hit: unknown): RankedReferenceDocumentResult | undefined {
  if (!isRecord(hit) || !isRecord(hit.fields)) return undefined;
  const fields = hit.fields;
  const documentId = fields.document_id;
  if (typeof documentId !== "string") return undefined;
  return {
    document_id: documentId,
    scope_id: typeof fields.scope_id === "string" ? fields.scope_id : "",
    title: typeof fields.title === "string" ? fields.title : "",
    chunks: toStringArray(fields.chunks),
    repository_id: typeof fields.repository_id === "string" ? fields.repository_id : "",
    source_path: typeof fields.source_path === "string" ? fields.source_path : "",
    source_uri: typeof fields.source_uri === "string" ? fields.source_uri : undefined,
    source_revision: typeof fields.source_revision === "string" ? fields.source_revision : "",
    guidance_notes: toStringArray(fields.guidance_notes),
    relevance: toNumber(hit.relevance),
  };
}

function searchHits(body: unknown): unknown[] {
  if (!isRecord(body) || !isRecord(body.root) || !Array.isArray(body.root.children)) return [];
  return body.root.children;
}

function merge<T extends { relevance: number }>(items: T[], key: (item: T) => string, limit: number): T[] {
  const unique = new Map<string, T>();
  for (const item of items) {
    const previous = unique.get(key(item));
    if (!previous || item.relevance > previous.relevance) unique.set(key(item), item);
  }
  return [...unique.values()].sort((left, right) => right.relevance - left.relevance).slice(0, limit);
}

function accessJwks(teamDomain: string): ReturnType<typeof createRemoteJWKSet> {
  let jwks = accessJwksByTeamDomain.get(teamDomain);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL("/cdn-cgi/access/certs", teamDomain));
    accessJwksByTeamDomain.set(teamDomain, jwks);
  }
  return jwks;
}

interface AuthorizationContext {
  role: NamespaceRole;
  principal_type: "development" | "user" | "service";
}

const roleRank: Record<NamespaceRole, number> = { reader: 1, contributor: 2, curator: 3 };

function configuredRole(value: unknown, setting: string): NamespaceRole {
  if (value === "reader" || value === "contributor" || value === "curator") return value;
  throw new RequestProblem(503, "authorization_misconfigured", `${setting} must be reader, contributor, or curator.`);
}

function configuredDefaultRole(env: Pick<Env, "LOCAL_DEVELOPMENT" | "DEVELOPMENT_AUTH_ROLE" | "DEFAULT_ROLE">): NamespaceRole {
  if (env.LOCAL_DEVELOPMENT === "true") return configuredRole(env.DEVELOPMENT_AUTH_ROLE ?? "contributor", "DEVELOPMENT_AUTH_ROLE");
  if (!env.DEFAULT_ROLE) throw new RequestProblem(503, "authorization_misconfigured", "DEFAULT_ROLE is required for hosted requests.");
  return configuredRole(env.DEFAULT_ROLE, "DEFAULT_ROLE");
}

function serviceTokenRoles(env: Pick<Env, "SERVICE_TOKEN_ROLES_JSON">): Record<string, NamespaceRole> {
  if (!env.SERVICE_TOKEN_ROLES_JSON) return {};
  try {
    const parsed: unknown = JSON.parse(env.SERVICE_TOKEN_ROLES_JSON);
    if (!isRecord(parsed)) throw new Error("not an object");
    return Object.fromEntries(Object.entries(parsed).map(([clientId, role]) => [clientId, configuredRole(role, "SERVICE_TOKEN_ROLES_JSON")])) as Record<string, NamespaceRole>;
  } catch (caught) {
    if (caught instanceof RequestProblem) throw caught;
    throw new RequestProblem(503, "authorization_misconfigured", "SERVICE_TOKEN_ROLES_JSON must be a JSON object mapping client IDs to roles.");
  }
}

function audiences(payload: JWTPayload): string[] {
  return typeof payload.aud === "string" ? [payload.aud] : Array.isArray(payload.aud) ? payload.aud.filter((audience): audience is string => typeof audience === "string") : [];
}

/**
 * Claims reach this function only after jose has verified the Access JWT's
 * signature, issuer, expiry, and allowed audience. Access emits common_name
 * for service-token assertions, not for ordinary user assertions.
 */
export function authorizationFromAccessClaims(
  payload: JWTPayload,
  env: Pick<Env, "DEFAULT_ROLE" | "CURATOR_ACCESS_AUD" | "SERVICE_TOKEN_ROLES_JSON">,
): AuthorizationContext {
  const serviceTokenClientId = payload.common_name;
  if (typeof serviceTokenClientId === "string" && serviceTokenClientId.length > 0) {
    const role = serviceTokenRoles(env)[serviceTokenClientId];
    if (!role) {
      throw new RequestProblem(403, "service_token_not_authorized", "This service token is not authorized for the namespace.");
    }
    return { role, principal_type: "service" };
  }
  if (env.CURATOR_ACCESS_AUD && audiences(payload).includes(env.CURATOR_ACCESS_AUD)) {
    return { role: "curator", principal_type: "user" };
  }
  return { role: configuredDefaultRole({ LOCAL_DEVELOPMENT: "false", DEFAULT_ROLE: env.DEFAULT_ROLE }), principal_type: "user" };
}

function requireRole(context: AuthorizationContext, required: NamespaceRole): void {
  if (roleRank[context.role] < roleRank[required]) {
    throw new RequestProblem(403, "forbidden", `${required} role is required for this operation.`);
  }
}

async function requireIdentity(request: Request, env: Env): Promise<AuthorizationContext> {
  if (env.LOCAL_DEVELOPMENT === "true") {
    if (!env.DEVELOPMENT_AUTH_TOKEN) {
      throw new RequestProblem(500, "development_auth_not_configured", "DEVELOPMENT_AUTH_TOKEN is required for local development.");
    }
    if (request.headers.get("authorization") !== `Bearer ${env.DEVELOPMENT_AUTH_TOKEN}`) {
      throw new RequestProblem(401, "unauthorized", "A valid local development bearer token is required.");
    }
    return { role: configuredDefaultRole(env), principal_type: "development" };
  }

  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) {
    throw new RequestProblem(503, "authentication_not_configured", "Cloudflare Access JWT validation is not configured.");
  }
  const assertion = request.headers.get("cf-access-jwt-assertion");
  if (!assertion) {
    throw new RequestProblem(401, "unauthorized", "A valid Cloudflare Access assertion is required.");
  }
  let payload: JWTPayload;
  try {
    const audiencesToAccept = [env.ACCESS_AUD, ...(env.CURATOR_ACCESS_AUD ? [env.CURATOR_ACCESS_AUD] : [])];
    ({ payload } = await jwtVerify(assertion, accessJwks(env.ACCESS_TEAM_DOMAIN), {
      issuer: env.ACCESS_TEAM_DOMAIN,
      audience: audiencesToAccept,
    }));
  } catch {
    throw new RequestProblem(401, "unauthorized", "The Cloudflare Access assertion is invalid or expired.");
  }
  return authorizationFromAccessClaims(payload, env);
}

function mcpProtectedResourceMetadataUrl(url: URL): string {
  return new URL("/.well-known/oauth-protected-resource/mcp", url.origin).toString();
}

function mcpProtectedResourceMetadata(url: URL, env: Env): Response {
  if (!env.ACCESS_TEAM_DOMAIN) {
    return error(503, "authentication_not_configured", "Cloudflare Access metadata is not configured.");
  }
  return json({
    resource: new URL("/mcp", url.origin).toString(),
    authorization_servers: [env.ACCESS_TEAM_DOMAIN],
  });
}

function scopeIds(scopeId: string): string[] {
  // Scope labels are created lazily by memories and reference documents. A
  // curated scope graph may add ancestor expansion later, but is never an
  // admission check on the Phase 1/2 request path.
  return [scopeId];
}

async function queryScope(
  fetchImpl: FetchLike,
  env: Env,
  profile: "recall" | "documents",
  query: string,
  scopeId: string,
): Promise<unknown[]> {
  const url = searchUrl(env);
  url.searchParams.set("queryProfile", profile);
  url.searchParams.set("query", query);
  url.searchParams.set("namespace_id", env.NAMESPACE_ID);
  url.searchParams.set("scope_id", scopeId);
  url.searchParams.set("input.query(query_embedding)", `embed(e5, "${query.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}")`);
  const response = await vespaJson(fetchImpl, url);
  if (response.status !== 200) throw new RequestProblem(502, "vespa_query_failed", "Vespa could not execute the fixed search query.");
  return searchHits(response.body);
}

async function getMemory(fetchImpl: FetchLike, env: Env, memoryId: string): Promise<Memory> {
  const response = await vespaJson(fetchImpl, documentUrl(env, "memory", memoryId));
  if (response.status === 404) throw new RequestProblem(404, "memory_not_found", "Memory was not found.");
  if (response.status !== 200) throw new RequestProblem(502, "vespa_read_failed", "Vespa could not read the memory.");
  const fields = fieldsFrom(response.body);
  if (!fields || fields.namespace_id !== env.NAMESPACE_ID) throw new RequestProblem(404, "memory_not_found", "Memory was not found.");
  return fields as unknown as Memory;
}

async function contentHash(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function currentSeconds(now: () => number): number {
  return Math.floor(now() / 1_000);
}

interface ReferenceSource {
  repository_id: string;
  scope_id: string;
  path_prefix: string;
}

function permittedReferenceSources(env: Env): ReferenceSource[] {
  if (!env.REFERENCE_SOURCES_JSON) {
    throw new RequestProblem(503, "reference_sync_not_configured", "Reference sync is not configured for this namespace.");
  }
  try {
    const parsed: unknown = JSON.parse(env.REFERENCE_SOURCES_JSON);
    if (!Array.isArray(parsed)) throw new Error("not an array");
    return parsed.map((source): ReferenceSource => {
      if (!isRecord(source)) throw new Error("not an object");
      return {
        repository_id: requiredString(source.repository_id, "reference repository_id", 256),
        scope_id: requiredString(source.scope_id, "reference scope_id", 256),
        path_prefix: requiredString(source.path_prefix, "reference path_prefix", 1_000).replace(/^\.\//, "").replace(/\/$/, ""),
      };
    });
  } catch (caught) {
    if (caught instanceof RequestProblem) throw caught;
    throw new RequestProblem(500, "reference_sync_misconfigured", "REFERENCE_SOURCES_JSON must be a JSON array of repository_id, scope_id, and path_prefix objects.");
  }
}

function assertPermittedReferenceSource(env: Env, sourcePath: string, repositoryId: string, scopeId: string, sourceUri: unknown, sourceRevision: string): void {
  if (sourcePath.startsWith("/") || sourcePath.split("/").includes("..")) {
    throw new RequestProblem(400, "invalid_source_path", "source_path must be repository-relative and cannot traverse directories.");
  }
  const permitted = permittedReferenceSources(env).some((source) =>
    source.repository_id === repositoryId && source.scope_id === scopeId &&
    (sourcePath === source.path_prefix || sourcePath.startsWith(`${source.path_prefix}/`)),
  );
  if (!permitted) throw new RequestProblem(403, "reference_source_not_allowed", "The repository, scope, or source path is not configured for reference sync.");
  if (typeof sourceUri === "string") {
    let parsed: URL;
    try { parsed = new URL(sourceUri); } catch { throw new RequestProblem(400, "invalid_source_uri", "source_uri must be an absolute HTTPS URL."); }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
      throw new RequestProblem(400, "invalid_source_uri", "source_uri must be an HTTPS URL without user credentials.");
    }
  }
  if (env.LOCAL_DEVELOPMENT !== "true" && sourceRevision === "local-uncommitted") {
    throw new RequestProblem(422, "source_not_committed", "Reference documents must identify a committed source revision.");
  }
}

async function createMemory(fetchImpl: FetchLike, env: Env, now: () => number, input: CreateMemoryRequest): Promise<Memory> {
  const memoryId = input.memory_id ?? crypto.randomUUID();
  const timestamp = currentSeconds(now);
  const fields: Memory = {
    memory_id: memoryId,
    revision: 1,
    namespace_id: env.NAMESPACE_ID,
    scope_id: input.scope_id,
    scope_kind: input.scope_kind,
    kind: input.kind,
    title: input.title,
    body: input.body,
    tags: input.tags ?? [],
    repository_id: input.repository_id,
    source_paths: input.source_paths ?? [],
    source_commit: input.source_commit,
    created_at: timestamp,
    updated_at: timestamp,
    status: "active",
    supersedes_ids: input.supersedes_ids ?? [],
    derived_from_memory_ids: [],
    useful_count: 0,
    last_useful_at: 0,
    content_hash: await contentHash(`${input.title}\n${input.body}\n${input.scope_id}`),
  };
  const existing = await vespaJson(fetchImpl, documentUrl(env, "memory", memoryId));
  if (existing.status === 200) {
    const existingFields = fieldsFrom(existing.body);
    if (existingFields?.content_hash === fields.content_hash && existingFields.namespace_id === env.NAMESPACE_ID) return existingFields as unknown as Memory;
    throw new RequestProblem(409, "memory_id_conflict", "memory_id already exists with different content.");
  }
  if (existing.status !== 404) throw new RequestProblem(502, "vespa_read_failed", "Vespa could not check the memory ID.");
  const response = await vespaJson(fetchImpl, documentUrl(env, "memory", memoryId), {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ fields }),
  });
  if (response.status < 200 || response.status >= 300) throw new RequestProblem(502, "vespa_write_failed", "Vespa could not store the memory.");
  return fields;
}

async function duplicateCandidates(fetchImpl: FetchLike, env: Env, input: CreateMemoryRequest): Promise<RankedMemoryResult[]> {
  const scopes = scopeIds(input.scope_id);
  const query = `${input.title}\n${input.body}`;
  const hits = (await Promise.all(scopes.map((scope) => queryScope(fetchImpl, env, "recall", query, scope))))
    .flat().map(memoryResult).filter((hit): hit is RankedMemoryResult => hit !== undefined)
    .filter((hit) => hit.status === "active" && hit.memory_id !== input.memory_id);
  return merge(hits, (hit) => hit.memory_id, 3);
}

async function markUseful(fetchImpl: FetchLike, env: Env, now: () => number, memoryId: string): Promise<{ memory_id: string }> {
  const memory = await getMemory(fetchImpl, env, memoryId);
  const timestamp = currentSeconds(now);
  const response = await vespaJson(fetchImpl, documentUrl(env, "memory", memoryId), {
    method: "PUT",
    headers: jsonHeaders,
    body: JSON.stringify({ fields: { useful_count: { increment: 1 }, last_useful_at: { assign: timestamp } } }),
  });
  if (response.status < 200 || response.status >= 300) throw new RequestProblem(502, "vespa_write_failed", "Vespa could not record usefulness.");
  return { memory_id: memory.memory_id };
}

async function supersede(fetchImpl: FetchLike, env: Env, now: () => number, memoryId: string, body: unknown): Promise<Memory> {
  const request = parseSupersede(body);
  if (request.successor_memory_id === memoryId) throw new RequestProblem(400, "invalid_request", "A memory cannot supersede itself.");
  const current = await getMemory(fetchImpl, env, memoryId);
  const successor = await getMemory(fetchImpl, env, request.successor_memory_id);
  if (successor.status !== "active" || successor.scope_id !== current.scope_id) {
    throw new RequestProblem(422, "invalid_successor", "The successor must be an active memory in the same logical scope.");
  }
  if (current.status === "superseded" && current.superseded_by === successor.memory_id) return current;
  if (current.status !== "active" || current.revision !== request.expected_revision) {
    throw new RequestProblem(409, "revision_conflict", "Memory changed before it could be superseded.");
  }
  const response = await vespaJson(fetchImpl, documentUrl(env, "memory", memoryId), {
    method: "PUT",
    headers: jsonHeaders,
    body: JSON.stringify({ fields: {
      status: { assign: "superseded" },
      superseded_by: { assign: successor.memory_id },
      updated_at: { assign: currentSeconds(now) },
      revision: { assign: current.revision + 1 },
    } }),
  });
  if (response.status < 200 || response.status >= 300) throw new RequestProblem(502, "vespa_write_failed", "Vespa could not supersede the memory.");
  return { ...current, status: "superseded", superseded_by: successor.memory_id, revision: current.revision + 1, updated_at: currentSeconds(now) };
}

async function transitionMemory(
  fetchImpl: FetchLike,
  env: Env,
  now: () => number,
  memoryId: string,
  body: unknown,
  transition: "withdraw" | "restore",
): Promise<Memory> {
  const request: MemoryLifecycleRequest = parseMemoryLifecycle(body);
  const current = await getMemory(fetchImpl, env, memoryId);
  const from = transition === "withdraw" ? "active" : "withdrawn";
  const to = transition === "withdraw" ? "withdrawn" : "active";
  if (current.status === to) return current;
  if (current.status !== from) {
    const verb = transition === "withdraw" ? "withdrawn" : "restored";
    throw new RequestProblem(422, "invalid_lifecycle_transition", `Only ${from} memories can be ${verb}.`);
  }
  if (current.revision !== request.expected_revision) {
    throw new RequestProblem(409, "revision_conflict", "Memory changed before its lifecycle state could be updated.");
  }
  const timestamp = currentSeconds(now);
  const response = await vespaJson(fetchImpl, documentUrl(env, "memory", memoryId), {
    method: "PUT",
    headers: jsonHeaders,
    body: JSON.stringify({ fields: {
      status: { assign: to },
      updated_at: { assign: timestamp },
      revision: { assign: current.revision + 1 },
    } }),
  });
  if (response.status < 200 || response.status >= 300) throw new RequestProblem(502, "vespa_write_failed", `Vespa could not ${transition} the memory.`);
  return { ...current, status: to, revision: current.revision + 1, updated_at: timestamp };
}

async function syncDocuments(fetchImpl: FetchLike, env: Env, now: () => number, body: unknown): Promise<{ indexed: Array<{ document_id: string; source_path: string }> }> {
  if (!isRecord(body) || !Array.isArray(body.documents) || body.documents.length > 100) {
    throw new RequestProblem(400, "invalid_request", "documents must contain at most 100 reference documents.");
  }
  const documents = body.documents;
  const indexed: Array<{ document_id: string; source_path: string }> = [];
  for (const candidate of documents) {
    if (!isRecord(candidate)) throw new RequestProblem(400, "invalid_request", "Each document must be an object.");
    const scopeId = scopedId(candidate.scope_id);
    const sourcePath = requiredString(candidate.source_path, "source_path", 1_000);
    const repositoryId = requiredString(candidate.repository_id, "repository_id", 256);
    const title = requiredString(candidate.title, "title", 240);
    const chunks = Array.isArray(candidate.chunks) ? candidate.chunks.filter((chunk): chunk is string => typeof chunk === "string" && chunk.length > 0) : [];
    if (chunks.length === 0 || chunks.length > 128) throw new RequestProblem(400, "invalid_request", "Each document needs between 1 and 128 chunks.");
    const headings = Array.isArray(candidate.chunk_headings) ? candidate.chunk_headings.filter((heading): heading is string => typeof heading === "string") : [];
    const sourceRevision = requiredString(candidate.source_revision, "source_revision", 256);
    const sourceHash = requiredString(candidate.source_content_hash, "source_content_hash", 256);
    assertPermittedReferenceSource(env, sourcePath, repositoryId, scopeId, candidate.source_uri, sourceRevision);
    const derivedId = await contentHash(`${repositoryId}\n${sourcePath}`);
    const documentId = typeof candidate.document_id === "string" ? candidate.document_id : `ref-${derivedId.slice(7, 31)}`;
    const fields: ReferenceDocument = {
      document_id: documentId,
      namespace_id: env.NAMESPACE_ID,
      scope_id: scopeId,
      kind: "specification",
      title,
      chunks,
      chunk_headings: headings,
      repository_id: repositoryId,
      source_path: sourcePath,
      source_uri: typeof candidate.source_uri === "string" ? candidate.source_uri : undefined,
      source_revision: sourceRevision,
      source_content_hash: sourceHash,
      indexed_at: currentSeconds(now),
      lifecycle_status: "active",
      source_status: "present",
      guidance_notes: Array.isArray(candidate.guidance_notes) ? candidate.guidance_notes.filter((note): note is string => typeof note === "string") : [],
      metadata_revision: 1,
    };
    const response = await vespaJson(fetchImpl, documentUrl(env, "reference_document", documentId), {
      method: "POST", headers: jsonHeaders, body: JSON.stringify({ fields }),
    });
    if (response.status < 200 || response.status >= 300) throw new RequestProblem(502, "vespa_write_failed", `Vespa could not index ${sourcePath}.`);
    indexed.push({ document_id: documentId, source_path: sourcePath });
  }
  return { indexed };
}

export function createWorker(overrides: Partial<Dependencies> = {}) {
  const dependencies: Dependencies = { fetch, now: Date.now, ...overrides };
  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health") return json({ ok: true });
      if (request.method === "GET" && (url.pathname === "/.well-known/oauth-protected-resource" || url.pathname === "/.well-known/oauth-protected-resource/mcp")) {
        return mcpProtectedResourceMetadata(url, env);
      }
      try {
        const authorization = await requireIdentity(request, env);
        const vespaFetch = env.LOCAL_DEVELOPMENT === "true"
          ? dependencies.fetch
          : env.VESPA_MTLS?.fetch.bind(env.VESPA_MTLS);
        if (!vespaFetch) throw new RequestProblem(503, "vespa_mtls_not_configured", "Production Vespa access requires the VESPA_MTLS binding.");
        if (request.method === "POST" && url.pathname === "/v1/recall") {
          requireRole(authorization, "reader");
          const input = parseSearch(await requestJson(request));
          const scopes = scopeIds(input.scope_id);
          const hits = (await Promise.all(scopes.map((scope) => queryScope(vespaFetch, env, "recall", input.query, scope))))
            .flat().map(memoryResult).filter((hit): hit is RankedMemoryResult => hit !== undefined);
          return json({ memories: merge(hits, (hit) => hit.memory_id, input.limit ?? 8).map(withoutMemoryRank), scope_ids: scopes } satisfies RecallResponse);
        }
        if (request.method === "POST" && url.pathname === "/v1/memories") {
          requireRole(authorization, "contributor");
          const input = parseCreateMemory(await requestJson(request));
          const [memory, duplicate_candidates] = await Promise.all([
            createMemory(vespaFetch, env, dependencies.now, input),
            duplicateCandidates(vespaFetch, env, input),
          ]);
          return json({ memory: memoryView(memory), duplicate_candidates: duplicate_candidates.map(withoutMemoryRank) } satisfies RememberResponse, 201);
        }
        if (request.method === "POST" && url.pathname === "/v1/documents/search") {
          requireRole(authorization, "reader");
          const input = parseSearch(await requestJson(request));
          const scopes = scopeIds(input.scope_id);
          const hits = (await Promise.all(scopes.map((scope) => queryScope(vespaFetch, env, "documents", input.query, scope))))
            .flat().map(referenceResult).filter((hit): hit is RankedReferenceDocumentResult => hit !== undefined);
          return json({ documents: merge(hits, (hit) => hit.document_id, input.limit ?? 8).map(withoutDocumentRank), scope_ids: scopes } satisfies SearchDocumentsResponse);
        }
        if (request.method === "POST" && url.pathname === "/v1/documents/sync") {
          requireRole(authorization, "contributor");
          return json(await syncDocuments(vespaFetch, env, dependencies.now, await requestJson(request)), 201);
        }
        const memoryMatch = /^\/v1\/memories\/([^/]+)$/.exec(url.pathname);
        if (request.method === "GET" && memoryMatch?.[1]) {
          requireRole(authorization, "reader");
          return json(memoryView(await getMemory(vespaFetch, env, decodeURIComponent(memoryMatch[1]))));
        }
        const usefulMatch = /^\/v1\/memories\/([^/]+)\/usefulness$/.exec(url.pathname);
        if (request.method === "PUT" && usefulMatch?.[1]) {
          requireRole(authorization, "contributor");
          return json(await markUseful(vespaFetch, env, dependencies.now, decodeURIComponent(usefulMatch[1])));
        }
        const supersedeMatch = /^\/v1\/memories\/([^/]+)\/supersede$/.exec(url.pathname);
        if (request.method === "POST" && supersedeMatch?.[1]) {
          requireRole(authorization, "contributor");
          return json(memoryView(await supersede(vespaFetch, env, dependencies.now, decodeURIComponent(supersedeMatch[1]), await requestJson(request))));
        }
        const withdrawMatch = /^\/v1\/memories\/([^/]+)\/withdraw$/.exec(url.pathname);
        if (request.method === "POST" && withdrawMatch?.[1]) {
          requireRole(authorization, "curator");
          return json(memoryView(await transitionMemory(vespaFetch, env, dependencies.now, decodeURIComponent(withdrawMatch[1]), await requestJson(request), "withdraw")));
        }
        const restoreMatch = /^\/v1\/memories\/([^/]+)\/restore$/.exec(url.pathname);
        if (request.method === "POST" && restoreMatch?.[1]) {
          requireRole(authorization, "curator");
          return json(memoryView(await transitionMemory(vespaFetch, env, dependencies.now, decodeURIComponent(restoreMatch[1]), await requestJson(request), "restore")));
        }
        return error(404, "not_found", "Route not found.");
      } catch (caught) {
        if (caught instanceof RequestProblem) {
          const headers = caught.status === 401 ? { "www-authenticate": `Bearer resource_metadata=\"${mcpProtectedResourceMetadataUrl(url)}\"` } : undefined;
          return error(caught.status, caught.code, caught.message, headers);
        }
        return error(500, "internal_error", "Unexpected server error.");
      }
    },
  };
}

export default createWorker();
