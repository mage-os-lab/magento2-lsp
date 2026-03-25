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
import * as fs from 'fs';

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

/**
 * Configuration for a generic XML file watcher that handles the common
 * read → parse → update index → update cache cycle.
 */
export interface XmlWatcherConfig<TContext, TResult> {
  /** Glob patterns and file paths to watch. */
  patterns: string[];
  /** Resolve a file path to its parse context. Return undefined to skip. */
  resolveContext: (file: string) => TContext | undefined;
  /** Parse file content with its context. */
  parse: (content: string, context: TContext) => TResult;
  /** Update the index and cache after a successful parse. */
  onParsed: (file: string, mtimeMs: number, result: TResult) => void;
  /** Remove the file from the index and cache. */
  onRemoved: (file: string) => void;
  /** Persist the cache to disk. */
  saveCache: () => void;
  /** Optional callback after each change/remove (e.g., rebuild plugin index). */
  afterChange?: () => void;
}

/**
 * Create a FileWatcher with the standard XML re-indexing lifecycle.
 * Handles reading the file, calling the parser, and updating the index/cache.
 */
export function createXmlWatcher<TContext, TResult>(
  config: XmlWatcherConfig<TContext, TResult>,
): FileWatcher {
  const watcher = new FileWatcher({
    onFileChange(filePath) {
      const context = config.resolveContext(filePath);
      if (!context) return;
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const stat = fs.statSync(filePath);
        const result = config.parse(content, context);
        config.onParsed(filePath, stat.mtimeMs, result);
        config.saveCache();
        config.afterChange?.();
      } catch {
        // File might be temporarily unreadable during write
      }
    },
    onFileRemove(filePath) {
      config.onRemoved(filePath);
      config.saveCache();
      config.afterChange?.();
    },
  });
  watcher.watch(config.patterns);
  return watcher;
}
