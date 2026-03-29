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
} from '../validation/diagnosticCodes';

/** Data payload attached to file-creation code actions, consumed by resolve. */
export interface CreateFileActionData {
  type: 'create-file';
  targetPath: string;
  content: string;
  /** URI of the document where the code action was invoked (for re-validation). */
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
  _getDocumentText?: (uri: string) => string | undefined,
  _token?: CancellationToken,
): CodeAction[] | null {
  const filePath = URI.parse(params.textDocument.uri).fsPath;
  const project = getProject(filePath);
  if (!project) return null;

  const actions: CodeAction[] = [];
  const templateDir = resolveTemplateDir(project.root);
  const sourceUri = params.textDocument.uri;

  for (const diag of params.context.diagnostics) {
    if (diag.source !== 'magento2-lsp') continue;
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
  const data = action.data as CreateFileActionData | AddInterfaceActionData | undefined;
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
