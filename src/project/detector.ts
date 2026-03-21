/**
 * Detect the Magento 2 project root for a given file path.
 *
 * Walks up the directory tree from `startPath` until it finds a directory containing
 * `app/etc/di.xml` — the definitive marker of a Magento 2 project root.
 *
 * This is the same detection strategy used in the Neovim LSP config for Intelephense,
 * ensuring both LSPs agree on the project root.
 */

import * as fs from 'fs';
import * as path from 'path';

/**
 * @param startPath - A directory path to start searching from (typically the dir of an open file).
 * @returns The absolute path to the Magento root, or undefined if not found.
 */
export function detectMagentoRoot(startPath: string): string | undefined {
  let current = path.resolve(startPath);

  // Walk up until we reach the filesystem root (where dirname === itself)
  while (current !== path.dirname(current)) {
    const diXmlPath = path.join(current, 'app', 'etc', 'di.xml');
    try {
      fs.accessSync(diXmlPath, fs.constants.R_OK);
      return current;
    } catch {
      // app/etc/di.xml not found at this level, continue walking up
    }
    current = path.dirname(current);
  }

  return undefined;
}
