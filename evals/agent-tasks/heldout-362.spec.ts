import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

vi.mock('../src/detect', () => ({ detect: vi.fn(async () => undefined) }))

let root: string
const originalCwd = process.cwd()
const originalNiConfigFile = process.env.NI_CONFIG_FILE

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), 'ni-heldout-config-'))
  vi.stubEnv('HOME', path.join(root, 'home'))
  delete process.env.NI_CONFIG_FILE
  vi.resetModules()
})

afterEach(async () => {
  process.chdir(originalCwd)
  vi.unstubAllEnvs()
  if (originalNiConfigFile === undefined)
    delete process.env.NI_CONFIG_FILE
  else
    process.env.NI_CONFIG_FILE = originalNiConfigFile
  await fs.rm(root, { recursive: true, force: true })
})

async function rc(directory: string, contents: string) {
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(path.join(directory, '.nirc'), contents)
}

it('layers home, distant ancestor, and nearest keys, then environment', async () => {
  const project = path.join(root, 'project')
  const app = path.join(project, 'app')
  const leaf = path.join(app, 'src')
  await rc(path.join(root, 'home'), 'globalAgent=npm\nuseSfw=true\nnoLastCommand=true\n')
  await rc(project, 'globalAgent=yarn\ncatalog=false\n')
  await rc(app, 'globalAgent=pnpm\n')
  await fs.mkdir(leaf, { recursive: true })
  process.chdir(leaf)
  vi.stubEnv('NI_NO_LAST_COMMAND', 'false')

  const { getConfig } = await import('../src/config')
  expect(await getConfig()).toMatchObject({
    globalAgent: 'pnpm', useSfw: true, catalog: false, noLastCommand: false,
  })
})

it('refreshes when the working directory changes in one process', async () => {
  const first = path.join(root, 'first')
  const second = path.join(root, 'second')
  await rc(first, 'globalAgent=pnpm\n')
  await rc(second, 'globalAgent=bun\n')
  process.chdir(first)
  const { getConfig } = await import('../src/config')
  expect((await getConfig()).globalAgent).toBe('pnpm')
  process.chdir(second)
  expect((await getConfig()).globalAgent).toBe('bun')
})

it('uses an explicit NI_CONFIG_FILE without traversal', async () => {
  const project = path.join(root, 'project')
  const explicit = path.join(root, 'explicit.nirc')
  await rc(path.join(root, 'home'), 'globalAgent=yarn\n')
  await rc(project, 'globalAgent=pnpm\n')
  await fs.writeFile(explicit, 'globalAgent=bun\n')
  process.chdir(project)
  vi.stubEnv('NI_CONFIG_FILE', explicit)
  const { getConfig } = await import('../src/config')
  expect((await getConfig()).globalAgent).toBe('bun')
})
