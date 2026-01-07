import fs from 'node:fs';
import { UserError } from 'fastmcp';
import type { drive_v3 } from 'googleapis';

type AllowlistState = {
  enabled: boolean;
  ids: Set<string>;
  sources: string[];
  error?: string;
};

type FileNode = {
  id: string;
  parents: string[];
};

const ENV_ALLOWLIST = 'GOOGLE_DRIVE_WRITE_ALLOWLIST';
const ENV_ALLOWLIST_PATH = 'GOOGLE_DRIVE_WRITE_ALLOWLIST_PATH';

const allowlistState = loadAllowlistState();
const parentCache = new Map<string, FileNode>();
let rootResolved = false;

export function getWriteAllowlistSummary(): string {
  if (!allowlistState.enabled) {
    return 'Write allowlist: disabled (full write access).';
  }

  if (allowlistState.error) {
    return `Write allowlist: ERROR (${formatSources(allowlistState)}): ${allowlistState.error}. Writes will be blocked.`;
  }

  if (allowlistState.ids.size === 0) {
    return `Write allowlist: enabled but empty (${formatSources(allowlistState)}). Writes will be blocked.`;
  }

  return `Write allowlist: enabled (${allowlistState.ids.size} ID${allowlistState.ids.size === 1 ? '' : 's'}).`;
}

export async function assertWriteAccessForFile(
  drive: drive_v3.Drive,
  fileId: string,
  actionDescription: string
): Promise<void> {
  await assertWriteAccessInternal(drive, [fileId], actionDescription, 'file');
}

export async function assertWriteAccessForParent(
  drive: drive_v3.Drive,
  parentId: string | undefined,
  actionDescription: string
): Promise<void> {
  const targetId = parentId ?? 'root';
  await assertWriteAccessInternal(drive, [targetId], actionDescription, 'parent');
}

export async function assertWriteAccessForParents(
  drive: drive_v3.Drive,
  parentIds: string[] | undefined,
  actionDescription: string
): Promise<void> {
  const targets = parentIds && parentIds.length > 0 ? parentIds : ['root'];
  await assertWriteAccessInternal(drive, targets, actionDescription, 'parents');
}

function loadAllowlistState(): AllowlistState {
  const sources: string[] = [];
  const errors: string[] = [];
  let enabled = false;
  const ids: string[] = [];

  const allowlistValue = process.env[ENV_ALLOWLIST];
  const allowlistPath = process.env[ENV_ALLOWLIST_PATH];

  if (allowlistValue !== undefined) {
    enabled = true;
    sources.push(`env:${ENV_ALLOWLIST}`);
    try {
      ids.push(...parseAllowlistInput(allowlistValue));
    } catch (error: any) {
      errors.push(error.message || String(error));
    }
  }

  if (allowlistPath !== undefined) {
    enabled = true;
    sources.push(`file:${allowlistPath}`);
    try {
      const fileContents = fs.readFileSync(allowlistPath, 'utf8');
      ids.push(...parseAllowlistInput(fileContents));
    } catch (error: any) {
      errors.push(`Failed to read ${allowlistPath}: ${error.message || String(error)}`);
    }
  }

  const normalizedIds = new Set(
    ids
      .map((id) => id.trim())
      .filter((id) => id.length > 0)
  );

  return {
    enabled,
    ids: normalizedIds,
    sources,
    error: errors.length > 0 ? errors.join(' ') : undefined,
  };
}

function parseAllowlistInput(rawValue: string): string[] {
  const trimmed = rawValue.trim();
  if (!trimmed) {
    return [];
  }

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed);

    if (Array.isArray(parsed)) {
      return parsed.map(String);
    }

    if (typeof parsed === 'object' && parsed !== null) {
      const ids = extractIds(parsed as Record<string, unknown>);
      return ids.map(String);
    }

    if (typeof parsed === 'string') {
      return [parsed];
    }

    throw new Error('Allowlist JSON must be an array or object with ids/files/folders.');
  }

  return splitList(trimmed);
}

