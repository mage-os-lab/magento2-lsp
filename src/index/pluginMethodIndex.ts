/**
 * Index mapping target class methods to the plugins that intercept them,
 * and reverse: plugin methods back to the target class methods they intercept.
 *
 * Magento plugins (interceptors) are declared in di.xml:
 *   <type name="Magento\Catalog\Model\Product">
 *     <plugin name="myPlugin" type="Vendor\Module\Plugin\ProductPlugin" />
 *   </type>
 *
 * The plugin PHP class then declares methods like beforeSave(), afterGetName(),
 * aroundLoad() — intercepting the corresponding methods on the target class.
 *
 * This index enables bidirectional navigation:
 *   - From intercepted method -> di.xml plugin declarations + plugin PHP methods
 *   - From plugin method (beforeSave) -> the target class method (save) it intercepts
 */

import * as fs from 'fs';
import { DiIndex } from './diIndex';
import { ClassHierarchy } from './classHierarchy';
import { DiReference } from '../indexer/types';
import { resolveClassFile } from '../indexer/phpClassLocator';
import { extractPhpMethods, getInterceptedMethodName, PhpMethodInfo } from '../utils/phpNamespace';
import { Psr4Map } from '../indexer/types';
import { yieldToEventLoop } from '../utils/async';

/** Info about a single plugin interception of a method. */
export interface PluginInterception {
  /** The before/after/around prefix. */
  prefix: 'before' | 'after' | 'around';
  /** The plugin class FQCN. */
  pluginFqcn: string;
  /** The di.xml reference for the <plugin type="..."> declaration. */
  diRef: DiReference;
  /** Location of the plugin method (e.g., beforeSave) in the plugin PHP file. */
  pluginMethodFile: string;
  pluginMethodLine: number;
  pluginMethodColumn: number;
  pluginMethodEndColumn: number;
  /** The plugin method name (e.g., "beforeSave"). */
  pluginMethodName: string;
}

/**
 * Reverse lookup entry: from a plugin method back to the target class and method.
 * Keyed by pluginFqcn + pluginMethodName in the reverse index.
 */
export interface ReversePluginEntry {
  /** The target class being intercepted. */
  targetFqcn: string;
  /** The target method being intercepted (e.g., "save"). */
  targetMethodName: string;
  /** The di.xml reference for the <plugin> declaration. */
  diRef: DiReference;
}

export class PluginMethodIndex {
  /**
   * Forward index: target class FQCN -> method name -> plugin interceptions.
   * Only stores DIRECT plugins (declared on the exact FQCN in di.xml).
   * Inherited plugins are resolved at query time via the class hierarchy.
   */
  private classMethodPlugins = new Map<string, Map<string, PluginInterception[]>>();

  /**
   * Reverse index: plugin class FQCN -> plugin method name -> reverse entry.
   * E.g., "Vendor\Plugin\ProductPlugin" -> "beforeSave" -> ReversePluginEntry
   */
  private reverseIndex = new Map<string, Map<string, ReversePluginEntry>>();

  /** Class hierarchy for resolving inherited plugins. */
  private hierarchy = new ClassHierarchy();

  /**
   * Tracks which di.xml files contributed plugin data for which target FQCNs.
   * Used by rebuildForFile() to know what to invalidate on incremental updates.
   */
  private fileToTargets = new Map<string, Set<string>>();

  /**
   * Build both forward and reverse indexes from the DI index.
   *
   * For each plugin-type reference in the DI index:
   *   1. Determine the target class (the <type name="..."> it's nested in)
   *   2. Resolve the plugin class to a PHP file via PSR-4
   *   3. Read the plugin PHP file and find its public methods
   *   4. Map before/after/around prefixed methods to the intercepted method names
   *   5. Store plugin method locations for forward navigation
   *   6. Build reverse entries for backward navigation
   */
  async build(diIndex: DiIndex, psr4Map: Psr4Map): Promise<void> {
    this.classMethodPlugins.clear();
    this.reverseIndex.clear();
    this.fileToTargets.clear();

    // Collect all plugin-type refs grouped by their target class
    const allPluginEntries = [...diIndex.getAllPluginRefsWithTargets()];
    const pluginsByTarget = new Map<string, DiReference[]>();
    for (const entry of allPluginEntries) {
      const existing = pluginsByTarget.get(entry.targetFqcn) ?? [];
      existing.push(entry.pluginRef);
      pluginsByTarget.set(entry.targetFqcn, existing);

      // Track file -> targets mapping
      const targets = this.fileToTargets.get(entry.pluginRef.file) ?? new Set();
      targets.add(entry.targetFqcn);
      this.fileToTargets.set(entry.pluginRef.file, targets);
    }

    // Build class hierarchy for all type-name FQCNs referenced in di.xml.
    // This lets us resolve inherited plugins: a plugin on an interface also
    // applies to all classes implementing that interface.
    const allTypeNames = new Set<string>();
    for (const entry of allPluginEntries) {
      allTypeNames.add(entry.targetFqcn);
    }
    // Also scan all type-name refs (classes configured in di.xml) since they
    // might implement interfaces that have plugins
    for (const ref of diIndex.getAllTypeNameFqcns()) {
      allTypeNames.add(ref);
    }
    await this.hierarchy.buildForClasses(allTypeNames, psr4Map);

    // For each target class, resolve its plugin classes and find intercepted methods
    let processed = 0;
    for (const [targetFqcn, pluginRefs] of pluginsByTarget) {
      const methodMap = new Map<string, PluginInterception[]>();

      for (const pluginRef of pluginRefs) {
        const pluginFilePath = resolveClassFile(pluginRef.fqcn, psr4Map);
        if (!pluginFilePath) continue;

        let methods: PhpMethodInfo[];
        try {
          const content = await fs.promises.readFile(pluginFilePath, 'utf-8');
          methods = extractPhpMethods(content);
        } catch {
          continue;
        }

        this.addPluginMethods(targetFqcn, pluginRef, pluginFilePath, methods, methodMap);
      }

      if (methodMap.size > 0) {
        this.classMethodPlugins.set(targetFqcn, methodMap);
      }

      if (++processed % 50 === 0) await yieldToEventLoop();
    }
  }

