/**
 * Code action handler (textDocument/codeAction) and resolver (codeAction/resolve).
 *
 * Provides quick-fix actions for semantic diagnostics:
 *   - "Create class" for broken FQCN references (di.xml, events.xml, layout, system.xml, webapi.xml)
 *   - "Create observer class" for broken observer class references
 *   - "Create template" for broken template references in layout XML
 *   - "Add implements ObserverInterface" for observers missing the interface
 *
 * File creation actions use a two-step resolve pattern:
 *   1. textDocument/codeAction returns lightweight actions (no edit, just data)
 *   2. codeAction/resolve writes the file to disk when the user selects the action
 * This avoids creating files just by listing available actions, and prevents
 * duplication if the user invokes the action list multiple times.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  CodeAction,
  CodeActionKind,
  CodeActionParams,
  CancellationToken,
  TextEdit,
  WorkspaceEdit,
} from 'vscode-languageserver/node';
import { URI } from 'vscode-uri';
import { ProjectContext } from '../project/projectManager';
import { resolveExpectedClassPath } from '../indexer/phpClassLocator';
import { fileExists } from '../utils/fsHelpers';
import { renderTemplate, buildTemplateVariables } from '../templates/templateEngine';
import { resolveTemplate } from '../templates/templateResolver';
import { getSettings } from '../settings';
import {
  DIAG_CLASS_NOT_FOUND,
  DIAG_OBSERVER_CLASS_NOT_FOUND,
  DIAG_SERVICE_CLASS_NOT_FOUND,
  DIAG_MODEL_CLASS_NOT_FOUND,
  DIAG_TEMPLATE_NOT_FOUND,
  DIAG_OBSERVER_MISSING_INTERFACE,
  DIAG_MISSING_CSP_REGISTRATION,
  DIAG_MISSING_CSP_TYPE_HINT,
} from '../validation/diagnosticCodes';
import {
  FRONTEND_CSP_TAG,
  BASE_CSP_TAG,
  type CspArea,
} from '../validation/phtmlValidator';

/** Data payload attached to file-creation code actions, consumed by resolve. */
export interface CreateFileActionData {
  type: 'create-file';
  targetPath: string;
  content: string;
  /** URI of the document where the code action was invoked (for re-validation). */
  sourceUri: string;
}

/** Data payload for the "Add CSP registration" action, consumed by resolve. */
export interface CspRegistrationActionData {
  type: 'add-csp-registration';
  /** The WorkspaceEdit to apply — computed at action time, applied at resolve time. */
  edit: WorkspaceEdit;
  sourceUri: string;
}

/** Data payload for the "Add implements ObserverInterface" action. */
export interface AddInterfaceActionData {
  type: 'add-observer-interface';
  classFile: string;
  sourceUri: string;
}

