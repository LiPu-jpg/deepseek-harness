/** Offline profile package replacement and launch coordination. */
import { createHash } from 'node:crypto'
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, rm, stat, symlink, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import * as yaml from 'js-yaml'

const fingerprint = (value: string): string => createHash('sha256').update(value).digest('hex')
const marker = (dir: string): string => join(dirname(dir), `.${basename(dir)}.host.pid`)
const journal = (dir: string): string => join(dirname(dir), `.${basename(dir)}.package-update.json`)

/** A live or uninspectable host prevents offline dependency replacement. */
export class ProfileInUseError extends Error {
  /** Stable identity for callers refusing a package write. */
  readonly code = 'PROFILE_IN_USE'
}

async function optional(path: string): Promise<string | undefined> {
  try { return await readFile(path, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

async function hostPid(dir: string): Promise<number | undefined> {
  const text = await optional(marker(dir))
  if (text === undefined) return undefined
  if (!/^[1-9]\d*\n$/.test(text) || Number(text.trim()) > 0x7fffffff) {
    throw new ProfileInUseError(`dsh: cannot inspect the profile host record ${marker(dir)}; repair it after quitting Desktop`)
  }
  return Number(text.trim())
}

/**
 * Refuse a live host, including an inaccessible PID; stale records remain harmless.
 * @param dir Profile directory whose host record is probed on this machine.
 * @throws ProfileInUseError until the recorded process has exited or its state is known.
 */
export async function assertProfileOffline(dir: string): Promise<void> {
  const pid = await hostPid(dir)
  if (pid === undefined) return
  try { process.kill(pid, 0) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return
    throw new ProfileInUseError(`dsh: cannot inspect profile host ${String(pid)}; fully quit DeepSeek Harness Desktop before updating plugins`, { cause: error })
  }
  throw new ProfileInUseError(`dsh: profile is in use by process ${String(pid)}; fully quit DeepSeek Harness Desktop before updating plugins`)
}

/**
 * Record the launching shell while holding withProfileUpdateLock; retain the record through process exit.
 * @param dir Profile directory; the sibling record stays outside directory swaps.
 */
export async function recordProfileHost(dir: string): Promise<void> {
  if (await hostPid(dir) !== process.pid) await assertProfileOffline(dir)
  await writeFileAtomic(marker(dir), `${String(process.pid)}\n`, { mode: 0o600 })
}

/**
 * Serialize launch preparation and offline replacement on a lock outside the replaceable directory.
 * @param dir Profile directory on this machine.
 * @param action Work performed exclusively, including any recovery.
 * @param waitMs Acquisition budget; omission uses the atomic writer's normal file-work bound.
 * @returns The action's result; throws without executing it when acquisition fails.
 */
export async function withProfileUpdateLock<T>(dir: string, action: () => Promise<T>, waitMs?: number): Promise<T> {
  await mkdir(dirname(dir), { recursive: true, mode: 0o700 })
  return withFileLock(join(dirname(dir), `.${basename(dir)}.package-update`), action, waitMs === undefined ? undefined : { waitMs })
}

/** Rebase only links and the pnpm store path owned by the copied profile. */
async function relocate(dir: string, previous: string, destination: string): Promise<void> {
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) {
        const target = await readlink(path)
        const original = isAbsolute(target) ? target : resolve(dirname(join(previous, relative(dir, path))), target)
        const next = original === previous || original.startsWith(previous + sep)
          ? join(destination, relative(previous, original)) : original
        const linkType = process.platform === 'win32' ? (await stat(path)).isDirectory() ? 'junction' : 'file' : undefined
        await unlink(path)
        await symlink(process.platform === 'win32' ? next : relative(dirname(join(destination, relative(dir, path))), next), path, linkType)
      } else if (entry.isDirectory()) await visit(path)
    }
  }
  await visit(dir)
}

/** Recover a directory swap while holding the update lock; never overwrite a later manifest. */
async function recover(dir: string): Promise<void> {
  const pending = await optional(journal(dir))
  if (pending === undefined) return
  const value: unknown = JSON.parse(pending)
  if (typeof value !== 'object' || value === null || !('stage' in value) || typeof value.stage !== 'string'
    || !value.stage.startsWith(`.${basename(dir)}-stage-`) || !/^[A-Za-z0-9]+$/.test(value.stage.slice(`.${basename(dir)}-stage-`.length))
    || !('before' in value) || typeof value.before !== 'string'
    || !('after' in value) || typeof value.after !== 'string'
    || !/^[a-f0-9]{64}$/.test(value.before) || !/^[a-f0-9]{64}$/.test(value.after)) throw new Error(`dsh: invalid package update journal ${journal(dir)}; preserve it for recovery`)
  const previous = join(dirname(dir), value.stage, 'previous')
  const current = await optional(join(dir, 'package.json'))
  if (current === undefined) {
    if (fingerprint(await readFile(join(previous, 'package.json'), 'utf8')) !== value.before) {
      throw new Error(`dsh: backup manifest changed; preserve ${previous} and ${journal(dir)} for recovery`)
    }
    await rename(previous, dir)
  }
  else if (![value.before, value.after].includes(fingerprint(current))) {
    throw new Error(`dsh: profile changed after interruption; preserve ${previous} and ${journal(dir)} for recovery`)
  }
  await rm(journal(dir))
}

