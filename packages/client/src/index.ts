import type {
  ApiErrorBody,
  CreateMemoryRequest,
  MarkUsefulResponse,
  Memory,
  RecallRequest,
  RecallResponse,
  RememberResponse,
  SearchDocumentsRequest,
  SearchDocumentsResponse,
  SupersedeRequest,
  SyncDocumentsRequest,
  SyncDocumentsResponse,
} from "@good-agent-context/contracts";
import { storedAccessToken } from "./access";

export { loginWithCloudflareAccess } from "./access";

export class GoodContextApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

export interface GoodContextClientOptions {
  baseUrl: string;
  token?: string;
  tokenProvider?: () => Promise<string | undefined>;
  fetch?: typeof fetch;
}

export class GoodContextClient {
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: URL;

  constructor(private readonly options: GoodContextClientOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.baseUrl = new URL(options.baseUrl.endsWith("/") ? options.baseUrl : `${options.baseUrl}/`);
  }

  async recall(request: RecallRequest): Promise<RecallResponse> {
    return this.request("/v1/recall", "POST", request);
  }

  async remember(request: CreateMemoryRequest): Promise<RememberResponse> {
    return this.request("/v1/memories", "POST", request);
  }

  async getMemory(memoryId: string): Promise<Memory> {
    return this.request(`/v1/memories/${encodeURIComponent(memoryId)}`, "GET");
  }

  async markUseful(memoryId: string): Promise<MarkUsefulResponse> {
    return this.request(`/v1/memories/${encodeURIComponent(memoryId)}/usefulness`, "PUT");
  }

  async supersede(memoryId: string, request: SupersedeRequest): Promise<Memory> {
    return this.request(`/v1/memories/${encodeURIComponent(memoryId)}/supersede`, "POST", request);
  }

  async searchDocuments(request: SearchDocumentsRequest): Promise<SearchDocumentsResponse> {
    return this.request("/v1/documents/search", "POST", request);
  }

  async syncDocuments(request: SyncDocumentsRequest): Promise<SyncDocumentsResponse> {
    return this.request("/v1/documents/sync", "POST", request);
  }

  private async request<T>(path: string, method: string, body?: unknown): Promise<T> {
    const token = this.options.token ?? await this.options.tokenProvider?.();
    if (!token) throw new Error("No Access token is available. Run `good-context auth login`, or set GOOD_CONTEXT_TOKEN for local development.");
    const response = await this.fetchImpl(new URL(path.slice(1), this.baseUrl), {
      method,
      headers: {
        authorization: `Bearer ${token}`,
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
  const token = environment.GOOD_CONTEXT_TOKEN;
  return new GoodContextClient({ baseUrl, token, tokenProvider: token ? undefined : () => storedAccessToken(baseUrl) });
}