export function handleCodeAction(
  params: CodeActionParams,
  getProject: (uri: string) => ProjectContext | undefined,
  getDocumentText?: (uri: string) => string | undefined,
  _token?: CancellationToken,
): CodeAction[] | null {
  const filePath = URI.parse(params.textDocument.uri).fsPath;
  const project = getProject(filePath);
  if (!project) return null;

  const actions: CodeAction[] = [];
  const templateDir = resolveTemplateDir(project.root);
  const sourceUri = params.textDocument.uri;
  // Track whether we've already built a CSP action (one action fixes all occurrences)
  let cspActionAdded = false;

  for (const diag of params.context.diagnostics) {
    if (diag.source !== 'magento2-lsp') continue;

    if (diag.code === DIAG_MISSING_CSP_REGISTRATION || diag.code === DIAG_MISSING_CSP_TYPE_HINT) {
      if (!cspActionAdded && getDocumentText) {
        const cspDiags = params.context.diagnostics.filter(
          (d) => d.source === 'magento2-lsp' && d.code === DIAG_MISSING_CSP_REGISTRATION,
        );
        const docText = getDocumentText(params.textDocument.uri);
        const cspArea = (diag.data as { cspArea?: CspArea } | undefined)?.cspArea;
        if (docText && cspArea) {
          const action = buildCspRegistrationAction(docText, cspArea, cspDiags, sourceUri);
          if (action) actions.push(action);
        }
        cspActionAdded = true;
      }
      continue;
    }

    // Other diagnostics carry data (fqcn, templateId, etc.) needed by their actions
    const data = diag.data as Record<string, string> | undefined;
    if (!data) continue;

    switch (diag.code) {
      case DIAG_CLASS_NOT_FOUND:
      case DIAG_SERVICE_CLASS_NOT_FOUND:
      case DIAG_MODEL_CLASS_NOT_FOUND: {
        const action = buildCreateClassAction(data.fqcn, 'class.php.tpl', sourceUri, project, templateDir);
        if (action) actions.push(action);
        break;
      }
      case DIAG_OBSERVER_CLASS_NOT_FOUND: {
        const action = buildCreateClassAction(data.fqcn, 'observer.php.tpl', sourceUri, project, templateDir);
        if (action) actions.push(action);
        break;
      }
      case DIAG_TEMPLATE_NOT_FOUND: {
        const action = buildCreateTemplateAction(data.templateId, data.area, filePath, sourceUri, project, templateDir);
        if (action) actions.push(action);
        break;
      }
      case DIAG_OBSERVER_MISSING_INTERFACE: {
        const action = buildAddObserverInterfaceAction(data.classFile, sourceUri);
        if (action) actions.push(action);
        break;
      }
    }
  }

  return actions.length > 0 ? actions : null;
}

/**
 * Resolve a code action by applying it to disk.
 * Called when the user selects an action from the list.
 *
 * The data payload round-trips through the LSP client, which could tamper with
 * paths. We validate that all target paths resolve to within the project root
 * before performing any filesystem writes.
 */
export function handleCodeActionResolve(
  action: CodeAction,
  getProject: (uri: string) => ProjectContext | undefined,
): CodeAction {
  const data = action.data as CreateFileActionData | AddInterfaceActionData | CspRegistrationActionData | undefined;
  if (!data) return action;

  const project = data.sourceUri ? getProject(URI.parse(data.sourceUri).fsPath) : undefined;

  if (data.type === 'create-file') {
    if (!isPathInsideProject(data.targetPath, project)) return action;
    try {
      fs.mkdirSync(path.dirname(data.targetPath), { recursive: true });
      fs.writeFileSync(data.targetPath, data.content, { flag: 'wx' });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') {
        process.stderr.write(`[magento2-lsp] Failed to create ${data.targetPath}: ${err}\n`);
      }
    }
  }

  if (data.type === 'add-observer-interface') {
    if (!isPathInsideProject(data.classFile, project)) return action;
    applyAddObserverInterface(data.classFile);
  }

  // CSP registration: return the pre-computed WorkspaceEdit so the editor
  // applies the text edits to the buffer (not written to disk).
  if (data.type === 'add-csp-registration') {
    action.edit = data.edit;
  }

  return action;
}

/** Check that a resolved path is within the project root to prevent path traversal. */
function isPathInsideProject(filePath: string, project: ProjectContext | undefined): boolean {
  if (!project) return false;
  const resolved = path.resolve(filePath);
  return resolved.startsWith(project.root + path.sep) || resolved === project.root;
}

// --- helpers ---

function resolveTemplateDir(projectRoot: string): string | undefined {
  const settings = getSettings();
  if (settings.templateDir) {
    return path.isAbsolute(settings.templateDir)
      ? settings.templateDir
      : path.join(projectRoot, settings.templateDir);
  }
  return undefined;
}

function findModuleForFqcn(fqcn: string, project: ProjectContext): string {
  for (const mod of project.modules) {
    for (const entry of project.psr4Map) {
      if (fqcn.startsWith(entry.prefix) && entry.path.startsWith(mod.path)) {
        return mod.name;
      }
    }
  }
  const parts = fqcn.split('\\');
  if (parts.length >= 2) return `${parts[0]}_${parts[1]}`;
  return '';
}

