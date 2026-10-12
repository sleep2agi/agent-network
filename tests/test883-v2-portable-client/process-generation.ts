// Read-only process identity observation, not a source-file mutation.
import { readFileSync } from 'node:fs';

/** Read-only diagnostics for known owned PIDs; no argv or credential values. */
export function observeGeneration(pid: number): { state: string; parent: string; ticks: string } | 'absent' {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    return { state: fields[0], parent: fields[1], ticks: fields[19] };
  } catch { return 'absent'; }
}

export function generationGone(p: { pid: number; ticks: string }): boolean {
  try {
    const stat = readFileSync(`/proc/${p.pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    // PID reuse is not the old generation. Zombies do not prove reaping.
    return fields[19] !== p.ticks;
  } catch { return true; }
}
