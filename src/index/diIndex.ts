/**
 * In-memory bidirectional index of all DI references across a Magento project.
 *
 * This index is the central data structure queried by the LSP handlers:
 *   - "Find references" uses getReferencesForFqcn() to return ALL di.xml locations for a class.
 *   - "Go to definition" uses getEffective*() to find the WINNING declaration after config merging.
 *
 * Magento's config merging rules (replicated here):
 *   1. Module load order: modules listed later in app/etc/config.php override earlier ones.
 *   2. Scoped overrides global: a declaration in etc/frontend/di.xml beats one in etc/di.xml.
 *
 * The index maintains four internal maps:
 *   - fqcnToRefs:        FQCN -> all DiReferences (for "find references")
 *   - virtualTypeDecls:  virtualType name -> all declarations
 *   - fileToRefs:        file path -> references in that file (for efficient per-file removal)
 *   - fileToVirtualTypes: file path -> virtualTypes in that file
 *
 * Plus an EffectiveConfig that caches the "winning" declaration for each preference,
 * plugin, and virtualType — rebuilt whenever the index changes.
 */

import { DiReference, VirtualTypeDecl } from '../indexer/types';

/**
 * Caches the winning (effective) declaration for each DI config element.
 * Keys encode the scope: e.g., "frontend:Magento\Store\Api\StoreManagerInterface"
 * so that scoped lookups can fall back to global.
 */
export interface EffectiveConfig {
  /** Key: `${area}:${interfaceFqcn}` -> the winning preference-type DiReference. */
  preferences: Map<string, DiReference>;
  /** Key: `${area}:${typeFqcn}:${pluginLine}` -> the winning plugin DiReference. */
  plugins: Map<string, DiReference>;
  /** Key: virtualType name -> the winning VirtualTypeDecl. */
  virtualTypes: Map<string, VirtualTypeDecl>;
}

export class DiIndex {
  /** FQCN -> all references to that class across all di.xml files. */
  private fqcnToRefs = new Map<string, DiReference[]>();
  /** VirtualType name -> all declarations (may have multiple from different modules). */
  private virtualTypeDecls = new Map<string, VirtualTypeDecl[]>();
  /** File path -> all references in that file (for efficient removal on re-index). */
  private fileToRefs = new Map<string, DiReference[]>();
  /** File path -> all virtualTypes in that file. */
  private fileToVirtualTypes = new Map<string, VirtualTypeDecl[]>();
  /** The "winning" config after merging — rebuilt on every index change. */
  private effective: EffectiveConfig = {
    preferences: new Map(),
    plugins: new Map(),
    virtualTypes: new Map(),
  };

  /** Add all references and virtualTypes from a single di.xml file. */
  addFile(
    file: string,
    refs: DiReference[],
    virtualTypes: VirtualTypeDecl[],
  ): void {
    this.fileToRefs.set(file, refs);
    this.fileToVirtualTypes.set(file, virtualTypes);

    for (const ref of refs) {
      const existing = this.fqcnToRefs.get(ref.fqcn);
      if (existing) {
        existing.push(ref);
      } else {
        this.fqcnToRefs.set(ref.fqcn, [ref]);
      }
    }

    for (const vt of virtualTypes) {
      const existing = this.virtualTypeDecls.get(vt.name);
      if (existing) {
        existing.push(vt);
      } else {
        this.virtualTypeDecls.set(vt.name, [vt]);
      }
    }

    this.rebuildEffective();
  }

  /**
   * Remove all references from a single file.
   * Called before re-parsing a changed file, so the old data is cleaned up.
   */
  removeFile(file: string): void {
    const refs = this.fileToRefs.get(file);
    if (refs) {
      for (const ref of refs) {
        const existing = this.fqcnToRefs.get(ref.fqcn);
        if (existing) {
          const filtered = existing.filter((r) => r.file !== file);
          if (filtered.length > 0) {
            this.fqcnToRefs.set(ref.fqcn, filtered);
          } else {
            this.fqcnToRefs.delete(ref.fqcn);
          }
        }
      }
      this.fileToRefs.delete(file);
    }

    const vts = this.fileToVirtualTypes.get(file);
    if (vts) {
      for (const vt of vts) {
        const existing = this.virtualTypeDecls.get(vt.name);
        if (existing) {
          const filtered = existing.filter((v) => v.file !== file);
          if (filtered.length > 0) {
            this.virtualTypeDecls.set(vt.name, filtered);
          } else {
            this.virtualTypeDecls.delete(vt.name);
          }
        }
      }
      this.fileToVirtualTypes.delete(file);
    }

    this.rebuildEffective();
  }