/**
 * Build a lightweight "Create class" action with data for resolve.
 * No edit — the file is written to disk in handleCodeActionResolve.
 */
function buildCreateClassAction(
  fqcn: string,
  templateName: string,
  sourceUri: string,
  project: ProjectContext,
  templateDir: string | undefined,
): CodeAction | undefined {
  if (!fqcn) return undefined;

  const targetPath = resolveExpectedClassPath(fqcn, project.psr4Map);
  if (!targetPath) return undefined;

  // Don't offer if the file already exists on disk
  if (fileExists(targetPath)) return undefined;

  const templateContent = resolveTemplate(templateName, templateDir);
  if (!templateContent) return undefined;

  const moduleName = findModuleForFqcn(fqcn, project);
  const vars = buildTemplateVariables(fqcn, moduleName);
  const content = renderTemplate(templateContent, vars);

  const shortName = fqcn.split('\\').pop() ?? fqcn;
  const isObserver = templateName === 'observer.php.tpl';

  return {
    title: isObserver ? `Create observer class ${shortName}` : `Create class ${shortName}`,
    kind: CodeActionKind.QuickFix,
    isPreferred: true,
    data: { type: 'create-file', targetPath, content, sourceUri } satisfies CreateFileActionData,
  };
}

/**
 * Detect whether a layout XML file lives inside a theme directory.
 * Theme layouts match:
 *   {themePath}/{Module_Name}/layout/*.xml
 *   {themePath}/{Module_Name}/page_layout/*.xml
 * Returns the theme root path if found, undefined otherwise.
 *
 * Module layouts live under {modulePath}/view/{area}/layout/ — the parent of
 * the Module_Name-like dir would be view/{area}, which contains "view".
 * For themes, the parent is the theme root (no "view" segment).
 */
function detectThemePath(layoutFilePath: string): string | undefined {
  const sepLayout = path.sep + 'layout' + path.sep;
  const sepPageLayout = path.sep + 'page_layout' + path.sep;
  let layoutIdx = layoutFilePath.indexOf(sepPageLayout);
  if (layoutIdx < 0) layoutIdx = layoutFilePath.indexOf(sepLayout);
  if (layoutIdx < 0) return undefined;
  const beforeLayout = layoutFilePath.slice(0, layoutIdx);
  const themePath = path.dirname(beforeLayout);
  if (path.basename(path.dirname(beforeLayout)).includes('view')) return undefined;
  return themePath;
}

/**
 * Build a lightweight "Create template" action with data for resolve.
 */
function buildCreateTemplateAction(
  templateId: string,
  area: string,
  layoutFilePath: string,
  sourceUri: string,
  project: ProjectContext,
  templateDir: string | undefined,
): CodeAction | undefined {
  if (!templateId || !templateId.includes('::')) return undefined;

  const [moduleId, relativePath] = templateId.split('::', 2);
  if (!moduleId || !relativePath) return undefined;

  // Reject path traversal in template IDs (e.g. Module::../../etc/env.php)
  if (relativePath.includes('..')) return undefined;

  let targetPath: string;
  const themePath = detectThemePath(layoutFilePath);
  if (themePath) {
    targetPath = path.join(themePath, moduleId, 'templates', relativePath);
  } else {
    const mod = project.modules.find((m) => m.name === moduleId);
    if (!mod) return undefined;
    targetPath = path.join(mod.path, 'view', area, 'templates', relativePath);
  }

  // Don't offer if the file already exists on disk
  if (fileExists(targetPath)) return undefined;

  const templateContent = resolveTemplate('template.phtml.tpl', templateDir);
  if (!templateContent) return undefined;

  const vars = buildTemplateVariables('', moduleId);
  const content = renderTemplate(templateContent, vars);

  return {
    title: `Create template ${relativePath}`,
    kind: CodeActionKind.QuickFix,
    isPreferred: true,
    data: { type: 'create-file', targetPath, content, sourceUri } satisfies CreateFileActionData,
  };
}

// --- "Add implements ObserverInterface" ---