  /**
   * Incrementally rebuild plugin data for a single changed di.xml file.
   * Only re-processes targets affected by that file, leaving the rest intact.
   */
  async rebuildForFile(
    file: string,
    diIndex: DiIndex,
    psr4Map: Psr4Map,
  ): Promise<void> {
    // Collect old targets from this file
    const oldTargets = this.fileToTargets.get(file) ?? new Set<string>();

    // Collect new targets from the current DI index for this file
    const newTargets = new Set<string>();
    const newPluginsByTarget = new Map<string, DiReference[]>();
    const fileRefs = diIndex.getRefsForFile(file);
    for (const ref of fileRefs) {
      if (ref.kind === 'plugin-type' && ref.parentTypeFqcn) {
        newTargets.add(ref.parentTypeFqcn);
        const existing = newPluginsByTarget.get(ref.parentTypeFqcn) ?? [];
        existing.push(ref);
        newPluginsByTarget.set(ref.parentTypeFqcn, existing);
      }
    }

    // All affected targets = old union new
    const affectedTargets = new Set([...oldTargets, ...newTargets]);
    if (affectedTargets.size === 0) {
      this.fileToTargets.delete(file);
      return;
    }

    // Remove forward + reverse entries for affected targets
    for (const targetFqcn of affectedTargets) {
      const methodMap = this.classMethodPlugins.get(targetFqcn);
      if (methodMap) {
        // Remove reverse entries for plugins on this target
        for (const interceptions of methodMap.values()) {
          for (const i of interceptions) {
            const reverseMap = this.reverseIndex.get(i.pluginFqcn);
            if (reverseMap) {
              reverseMap.delete(i.pluginMethodName);
              if (reverseMap.size === 0) this.reverseIndex.delete(i.pluginFqcn);
            }
          }
        }
        this.classMethodPlugins.delete(targetFqcn);
      }
    }

    // Update file -> targets mapping
    if (newTargets.size > 0) {
      this.fileToTargets.set(file, newTargets);
    } else {
      this.fileToTargets.delete(file);
    }

    // Rebuild hierarchy for any newly-added FQCNs
    const newFqcns = [...newTargets].filter((t) => !oldTargets.has(t));
    if (newFqcns.length > 0) {
      await this.hierarchy.buildForClasses(newFqcns, psr4Map);
    }

    // Rebuild forward + reverse entries for affected targets using ALL plugin refs
    // (not just from the changed file — other files may also declare plugins for the same target)
    for (const targetFqcn of affectedTargets) {
      const allPluginRefs: DiReference[] = [];
      for (const entry of diIndex.getAllPluginRefsWithTargets()) {
        if (entry.targetFqcn === targetFqcn) {
          allPluginRefs.push(entry.pluginRef);
        }
      }

      if (allPluginRefs.length === 0) continue;

      const methodMap = new Map<string, PluginInterception[]>();
      for (const pluginRef of allPluginRefs) {
        const pluginFilePath = resolveClassFile(pluginRef.fqcn, psr4Map);
        if (!pluginFilePath) continue;

        let methods: PhpMethodInfo[];
        try {
          const content = await fs.promises.readFile(pluginFilePath, 'utf-8');
          methods = extractPhpMethods(content);
        } catch {
          continue;
        }

        this.addPluginMethods(targetFqcn, pluginRef, pluginFilePath, methods, methodMap);
      }

      if (methodMap.size > 0) {
        this.classMethodPlugins.set(targetFqcn, methodMap);
      }
    }
  }