function extractIds(parsed: Record<string, unknown>): string[] {
  const ids: string[] = [];
  const fields = ['ids', 'files', 'folders'];
  for (const field of fields) {
    const value = parsed[field];
    if (Array.isArray(value)) {
      ids.push(...value.map(String));
    } else if (typeof value === 'string') {
      ids.push(value);
    }
  }
  return ids;
}

function splitList(rawValue: string): string[] {
  return rawValue
    .split(/[\n,]/)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

async function assertWriteAccessInternal(
  drive: drive_v3.Drive,
  targetIds: string[],
  actionDescription: string,
  targetLabel: 'file' | 'parent' | 'parents'
): Promise<void> {
  if (!allowlistState.enabled) {
    return;
  }

  if (allowlistState.error) {
    throw new UserError(
      `Write allowlist configuration error (${formatSources(allowlistState)}): ${allowlistState.error}. Writes are blocked.`
    );
  }

  if (allowlistState.ids.size === 0) {
    throw new UserError(
      `Write allowlist is enabled but empty (${formatSources(allowlistState)}). Configure ${ENV_ALLOWLIST} or ${ENV_ALLOWLIST_PATH} to permit writes.`
    );
  }

  await ensureRootResolved(drive, allowlistState.ids);

  for (const targetId of targetIds) {
    const allowed = await isIdWithinAllowlist(drive, targetId, allowlistState.ids);
    if (!allowed) {
      throw new UserError(
        `Write blocked by allowlist: ${actionDescription}. The target ${targetLabel} (${targetId}) is not within a whitelisted file or folder.`
      );
    }
  }
}

async function ensureRootResolved(drive: drive_v3.Drive, allowlistIds: Set<string>): Promise<void> {
  if (rootResolved || !allowlistIds.has('root')) {
    return;
  }

  const rootNode = await getFileNode(drive, 'root');
  if (rootNode.id && rootNode.id !== 'root') {
    allowlistIds.add(rootNode.id);
  }
  rootResolved = true;
}

async function isIdWithinAllowlist(
  drive: drive_v3.Drive,
  fileId: string,
  allowlistIds: Set<string>
): Promise<boolean> {
  const queue: string[] = [fileId];
  const seen = new Set<string>();

  while (queue.length > 0) {
    const currentId = queue.shift();
    if (!currentId || seen.has(currentId)) {
      continue;
    }
    seen.add(currentId);

    if (allowlistIds.has(currentId)) {
      return true;
    }

    const node = await getFileNode(drive, currentId);
    if (allowlistIds.has(node.id)) {
      return true;
    }

    for (const parentId of node.parents) {
      if (!seen.has(parentId)) {
        queue.push(parentId);
      }
    }
  }

  return false;
}

async function getFileNode(drive: drive_v3.Drive, fileId: string): Promise<FileNode> {
  const cached = parentCache.get(fileId);
  if (cached) {
    return cached;
  }

  try {
    const response = await drive.files.get({
      fileId,
      fields: 'id,parents',
      supportsAllDrives: true,
    });

    const node: FileNode = {
      id: response.data.id || fileId,
      parents: response.data.parents || [],
    };

    parentCache.set(fileId, node);
    if (node.id && node.id !== fileId) {
      parentCache.set(node.id, node);
    }

    return node;
  } catch (error: any) {
    const message = error.response?.data?.error?.message || error.message || 'Unknown error';
    if (error.code === 404) {
      throw new UserError(`Cannot verify allowlist: file not found (ID: ${fileId}).`);
    }
    if (error.code === 403) {
      throw new UserError(`Cannot verify allowlist: permission denied for file (ID: ${fileId}).`);
    }
    throw new UserError(`Cannot verify allowlist for file ${fileId}: ${message}`);
  }
}

function formatSources(state: AllowlistState): string {
  if (!state.sources.length) {
    return 'unknown source';
  }
  return state.sources.join(', ');
}
