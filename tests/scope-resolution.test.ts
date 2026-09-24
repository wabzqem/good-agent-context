import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProjectConfig, resolveProjectScope } from "../packages/client/src/project-scope";

const created: string[] = [];

async function fixture(config: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "good-context-scope-"));
  created.push(root);
  await mkdir(join(root, ".git"));
  await writeFile(join(root, ".good-agent-context.yaml"), config);
  return root;
}

afterEach(async () => {
  for (const root of created.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("repository scope resolution", () => {
  it("uses the most specific path binding and lets an explicit declared scope win", async () => {
    const root = await fixture(`version: 1
repository: repository:payments-platform
scopes:
  - id: organisation:acme
    parents: []
  - id: capability:payments
    parents: [organisation:acme]
  - id: service:ledger
    parents: [capability:payments]
bindings:
  - root: .
    scope: capability:payments
  - root: services/ledger
    scope: service:ledger
`);
    await mkdir(join(root, "services", "ledger", "src"), { recursive: true });
    expect(await resolveProjectScope(join(root, "services", "ledger", "src"))).toEqual({
      scope_id: "service:ledger", repository_id: "repository:payments-platform",
    });
    expect(await resolveProjectScope(join(root, "services", "ledger"), "capability:payments")).toEqual({
      scope_id: "capability:payments", repository_id: "repository:payments-platform",
    });
    expect(await resolveProjectScope(root)).toEqual({ scope_id: "capability:payments", repository_id: "repository:payments-platform" });
    await expect(resolveProjectScope(root, "capability:other")).rejects.toThrow(/not declared/);
  });

  it("uses only the repository scope when no capability is configured", async () => {
    const root = await fixture(`version: 1
repository: repository:standalone
scopes: []
bindings:
  - root: .
    scope: repository:standalone
`);
    expect(await resolveProjectScope(root)).toEqual({ scope_id: "repository:standalone", repository_id: "repository:standalone" });
    expect((await loadProjectConfig(root)).config.scopes).toEqual([]);
  });

  it("does not borrow an unrelated repository configuration", async () => {
    const root = await fixture(`version: 1
repository: repository:one
scopes: []
bindings:
  - root: .
    scope: repository:one
`);
    const other = await mkdtemp(join(tmpdir(), "good-context-scope-"));
    created.push(other);
    await mkdir(join(other, ".git"));
    await expect(resolveProjectScope(other, "repository:one")).rejects.toThrow(/No .good-agent-context.yaml/);
    expect(await resolveProjectScope(root)).toMatchObject({ repository_id: "repository:one" });
  });
});
