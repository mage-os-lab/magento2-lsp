/**
 * Filesystem helper functions used across the LSP.
 *
 * These wrappers around Node's fs.statSync swallow errors and return a boolean,
 * which is the most common pattern in this codebase — we check existence before
 * reading, and a missing file is a normal (non-exceptional) condition.
 */

import * as fs from 'fs';

/**
 * Check whether a path exists and is a regular file.
 *
 * Returns false for directories, symlinks to directories, and paths that don't
 * exist or are inaccessible. Uses statSync (follows symlinks) so that symlinked
 * vendor packages resolve correctly.
 */
export function fileExists(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Check whether a path exists and is a directory.
 *
 * Returns false for regular files and paths that don't exist or are inaccessible.
 * Uses statSync (follows symlinks).
 */
export function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
