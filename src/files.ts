// Workspace-confined file access for release bodies and assets.
import { glob, readFile, realpath, stat } from 'node:fs/promises';
import { basename, extname, resolve, sep } from 'node:path';

export interface Asset {
  path: string;
  name: string;
  size: number;
  contentType: string;
}

export const MAX_ASSET_BYTES = 2 * 1024 ** 3;
export const MAX_ASSETS = 1000;
const MAX_BODY_FILE_BYTES = 1024 ** 2;

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.7z': 'application/x-7z-compressed',
  '.bz2': 'application/x-bzip2',
  '.deb': 'application/vnd.debian.binary-package',
  '.dmg': 'application/x-apple-diskimage',
  '.exe': 'application/vnd.microsoft.portable-executable',
  '.gz': 'application/gzip',
  '.jar': 'application/java-archive',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.msi': 'application/x-msi',
  '.pdf': 'application/pdf',
  '.pem': 'application/x-pem-file',
  '.png': 'image/png',
  '.rpm': 'application/x-rpm',
  '.svg': 'image/svg+xml',
  '.tar': 'application/x-tar',
  '.tgz': 'application/gzip',
  '.txt': 'text/plain',
  '.wasm': 'application/wasm',
  '.xz': 'application/x-xz',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.zip': 'application/zip',
  '.zst': 'application/zstd',
};

export const contentType = (name: string): string => CONTENT_TYPES[extname(name).toLowerCase()] ?? 'application/octet-stream';

/** Sanitized up front so GitHub keeps the name as-is and name checks are reliable. */
export function assetName(file: string): string {
  const name = basename(file).replace(/[^A-Za-z0-9._+-]/g, '.').replace(/^\.+|\.+$/g, '');
  if (!name) throw new Error(`asset '${file}' has no usable name`);
  return name;
}

async function confine(root: string, candidate: string): Promise<string> {
  const full = await realpath(candidate);
  if (full !== root && !full.startsWith(root.endsWith(sep) ? root : root + sep)) {
    throw new Error(`'${candidate}' resolves outside the workspace`);
  }
  return full;
}

export async function readBodyFile(workspace: string, file: string): Promise<string> {
  const root = await realpath(workspace);
  const full = await confine(root, resolve(root, file));
  const info = await stat(full);
  if (!info.isFile()) throw new Error(`release-body-file '${file}' is not a regular file`);
  if (info.size > MAX_BODY_FILE_BYTES) throw new Error(`release-body-file '${file}' is larger than 1 MiB`);
  return readFile(full, 'utf8');
}

export async function resolveAssets(workspace: string, patterns: readonly string[]): Promise<Asset[]> {
  if (!patterns.length) return [];
  const root = await realpath(workspace);
  const byName = new Map<string, Asset>();
  for (const pattern of patterns) {
    let matched = 0;
    for await (const rel of glob(pattern, { cwd: root })) {
      const full = await confine(root, resolve(root, rel));
      const info = await stat(full);
      if (info.isDirectory()) continue;
      if (!info.isFile()) throw new Error(`asset '${rel}' is not a regular file`);
      if (info.size === 0) throw new Error(`asset '${rel}' is empty`);
      if (info.size > MAX_ASSET_BYTES) throw new Error(`asset '${rel}' is larger than 2 GiB`);
      matched++;
      const name = assetName(rel);
      const seen = byName.get(name);
      if (seen && seen.path !== full) throw new Error(`assets '${seen.path}' and '${full}' would both be named '${name}'`);
      byName.set(name, { path: full, name, size: info.size, contentType: contentType(name) });
    }
    if (!matched) throw new Error(`release-assets pattern '${pattern}' matched no files`);
  }
  if (byName.size > MAX_ASSETS) throw new Error(`a release can have at most ${MAX_ASSETS} assets`);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
