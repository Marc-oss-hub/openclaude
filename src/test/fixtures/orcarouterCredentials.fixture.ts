import assert from 'node:assert/strict'
import type Anthropic from '@anthropic-ai/sdk'
import { createOpenAIShimClient } from '../../services/api/openaiShim.js'
import { enableConfigs, getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { applyConfigEnvironmentVariables, applySafeConfigEnvironmentVariables } from '../../utils/managedEnv.js'
import { applyStartupEnvFromProfile } from '../../utils/providerProfile.js'
import { applyActiveProviderProfileFromConfig, setActiveProviderProfile, updateProviderProfile } from '../../utils/providerProfiles.js'
import { getProviderValidationError } from '../../utils/providerValidation.js'
import { quote } from '../../utils/bash/shellQuote.js'
import { buildInheritedEnvVars } from '../../utils/swarm/spawnUtils.js'

const [scenario, provider = 'openai', option] = process.argv.slice(2)
const profile = {
  id: 'orca-process', name: 'Orca process', provider,
  baseUrl: 'https://api.orcarouter.ai/v1', model: 'openai/gpt-5.5',
  apiKey: 'selected-key',
}
enableConfigs()
getGlobalConfig() // Start the normal watcher before either process writes.
async function authorization() {
  let header: string | null = null
  globalThis.fetch = Object.assign(async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    header = new Headers(init?.headers).get('authorization')
    return Response.json({
      id: 'reply', model: profile.model,
      choices: [{ message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    })
  }, { preconnect: globalThis.fetch.preconnect })
  const client = createOpenAIShimClient({}) as Pick<Anthropic, 'messages'>
  await client.messages.create({
    model: profile.model, messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 32, stream: false,
  })
  return header
}
function activate() {
  saveGlobalConfig(current => ({
    ...current, providerProfiles: [profile], activeProviderProfileId: profile.id,
  }))
  setActiveProviderProfile(profile.id, { configDir: process.env.OPENCLAUDE_CONFIG_DIR })
}
function finish(value: unknown): never {
  console.log(JSON.stringify(value))
  process.exit(0)
}
if (scenario === 'pane-child') {
  applySafeConfigEnvironmentVariables()
  await applyStartupEnvFromProfile()
  finish({ validation: await getProviderValidationError(), authorization: await authorization() })
}
if (scenario === 'pane') {
  activate()
  // An existing tmux login shell has none of the leader's provider credentials.
  const child = Bun.spawnSync(['/bin/sh', '-c',
    'env ' + buildInheritedEnvVars() + ' ' +
    quote([process.execPath, import.meta.path, 'pane-child']),
  ], {
    env: Object.fromEntries([
      'PATH', 'NODE_ENV', 'TMPDIR', 'TMP', 'TEMP', 'CARGO_TARGET_DIR', 'GOCACHE',
      'GOMODCACHE', 'NPM_CONFIG_CACHE', 'BUN_INSTALL_CACHE_DIR', 'PIP_CACHE_DIR',
      'XDG_CACHE_HOME', 'BUN_RUNTIME_TRANSPILER_CACHE_PATH',
    ].map(key => [key, process.env[key]])),
    timeout: 10_000,
  })
  assert.equal(child.exitCode, 0, child.stderr.toString())
  finish(JSON.parse(child.stdout.toString()))
}
if (scenario === 'host-pre' || scenario === 'host-post') {
  if (option !== 'unmanaged') process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = '1'
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = profile.baseUrl
  process.env.OPENAI_MODEL = profile.model
  process.env.OPENAI_API_KEY = 'host-key'
  process.env.ORCAROUTER_API_KEY = 'host-key'
  saveGlobalConfig(current => ({ ...current, env: { ORCAROUTER_API_KEY: 'settings-key' } }))
  if (scenario === 'host-pre') applySafeConfigEnvironmentVariables()
  else applyConfigEnvironmentVariables()
  finish({ authorization: await authorization() })
}
if (scenario === 'edit') {
  const edited = updateProviderProfile(profile.id, { ...profile, apiKey: undefined })
  assert(edited)
  assert.equal(edited.apiKey, undefined)
  finish({ savedKeyRemoved: true, authorization: await authorization() })
}
if (scenario === 'remove-inherited') {
  activate()
  const child = Bun.spawnSync([process.execPath, import.meta.path, 'remove-aligned', provider, option], {
    env: process.env, timeout: 10_000,
  })
  assert.equal(child.exitCode, 0, child.stderr.toString())
  finish(JSON.parse(child.stdout.toString()))
}
if (scenario === 'remove') activate()
else {
  assert.equal(scenario, 'remove-aligned')
  applyActiveProviderProfileFromConfig()
}
if (option === 'generic-removed') delete process.env.OPENAI_API_KEY
if (option === 'replacement') {
  process.env.ORCAROUTER_API_KEY = 'replacement-shell-key'
  delete process.env.OPENAI_API_KEY
}
// Let the subsequent write have a newer timestamp than our write-through cache.
await Bun.sleep(30)
const child = Bun.spawnSync([process.execPath, import.meta.path, 'edit', provider], {
  env: process.env, timeout: 5_000,
})
assert.equal(child.exitCode, 0, child.stderr.toString())
const edited = JSON.parse(child.stdout.toString()) as { authorization: string | null }
assert.equal(edited.authorization, option === 'replacement' ? 'Bearer replacement-shell-key' : null)
const deadline = Date.now() + 5_000
while (getGlobalConfig().providerProfiles?.[0]?.apiKey && Date.now() < deadline) {
  await Bun.sleep(25)
}
assert.equal(getGlobalConfig().providerProfiles?.[0]?.apiKey, undefined)
applyConfigEnvironmentVariables()
finish({ authorization: await authorization() })
