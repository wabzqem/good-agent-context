import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import type { ScopeDefinition, ScopeKind } from "@good-agent-context/contracts";

const scopeIdPattern = /^(organisation|capability|service|component|repository):[a-z0-9][a-z0-9._-]{0,240}$/;

export interface ProjectConfig {
  version: 1;
  repository: string;
  scopes: ScopeDefinition[];
  bindings: Array<{ root: string; scope: string }>;
  documents: Array<{ kind: "specification"; root: string; include?: string[]; scope: string }>;
}

export interface LoadedProjectConfig {
  root: string;
  path: string;
  config: ProjectConfig;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function scopeId(value: unknown, label: string): string {
  if (typeof value !== "string" || !scopeIdPattern.test(value)) {
    throw new Error(`${label} must be a stable scope ID such as capability:payments.`);
  }
  return value;
}

export function scopeKindFromId(id: string): ScopeKind {
  return scopeId(id, "scope_id").split(":", 1)[0] as ScopeKind;
}

function relativeRoot(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || isAbsolute(value) || value.includes("\\")) {
    throw new Error(`${label} must be a repository-relative path.`);
  }
  if (value === ".") return ".";
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error(`${label} must be a normalized repository-relative path.`);
  }
  return value;
}

function parseConfig(raw: string, path: string): ProjectConfig {
  const input: unknown = parseYaml(raw);
  if (!record(input) || input.version !== 1) throw new Error(`${path} requires version: 1.`);
  const repository = scopeId(input.repository, "repository");
  if (!repository.startsWith("repository:")) throw new Error(`${path} repository must start with repository:.`);
  if (!Array.isArray(input.scopes) || input.scopes.length > 128) throw new Error(`${path} scopes must be an array of at most 128 entries.`);
  const scopes = input.scopes.map((entry, index): ScopeDefinition => {
    if (!record(entry) || !Array.isArray(entry.parents) || entry.parents.length > 8) {
      throw new Error(`${path} scopes[${index}] requires a parents array of at most 8 IDs.`);
    }
    const id = scopeId(entry.id, `scopes[${index}].id`);
    if (id.startsWith("repository:")) throw new Error(`${path} repository scope is declared by repository, not scopes.`);
    const parent_ids = entry.parents.map((parent, parentIndex) => scopeId(parent, `scopes[${index}].parents[${parentIndex}]`));
    if (new Set(parent_ids).size !== parent_ids.length) throw new Error(`${path} scopes[${index}] has duplicate parents.`);
    const ranks: Record<string, number> = { organisation: 0, capability: 1, service: 2, component: 3 };
    for (const parent of parent_ids) {
      if ((ranks[parent.split(":")[0]!] ?? 99) >= ranks[id.split(":")[0]!]!) {
        throw new Error(`${path} ${parent} must be higher in the scope ladder than ${id}.`);
      }
    }
    return { scope_id: id, parent_ids };
  });
  const scopeIds = new Set([repository, ...scopes.map((scope) => scope.scope_id)]);
  if (scopeIds.size !== scopes.length + 1) throw new Error(`${path} has duplicate scope IDs.`);
  for (const scope of scopes) {
    for (const parent of scope.parent_ids) {
      if (!scopeIds.has(parent) || parent === repository) throw new Error(`${path} ${scope.scope_id} has an undeclared parent: ${parent}.`);
    }
  }
  const byId = new Map(scopes.map((scope) => [scope.scope_id, scope]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(id: string): void {
    if (visiting.has(id)) throw new Error(`${path} has a cycle in its scope parents at ${id}.`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const parent of byId.get(id)?.parent_ids ?? []) visit(parent);
    visiting.delete(id);
    visited.add(id);
  }
  for (const scope of scopes) visit(scope.scope_id);
  for (const scope of scopes) {
    const closure = new Set<string>();
    function add(id: string): void {
      if (closure.has(id)) return;
      closure.add(id);
      if (closure.size >= 16) throw new Error(`${path} ${scope.scope_id} exceeds the 16-scope closure limit including its repository.`);
      for (const parent of byId.get(id)?.parent_ids ?? []) add(parent);
    }
    add(scope.scope_id);
  }

  if (!Array.isArray(input.bindings) || input.bindings.length === 0) throw new Error(`${path} requires bindings, including root: . as the fallback.`);
  const bindings = input.bindings.map((entry, index) => {
    if (!record(entry)) throw new Error(`${path} bindings[${index}] must be an object.`);
    const root = relativeRoot(entry.root, `bindings[${index}].root`);
    const scope = scopeId(entry.scope, `bindings[${index}].scope`);
    if (!scopeIds.has(scope)) throw new Error(`${path} binding ${root} names undeclared scope ${scope}.`);
    return { root, scope };
  });
  if (bindings.filter((binding) => binding.root === ".").length !== 1) throw new Error(`${path} requires exactly one root: . binding.`);
  if (new Set(bindings.map((binding) => binding.root)).size !== bindings.length) throw new Error(`${path} has duplicate binding roots.`);

  if (input.documents !== undefined && !Array.isArray(input.documents)) throw new Error(`${path} documents must be an array.`);
  const documents = (input.documents ?? []).map((entry: unknown, index: number) => {
    if (!record(entry) || entry.kind !== "specification") throw new Error(`${path} documents[${index}] must be a specification.`);
    const root = relativeRoot(entry.root, `documents[${index}].root`);
    const scope = scopeId(entry.scope, `documents[${index}].scope`);
    if (!scopeIds.has(scope)) throw new Error(`${path} document root ${root} names undeclared scope ${scope}.`);
    if (entry.include !== undefined && (!Array.isArray(entry.include) || entry.include.some((pattern) => typeof pattern !== "string"))) {
      throw new Error(`${path} documents[${index}].include must be an array of glob strings.`);
    }
    return { kind: "specification" as const, root, scope, include: entry.include as string[] | undefined };
  });
  return { version: 1, repository, scopes, bindings, documents };
}

async function projectDirectory(projectPath: string): Promise<string> {
  const absolute = await realpath(resolve(projectPath));
  return (await stat(absolute)).isDirectory() ? absolute : dirname(absolute);
}

export async function loadProjectConfig(projectPath: string, configPath?: string): Promise<LoadedProjectConfig> {
  let path: string;
  if (configPath) {
    path = resolve(configPath);
  } else {
    let directory = await projectDirectory(projectPath);
    while (true) {
      const candidate = resolve(directory, ".good-agent-context.yaml");
      if (await stat(candidate).then((entry) => entry.isFile(), () => false)) {
        path = candidate;
        break;
      }
      if (await stat(resolve(directory, ".git")).then(() => true, () => false)) {
        throw new Error(`No .good-agent-context.yaml in ${directory}. Add a repository configuration with a root: . binding.`);
      }
      const parent = dirname(directory);
      if (parent === directory) throw new Error(`No .good-agent-context.yaml for ${projectPath}. Add one at the repository root.`);
      directory = parent;
    }
  }
  const raw = await readFile(path, "utf8");
  return { root: dirname(path), path, config: parseConfig(raw, path) };
}

export async function resolveProjectScope(projectPath: string, explicitScope?: string): Promise<{ scope_id: string; repository_id: string }> {
  const { root, config } = await loadProjectConfig(projectPath);
  const directory = await projectDirectory(projectPath);
  const relativePath = relative(root, directory);
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error(`${projectPath} is outside the configured repository ${root}.`);
  }
  const available = new Set([config.repository, ...config.scopes.map((scope) => scope.scope_id)]);
  if (explicitScope !== undefined) {
    const id = scopeId(explicitScope, "scope_id");
    if (!available.has(id)) throw new Error(`${id} is not declared in ${root}/.good-agent-context.yaml.`);
    return { scope_id: id, repository_id: config.repository };
  }
  const relativePosix = relativePath.split(sep).join("/");
  const binding = config.bindings
    .filter(({ root: bindingRoot }) => bindingRoot === "." || relativePosix === bindingRoot || relativePosix.startsWith(`${bindingRoot}/`))
    .sort((a, b) => b.root.length - a.root.length)[0];
  if (!binding) throw new Error(`No scope binding matches ${projectPath}. Add a root: . binding.`);
  return { scope_id: binding.scope, repository_id: config.repository };
}