  /** Return ALL references to a FQCN (across all files and areas). Used by "find references". */
  getReferencesForFqcn(fqcn: string): DiReference[] {
    return this.fqcnToRefs.get(fqcn) ?? [];
  }

  /** Return all declarations of a virtualType (before merging). */
  getAllVirtualTypeDecls(name: string): VirtualTypeDecl[] {
    return this.virtualTypeDecls.get(name) ?? [];
  }

  /** Return the effective (winning) virtualType declaration after config merging. */
  getEffectiveVirtualType(name: string): VirtualTypeDecl | undefined {
    return this.effective.virtualTypes.get(name);
  }

  /**
   * Return the effective preference implementation for an interface in a given area.
   * Falls back to global scope if no area-specific preference exists.
   */
  getEffectivePreferenceType(
    interfaceFqcn: string,
    area: string,
  ): DiReference | undefined {
    return (
      this.effective.preferences.get(`${area}:${interfaceFqcn}`) ??
      this.effective.preferences.get(`global:${interfaceFqcn}`)
    );
  }

  /**
   * Return the effective plugin for a type+pluginName combination in a given area.
   * Falls back to global scope if no area-specific plugin exists.
   */
  getEffectivePlugin(
    typeFqcn: string,
    pluginName: string,
    area: string,
  ): DiReference | undefined {
    return (
      this.effective.plugins.get(`${area}:${typeFqcn}:${pluginName}`) ??
      this.effective.plugins.get(`global:${typeFqcn}:${pluginName}`)
    );
  }

  /**
   * Find which DiReference (if any) the cursor is on at a given position in a di.xml file.
   * Used by both definition and references handlers to determine what the user clicked on.
   */
  getReferenceAtPosition(
    file: string,
    line: number,
    col: number,
  ): DiReference | undefined {
    const refs = this.fileToRefs.get(file);
    if (!refs) return undefined;

    return refs.find(
      (r) => r.line === line && col >= r.column && col < r.endColumn,
    );
  }

  /**
   * Iterate all plugin-type references paired with their target class FQCN.
   * Used by PluginMethodIndex to build the method-level plugin mapping.
   */
  *getAllPluginRefsWithTargets(): Generator<{ targetFqcn: string; pluginRef: DiReference }> {
    for (const [file, refs] of this.fileToRefs) {
      for (const ref of refs) {
        if (ref.kind === 'plugin-type') {
          const targetFqcn = this.findParentTypeName(ref, refs);
          if (targetFqcn) {
            yield { targetFqcn, pluginRef: ref };
          }
        }
      }
    }
  }

  /** Return all unique FQCNs that appear as type-name refs (classes configured in di.xml). */
  *getAllTypeNameFqcns(): Generator<string> {
    const seen = new Set<string>();
    for (const refs of this.fqcnToRefs.values()) {
      for (const ref of refs) {
        if (ref.kind === 'type-name' && !seen.has(ref.fqcn)) {
          seen.add(ref.fqcn);
          yield ref.fqcn;
        }
      }
    }
  }

  /** Get all DI references declared by a given module. */
  getReferencesByModule(moduleName: string): DiReference[] {
    const result: DiReference[] = [];
    for (const refs of this.fileToRefs.values()) {
      for (const ref of refs) {
        if (ref.module === moduleName) {
          result.push(ref);
        }
      }
    }
    return result;
  }

  /** Number of di.xml files currently indexed. */
  getFileCount(): number {
    return this.fileToRefs.size;
  }

  /** Remove all data from the index. */
  clear(): void {
    this.fqcnToRefs.clear();
    this.virtualTypeDecls.clear();
    this.fileToRefs.clear();
    this.fileToVirtualTypes.clear();
    this.effective.preferences.clear();
    this.effective.plugins.clear();
    this.effective.virtualTypes.clear();
  }

