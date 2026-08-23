import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { clientFromEnvironment } from "@good-agent-context/client";

function textResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], structuredContent: value as Record<string, unknown> };
}

function buildServer(): McpServer {
  const client = clientFromEnvironment();
  const server = new McpServer(
    { name: "good-agent-context", version: "0.1.0" },
    { instructions: "Use recall before rediscovering system context. Remember only durable, non-personal system facts. Specification results are indexed references: open their source_path before relying on them." },
  );
  server.registerTool("recall", {
    description: "Retrieve durable, scoped memories. Superseded results are historical context and explicitly labelled.",
    inputSchema: z.object({ query: z.string().min(1).max(1000), scope_id: z.string().min(1), limit: z.number().int().min(1).max(20).optional() }),
  }, async (input) => textResult(await client.recall(input)));
  server.registerTool("remember", {
    description: "Store a concise, durable system fact. Do not store personal information, session state, TODOs, or incomplete work.",
    inputSchema: z.object({
      scope_id: z.string().min(1), scope_kind: z.enum(["organisation", "capability", "service", "component", "repository"]),
      kind: z.enum(["architecture", "implementation", "tooling", "convention", "decision"]), title: z.string().min(1).max(240), body: z.string().min(20).max(4000),
      tags: z.array(z.string()).max(32).optional(), repository_id: z.string().optional(), source_paths: z.array(z.string()).max(32).optional(), source_commit: z.string().optional(),
    }),
  }, async (input) => textResult(await client.remember(input)));
  server.registerTool("mark_useful", {
    description: "Record that a recalled memory was useful. This is an aggregate event, not a personal vote.",
    inputSchema: z.object({ memory_id: z.string().min(1) }),
  }, async ({ memory_id }) => textResult(await client.markUseful(memory_id)));
  server.registerTool("supersede_memory", {
    description: "Mark an existing memory superseded by an already-created active successor in the same scope.",
    inputSchema: z.object({ memory_id: z.string().min(1), expected_revision: z.number().int().positive(), successor_memory_id: z.string().min(1) }),
  }, async ({ memory_id, expected_revision, successor_memory_id }) => textResult(await client.supersede(memory_id, { expected_revision, successor_memory_id })));
  server.registerTool("search_documents", {
    description: "Search indexed repository specifications and return labelled excerpts with authoritative source paths and revisions.",
    inputSchema: z.object({ query: z.string().min(1).max(1000), scope_id: z.string().min(1), limit: z.number().int().min(1).max(20).optional() }),
  }, async (input) => textResult(await client.searchDocuments(input)));
  return server;
}

serveStdio(buildServer, { onerror: (caught) => console.error(caught.message) });