/**
 * Finish or roll back an interrupted offline swap before profile initialization, under the update lock.
 * @param dir Profile directory; a complete replacement remains committed, a missing target restores the backup.
 * @throws When recovery cannot establish a complete profile; backups and journal are retained.
 */
export async function recoverProfileUpdate(dir: string): Promise<void> {
  if (await optional(journal(dir)) !== undefined) {
    await assertProfileOffline(dir)
    await recover(dir)
  }
}

/**
 * Run package work against a complete sibling copy, then commit only an accepted result.
 * Callers hold withProfileUpdateLock and own validation before returning commit=true.
 * @param dir Offline profile directory; manifests and dependencies remain unchanged during the action.
 * @param action Installation and validation against the copied profile.
 * @returns The action result and whether it committed; staging retains logs and the previous tree for recovery.
 * @throws Preparation/commit failures; an interrupted two-rename swap retains a recoverable journal.
 */
export async function stageProfileUpdate<T>(
  dir: string, action: (staging: string) => Promise<{ commit: boolean; value: T }>,
): Promise<{ committed: boolean; value: T; staging: string; backup: string }> {
  await recoverProfileUpdate(dir)
  await assertProfileOffline(dir)
  if ((await lstat(dir)).isSymbolicLink()) {
    throw new Error('dsh: offline updates require a physical profile directory; the linked profile was not changed')
  }
  dir = await realpath(dir)
  const modules = join(dir, 'node_modules')
  try {
    if ((await lstat(modules)).isSymbolicLink()) throw new Error('dsh: offline updates cannot replace a linked node_modules directory')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const before = await readFile(join(dir, 'package.json'), 'utf8')
  const stage = await mkdtemp(join(dirname(dir), `.${basename(dir)}-stage-`))
  const staging = join(stage, 'profile')
  const backup = join(stage, 'previous')
  await cp(dir, staging, { recursive: true, dereference: false, verbatimSymlinks: true,
    filter: path => path !== join(dir, 'lock') && path !== join(dir, 'package.json.lock') && path !== join(dir, '.plugin-manager') })
  await relocate(staging, dir, staging)
  const modulesPath = join(staging, 'node_modules', '.modules.yaml')
  const modulesText = await optional(modulesPath)
  if (modulesText !== undefined) {
    const modules: unknown = yaml.load(modulesText)
    if (typeof modules === 'object' && modules !== null && 'virtualStoreDir' in modules && typeof modules.virtualStoreDir === 'string') {
      const store = resolve(join(dir, 'node_modules'), modules.virtualStoreDir)
      if (!store.startsWith(dir + sep)) {
        throw new Error('dsh: cannot stage an external virtual store; keep the original profile and use a local store')
      }
      try {
        if ((await lstat(store)).isSymbolicLink()) throw new Error('dsh: offline updates cannot replace a linked virtual store')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      modules.virtualStoreDir = relative(join(dir, 'node_modules'), store)
      await writeFileAtomic(modulesPath, yaml.dump(modules), { mode: 0o600 })
    }
  }

  const result = await action(staging)
  if (!result.commit) return { committed: false, value: result.value, staging, backup }
  const after = await readFile(join(staging, 'package.json'), 'utf8')
  if (fingerprint(await readFile(join(dir, 'package.json'), 'utf8')) !== fingerprint(before)) {
    throw new Error('dsh: profile changed during staging; installation was not committed')
  }
  await assertProfileOffline(dir)
  await relocate(staging, staging, dir)
  const transaction = { stage: basename(stage), before: fingerprint(before), after: fingerprint(after) }
  await writeFileAtomic(journal(dir), JSON.stringify(transaction), { mode: 0o600 })
  try {
    await rename(dir, backup)
    await rename(staging, dir)
  } catch (error) {
    try { await recover(dir) } catch (recoveryError) {
      throw new AggregateError([error, recoveryError], `dsh: package replacement needs recovery; preserve ${backup} and ${journal(dir)}`)
    }
    throw error
  }
  try { await rm(journal(dir)) } catch (error) {
    throw new Error(`dsh: profile update committed but journal cleanup failed; retain ${backup} and ${journal(dir)}`, { cause: error })
  }
  return { committed: true, value: result.value, staging, backup }
}