const CLASS_DECL_RE = /^(\s*(?:abstract\s+|final\s+|readonly\s+)*(?:class|interface|trait|enum)\s+)(\w+)/;
const IMPLEMENTS_RE = /\bimplements\s+/;
const OBSERVER_INTERFACE = 'Magento\\Framework\\Event\\ObserverInterface';
const OBSERVER_INTERFACE_SHORT = 'ObserverInterface';

/**
 * Return a lightweight action — the actual file modification happens in resolve.
 */
function buildAddObserverInterfaceAction(
  classFile: string,
  sourceUri: string,
): CodeAction | undefined {
  if (!classFile) return undefined;

  // Check if the class already implements ObserverInterface (prevents offering after apply)
  try {
    const content = fs.readFileSync(classFile, 'utf-8');
    if (content.includes('ObserverInterface')) return undefined;
  } catch {
    return undefined;
  }

  return {
    title: 'Add implements ObserverInterface',
    kind: CodeActionKind.QuickFix,
    isPreferred: true,
    data: { type: 'add-observer-interface', classFile, sourceUri } satisfies AddInterfaceActionData,
  };
}

/**
 * Read the PHP file, add `implements ObserverInterface` and `use` statement, write back to disk.
 */
function applyAddObserverInterface(classFile: string): void {
  let content: string;
  try {
    content = fs.readFileSync(classFile, 'utf-8');
  } catch {
    return;
  }

  // Already has it — nothing to do
  if (content.includes('ObserverInterface')) return;

  const lines = content.split('\n');

  const hasUseStatements = lines.some((l) => /^use\s+/.test(l.trim()));
  const interfaceName = hasUseStatements ? OBSERVER_INTERFACE_SHORT : '\\' + OBSERVER_INTERFACE;

  // Add use statement after the last existing use statement
  if (hasUseStatements) {
    let lastUseLine = -1;
    for (let i = 0; i < lines.length; i++) {
      if (/^use\s+/.test(lines[i].trim())) lastUseLine = i;
    }
    if (lastUseLine >= 0) {
      lines.splice(lastUseLine + 1, 0, `use ${OBSERVER_INTERFACE};`);
    }
  }

  // Add implements clause to class declaration
  for (let i = 0; i < lines.length; i++) {
    const match = CLASS_DECL_RE.exec(lines[i]);
    if (!match) continue;

    const line = lines[i];
    if (IMPLEMENTS_RE.test(line)) {
      // Already has implements — append to the list before the opening brace
      const implIdx = line.search(IMPLEMENTS_RE);
      const afterImpl = line.slice(implIdx);
      const braceIdx = afterImpl.indexOf('{');
      const insertCol = braceIdx >= 0 ? implIdx + braceIdx : line.length;
      lines[i] = line.slice(0, insertCol) + `, ${interfaceName}` + line.slice(insertCol);
    } else {
      // No implements clause — add one after class name (and extends if present)
      const classNameEnd = match[1].length + match[2].length;
      const rest = line.slice(classNameEnd);
      const extendsMatch = rest.match(/^(\s+extends\s+\S+)/);
      const insertCol = extendsMatch ? classNameEnd + extendsMatch[1].length : classNameEnd;
      lines[i] = line.slice(0, insertCol) + ` implements ${interfaceName}` + line.slice(insertCol);
    }
    break;
  }

  try {
    fs.writeFileSync(classFile, lines.join('\n'));
  } catch {
    // File not writable
  }
}

// --- "Add Hyvä CSP registration" ---

/**
 * FQCN and short name for the HyvaCsp ViewModel.
 * Used in the `use` statement and PHPDoc type hint that the code action inserts.
 */
const HYVA_CSP_FQCN = 'Hyva\\Theme\\ViewModel\\HyvaCsp';
const HYVA_CSP_SHORT = 'HyvaCsp';

/**
 * The use statement to add at the top of the template.
 */
const HYVA_CSP_USE = `use ${HYVA_CSP_FQCN};`;

/**
 * The PHPDoc type hint to add after the use statements.
 */
