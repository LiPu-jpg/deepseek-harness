/** Offline profile updates preserve the previous dependency tree until acceptance. */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { assertProfileOffline, recordProfileHost, recoverProfileUpdate, stageProfileUpdate, withProfileUpdateLock } from '../src/profile-update.ts'

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'profile-update-'))
  onTestFinished(() => rm(home, { recursive: true, force: true }))
  const dir = join(home, 'desktop')
  await mkdir(join(dir, 'node_modules', 'plugin'), { recursive: true })
  await writeFile(join(dir, 'package.json'), '{"dependencies":{"plugin":"1"}}\n')
  await writeFile(join(dir, 'node_modules', 'plugin', 'package.json'), '{"version":"1"}\n')
  await writeFile(join(dir, 'cordis.patch.yml'), '[]\n')
  return { home, dir }
}

it('keeps the old tree readable until validation and retains it after commit', async () => {
  const { dir } = await fixture()
  const old = await readFile(join(dir, 'package.json'), 'utf8')
  const result = await withProfileUpdateLock(dir, () => stageProfileUpdate(dir, async (staging) => {
    await writeFile(join(staging, 'package.json'), '{"dependencies":{"plugin":"2"}}\n')
    await writeFile(join(staging, 'node_modules', 'plugin', 'package.json'), '{"version":"2"}\n')
    expect(await readFile(join(dir, 'package.json'), 'utf8')).toBe(old)
    expect(await readFile(join(dir, 'node_modules', 'plugin', 'package.json'), 'utf8')).toContain('"1"')
    return { commit: true, value: 'accepted' }
  }))
  expect(result.committed).toBe(true)
  expect(await readFile(join(dir, 'node_modules', 'plugin', 'package.json'), 'utf8')).toContain('"2"')
  expect(await readFile(join(result.backup, 'package.json'), 'utf8')).toBe(old)
  expect(await readFile(join(dir, 'cordis.patch.yml'), 'utf8')).toBe('[]\n')
})

it('leaves all original files unchanged after rejection or an installer exception', async () => {
  const { dir } = await fixture()
  const before = await readFile(join(dir, 'package.json'), 'utf8')
  expect((await stageProfileUpdate(dir, async (staging) => {
    await rm(join(staging, 'node_modules'), { recursive: true })
    return { commit: false, value: 1 }
  })).committed).toBe(false)
  await expect(stageProfileUpdate(dir, async (staging) => {
    await rm(join(staging, 'package.json'))
    throw new Error('installer failed')
  })).rejects.toThrow('installer failed')
  expect(await readFile(join(dir, 'package.json'), 'utf8')).toBe(before)
  expect(await readFile(join(dir, 'node_modules', 'plugin', 'package.json'), 'utf8')).toContain('"1"')
})

it('refuses the running shell before copying or starting the installer', async () => {
  const { dir, home } = await fixture()
  await withProfileUpdateLock(dir, () => recordProfileHost(dir))
  await expect(assertProfileOffline(dir)).rejects.toMatchObject({ code: 'PROFILE_IN_USE' })
  let started = false
  await expect(stageProfileUpdate(dir, async () => { started = true; return { commit: true, value: 0 } })).rejects.toMatchObject({ code: 'PROFILE_IN_USE' })
  expect(started).toBe(false)
  expect((await readdir(home)).filter(name => name.includes('-stage-'))).toEqual([])
})

it('refuses incomplete host records instead of treating unknown liveness as stopped', async () => {
  const { dir, home } = await fixture()
  await writeFile(join(home, '.desktop.host.pid'), '')
  await expect(assertProfileOffline(dir)).rejects.toMatchObject({ code: 'PROFILE_IN_USE' })
})

it('restores the complete old profile after interruption between the two renames', async () => {
  const { dir, home } = await fixture()
  const stage = join(home, '.desktop-stage-abcdef')
  await mkdir(stage)
  const before = createHash('sha256').update(await readFile(join(dir, 'package.json'))).digest('hex')
  await writeFile(join(home, '.desktop.package-update.json'), JSON.stringify({ stage: '.desktop-stage-abcdef', before, after: createHash('sha256').update('next').digest('hex') }))
  await rename(dir, join(stage, 'previous'))
  await withProfileUpdateLock(dir, () => recoverProfileUpdate(dir))
  expect(await readFile(join(dir, 'node_modules', 'plugin', 'package.json'), 'utf8')).toContain('"1"')
  expect(await readdir(home)).not.toContain('.desktop.package-update.json')
})

it('keeps the journal and backup when a later edit makes recovery ambiguous', async () => {
  const { dir, home } = await fixture()
  await writeFile(join(home, '.desktop.package-update.json'), JSON.stringify({ stage: '.desktop-stage-abcdef', before: createHash('sha256').update('old').digest('hex'), after: createHash('sha256').update('next').digest('hex') }))
  await expect(recoverProfileUpdate(dir)).rejects.toThrow('profile changed after interruption')
  expect(await readdir(home)).toContain('.desktop.package-update.json')
})