  /**
   * Rebuild the effective (merged) config from all current references.
   * Called after every addFile/removeFile. This is O(total references) but is fast
   * in practice because di.xml files are small and the total count is manageable (~600 files).
   */
  private rebuildEffective(): void {
    this.effective.preferences.clear();
    this.effective.plugins.clear();
    this.effective.virtualTypes.clear();

    // --- Preferences ---
    // Group by area:interfaceFqcn, then pick the winner (highest moduleOrder, scoped > global).
    const prefGroups = new Map<string, DiReference[]>();
    for (const refs of this.fqcnToRefs.values()) {
      for (const ref of refs) {
        if (ref.kind === 'preference-for' && ref.pairedFqcn) {
          // Find the matching preference-type on the same line in the same file
          const typeRef = this.findPairedTypeRef(ref);
          if (typeRef) {
            const key = `${ref.area}:${ref.fqcn}`;
            const group = prefGroups.get(key) ?? [];
            group.push(typeRef);
            prefGroups.set(key, group);
          }
        }
      }
    }
    for (const [key, group] of prefGroups) {
      const winner = this.pickWinner(group);
      if (winner) {
        this.effective.preferences.set(key, winner);
      }
    }

    // --- Plugins ---
    // Group by area:typeFqcn:line, then pick the winner.
    const pluginGroups = new Map<string, DiReference[]>();
    for (const refs of this.fqcnToRefs.values()) {
      for (const ref of refs) {
        if (ref.kind === 'plugin-type') {
          const fileRefs = this.fileToRefs.get(ref.file) ?? [];
          // Determine which <type> element this plugin belongs to
          const parentType = this.findParentTypeName(ref, fileRefs);
          if (parentType) {
            const key = `${ref.area}:${parentType}:${ref.line}`;
            const group = pluginGroups.get(key) ?? [];
            group.push(ref);
            pluginGroups.set(key, group);
          }
        }
      }
    }
    for (const [key, group] of pluginGroups) {
      const winner = this.pickWinner(group);
      if (winner) {
        this.effective.plugins.set(key, winner);
      }
    }

    // --- VirtualTypes ---
    for (const [name, decls] of this.virtualTypeDecls) {
      const winner = this.pickWinnerVt(decls);
      if (winner) {
        this.effective.virtualTypes.set(name, winner);
      }
    }
  }

  /**
   * For a preference-for reference, find the corresponding preference-type reference
   * on the same line in the same file. These two always appear together on the same
   * <preference> element.
   */
  private findPairedTypeRef(forRef: DiReference): DiReference | undefined {
    const fileRefs = this.fileToRefs.get(forRef.file) ?? [];
    return fileRefs.find(
      (r) =>
        r.kind === 'preference-type' &&
        r.line === forRef.line &&
        r.file === forRef.file,
    );
  }

  /**
   * Find the <type name="..."> that contains a given <plugin> element.
   * Since plugins are nested inside type elements, we find the closest type-name
   * reference that appears on a line before (or equal to) the plugin's line.
   */
  private findParentTypeName(
    pluginRef: DiReference,
    fileRefs: DiReference[],
  ): string | undefined {
    let closest: DiReference | undefined;
    for (const r of fileRefs) {
      if (r.kind === 'type-name' && r.line <= pluginRef.line) {
        if (!closest || r.line > closest.line) {
          closest = r;
        }
      }
    }
    return closest?.fqcn;
  }

  /**
   * Config merging: pick the winning DiReference from a group of competing declarations.
   * Rules: scoped (non-global) beats global; among same scope level, higher moduleOrder wins.
   */
  private pickWinner(refs: DiReference[]): DiReference | undefined {
    if (refs.length === 0) return undefined;
    if (refs.length === 1) return refs[0];

    return refs.reduce((best, current) => {
      if (best.area !== 'global' && current.area === 'global') return best;
      if (best.area === 'global' && current.area !== 'global') return current;
      return current.moduleOrder >= best.moduleOrder ? current : best;
    });
  }

  /** Same merging logic as pickWinner, but for VirtualTypeDecl. */
  private pickWinnerVt(decls: VirtualTypeDecl[]): VirtualTypeDecl | undefined {
    if (decls.length === 0) return undefined;
    if (decls.length === 1) return decls[0];

    return decls.reduce((best, current) => {
      if (best.area !== 'global' && current.area === 'global') return best;
      if (best.area === 'global' && current.area !== 'global') return current;
      return current.moduleOrder >= best.moduleOrder ? current : best;
    });
  }
}