const HYVA_CSP_PHPDOC = `/** @var ${HYVA_CSP_SHORT} $hyvaCsp */`;

/**
 * Build a code action that adds CSP registration after every </script> tag,
 * plus the use statement and PHPDoc type hint if they're missing.
 *
 * A single action fixes all CSP diagnostics in the file at once, so the user
 * can apply the fix once and resolve every violation.
 *
 * Hyvä .phtml template conventions (top-to-bottom):
 *   1. License comment block
 *   2. Use statements (e.g., `use Hyva\Theme\ViewModel\HyvaCsp;`)
 *   3. PHPDoc type hints (e.g., `/** @var HyvaCsp $hyvaCsp *​/`)
 *   4. Variable declarations and template content
 *
 * The code action inserts the use statement after the last existing `use` line,
 * and the PHPDoc after the last existing `/** @var` line, respecting this order.
 */
function buildCspRegistrationAction(
  content: string,
  cspArea: CspArea,
  cspDiags: import('vscode-languageserver/node').Diagnostic[],
  sourceUri: string,
): CodeAction | undefined {
  const cspTag = cspArea === 'frontend' ? FRONTEND_CSP_TAG : BASE_CSP_TAG;
  const edits: TextEdit[] = [];
  const lines = content.split('\n');

  // 1. Add CSP registration tag after each </script> that is missing it.
  //    Insert on the line immediately after the </script> tag.
  for (const diag of cspDiags) {
    const scriptLine = diag.range.end.line;
    // Insert the CSP tag at the beginning of the next line.
    // If </script> is on the last line, append after it.
    const insertLine = scriptLine + 1;
    edits.push(TextEdit.insert(
      { line: insertLine, character: 0 },
      cspTag + '\n',
    ));
  }

  // 2. Add `use Hyva\Theme\ViewModel\HyvaCsp;` if not already present.
  const hasUseStatement = lines.some((l) => l.includes(HYVA_CSP_FQCN));
  if (!hasUseStatement) {
    const useInsertPos = findUseStatementInsertPosition(lines);
    if (useInsertPos) {
      edits.push(TextEdit.insert(useInsertPos, HYVA_CSP_USE + '\n'));
    }
  }

  // 3. Add PHPDoc type hint if not already present.
  const hasPhpDoc = lines.some((l) => l.includes('$hyvaCsp') && l.includes('@var'));
  if (!hasPhpDoc) {
    const phpDocInsert = findPhpDocInsertPosition(lines);
    if (phpDocInsert) {
      edits.push(TextEdit.insert(phpDocInsert.pos, phpDocInsert.prefix + HYVA_CSP_PHPDOC + '\n'));
    }
  }

  if (edits.length === 0) return undefined;

  const edit: WorkspaceEdit = { changes: { [sourceUri]: edits } };
  let title: string;
  if (cspDiags.length === 0) {
    title = 'Add Hyvä CSP type hint';
  } else if (cspDiags.length === 1) {
    title = 'Add Hyvä CSP inline script registration';
  } else {
    title = `Add Hyvä CSP inline script registration (${cspDiags.length} scripts)`;
  }

  // Store the edit in data (not directly on the action) so it's applied during
  // codeAction/resolve. This is required because the server declares
  // resolveProvider: true — editors like Neovim only apply edits from resolve.
  return {
    title,
    kind: CodeActionKind.QuickFix,
    isPreferred: true,
    data: { type: 'add-csp-registration', edit, sourceUri } satisfies CspRegistrationActionData,
  };
}

/**
 * Find where to insert a new `use` statement.
 *
 * Strategy: insert after the last existing `use ...;` line. If there are no
 * use statements, insert after the first `<?php` opening tag (which by Hyvä
 * convention appears at the top of the file, before use statements).
 *
 * Returns a Position at the start of the line after the insertion point,
 * or undefined if no suitable location is found.
 */
