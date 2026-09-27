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
  root = await fs.mkdtemp(path.join(tmpdir(), 'ni-heldout-missing-config-'))
  vi.resetModules()
})

afterEach(async () => {
  process.chdir(originalCwd)
  vi.unstubAllEnvs()
  if (originalNiConfigFile === undefined)
    delete process.env.NI_CONFIG_FILE
  else
    process.env.NI_CONFIG_FILE = originalNiConfigFile
  vi.restoreAllMocks()
  await fs.rm(root, { recursive: true, force: true })
})

it('warns for a missing explicit file without falling back to discovered files', async () => {
  const project = path.join(root, 'project')
  await fs.mkdir(project)
  await fs.writeFile(path.join(project, '.nirc'), 'globalAgent=pnpm\n')
  const missing = path.join(root, 'missing.nirc')
  process.chdir(project)
  vi.stubEnv('NI_CONFIG_FILE', missing)
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

  const { getConfig } = await import('../src/config')
  expect((await getConfig()).globalAgent).toBe('npm')
  expect(warn.mock.calls.flat().join(' ')).toContain('NI_CONFIG_FILE')
  expect(warn.mock.calls.flat().join(' ')).toContain(missing)
  expect(warn.mock.calls.flat().join(' ').toLowerCase()).toMatch(/does not exist|not found|missing/)
})

it('resolves a relative explicit file against process.cwd()', async () => {
  const processDir = path.join(root, 'process')
  const targetDir = path.join(root, 'target')
  await fs.mkdir(processDir)
  await fs.mkdir(targetDir)
  await fs.writeFile(path.join(processDir, 'custom.nirc'), 'globalAgent=bun\n')
  await fs.writeFile(path.join(targetDir, 'custom.nirc'), 'globalAgent=pnpm\n')
  process.chdir(processDir)
  vi.stubEnv('NI_CONFIG_FILE', 'custom.nirc')
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

  const { getConfig } = await import('../src/config')
  expect((await getConfig()).globalAgent).toBe('bun')
  expect(warn).not.toHaveBeenCalled()
})
