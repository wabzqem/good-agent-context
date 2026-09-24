import type {
  ApiErrorBody,
  CreateMemoryRequest,
  MarkUsefulResponse,
  MemoryLifecycleRequest,
  MemoryView,
  RecallRequest,
  RecallResponse,
  RememberResponse,
  SearchDocumentsRequest,
  SearchDocumentsResponse,
  SupersedeRequest,
  SyncDocumentsRequest,
  SyncDocumentsResponse,
  SyncScopesRequest,
  SyncScopesResponse,
} from "@good-agent-context/contracts";
import { storedAccessToken } from "./access";

export { loginWithCloudflareAccess } from "./access";
export { loadProjectConfig, resolveProjectScope, scopeKindFromId } from "./project-scope";

export class GoodContextApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

export interface GoodContextClientOptions {
  baseUrl: string;
  /** Set to `none` for a trusted local Worker that does not require Access. */
  authentication?: "access" | "none";
  token?: string;
  tokenProvider?: () => Promise<string | undefined>;
  /** Cloudflare Access service-token client ID for unattended workloads. */
  serviceTokenId?: string;
  /** Cloudflare Access service-token secret for unattended workloads. */
  serviceTokenSecret?: string;
  fetch?: typeof fetch;
}

export class GoodContextClient {
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: URL;

  constructor(private readonly options: GoodContextClientOptions) {
    if (options.authentication === "none" && (options.serviceTokenId || options.serviceTokenSecret)) {
      throw new Error("Cloudflare Access service-token authentication cannot be configured when authentication is disabled.");
    }
    if (Boolean(options.serviceTokenId) !== Boolean(options.serviceTokenSecret)) {
      throw new Error("Both serviceTokenId and serviceTokenSecret are required for Cloudflare Access service-token authentication.");
    }
    this.fetchImpl = options.fetch ?? fetch;
    this.baseUrl = new URL(options.baseUrl.endsWith("/") ? options.baseUrl : `${options.baseUrl}/`);
  }

  async recall(request: RecallRequest): Promise<RecallResponse> {
    return this.request("/v1/recall", "POST", request);
  }

  async remember(request: CreateMemoryRequest): Promise<RememberResponse> {
    return this.request("/v1/memories", "POST", request);
  }

  async getMemory(memoryId: string): Promise<MemoryView> {
    return this.request(`/v1/memories/${encodeURIComponent(memoryId)}`, "GET");
  }

  async markUseful(memoryId: string): Promise<MarkUsefulResponse> {
    return this.request(`/v1/memories/${encodeURIComponent(memoryId)}/usefulness`, "PUT");
  }

  async supersede(memoryId: string, request: SupersedeRequest): Promise<MemoryView> {
    return this.request(`/v1/memories/${encodeURIComponent(memoryId)}/supersede`, "POST", request);
  }

  async withdrawMemory(memoryId: string, request: MemoryLifecycleRequest): Promise<MemoryView> {
    return this.request(`/v1/memories/${encodeURIComponent(memoryId)}/withdraw`, "POST", request);
  }

  async restoreMemory(memoryId: string, request: MemoryLifecycleRequest): Promise<MemoryView> {
    return this.request(`/v1/memories/${encodeURIComponent(memoryId)}/restore`, "POST", request);
  }

  async searchDocuments(request: SearchDocumentsRequest): Promise<SearchDocumentsResponse> {
    return this.request("/v1/documents/search", "POST", request);
  }

  async syncDocuments(request: SyncDocumentsRequest): Promise<SyncDocumentsResponse> {
    return this.request("/v1/documents/sync", "POST", request);
  }

  async syncScopes(request: SyncScopesRequest): Promise<SyncScopesResponse> {
    return this.request("/v1/scopes/sync", "POST", request);
  }

  private async request<T>(path: string, method: string, body?: unknown): Promise<T> {
    const authenticationDisabled = this.options.authentication === "none";
    const serviceTokenHeaders = this.options.serviceTokenId && this.options.serviceTokenSecret
      ? {
        "cf-access-client-id": this.options.serviceTokenId,
        "cf-access-client-secret": this.options.serviceTokenSecret,
      }
      : undefined;
    const token = authenticationDisabled || serviceTokenHeaders ? undefined : this.options.token ?? await this.options.tokenProvider?.();
    if (!authenticationDisabled && !serviceTokenHeaders && !token) throw new Error("No Access token is available. Run `good-context auth login` or configure a Cloudflare Access service token.");
    const response = await this.fetchImpl(new URL(path.slice(1), this.baseUrl), {
      method,
      headers: {
        ...(authenticationDisabled ? {} : serviceTokenHeaders ?? { authorization: `Bearer ${token}` }),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = await response.json().catch(() => undefined);
    if (!response.ok) {
      const apiError = payload as ApiErrorBody | undefined;
      throw new GoodContextApiError(response.status, apiError?.error?.code ?? "request_failed", apiError?.error?.message ?? `Request failed with HTTP ${response.status}.`);
    }
    return payload as T;
  }
}

export function clientFromEnvironment(environment: Record<string, string | undefined> = process.env): GoodContextClient {
  const baseUrl = environment.GOOD_CONTEXT_URL ?? "https://gac.wabz.net";
  const hostname = new URL(baseUrl).hostname;
  const authentication = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" ? "none" : "access";
  const serviceTokenId = environment.GOOD_CONTEXT_SERVICE_TOKEN_ID;
  const serviceTokenSecret = environment.GOOD_CONTEXT_SERVICE_TOKEN_SECRET;
  const token = environment.GOOD_CONTEXT_TOKEN;
  return new GoodContextClient({
    baseUrl,
    authentication,
    token: authentication === "none" ? undefined : token,
    serviceTokenId: authentication === "none" ? undefined : serviceTokenId,
    serviceTokenSecret: authentication === "none" ? undefined : serviceTokenSecret,
    tokenProvider: authentication === "none" || token || serviceTokenId || serviceTokenSecret ? undefined : () => storedAccessToken(baseUrl),
  });
}
