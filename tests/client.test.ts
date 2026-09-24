import { describe, expect, it } from "vitest";
import { clientFromEnvironment, GoodContextClient } from "../packages/client/src/index";

describe("GoodContextClient service-token authentication", () => {
  it("does not use or look up credentials for a loopback Worker", async () => {
    let receivedHeaders: Headers | undefined;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_input, init) => {
      receivedHeaders = new Headers(init?.headers);
      return Response.json({ memories: [], scope_ids: ["capability:payments"] });
    };
    try {
      const client = clientFromEnvironment({
        GOOD_CONTEXT_URL: "http://127.0.0.1:8787",
        GOOD_CONTEXT_TOKEN: "must-not-be-sent",
        GOOD_CONTEXT_SERVICE_TOKEN_ID: "must-not-be-sent",
        GOOD_CONTEXT_SERVICE_TOKEN_SECRET: "must-not-be-sent",
      });
      await client.recall({ query: "authentication", scope_id: "capability:payments", repository_id: "repository:payments" });
      expect(receivedHeaders?.has("authorization")).toBe(false);
      expect(receivedHeaders?.has("cf-access-client-id")).toBe(false);
      expect(receivedHeaders?.has("cf-access-client-secret")).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects Access credentials when authentication is disabled", () => {
    expect(() => new GoodContextClient({
      baseUrl: "http://127.0.0.1:8787",
      authentication: "none",
      serviceTokenId: "client-id",
      serviceTokenSecret: "client-secret",
    })).toThrow(/cannot be configured/);
  });

  it("sends Cloudflare Access service-token headers instead of a bearer token", async () => {
    let receivedHeaders: Headers | undefined;
    const client = new GoodContextClient({
      baseUrl: "https://api.example",
      serviceTokenId: "client-id",
      serviceTokenSecret: "client-secret",
      fetch: async (_input, init) => {
        receivedHeaders = new Headers(init?.headers);
        return Response.json({ memories: [], scope_ids: ["capability:payments"] });
      },
    });
    await client.recall({ query: "authentication", scope_id: "capability:payments", repository_id: "repository:payments" });
    expect(receivedHeaders?.get("cf-access-client-id")).toBe("client-id");
    expect(receivedHeaders?.get("cf-access-client-secret")).toBe("client-secret");
    expect(receivedHeaders?.has("authorization")).toBe(false);
  });

  it("rejects a partially configured service token", () => {
    expect(() => new GoodContextClient({ baseUrl: "https://api.example", serviceTokenId: "client-id" })).toThrow(/Both serviceTokenId/);
  });

  it("uses the explicit curator lifecycle endpoints", async () => {
    const paths: string[] = [];
    const client = new GoodContextClient({
      baseUrl: "https://api.example",
      token: "local-token",
      fetch: async (input) => {
        paths.push(new URL(input.toString()).pathname);
        return Response.json({ memory_id: "memory-1", revision: 2, scope_id: "capability:payments", kind: "architecture", title: "Title", body: "Body", tags: [], source_paths: [], status: "withdrawn" });
      },
    });
    await client.withdrawMemory("memory-1", { expected_revision: 1 });
    await client.restoreMemory("memory-1", { expected_revision: 2 });
    expect(paths).toEqual(["/v1/memories/memory-1/withdraw", "/v1/memories/memory-1/restore"]);
  });
});
