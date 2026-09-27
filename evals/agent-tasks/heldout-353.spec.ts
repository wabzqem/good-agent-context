import type { Runner } from '../src/runner'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import prompts from '@posva/prompts'
import { afterAll, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  runner: undefined as Runner | undefined,
  storage: { lastRunCommand: undefined as string | undefined },
}))

vi.mock('@posva/prompts')
vi.mock('../src/runner', () => ({ runCli: (runner: Runner) => { state.runner = runner } }))
vi.mock('../src/storage', () => ({ load: async () => state.storage, dump: vi.fn() }))

await import('../src/commands/nr')
const root = await fs.mkdtemp(path.join(tmpdir(), 'ni-heldout-nr-'))
afterAll(async () => { await fs.rm(root, { recursive: true, force: true }) })

it('finds the nearest ancestor rather than the workspace root', async () => {
  const app = path.join(root, 'packages', 'app')
  const leaf = path.join(app, 'src', 'deep')
  await fs.mkdir(leaf, { recursive: true })
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { root: 'echo root' } }))
  await fs.writeFile(path.join(app, 'package.json'), JSON.stringify({ scripts: { test: 'echo app' } }))
  vi.mocked(prompts).mockResolvedValue({ fn: 'test' })

  const result = await state.runner!('npm', [], { cwd: leaf })
  expect(prompts).toHaveBeenCalledWith(expect.objectContaining({
    choices: [expect.objectContaining({ title: 'test' })],
  }))
  expect(result).toMatchObject({ command: 'npm', args: ['run', 'test'], cwd: app })
})
