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
  limit?: number;
}

export interface MemoryResult extends Pick<Memory,
  "memory_id" | "revision" | "scope_id" | "scope_kind" | "kind" | "title" | "body" |
  "tags" | "repository_id" | "source_paths" | "source_commit" | "created_at" | "updated_at" |
  "status" | "superseded_by" | "useful_count" | "last_useful_at"> {
  relevance: number;
  match_features?: Record<string, number>;
}

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
  repository_id?: string;
  source_paths?: string[];
  source_commit?: string;
  supersedes_ids?: string[];
}

export interface RememberResponse {
  memory: Memory;
  duplicate_candidates: MemoryResult[];
}

export interface MarkUsefulResponse {
  memory_id: string;
  useful_count: number;
  last_useful_at: number;
}

export interface SupersedeRequest {
  expected_revision: number;
  successor_memory_id: string;
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
  limit?: number;
}

export interface ReferenceDocumentResult extends Pick<ReferenceDocument,
  "document_id" | "scope_id" | "kind" | "title" | "chunks" | "chunk_headings" |
  "repository_id" | "source_path" | "source_uri" | "source_revision" | "source_content_hash" |
  "indexed_at" | "lifecycle_status" | "source_status" | "superseded_by_document_id" | "guidance_notes"> {
  relevance: number;
  match_features?: Record<string, number>;
}

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
