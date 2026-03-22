/**
 * Resolve a path to its canonical (real) form, following symlinks.
 *
 * This is critical for environments where the workspace is accessed via a symlink
 * (e.g., /Users/vinai/Workspace -> /Volumes/CaseSensitive/Workspace). Without this,
 * the editor sends URIs with the resolved (real) path, but the indexer would store
 * paths using the symlink form — causing all index lookups to fail.
 *
 * Falls back to the original path if realpathSync fails (e.g., file doesn't exist yet).
 */

import * as fs from 'fs';

export function realpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}
