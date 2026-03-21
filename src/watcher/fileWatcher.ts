/**
 * File watcher for automatic re-indexing of di.xml files.
 *
 * Uses chokidar to monitor di.xml files for changes. When a file is modified or added,
 * it's re-parsed and the index + cache are updated. When a file is deleted, its entries
 * are removed from the index and cache.
 *
 * The awaitWriteFinish option adds a small delay before processing changes, preventing
 * partial reads when editors write files in multiple steps (write temp file + rename).
 */

import * as chokidar from 'chokidar';
import * as fs from 'fs';
import { DiIndex } from '../index/diIndex';
import { IndexCache } from '../cache/indexCache';
import { parseDiXml, DiXmlParseContext } from '../indexer/diXmlParser';

export interface FileWatcherOptions {
  /** The project's DI index to update on file changes. */
  index: DiIndex;
  /** The project's disk cache to update alongside the index. */
  cache: IndexCache;
  /**
   * Returns the parse context (area, module, moduleOrder) for a given di.xml file path.
   * Returns undefined if the file is not recognized as belonging to any active module.
   */
  getContext: (file: string) => DiXmlParseContext | undefined;
}

export class FileWatcher {
  private watcher: chokidar.FSWatcher | undefined;

  constructor(private options: FileWatcherOptions) {}

  /**
   * Start watching the given file paths/glob patterns.
   * ignoreInitial=true prevents re-indexing files that were already indexed at startup.
   */
  watch(patterns: string[]): void {
    this.watcher = chokidar.watch(patterns, {
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 300,
        pollInterval: 100,
      },
    });

    this.watcher.on('change', (filePath) => this.onFileChange(filePath));
    this.watcher.on('add', (filePath) => this.onFileChange(filePath));
    this.watcher.on('unlink', (filePath) => this.onFileRemove(filePath));
  }

  /** Re-parse a changed/added di.xml file and update the index + cache. */
  private onFileChange(filePath: string): void {
    const context = this.options.getContext(filePath);
    if (!context) return;

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const stat = fs.statSync(filePath);
      const result = parseDiXml(content, context);

      // Remove old data first, then add new data
      this.options.index.removeFile(filePath);
      this.options.index.addFile(
        filePath,
        result.references,
        result.virtualTypes,
      );
      this.options.cache.setCachedEntry(
        filePath,
        stat.mtimeMs,
        result.references,
        result.virtualTypes,
      );
      this.options.cache.save();
    } catch {
      // File might be temporarily unreadable during write — skip silently
    }
  }

  /** Remove a deleted file's entries from the index and cache. */
  private onFileRemove(filePath: string): void {
    this.options.index.removeFile(filePath);
    this.options.cache.removeEntry(filePath);
    this.options.cache.save();
  }

  /** Stop watching and release resources. Called on LSP shutdown. */
  close(): void {
    this.watcher?.close();
  }
}
