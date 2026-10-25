import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const fixture = fileURLToPath(new URL('../test/fixtures/orcarouterCredentials.fixture.ts', import.meta.url))
const childEnvKeys = [
  'PATH', 'TMPDIR', 'TMP', 'TEMP', 'CARGO_TARGET_DIR', 'GOCACHE', 'GOMODCACHE',
  'NPM_CONFIG_CACHE', 'BUN_INSTALL_CACHE_DIR', 'PIP_CACHE_DIR', 'XDG_CACHE_HOME',
  'BUN_RUNTIME_TRANSPILER_CACHE_PATH',
]
function run(scenario: string, provider = 'openai', option = '') {
  const configDir = mkdtempSync(join(tmpdir(), 'orca-credentials-'))
  try {
    const child = Bun.spawnSync([process.execPath, fixture, scenario, provider, option], {
      env: {
        ...Object.fromEntries(childEnvKeys.map(key => [key, process.env[key]])),
        OPENCLAUDE_CONFIG_DIR: configDir, NODE_ENV: 'development',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      },
      // Real config polling and a second executable need more than the default
      // test deadline: child deadline 15s, test deadline 20s allows teardown.
      timeout: 15_000,
    })
    expect(child.exitCode, child.stderr.toString()).toBe(0)
    return JSON.parse(child.stdout.toString().trim()) as Record<string, unknown>
  } finally {
    rmSync(configDir, { recursive: true, force: true })
  }
}
test.skipIf(process.platform === 'win32')('Orca pane inheritance authenticates after real child startup', () => {
  const result = run('pane')
  expect(result.validation).toBeNull()
  expect(result.authorization).toBe('Bearer selected-key')
}, 20_000)

for (const phase of ['host-pre', 'host-post']) {
  test.each([true, false])(`Orca ${phase} settings merge preserves credential ownership (host managed: %s)`, managed => {
    expect(run(phase, 'openai', managed ? '' : 'unmanaged').authorization)
      .toBe(managed ? 'Bearer host-key' : 'Bearer settings-key')
  }, 20_000)
}
for (const provider of ['openai', 'orcarouter']) {
  test(`${provider} Orca initializes ownership when startup inherits an aligned profile`, () => {
    expect(run('remove-inherited', provider, 'generic-removed').authorization).toBeNull()
  }, 20_000)
  test.each(['', 'generic-removed', 'replacement'])(
    `${provider} Orca reconciles another process's key removal (%s)`, option => {
      expect(run('remove', provider, option).authorization)
        .toBe(option === 'replacement' ? 'Bearer replacement-shell-key' : null)
    }, 20_000)
}
