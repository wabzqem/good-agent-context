#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve, relative, sep } from "node:path";
import fastGlob from "fast-glob";
import { parse as parseYaml } from "yaml";
import { clientFromEnvironment, GoodContextApiError, loginWithCloudflareAccess } from "@good-agent-context/client";
import type { ScopeKind, SyncDocumentsRequest } from "@good-agent-context/contracts";

interface LocalConfig {
  repository: string;
  default_scope: string;
  documents?: Array<{ kind: "specification"; root: string; include?: string[]; scope: string }>;
}

function usage(): never {
  console.error(`Usage:
  good-context recall <query> [scope]
  good-context remember <scope> <scope-kind> <kind> <title> <body>
  good-context get <memory-id>
  good-context useful <memory-id>
  good-context supersede <memory-id> <expected-revision> <successor-memory-id>
  good-context documents search <query> [scope]
  good-context documents sync [config-path]
  good-context auth login`);
  process.exit(64);
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function loadConfig(configPath = ".good-agent-context.yaml"): Promise<LocalConfig> {
  const raw = await readFile(resolve(configPath), "utf8");
  const config = parseYaml(raw) as LocalConfig;
  if (!config?.repository || !config.default_scope) throw new Error(`${configPath} requires repository and default_scope.`);
  return config;
}

function chunksForMarkdown(markdown: string): { chunks: string[]; headings: string[] } {
  const sections = markdown.split(/(?=^#{1,3}\s+)/m).map((section) => section.trim()).filter(Boolean);
  const chunks = sections.length > 0 ? sections : [markdown.trim()];
  return {
    chunks: chunks.flatMap((chunk) => chunk.length <= 3_000 ? [chunk] : chunk.match(/[\s\S]{1,3000}/g) ?? []),
    headings: chunks.map((chunk) => /^#{1,3}\s+(.+)$/m.exec(chunk)?.[1] ?? "Untitled section"),
  };
}

async function syncDocuments(configPath?: string): Promise<void> {
  const config = await loadConfig(configPath);
  const repositoryRoot = resolve(configPath ? resolve(configPath, "..") : process.cwd());
  const documents: SyncDocumentsRequest["documents"] = [];
  for (const source of config.documents ?? []) {
    if (source.kind !== "specification") continue;
    const root = resolve(repositoryRoot, source.root);
    if (relative(repositoryRoot, root).split(sep).includes("..")) throw new Error(`Document root escapes the repository: ${source.root}`);
    const files = await fastGlob(source.include ?? ["**/*.md"], { cwd: root, absolute: true, onlyFiles: true, followSymbolicLinks: false });
    for (const file of files) {
      const content = await readFile(file, "utf8");
      const { chunks, headings } = chunksForMarkdown(content);
      const sourcePath = relative(repositoryRoot, file).split(sep).join("/");
      if (sourcePath.split("/").includes("..")) throw new Error(`Document path escapes the repository: ${file}`);
      documents.push({
        scope_id: source.scope,
        kind: "specification",
        title: headings[0] ?? sourcePath,
        chunks,
        chunk_headings: headings,
        repository_id: config.repository,
        source_path: sourcePath,
        source_revision: process.env.GIT_COMMIT ?? "local-uncommitted",
        source_content_hash: `sha256:${createHash("sha256").update(content).digest("hex")}`,
      });
    }
  }
  print(await clientFromEnvironment().syncDocuments({ documents }));
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === "auth" && args[0] === "login" && args.length === 1) {
    process.stderr.write("Starting Cloudflare Access browser login…\n");
    await loginWithCloudflareAccess(process.env.GOOD_CONTEXT_URL ?? "https://gac.wabz.net");
    process.stdout.write("Cloudflare Access login complete. Credentials are stored in the macOS Keychain.\n");
    return;
  }
  const client = clientFromEnvironment();
  if (command === "recall" && args.length >= 1) {
    const config = await loadConfig().catch(() => undefined);
    print(await client.recall({ query: args[0]!, scope_id: args[1] ?? config?.default_scope ?? usage() }));
    return;
  }
  if (command === "remember" && args.length === 5) {
    const [scope_id, scope_kind, kind, title, body] = args;
    print(await client.remember({ scope_id: scope_id!, scope_kind: scope_kind as ScopeKind, kind: kind as "implementation", title: title!, body: body! }));
    return;
  }
  if (command === "get" && args.length === 1) { print(await client.getMemory(args[0]!)); return; }
  if (command === "useful" && args.length === 1) { print(await client.markUseful(args[0]!)); return; }
  if (command === "supersede" && args.length === 3) {
    print(await client.supersede(args[0]!, { expected_revision: Number(args[1]), successor_memory_id: args[2]! }));
    return;
  }
  if (command === "documents" && args[0] === "search" && args.length >= 2) {
    const config = await loadConfig().catch(() => undefined);
    print(await client.searchDocuments({ query: args[1]!, scope_id: args[2] ?? config?.default_scope ?? usage() }));
    return;
  }
  if (command === "documents" && args[0] === "sync" && args.length <= 2) { await syncDocuments(args[1]); return; }
  usage();
}

main().catch((caught) => {
  const message = caught instanceof GoodContextApiError ? `${caught.code}: ${caught.message}` : caught instanceof Error ? caught.message : "Unknown error";
  console.error(message);
  process.exit(1);
});
