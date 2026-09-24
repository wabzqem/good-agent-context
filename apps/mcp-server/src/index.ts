import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { clientFromEnvironment, resolveProjectScope, scopeKindFromId } from "@good-agent-context/client";

async function toolScope(projectPath?: string, explicitScope?: string) {
  const path = projectPath ?? process.env.GOOD_CONTEXT_PROJECT_ROOT;
  if (!path) throw new Error("Provide project_path for this call or configure GOOD_CONTEXT_PROJECT_ROOT for this MCP server.");
  return resolveProjectScope(path, explicitScope);
}

function textResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], structuredContent: value as Record<string, unknown> };
}

function buildServer(): McpServer {
  const client = clientFromEnvironment();
  const server = new McpServer(
    { name: "good-agent-context", version: "0.1.0" },
    { instructions: "Use recall before rediscovering system context. Provide the current project's absolute project_path on scoped calls, or configure GOOD_CONTEXT_PROJECT_ROOT. Remember only durable, non-personal system facts. Specification results are indexed references: open their source_path before relying on them." },
  );
  server.registerTool("recall", {
    description: "Retrieve durable, scoped memories. Superseded results are historical context and explicitly labelled.",
    inputSchema: z.object({ query: z.string().min(1).max(1000), project_path: z.string().min(1).optional(), scope_id: z.string().min(1).optional(), limit: z.number().int().min(1).max(20).optional() }),
  }, async ({ project_path, scope_id, query, limit }) => textResult(await client.recall({ query, limit, ...await toolScope(project_path, scope_id) })));
  server.registerTool("remember", {
    description: "Store a concise, durable system fact. Do not store personal information, session state, TODOs, or incomplete work.",
    inputSchema: z.object({
      project_path: z.string().min(1).optional(), scope_id: z.string().min(1).optional(),
      kind: z.enum(["architecture", "implementation", "tooling", "convention", "decision"]), title: z.string().min(1).max(240), body: z.string().min(20).max(4000),
      tags: z.array(z.string()).max(32).optional(), source_paths: z.array(z.string()).max(32).optional(), source_commit: z.string().optional(),
    }),
  }, async ({ project_path, scope_id, ...input }) => {
    const scope = await toolScope(project_path, scope_id);
    return textResult(await client.remember({ ...input, ...scope, scope_kind: scopeKindFromId(scope.scope_id) }));
  });
  server.registerTool("mark_useful", {
    description: "Record that a recalled memory was useful. This is an aggregate event, not a personal vote.",
    inputSchema: z.object({ memory_id: z.string().min(1) }),
  }, async ({ memory_id }) => textResult(await client.markUseful(memory_id)));
  server.registerTool("supersede_memory", {
    description: "Mark an existing memory superseded by an already-created active successor in the same scope.",
    inputSchema: z.object({ memory_id: z.string().min(1), expected_revision: z.number().int().positive(), successor_memory_id: z.string().min(1) }),
  }, async ({ memory_id, expected_revision, successor_memory_id }) => textResult(await client.supersede(memory_id, { expected_revision, successor_memory_id })));
  server.registerTool("withdraw_memory", {
    description: "Curator-only: remove an active memory from normal recall without deleting its historical record.",
    inputSchema: z.object({ memory_id: z.string().min(1), expected_revision: z.number().int().positive() }),
  }, async ({ memory_id, expected_revision }) => textResult(await client.withdrawMemory(memory_id, { expected_revision })));
  server.registerTool("restore_memory", {
    description: "Curator-only: return a previously withdrawn memory to active normal recall.",
    inputSchema: z.object({ memory_id: z.string().min(1), expected_revision: z.number().int().positive() }),
  }, async ({ memory_id, expected_revision }) => textResult(await client.restoreMemory(memory_id, { expected_revision })));
  server.registerTool("search_documents", {
    description: "Search indexed repository specifications and return labelled excerpts with authoritative source paths and revisions.",
    inputSchema: z.object({ query: z.string().min(1).max(1000), project_path: z.string().min(1).optional(), scope_id: z.string().min(1).optional(), limit: z.number().int().min(1).max(20).optional() }),
  }, async ({ project_path, scope_id, query, limit }) => textResult(await client.searchDocuments({ query, limit, ...await toolScope(project_path, scope_id) })));
  return server;
}

serveStdio(buildServer, { onerror: (caught) => console.error(caught.message) });
