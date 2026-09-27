#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { createWriteStream, existsSync } from 'node:fs'
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const [task, checkout, output] = process.argv.slice(2)
if (!['353', '362', '368'].includes(task) || !checkout || !output) {
  process.stderr.write('Usage: node grade.mjs <353|362|368> <checkout> <output>\n')
  process.exit(64)
}

const source = resolve(fileURLToPath(import.meta.url), `../heldout-${task}.spec.ts`)
const target = resolve(checkout, 'test/gac-eval.hidden.spec.ts')
if (existsSync(target)) throw new Error(`Refusing to overwrite ${target}`)
await mkdir(output, { recursive: true })

function run(command, args, logPath) {
  return new Promise((resolveRun, reject) => {
    const log = createWriteStream(logPath)
    const child = spawn(command, args, { cwd: checkout, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.pipe(log, { end: false })
    child.stderr.pipe(log, { end: false })
    child.on('error', reject)
    child.on('close', (code) => {
      log.end()
      resolveRun(code)
    })
  })
}

let heldoutExit
try {
  await copyFile(source, target)
  heldoutExit = await run('pnpm', ['exec', 'vitest', 'run', 'test/gac-eval.hidden.spec.ts'], resolve(output, 'heldout.log'))
}
finally {
  await rm(target, { force: true })
}
const typecheckExit = await run('pnpm', ['typecheck'], resolve(output, 'typecheck.log'))
const result = { task, checkout, heldout_exit_code: heldoutExit, typecheck_exit_code: typecheckExit }
await writeFile(resolve(output, 'grade.json'), `${JSON.stringify(result, null, 2)}\n`)
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
