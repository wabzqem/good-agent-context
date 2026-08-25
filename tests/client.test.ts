import { describe, expect, it } from "vitest";
import { GoodContextClient } from "../packages/client/src/index";

describe("GoodContextClient service-token authentication", () => {
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
    await client.recall({ query: "authentication", scope_id: "capability:payments" });
    expect(receivedHeaders?.get("cf-access-client-id")).toBe("client-id");
    expect(receivedHeaders?.get("cf-access-client-secret")).toBe("client-secret");
    expect(receivedHeaders?.has("authorization")).toBe(false);
  });

  it("rejects a partially configured service token", () => {
    expect(() => new GoodContextClient({ baseUrl: "https://api.example", serviceTokenId: "client-id" })).toThrow(/Both serviceTokenId/);
  });
});
