import { access, readFile } from 'node:fs/promises';

export function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function readFileIfExists(filePath: string, fallback = ''): Promise<string> {
  try {
    return await readFile(filePath, 'utf8');
  } catch {
    return fallback;
  }
}

export function isPidAlive(pid: number | null | undefined): boolean {
  if (!pid || !Number.isFinite(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function parseGitStatusPaths(stdout: string): string[] {
  const files = new Set<string>();
  for (const rawLine of stdout.split('\n').map(line => line.trimEnd()).filter(Boolean)) {
    const payload = rawLine.slice(3).trim();
    if (!payload) continue;
    const parts = payload.includes(' -> ') ? payload.split(' -> ') : [payload];
    for (const part of parts) {
      const normalized = part.replace(/^"+|"+$/g, '');
      if (normalized) {
        files.add(normalized);
      }
    }
  }
  return [...files];
}