function findUseStatementInsertPosition(
  lines: string[],
): { line: number; character: number } | undefined {
  // Find the last `use` statement line
  let lastUseLine = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*use\s+[\w\\]+/.test(lines[i])) {
      lastUseLine = i;
    }
  }
  if (lastUseLine >= 0) {
    return { line: lastUseLine + 1, character: 0 };
  }

  // No use statements — insert after the file header preamble (license comment,
  // declare(strict_types=1)) that follows the first `<?php` tag.
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('<?php')) {
      // j tracks the next line to inspect; after the loop it points past the
      // last preamble line, so the insert position is j - 1.
      let j = i + 1;

      // Skip blank lines after <?php
      while (j < lines.length && lines[j].trim() === '') j++;

      // Skip block comment (/* ... */ or /** ... */)
      if (j < lines.length && /^\s*(\/\*|\/\*\*)/.test(lines[j])) {
        while (j < lines.length && !lines[j].includes('*/')) j++;
        if (j < lines.length) j++; // skip the closing */ line
      }

      // Skip single-line comments (// ...)
      while (j < lines.length && /^\s*\/\//.test(lines[j])) j++;

      // Skip blank lines after comment
      while (j < lines.length && lines[j].trim() === '') j++;

      // Skip declare(strict_types=1); if present
      if (j < lines.length && /^\s*declare\s*\(/.test(lines[j])) j++;

      // j now points to the first non-preamble line; insert after the last
      // preamble line, with a blank line separator if needed.
      const insertAfter = j - 1;
      const nextLine = insertAfter + 1 < lines.length ? lines[insertAfter + 1] : '';
      if (nextLine.trim() === '') {
        return { line: insertAfter + 2, character: 0 };
      }
      return { line: insertAfter + 1, character: 0 };
    }
  }

  // No <?php found (unusual for .phtml) — insert at top
  return { line: 0, character: 0 };
}

/**
 * Find where to insert a PHPDoc type hint (`/** @var ... *​/`).
 *
 * Strategy: insert after the last existing `/** @var` line. If there are no
 * PHPDoc type hints, insert after the last `use` statement (with a blank line
 * separator per convention). If there are neither, insert after the first `<?php`.
 *
 * Returns a Position at the start of the line after the insertion point,
 * plus a prefix string (empty or `\n`) to ensure a blank line separator.
 */
function findPhpDocInsertPosition(
  lines: string[],
): { pos: { line: number; character: number }; prefix: string } | undefined {
  // Find the last `/** @var` line in the file header only (before the first
  // non-whitespace HTML content). This prevents inserting the annotation in
  // the template body next to a loop variable's @var, for example.
  let lastVarLine = -1;
  for (let i = 0; i < lines.length; i++) {
    // Stop at the first line that is not part of the PHP file header.
    // Header lines are: PHP open/close tags, comments, use/declare statements,
    // and blank lines.
    const trimmed = lines[i].trim();
    if (trimmed !== '' && !/^(<\?|\?>|\*|\/\/|\/\*|\*\/|use |declare\b)/.test(trimmed)) {
      break;
    }
    if (/^\s*\/\*\*\s*@var\b/.test(lines[i])) {
      lastVarLine = i;
    }
  }
  if (lastVarLine >= 0) {
    return { pos: { line: lastVarLine + 1, character: 0 }, prefix: '' };
  }

  // No @var lines — insert after the last `use` statement, with a blank line
  let lastUseLine = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*use\s+[\w\\]+/.test(lines[i])) {
      lastUseLine = i;
    }
  }
  if (lastUseLine >= 0) {
    // If there's already a blank line after the last use, insert after it
    const nextLine = lastUseLine + 1 < lines.length ? lines[lastUseLine + 1] : '';
    if (nextLine.trim() === '') {
      return { pos: { line: lastUseLine + 2, character: 0 }, prefix: '' };
    }
    // No blank line yet — prepend one so use block and @var block are separated
    return { pos: { line: lastUseLine + 1, character: 0 }, prefix: '\n' };
  }

  // No use statements either — insert after first <?php line
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('<?php')) {
      return { pos: { line: i + 1, character: 0 }, prefix: '' };
    }
  }

  return { pos: { line: 0, character: 0 }, prefix: '' };
}
