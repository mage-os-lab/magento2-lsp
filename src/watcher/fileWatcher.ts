/**
 * Generic file watcher for automatic re-indexing.
 *
 * Uses chokidar to monitor files for changes. When a file is modified or added,
 * the onFileChange callback is invoked. When a file is deleted, onFileRemove is called.
 *
 * The awaitWriteFinish option adds a small delay before processing changes, preventing
 * partial reads when editors write files in multiple steps (write temp file + rename).
 */

import * as chokidar from 'chokidar';

export interface FileWatcherOptions {
  /** Called when a watched file is added or changed. */
  onFileChange: (filePath: string) => void;
  /** Called when a watched file is deleted. */
  onFileRemove: (filePath: string) => void;
}

export class FileWatcher {
  private watcher: chokidar.FSWatcher | undefined;

  constructor(private options: FileWatcherOptions) {}

  /**
   * Start watching the given file paths/glob patterns.
   * ignoreInitial=true prevents triggering for files that already exist at startup.
   */
  watch(patterns: string[]): void {
    this.watcher = chokidar.watch(patterns, {
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 300,
        pollInterval: 100,
      },
    });

    this.watcher.on('change', (filePath) => this.options.onFileChange(filePath));
    this.watcher.on('add', (filePath) => this.options.onFileChange(filePath));
    this.watcher.on('unlink', (filePath) => this.options.onFileRemove(filePath));
  }

  /** Stop watching and release resources. Called on LSP shutdown. */
  close(): void {
    this.watcher?.close();
  }
}