it('retains internal and external relative links across the staging and final locations', async () => {
  const { dir, home } = await fixture()
  const external = join(home, 'external')
  await mkdir(external)
  await writeFile(join(external, 'value'), 'external')
  const internal = join(dir, 'node_modules', 'inside')
  const outside = join(dir, 'node_modules', 'outside')
  await symlink(process.platform === 'win32' ? join(dir, 'node_modules', 'plugin') : 'plugin', internal, process.platform === 'win32' ? 'junction' : undefined)
  await symlink(process.platform === 'win32' ? external : '../../external', outside, process.platform === 'win32' ? 'junction' : undefined)
  await stageProfileUpdate(dir, async (staging) => {
    expect(await readFile(join(staging, 'node_modules', 'inside', 'package.json'), 'utf8')).toContain('"1"')
    expect(await readFile(join(staging, 'node_modules', 'outside', 'value'), 'utf8')).toBe('external')
    return { commit: true, value: 0 }
  })
  expect(await readFile(join(dir, 'node_modules', 'inside', 'package.json'), 'utf8')).toContain('"1"')
  expect(await readFile(join(dir, 'node_modules', 'outside', 'value'), 'utf8')).toBe('external')
})

it('serializes shell launch with a package swap even while the target directory moves', async () => {
  const { dir } = await fixture()
  const entered = Promise.withResolvers<undefined>()
  const proceed = Promise.withResolvers<undefined>()
  let launched = false
  const update = withProfileUpdateLock(dir, () => stageProfileUpdate(dir, async () => {
    entered.resolve(undefined); await proceed.promise
    expect(launched).toBe(false)
    return { commit: true, value: 0 }
  }))
  await entered.promise
  const launch = withProfileUpdateLock(dir, async () => { launched = true; await recordProfileHost(dir) })
  proceed.resolve(undefined)
  await Promise.all([update, launch])
  expect(launched).toBe(true)
  await expect(assertProfileOffline(dir)).rejects.toMatchObject({ code: 'PROFILE_IN_USE' })
})


it('blocks replacement until a real process running from the profile exits', async () => {
  const { dir, home } = await fixture()
  const executable = process.platform === 'win32' ? join(dir, 'profile-node.exe') : process.execPath
  if (process.platform === 'win32') await copyFile(process.execPath, executable)
  const child = spawn(executable, ['-e', `
    require('node:fs').writeFileSync(process.argv[1], String(process.pid) + '\\n')
    process.stdout.write('ready')
    process.stdin.resume()
    process.stdin.on('end', () => process.exit(0))
    setTimeout(() => process.exit(1), 15000)
  `, join(home, '.desktop.host.pid')], { stdio: ['pipe', 'pipe', 'pipe'] })
  const closed = new Promise<void>((resolve) => { child.once('close', () => { resolve() }) })
  const ready = new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code) => { reject(new Error(`profile process exited before readiness: ${String(code)}`)) })
    child.stdout.once('data', () => { resolve() })
  })
  try {
    await ready
    await expect(withProfileUpdateLock(dir, () => stageProfileUpdate(dir, async () => ({ commit: true, value: 0 }))))
      .rejects.toMatchObject({ code: 'PROFILE_IN_USE' })
    child.stdin.end()
    await closed
    expect((await withProfileUpdateLock(dir, () => stageProfileUpdate(dir, async () => ({ commit: true, value: 0 })))).committed).toBe(true)
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await closed
  }
})


it('refuses a linked profile or node_modules before the installer can mutate their targets', async () => {
  const { dir, home } = await fixture()
  const alias = join(home, 'alias')
  await symlink(dir, alias, process.platform === 'win32' ? 'junction' : 'dir')
  let started = false
  const action = async () => { started = true; return { commit: true, value: 0 } }
  await expect(stageProfileUpdate(alias, action)).rejects.toThrow('physical profile directory')
  const modules = join(home, 'shared-modules')
  await rename(join(dir, 'node_modules'), modules)
  await symlink(modules, join(dir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  await expect(stageProfileUpdate(dir, action)).rejects.toThrow('linked node_modules')
  expect(started).toBe(false)
  expect(await readFile(join(modules, 'plugin', 'package.json'), 'utf8')).toContain('"1"')
})


it('refuses an external relative virtual store without running the installer', async () => {
  const { dir } = await fixture()
  await writeFile(join(dir, 'node_modules', '.modules.yaml'), 'virtualStoreDir: ../../shared-store\n')
  let started = false
  await expect(stageProfileUpdate(dir, async () => { started = true; return { commit: true, value: 0 } }))
    .rejects.toThrow('external virtual store')
  expect(started).toBe(false)
})
