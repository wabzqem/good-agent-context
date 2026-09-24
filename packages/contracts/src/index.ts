export type ScopeKind =
  | "organisation"
  | "capability"
  | "service"
  | "component"
  | "repository";

export type MemoryStatus = "active" | "superseded" | "withdrawn";
export type MemoryKind = "architecture" | "implementation" | "tooling" | "convention" | "decision";

export interface Memory {
  memory_id: string;
  revision: number;
  namespace_id: string;
  scope_id: string;
  scope_kind: ScopeKind;
  kind: MemoryKind;
  title: string;
  body: string;
  tags: string[];
  repository_id?: string;
  source_paths: string[];
  source_commit?: string;
  created_at: number;
  updated_at: number;
  status: MemoryStatus;
  supersedes_ids: string[];
  superseded_by?: string;
  derived_from_memory_ids: string[];
  useful_count: number;
  last_useful_at: number;
  content_hash: string;
}

export interface RecallRequest {
  query: string;
  scope_id: string;
  repository_id: string;
  limit?: number;
}

/**
 * The compact, agent-facing representation of a memory. Ranking, tenancy,
 * timestamps, hashes, and aggregate counters remain internal implementation
 * details; callers receive only the context and lifecycle data they can act on.
 */
export interface MemoryView extends Pick<Memory,
  "memory_id" | "revision" | "scope_id" | "kind" | "title" | "body" |
  "tags" | "repository_id" | "source_paths" | "source_commit" |
  "status" | "superseded_by"> {}

export type MemoryResult = MemoryView;

export interface RecallResponse {
  memories: MemoryResult[];
  scope_ids: string[];
}

export interface CreateMemoryRequest {
  memory_id?: string;
  scope_id: string;
  scope_kind: ScopeKind;
  kind: MemoryKind;
  title: string;
  body: string;
  tags?: string[];
  repository_id: string;
  source_paths?: string[];
  source_commit?: string;
  supersedes_ids?: string[];
}

export interface RememberResponse {
  memory: MemoryView;
  duplicate_candidates: MemoryResult[];
}

export interface MarkUsefulResponse {
  memory_id: string;
}

export interface SupersedeRequest {
  expected_revision: number;
  successor_memory_id: string;
}

export interface MemoryLifecycleRequest {
  expected_revision: number;
}

export interface ReferenceDocument {
  document_id: string;
  namespace_id: string;
  scope_id: string;
  kind: "specification";
  title: string;
  chunks: string[];
  chunk_headings: string[];
  repository_id: string;
  source_path: string;
  source_uri?: string;
  source_revision: string;
  source_content_hash: string;
  indexed_at: number;
  lifecycle_status: "active" | "superseded" | "withdrawn";
  source_status: "present" | "removed" | "unknown";
  superseded_by_document_id?: string;
  guidance_notes?: string[];
  metadata_revision: number;
}

export interface SearchDocumentsRequest {
  query: string;
  scope_id: string;
  repository_id: string;
  limit?: number;
}

export interface ScopeDefinition {
  scope_id: string;
  parent_ids: string[];
}

export interface SyncScopesRequest {
  repository_id: string;
  scopes: ScopeDefinition[];
}

export interface SyncScopesResponse {
  synced: string[];
  unbound: string[];
}

export interface ReferenceDocumentResult extends Pick<ReferenceDocument,
  "scope_id" | "title" | "chunks" | "repository_id" | "source_path" |
  "source_uri" | "source_revision" | "guidance_notes"> {}

export interface SearchDocumentsResponse {
  documents: ReferenceDocumentResult[];
  scope_ids: string[];
}

export interface SyncDocumentsRequest {
  documents: Array<Omit<ReferenceDocument,
    "document_id" | "namespace_id" | "indexed_at" | "lifecycle_status" | "source_status" | "metadata_revision"> & {
      document_id?: string;
      scope_id: string;
    }>;
}

export interface SyncDocumentsResponse {
  indexed: Array<{ document_id: string; source_path: string }>;
}

export interface ApiErrorBody {
  error: { code: string; message: string };
}
