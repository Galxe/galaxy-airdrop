import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';

export const json = value => JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item);

export function acquireLock(dir) {
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, '.writer-lock');
  try { mkdirSync(lock); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let owner;
    try { owner = JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8')); } catch { /* Incomplete lock requires manual inspection. */ }
    if (owner?.host === hostname() && Number.isSafeInteger(owner.pid) && owner.pid > 0) {
      let alive = true;
      try { process.kill(owner.pid, 0); } catch (failure) { if (failure.code === 'ESRCH') alive = false; }
      if (!alive) {
        rmSync(lock, { recursive: true });
        return acquireLock(dir);
      }
    }
    throw new Error(`Run directory locked: ${lock}. Verify no collector is running before removing a stale lock.`);
  }
  writeFileSync(join(lock, 'owner.json'), json({ pid: process.pid, host: hostname() }));
  return () => rmSync(lock, { recursive: true, force: true });
}
