import type { CreateMemoryRequest, MemoryLifecycleRequest, SearchDocumentsRequest, SupersedeRequest, SyncScopesRequest } from "@good-agent-context/contracts";

export class RequestProblem extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requiredString(value: unknown, field: string, max = 4_000): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max) {
    throw new RequestProblem(400, "invalid_request", `${field} must be a non-empty string no longer than ${max} characters.`);
  }
  return value.trim();
}

function stringArray(value: unknown, field: string, maxItems = 32): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maxItems || value.some((item) => typeof item !== "string" || item.length > 500)) {
    throw new RequestProblem(400, "invalid_request", `${field} must be an array of up to ${maxItems} short strings.`);
  }
  return value.map((item) => item.trim()).filter(Boolean);
}

const scopeKinds = new Set(["organisation", "capability", "service", "component", "repository"]);
const memoryKinds = new Set(["architecture", "implementation", "tooling", "convention", "decision"]);
const scopeIdPattern = /^(organisation|capability|service|component|repository):[a-z0-9][a-z0-9._-]{0,240}$/;

export function scopedId(value: unknown, field = "scope_id"): string {
  const scopeId = requiredString(value, field, 256);
  if (!scopeIdPattern.test(scopeId)) {
    throw new RequestProblem(400, "invalid_request", `${field} must be a stable logical scope identifier such as capability:payments.`);
  }
  return scopeId;
}

export function repositoryId(value: unknown): string {
  const id = scopedId(value, "repository_id");
  if (!id.startsWith("repository:")) throw new RequestProblem(400, "invalid_request", "repository_id must start with repository:.");
  return id;
}

export function parseCreateMemory(value: unknown): CreateMemoryRequest {
  if (!isRecord(value)) throw new RequestProblem(400, "invalid_request", "Request body must be an object.");
  const scopeKind = requiredString(value.scope_kind, "scope_kind", 64);
  const kind = requiredString(value.kind, "kind", 64);
  const title = requiredString(value.title, "title", 240);
  const body = requiredString(value.body, "body", 4_000);
  if (!scopeKinds.has(scopeKind) || !memoryKinds.has(kind)) {
    throw new RequestProblem(400, "invalid_request", "scope_kind or kind is not supported.");
  }
  const scopeId = scopedId(value.scope_id);
  if (!scopeId.startsWith(`${scopeKind}:`)) {
    throw new RequestProblem(400, "invalid_request", "scope_id prefix must match scope_kind.");
  }
  if (body.length < 20 || /\b(?:todo|wip|investigating|need to finish)\b/i.test(body)) {
    throw new RequestProblem(422, "not_durable", "Memory content must describe a durable system fact, not incomplete work.");
  }
  if (/\b(?:my password|api[_ -]?key|secret[_ -]?key|private key)\b/i.test(`${title}\n${body}`)) {
    throw new RequestProblem(422, "sensitive_content", "Memory content appears to contain a secret or personal credential.");
  }
  const memoryId = value.memory_id === undefined ? undefined : requiredString(value.memory_id, "memory_id", 128);
  return {
    memory_id: memoryId,
    scope_id: scopeId,
    scope_kind: scopeKind as CreateMemoryRequest["scope_kind"],
    kind: kind as CreateMemoryRequest["kind"],
    title,
    body,
    tags: stringArray(value.tags, "tags"),
    repository_id: repositoryId(value.repository_id),
    source_paths: stringArray(value.source_paths, "source_paths"),
    source_commit: value.source_commit === undefined ? undefined : requiredString(value.source_commit, "source_commit", 256),
    supersedes_ids: stringArray(value.supersedes_ids, "supersedes_ids"),
  };
}

export function parseSearch(value: unknown): SearchDocumentsRequest {
  if (!isRecord(value)) throw new RequestProblem(400, "invalid_request", "Request body must be an object.");
  const limit = value.limit === undefined ? 8 : Number(value.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
    throw new RequestProblem(400, "invalid_request", "limit must be an integer between 1 and 20.");
  }
  return { query: requiredString(value.query, "query", 1_000), scope_id: scopedId(value.scope_id), repository_id: repositoryId(value.repository_id), limit };
}

export function parseSyncScopes(value: unknown): SyncScopesRequest {
  if (!isRecord(value)) throw new RequestProblem(400, "invalid_request", "Request body must be an object.");
  const repository_id = repositoryId(value.repository_id);
  if (!Array.isArray(value.scopes) || value.scopes.length > 128) {
    throw new RequestProblem(400, "invalid_request", "scopes must be an array of at most 128 entries.");
  }
  const ranks: Record<string, number> = { organisation: 0, capability: 1, service: 2, component: 3 };
  const scopes = value.scopes.map((candidate) => {
    if (!isRecord(candidate) || !Array.isArray(candidate.parent_ids) || candidate.parent_ids.length > 8) {
      throw new RequestProblem(400, "invalid_request", "Each scope requires a parent_ids array of at most 8 IDs.");
    }
    const scope_id = scopedId(candidate.scope_id);
    if (scope_id.startsWith("repository:")) throw new RequestProblem(400, "invalid_request", "Repository scopes are created from repository_id.");
    const parent_ids = candidate.parent_ids.map((parent) => scopedId(parent, "parent_id"));
    if (new Set(parent_ids).size !== parent_ids.length) throw new RequestProblem(400, "invalid_request", "A scope cannot repeat a parent.");
    for (const parent of parent_ids) {
      if ((ranks[parent.split(":")[0]!] ?? 99) >= ranks[scope_id.split(":")[0]!]!) {
        throw new RequestProblem(400, "invalid_request", "A parent must be higher in the organisation, capability, service, component ladder.");
      }
    }
    return { scope_id, parent_ids };
  });
  const ids = new Set(scopes.map((scope) => scope.scope_id));
  if (ids.size !== scopes.length || scopes.some((scope) => scope.parent_ids.some((parent) => !ids.has(parent)))) {
    throw new RequestProblem(400, "invalid_request", "Scope IDs must be unique and every parent must be declared in the same sync request.");
  }
  const byId = new Map(scopes.map((scope) => [scope.scope_id, scope]));
  for (const scope of scopes) {
    const closure = new Set<string>();
    function add(id: string): void {
      if (closure.has(id)) return;
      closure.add(id);
      if (closure.size >= 16) throw new RequestProblem(400, "invalid_request", "A scope closure cannot exceed 16 scopes including its repository.");
      for (const parent of byId.get(id)?.parent_ids ?? []) add(parent);
    }
    add(scope.scope_id);
  }
  return { repository_id, scopes };
}

export function parseMemoryLifecycle(value: unknown): MemoryLifecycleRequest {
  if (!isRecord(value)) throw new RequestProblem(400, "invalid_request", "Request body must be an object.");
  const expected = Number(value.expected_revision);
  if (!Number.isInteger(expected) || expected < 1) {
    throw new RequestProblem(400, "invalid_request", "expected_revision must be a positive integer.");
  }
  return { expected_revision: expected };
}

export function parseSupersede(value: unknown): SupersedeRequest {
  const request = parseMemoryLifecycle(value);
  if (!isRecord(value)) throw new RequestProblem(400, "invalid_request", "Request body must be an object.");
  return { ...request, successor_memory_id: requiredString(value.successor_memory_id, "successor_memory_id", 128) };
}
