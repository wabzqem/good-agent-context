#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { finished } from "node:stream/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const [arm, cwd, promptPath, outputDirectory] = process.argv.slice(2);
if (!["baseline", "gac", "seed"].includes(arm) || !cwd || !promptPath || !outputDirectory) {
  process.stderr.write("Usage: node run-codex.mjs <baseline|gac|seed> <cwd> <prompt-file> <output-directory>\n");
  process.exit(64);
}

const projectRoot = resolve(fileURLToPath(import.meta.url), "../../..");
const model = process.env.GAC_EVAL_MODEL ?? "gpt-6-sol";
const args = [
  "exec", "--ephemeral", "--ignore-user-config", "--json", "--approve-for-me",
  "-m", model, "-C", resolve(cwd),
  "-c", "model_reasoning_effort=medium",
];

if (arm !== "baseline") {
  const server = "mcp_servers.good-agent-context";
  args.push(
    "-c", `${server}.command=${JSON.stringify(resolve(projectRoot, "node_modules/.bin/tsx"))}`,
    "-c", `${server}.args=${JSON.stringify([resolve(projectRoot, "apps/mcp-server/src/index.ts")])}`,
    "-c", `${server}.env.GOOD_CONTEXT_URL=${JSON.stringify(process.env.GOOD_CONTEXT_URL ?? "http://127.0.0.1:8787")}`,
    "-c", `${server}.enabled_tools=${JSON.stringify(arm === "seed" ? ["recall", "remember"] : ["recall"])}`,
  );
}
args.push("-");

await mkdir(outputDirectory, { recursive: true });
const prompt = (await readFile(promptPath, "utf8")).replaceAll("{{PROJECT_PATH}}", resolve(cwd));
const eventLog = createWriteStream(resolve(outputDirectory, "events.jsonl"));
const errorLog = createWriteStream(resolve(outputDirectory, "stderr.log"));
const start = Date.now();
const child = spawn("codex", args, {
  cwd: resolve(cwd),
  env: Object.fromEntries(Object.entries(process.env).filter(([key]) => arm !== "baseline" || key !== "GOOD_CONTEXT_URL")),
  stdio: ["pipe", "pipe", "pipe"],
});
const closePromise = once(child, "close");
child.stdin.end(prompt);
child.stderr.pipe(errorLog);

const summary = {
  arm,
  model,
  cwd: resolve(cwd),
  started_at: new Date(start).toISOString(),
  exit_code: null,
  elapsed_seconds: null,
  usage: null,
  mcp_calls: [],
  commands: 0,
  final_message: null,
};
const itemStarts = new Map();

for await (const line of createInterface({ input: child.stdout })) {
  eventLog.write(`${line}\n`);
  let event;
  try { event = JSON.parse(line); } catch { continue; }
  if (event.type === "item.started" && event.item?.id) itemStarts.set(event.item.id, Date.now());
  if (event.type === "turn.completed") summary.usage = event.usage;
  if (event.type === "item.completed" && event.item?.type === "agent_message") {
    summary.final_message = event.item.text;
  }
  if (event.type === "item.completed" && event.item?.type === "mcp_tool_call") {
    const started = itemStarts.get(event.item.id);
    summary.mcp_calls.push({
      tool: event.item.tool,
      status: event.item.status,
      duration_ms: started ? Date.now() - started : null,
      error: event.item.error?.message ?? (event.item.status === "failed" ? event.item.result?.content?.[0]?.text ?? null : null),
    });
  }
  if (event.type === "item.completed" && event.item?.type === "command_execution") summary.commands++;
}

const [exitCode] = await closePromise;
summary.exit_code = exitCode;
summary.elapsed_seconds = Math.round((Date.now() - start) / 1000);
eventLog.end();
await Promise.all([finished(eventLog), finished(errorLog)]);
await writeFile(resolve(outputDirectory, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
if (exitCode !== 0) process.exitCode = exitCode ?? 1;