  /**
   * Shared helper: process a plugin class's methods and populate the forward
   * and reverse indexes for a given target FQCN.
   */
  private addPluginMethods(
    targetFqcn: string,
    pluginRef: DiReference,
    pluginFilePath: string,
    methods: PhpMethodInfo[],
    methodMap: Map<string, PluginInterception[]>,
  ): void {
    // Set up reverse index map for this plugin class
    let reverseMap = this.reverseIndex.get(pluginRef.fqcn);
    if (!reverseMap) {
      reverseMap = new Map();
      this.reverseIndex.set(pluginRef.fqcn, reverseMap);
    }

    for (const method of methods) {
      const intercepted = getInterceptedMethodName(method.name);
      if (!intercepted) continue;

      // Forward index entry
      const interception: PluginInterception = {
        prefix: intercepted.prefix,
        pluginFqcn: pluginRef.fqcn,
        diRef: pluginRef,
        pluginMethodFile: pluginFilePath,
        pluginMethodLine: method.line,
        pluginMethodColumn: method.column,
        pluginMethodEndColumn: method.endColumn,
        pluginMethodName: method.name,
      };

      const interceptions = methodMap.get(intercepted.methodName) ?? [];
      interceptions.push(interception);
      methodMap.set(intercepted.methodName, interceptions);

      // Reverse index entry
      reverseMap.set(method.name, {
        targetFqcn,
        targetMethodName: intercepted.methodName,
        diRef: pluginRef,
      });
    }
  }

  /**
   * Get all plugin interceptions for a specific method on a class,
   * including plugins inherited from parent classes and implemented interfaces.
   */
  getPluginsForMethod(classFqcn: string, methodName: string): PluginInterception[] {
    const result: PluginInterception[] = [];

    // Direct plugins on this class
    const direct = this.classMethodPlugins.get(classFqcn)?.get(methodName);
    if (direct) result.push(...direct);

    // Inherited plugins from ancestors (parent classes + interfaces)
    for (const ancestor of this.hierarchy.getAncestors(classFqcn)) {
      const inherited = this.classMethodPlugins.get(ancestor)?.get(methodName);
      if (inherited) result.push(...inherited);
    }

    return result;
  }

  /**
   * Get all intercepted method names for a class (for code lens),
   * including methods intercepted via inherited plugins.
   */
  getInterceptedMethods(classFqcn: string): Map<string, PluginInterception[]> | undefined {
    // Merge direct + inherited into a single map
    const merged = new Map<string, PluginInterception[]>();
    const fqcnsToCheck = [classFqcn, ...this.hierarchy.getAncestors(classFqcn)];

    for (const fqcn of fqcnsToCheck) {
      const methodMap = this.classMethodPlugins.get(fqcn);
      if (methodMap) {
        for (const [methodName, interceptions] of methodMap) {
          const existing = merged.get(methodName) ?? [];
          existing.push(...interceptions);
          merged.set(methodName, existing);
        }
      }
    }

    return merged.size > 0 ? merged : undefined;
  }

  /**
   * Reverse lookup: given a plugin class and one of its methods (e.g., "beforeSave"),
   * find the target class and method it intercepts.
   */
  getReverseEntry(pluginFqcn: string, pluginMethodName: string): ReversePluginEntry | undefined {
    return this.reverseIndex.get(pluginFqcn)?.get(pluginMethodName);
  }

  /** Get all reverse entries for a plugin class (all methods it intercepts). */
  getAllReverseEntries(pluginFqcn: string): ReversePluginEntry[] {
    const map = this.reverseIndex.get(pluginFqcn);
    return map ? Array.from(map.values()) : [];
  }

  /**
   * Get the total number of unique plugin declarations targeting a class,
   * including inherited plugins from parent classes and interfaces.
   */
  getTotalPluginCount(classFqcn: string): number {
    const methods = this.getInterceptedMethods(classFqcn);
    if (!methods) return 0;
    const uniquePlugins = new Set<string>();
    for (const interceptions of methods.values()) {
      for (const i of interceptions) {
        uniquePlugins.add(`${i.diRef.file}:${i.diRef.line}`);
      }
    }
    return uniquePlugins.size;
  }

  /** Check if a class has any plugins (direct or inherited). */
  hasPlugins(classFqcn: string): boolean {
    if (this.classMethodPlugins.has(classFqcn)) return true;
    // Check ancestors
    for (const ancestor of this.hierarchy.getAncestors(classFqcn)) {
      if (this.classMethodPlugins.has(ancestor)) return true;
    }
    return false;
  }

  /** Check if a class is a known plugin class (has entries in the reverse index). */
  isPluginClass(pluginFqcn: string): boolean {
    return this.reverseIndex.has(pluginFqcn);
  }

  /** Get all ancestor FQCNs (parent classes + interfaces) for a class. */
  getAncestors(classFqcn: string): string[] {
    return this.hierarchy.getAncestors(classFqcn);
  }

  /** Ensure a class has been scanned for hierarchy data (extends/implements). */
  async ensureScanned(fqcn: string, psr4Map: Psr4Map): Promise<void> {
    await this.hierarchy.buildForClasses([fqcn], psr4Map);
  }

  /** Get the direct parent class FQCN, or undefined if none. */
  getParent(fqcn: string): string | undefined {
    return this.hierarchy.getParent(fqcn);
  }

  /** Get the directly implemented interface FQCNs. */
  getInterfaces(fqcn: string): string[] {
    return this.hierarchy.getInterfaces(fqcn);
  }

  /** Invalidate hierarchy data for a class (e.g., when its PHP file changes). */
  invalidateHierarchy(fqcn: string): void {
    this.hierarchy.invalidateClass(fqcn);
  }
}
