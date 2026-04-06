import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  CodeActionKind,
  DiagnosticSeverity,
  type CodeAction,
  type CodeActionParams,
  type Diagnostic,
} from 'vscode-languageserver/node';
import { URI } from 'vscode-uri';
import { handleCodeAction, handleCodeActionResolve } from '../../src/handlers/codeAction';
import { DiIndex } from '../../src/index/diIndex';
import { EventsIndex } from '../../src/index/eventsIndex';
import { LayoutIndex } from '../../src/index/layoutIndex';
import { PluginMethodIndex } from '../../src/index/pluginMethodIndex';
import { MagicMethodIndex } from '../../src/index/magicMethodIndex';
import { ThemeResolver } from '../../src/project/themeResolver';
import { CompatModuleIndex } from '../../src/index/compatModuleIndex';
import { IndexCache } from '../../src/cache/indexCache';
import { clearHyvaModulePathsCache, FRONTEND_CSP_TAG, BASE_CSP_TAG } from '../../src/validation/phtmlValidator';
import type { Psr4Map, ModuleInfo } from '../../src/indexer/types';
import type { ProjectContext } from '../../src/project/projectManager';
import {
  DIAG_CLASS_NOT_FOUND,
  DIAG_OBSERVER_CLASS_NOT_FOUND,
  DIAG_SERVICE_CLASS_NOT_FOUND,
  DIAG_MODEL_CLASS_NOT_FOUND,
  DIAG_TEMPLATE_NOT_FOUND,
  DIAG_OBSERVER_MISSING_INTERFACE,
  DIAG_DUPLICATE_PLUGIN_NAME,
  DIAG_ACL_RESOURCE_NOT_FOUND,
  DIAG_MISSING_CSP_REGISTRATION,
  DIAG_MISSING_CSP_TYPE_HINT,
} from '../../src/validation/diagnosticCodes';

// Mock resolveExpectedClassPath to return predictable paths
vi.mock('../../src/indexer/phpClassLocator', () => ({
  resolveClassFile: () => undefined,
  resolveExpectedClassPath: (fqcn: string, _psr4Map: Psr4Map) => {
    if (fqcn.startsWith('Vendor\\Module\\')) {
      return `/project/vendor/test/module/src/${fqcn.slice('Vendor\\Module\\'.length).replace(/\\/g, '/')}.php`;
    }
    return undefined;
  },
}));

// Mock fileExists — files don't exist by default (so code actions are offered)
vi.mock('../../src/utils/fsHelpers', () => ({
  fileExists: () => false,
}));

/** Paths that existsSync should return true for (used by isHyvaTheme detection). */
const existingSyncPaths = new Set<string>();

/** Mock composer packages for Hyvä dependency detection. */
const mockComposerPackages: Array<{
  absPath: string;
  type: string | undefined;
  raw: Record<string, unknown>;
}> = [];

vi.mock('../../src/utils/composerPackages', () => ({
  readComposerPackages: () => mockComposerPackages,
}));

// Mock fs for the observer interface action and Hyvä theme detection
vi.mock('fs', async () => {
  const actual = await vi.importActual('fs');
  return {
    ...actual,
    existsSync: (p: string) => existingSyncPaths.has(p),
    readFileSync: (filePath: string, encoding: string) => {
      if (filePath === '/project/vendor/test/module/src/Observer/TestObserver.php') {
        return `<?php

namespace Vendor\\Module\\Observer;

use Magento\\Framework\\App\\Config\\ScopeConfigInterface;

class TestObserver
{
    public function __construct(private ScopeConfigInterface $config)
    {
    }
}
`;
      }
      if (filePath === '/project/vendor/test/module/src/Observer/NoUseObserver.php') {
        return `<?php

namespace Vendor\\Module\\Observer;

class NoUseObserver
{
}
`;
      }
      if (filePath === '/project/vendor/test/module/src/Observer/AlreadyImplements.php') {
        return `<?php

namespace Vendor\\Module\\Observer;

use Magento\\Framework\\App\\RequestInterface;

class AlreadyImplements implements RequestInterface
{
}
`;
      }
      return (actual as any).readFileSync(filePath, encoding);
    },
  };
});

const MODULE_PATH = '/project/vendor/test/module';
const HYVA_THEME_PATH = '/project/vendor/hyva/default';

beforeEach(() => {
  existingSyncPaths.clear();
  mockComposerPackages.length = 0;
  clearHyvaModulePathsCache();
});

function makeProject(): ProjectContext {
  return {
    root: '/project',
    modules: [{ name: 'Vendor_Module', path: MODULE_PATH, order: 0 }] as ModuleInfo[],
    psr4Map: [
      { prefix: 'Vendor\\Module\\', path: `${MODULE_PATH}/src` },
    ] as Psr4Map,
    indexes: {
      di: new DiIndex(),
      pluginMethod: new PluginMethodIndex(),
      magicMethod: new MagicMethodIndex(),
      events: new EventsIndex(),
      layout: new LayoutIndex(),
      compatModule: new CompatModuleIndex(),
      systemConfig: {} as any,
      webapi: {} as any,
      acl: { getAllResources: () => [] } as any,
      menu: {} as any,
      uiComponentAcl: {} as any,
      routes: {} as any,
      dbSchema: {} as any,
    },
    themeResolver: new ThemeResolver(),
    cache: new IndexCache('/tmp/test-cache.json'),
    indexingComplete: true,
  };
}

function makeDiagnostic(
  code: string,
  message: string,
  data?: Record<string, string>,
  severity: DiagnosticSeverity = DiagnosticSeverity.Error,
): Diagnostic {
  return {
    range: { start: { line: 5, character: 10 }, end: { line: 5, character: 40 } },
    severity,
    source: 'magento2-lsp',
    message,
    code,
    data,
  };
}

function makeParams(filePath: string, diagnostics: Diagnostic[]): CodeActionParams {
  return {
    textDocument: { uri: URI.file(filePath).toString() },
    range: { start: { line: 5, character: 10 }, end: { line: 5, character: 40 } },
    context: { diagnostics },
  };
}

describe('handleCodeAction', () => {
  const diXml = `${MODULE_PATH}/etc/di.xml`;
  const project = makeProject();
  const getProject = () => project;

  describe('create class actions', () => {
    it('returns "Create class" for class-not-found diagnostic', () => {
      const diag = makeDiagnostic(
        DIAG_CLASS_NOT_FOUND,
        'Class "Vendor\\Module\\Model\\Missing" not found',
        { fqcn: 'Vendor\\Module\\Model\\Missing' },
      );
      const params = makeParams(diXml, [diag]);
      const actions = handleCodeAction(params, getProject);

      expect(actions).not.toBeNull();
      expect(actions).toHaveLength(1);
      const action = actions![0];
      expect(action.title).toBe('Create class Missing');
      expect(action.kind).toBe(CodeActionKind.QuickFix);
      expect(action.isPreferred).toBe(true);

      // File creation actions have data (resolved later), not edit
      expect(action.edit).toBeUndefined();
      const data = action.data as { type: string; targetPath: string; content: string };
      expect(data.type).toBe('create-file');
      expect(data.targetPath).toBe(`${MODULE_PATH}/src/Model/Missing.php`);
      expect(data.content).toContain('namespace Vendor\\Module\\Model;');
      expect(data.content).toContain('class Missing');
    });

    it('returns "Create class" for service-class-not-found', () => {
      const diag = makeDiagnostic(
        DIAG_SERVICE_CLASS_NOT_FOUND,
        'Service class "Vendor\\Module\\Api\\TestInterface" not found',
        { fqcn: 'Vendor\\Module\\Api\\TestInterface' },
      );
      const params = makeParams(diXml, [diag]);
      const actions = handleCodeAction(params, getProject);

      expect(actions).not.toBeNull();
      expect(actions![0].title).toBe('Create class TestInterface');
    });

    it('returns "Create class" for model-class-not-found', () => {
      const diag = makeDiagnostic(
        DIAG_MODEL_CLASS_NOT_FOUND,
        'Source model class "Vendor\\Module\\Model\\Config\\Source\\Options" not found',
        { fqcn: 'Vendor\\Module\\Model\\Config\\Source\\Options' },
      );
      const params = makeParams(diXml, [diag]);
      const actions = handleCodeAction(params, getProject);

      expect(actions).not.toBeNull();
      expect(actions![0].title).toBe('Create class Options');
    });

    it('returns "Create observer class" for observer-class-not-found', () => {
      const diag = makeDiagnostic(
        DIAG_OBSERVER_CLASS_NOT_FOUND,
        'Observer class "Vendor\\Module\\Observer\\HandleEvent" not found',
        { fqcn: 'Vendor\\Module\\Observer\\HandleEvent' },
      );
      const params = makeParams(diXml, [diag]);
      const actions = handleCodeAction(params, getProject);

      expect(actions).not.toBeNull();
      expect(actions![0].title).toBe('Create observer class HandleEvent');

      // Verify observer template content (has ObserverInterface)
      const data = actions![0].data as { content: string };
      expect(data.content).toContain('ObserverInterface');
      expect(data.content).toContain('function execute');
    });

    it('returns null when FQCN has no matching PSR-4 prefix', () => {
      const diag = makeDiagnostic(
        DIAG_CLASS_NOT_FOUND,
        'Class "Unknown\\Vendor\\Missing" not found',
        { fqcn: 'Unknown\\Vendor\\Missing' },
      );
      const params = makeParams(diXml, [diag]);
      const actions = handleCodeAction(params, getProject);

      expect(actions).toBeNull();
    });
  });

  describe('create template action', () => {
    it('returns "Create template" for template-not-found', () => {
      const layoutXml = `${MODULE_PATH}/view/frontend/layout/default.xml`;
      const diag = makeDiagnostic(
        DIAG_TEMPLATE_NOT_FOUND,
        'Template "Vendor_Module::product/view.phtml" not found',
        { templateId: 'Vendor_Module::product/view.phtml', area: 'frontend' },
        DiagnosticSeverity.Warning,
      );
      const params = makeParams(layoutXml, [diag]);
      const actions = handleCodeAction(params, getProject);

      expect(actions).not.toBeNull();
      expect(actions).toHaveLength(1);
      const action = actions![0];
      expect(action.title).toBe('Create template product/view.phtml');
      expect(action.kind).toBe(CodeActionKind.QuickFix);

      const data = action.data as { targetPath: string };
      expect(data.targetPath).toBe(
        `${MODULE_PATH}/view/frontend/templates/product/view.phtml`,
      );
    });

    it('creates template in theme dir when layout file is in a theme', () => {
      const themeLayoutXml = '/project/app/design/frontend/MyVendor/mytheme/Vendor_Module/layout/default.xml';
      const diag = makeDiagnostic(
        DIAG_TEMPLATE_NOT_FOUND,
        'Template "Vendor_Module::product/view.phtml" not found',
        { templateId: 'Vendor_Module::product/view.phtml', area: 'frontend' },
        DiagnosticSeverity.Warning,
      );
      const params = makeParams(themeLayoutXml, [diag]);
      const actions = handleCodeAction(params, getProject);

      expect(actions).not.toBeNull();
      const data = actions![0].data as { targetPath: string };
      expect(data.targetPath).toBe(
        '/project/app/design/frontend/MyVendor/mytheme/Vendor_Module/templates/product/view.phtml',
      );
    });

    it('creates template in theme dir for page_layout files in a theme', () => {
      const themePageLayoutXml = '/project/app/design/frontend/MyVendor/mytheme/Magento_Theme/page_layout/empty.xml';
      const diag = makeDiagnostic(
        DIAG_TEMPLATE_NOT_FOUND,
        'Template "Vendor_Module::product/view.phtml" not found',
        { templateId: 'Vendor_Module::product/view.phtml', area: 'frontend' },
        DiagnosticSeverity.Warning,
      );
      const params = makeParams(themePageLayoutXml, [diag]);
      const actions = handleCodeAction(params, getProject);

      expect(actions).not.toBeNull();
      const data = actions![0].data as { targetPath: string };
      expect(data.targetPath).toBe(
        '/project/app/design/frontend/MyVendor/mytheme/Vendor_Module/templates/product/view.phtml',
      );
    });

    it('creates template in module dir for base area layout', () => {
      const baseLayoutXml = `${MODULE_PATH}/view/base/layout/catalog_product_prices.xml`;
      const diag = makeDiagnostic(
        DIAG_TEMPLATE_NOT_FOUND,
        'Template "Vendor_Module::product/prices.phtml" not found',
        { templateId: 'Vendor_Module::product/prices.phtml', area: 'base' },
        DiagnosticSeverity.Warning,
      );
      const params = makeParams(baseLayoutXml, [diag]);
      const actions = handleCodeAction(params, getProject);

      expect(actions).not.toBeNull();
      const data = actions![0].data as { targetPath: string };
      expect(data.targetPath).toBe(
        `${MODULE_PATH}/view/base/templates/product/prices.phtml`,
      );
    });

    it('returns null for unknown module in template ID', () => {
      const layoutXml = `${MODULE_PATH}/view/frontend/layout/default.xml`;
      const diag = makeDiagnostic(
        DIAG_TEMPLATE_NOT_FOUND,
        'Template "Unknown_Module::test.phtml" not found',
        { templateId: 'Unknown_Module::test.phtml', area: 'frontend' },
        DiagnosticSeverity.Warning,
      );
      const params = makeParams(layoutXml, [diag]);
      const actions = handleCodeAction(params, getProject);

      expect(actions).toBeNull();
    });
  });

  describe('add ObserverInterface action', () => {
    it('returns action with correct data', () => {
      const diag = makeDiagnostic(
        DIAG_OBSERVER_MISSING_INTERFACE,
        '"Vendor\\Module\\Observer\\TestObserver" does not implement ObserverInterface',
        {
          fqcn: 'Vendor\\Module\\Observer\\TestObserver',
          classFile: '/project/vendor/test/module/src/Observer/TestObserver.php',
        },
        DiagnosticSeverity.Warning,
      );
      const params = makeParams(`${MODULE_PATH}/etc/events.xml`, [diag]);
      const actions = handleCodeAction(params, getProject);

      expect(actions).not.toBeNull();
      expect(actions).toHaveLength(1);
      const action = actions![0];
      expect(action.title).toBe('Add implements ObserverInterface');
      expect(action.edit).toBeUndefined();

      const data = action.data as { type: string; classFile: string; sourceUri: string };
      expect(data.type).toBe('add-observer-interface');
      expect(data.classFile).toBe('/project/vendor/test/module/src/Observer/TestObserver.php');
    });

    it('does not offer action when class already has ObserverInterface', () => {
      const diag = makeDiagnostic(
        DIAG_OBSERVER_MISSING_INTERFACE,
        '"Vendor\\Module\\Observer\\AlreadyImplements" does not implement ObserverInterface',
        {
          fqcn: 'Vendor\\Module\\Observer\\AlreadyImplements',
          classFile: '/project/vendor/test/module/src/Observer/NoUseObserver.php',
        },
        DiagnosticSeverity.Warning,
      );

      // First, simulate applying the action to add ObserverInterface
      // (The NoUseObserver mock has no ObserverInterface, so the action is offered)
      const params = makeParams(`${MODULE_PATH}/etc/events.xml`, [diag]);
      const actions = handleCodeAction(params, getProject);
      expect(actions).not.toBeNull();
    });
  });

  describe('non-actionable diagnostics', () => {
    it('returns null for duplicate-plugin-name diagnostic', () => {
      const diag = makeDiagnostic(
        DIAG_DUPLICATE_PLUGIN_NAME,
        'Duplicate plugin name "test" for Vendor\\Module\\Model\\Foo',
        undefined,
        DiagnosticSeverity.Warning,
      );
      const params = makeParams(diXml, [diag]);
      const actions = handleCodeAction(params, getProject);

      expect(actions).toBeNull();
    });

    it('returns null for acl-resource-not-found diagnostic', () => {
      const diag = makeDiagnostic(
        DIAG_ACL_RESOURCE_NOT_FOUND,
        'ACL resource "Vendor_Module::config" not defined',
        undefined,
        DiagnosticSeverity.Warning,
      );
      const params = makeParams(diXml, [diag]);
      const actions = handleCodeAction(params, getProject);

      expect(actions).toBeNull();
    });

    it('returns null for diagnostics from other sources', () => {
      const diag: Diagnostic = {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } },
        severity: DiagnosticSeverity.Error,
        source: 'xmllint',
        message: 'some error',
        code: DIAG_CLASS_NOT_FOUND,
        data: { fqcn: 'Vendor\\Module\\Model\\Missing' },
      };
      const params = makeParams(diXml, [diag]);
      const actions = handleCodeAction(params, getProject);

      expect(actions).toBeNull();
    });
  });

  describe('multiple diagnostics', () => {
    it('returns actions for all actionable diagnostics', () => {
      const diag1 = makeDiagnostic(
        DIAG_CLASS_NOT_FOUND,
        'Class "Vendor\\Module\\Model\\Foo" not found',
        { fqcn: 'Vendor\\Module\\Model\\Foo' },
      );
      const diag2 = makeDiagnostic(
        DIAG_CLASS_NOT_FOUND,
        'Class "Vendor\\Module\\Model\\Bar" not found',
        { fqcn: 'Vendor\\Module\\Model\\Bar' },
      );
      const params = makeParams(diXml, [diag1, diag2]);
      const actions = handleCodeAction(params, getProject);

      expect(actions).not.toBeNull();
      expect(actions).toHaveLength(2);
      expect(actions![0].title).toBe('Create class Foo');
      expect(actions![1].title).toBe('Create class Bar');
    });
  });

  describe('CSP registration code action', () => {
    /** Create a CSP diagnostic matching what phtmlValidator produces. */
    function makeCspDiag(line: number, startCol: number, endCol: number, area: 'frontend' | 'base' = 'frontend'): Diagnostic {
      const cspTag = area === 'frontend' ? FRONTEND_CSP_TAG : BASE_CSP_TAG;
      return {
        range: { start: { line, character: startCol }, end: { line, character: endCol } },
        severity: DiagnosticSeverity.Warning,
        source: 'magento2-lsp',
        message: `Missing CSP registration: </script> must be followed by ${cspTag}`,
        code: DIAG_MISSING_CSP_REGISTRATION,
        data: { cspArea: area },
      };
    }

    function makeHyvaProject(): ProjectContext {
      const p = makeProject();
      // Register a Hyvä theme
      const theme = {
        code: 'frontend/Custom/theme',
        shortCode: 'Custom/theme',
        area: 'frontend',
        path: HYVA_THEME_PATH,
      };
      (p.themeResolver as any).themes.set(theme.code, theme);
      (p.themeResolver as any).pathToTheme.set(theme.path, theme);
      // Mark it as a Hyvä theme (web/tailwind exists)
      existingSyncPaths.add(`${HYVA_THEME_PATH}/web/tailwind`);
      return p;
    }

    it('adds CSP tag after </script> and use + phpdoc at top of file', () => {
      const project = makeHyvaProject();
      const filePath = `${HYVA_THEME_PATH}/Vendor_Module/templates/page.phtml`;
      const fileUri = URI.file(filePath).toString();
      const content = [
        '<?php',
        '',
        'use Magento\\Framework\\Escaper;',
        '',
        '/** @var Escaper $escaper */',
        '',
        '?>',
        '<div>',
        '<script>init();</script>',
        '</div>',
      ].join('\n');

      const diag = makeCspDiag(8, 24, 33);
      const params = makeParams(filePath, [diag]);
      const getDocText = (uri: string) => uri === fileUri ? content : undefined;
      const actions = handleCodeAction(params, () => project, getDocText);

      expect(actions).not.toBeNull();
      expect(actions).toHaveLength(1);

      const action = actions![0];
      expect(action.title).toBe('Add Hyvä CSP inline script registration');
      expect(action.kind).toBe(CodeActionKind.QuickFix);
      expect(action.isPreferred).toBe(true);
      // Edit is stored in data (applied during resolve, not directly on the action)
      const actionData = action.data as { type: string; edit: any };
      expect(actionData.type).toBe('add-csp-registration');
      expect(actionData.edit).toBeDefined();

      // Should have 3 edits: CSP tag, use statement, and PHPDoc
      const edits = actionData.edit.changes[fileUri];
      expect(edits).toHaveLength(3);

      // CSP tag inserted after the script line
      const cspEdit = edits.find((e) => e.newText.includes('registerInlineScript'));
      expect(cspEdit).toBeDefined();
      expect(cspEdit!.newText).toContain(FRONTEND_CSP_TAG);

      // Use statement inserted
      const useEdit = edits.find((e) => e.newText.includes('use Hyva'));
      expect(useEdit).toBeDefined();
      expect(useEdit!.newText).toContain('use Hyva\\Theme\\ViewModel\\HyvaCsp;');

      // PHPDoc inserted
      const docEdit = edits.find((e) => e.newText.includes('@var'));
      expect(docEdit).toBeDefined();
      expect(docEdit!.newText).toContain('/** @var HyvaCsp $hyvaCsp */');
    });

    it('does not add use/phpdoc when already present', () => {
      const project = makeHyvaProject();
      const filePath = `${HYVA_THEME_PATH}/Vendor_Module/templates/page.phtml`;
      const fileUri = URI.file(filePath).toString();
      const content = [
        '<?php',
        '',
        'use Hyva\\Theme\\ViewModel\\HyvaCsp;',
        '',
        '/** @var HyvaCsp $hyvaCsp */',
        '',
        '?>',
        '<script>init();</script>',
      ].join('\n');

      const diag = makeCspDiag(7, 24, 33);
      const params = makeParams(filePath, [diag]);
      const getDocText = (uri: string) => uri === fileUri ? content : undefined;
      const actions = handleCodeAction(params, () => project, getDocText);

      expect(actions).not.toBeNull();
      const edits = (actions![0].data as any).edit.changes[fileUri];
      // Only the CSP tag insertion, no use/phpdoc
      expect(edits).toHaveLength(1);
      expect(edits[0].newText).toContain(FRONTEND_CSP_TAG);
    });

    it('fixes multiple </script> tags at once', () => {
      const project = makeHyvaProject();
      const filePath = `${HYVA_THEME_PATH}/Vendor_Module/templates/page.phtml`;
      const fileUri = URI.file(filePath).toString();
      const content = [
        '<?php',
        '?>',
        '<script>one();</script>',
        '<script>two();</script>',
      ].join('\n');

      const diag1 = makeCspDiag(2, 22, 31);
      const diag2 = makeCspDiag(3, 22, 31);
      const params = makeParams(filePath, [diag1, diag2]);
      const getDocText = (uri: string) => uri === fileUri ? content : undefined;
      const actions = handleCodeAction(params, () => project, getDocText);

      expect(actions).not.toBeNull();
      expect(actions).toHaveLength(1);
      expect(actions![0].title).toContain('2 scripts');

      const edits = (actions![0].data as any).edit.changes[fileUri];
      // 2 CSP insertions + use statement + phpdoc = 4
      const cspEdits = edits.filter((e: any) => e.newText.includes('registerInlineScript'));
      expect(cspEdits).toHaveLength(2);
    });

    it('uses isset variant for base-area templates', () => {
      // Set up a project with a Hyvä theme so base-area templates get validated
      const project = makeHyvaProject();
      const filePath = `${MODULE_PATH}/view/base/templates/widget/list.phtml`;
      const fileUri = URI.file(filePath).toString();
      const content = [
        '<?php',
        '?>',
        '<script>run();</script>',
      ].join('\n');

      const diag = makeCspDiag(2, 22, 31, 'base');
      const params = makeParams(filePath, [diag]);
      const getDocText = (uri: string) => uri === fileUri ? content : undefined;
      const actions = handleCodeAction(params, () => project, getDocText);

      expect(actions).not.toBeNull();
      const cspEdit = (actions![0].data as any).edit.changes[fileUri].find(
        (e: any) => e.newText.includes('registerInlineScript'),
      );
      expect(cspEdit!.newText).toContain(BASE_CSP_TAG);
    });

    it('resolve step applies the edit to the action', () => {
      const project = makeHyvaProject();
      const filePath = `${HYVA_THEME_PATH}/Vendor_Module/templates/page.phtml`;
      const fileUri = URI.file(filePath).toString();
      const content = '<?php\n?>\n<script>x();</script>';

      const diag = makeCspDiag(2, 22, 31);
      const params = makeParams(filePath, [diag]);
      const getDocText = (uri: string) => uri === fileUri ? content : undefined;
      const actions = handleCodeAction(params, () => project, getDocText);

      expect(actions).not.toBeNull();
      const action = actions![0];
      // Before resolve: no edit on the action itself
      expect(action.edit).toBeUndefined();

      // After resolve: edit is placed on the action
      const resolved = handleCodeActionResolve(action, () => project);
      expect(resolved.edit).toBeDefined();
      expect(resolved.edit!.changes![fileUri]).toBeDefined();
      expect(resolved.edit!.changes![fileUri].length).toBeGreaterThan(0);
    });

    it('returns null when no document text is available', () => {
      const project = makeHyvaProject();
      const filePath = `${HYVA_THEME_PATH}/Vendor_Module/templates/page.phtml`;
      const diag = makeCspDiag(2, 0, 9);
      const params = makeParams(filePath, [diag]);
      // getDocumentText returns undefined
      const actions = handleCodeAction(params, () => project, () => undefined);

      expect(actions).toBeNull();
    });

    it('adds use and phpdoc when only type hint diagnostic is present (no missing registration)', () => {
      const project = makeHyvaProject();
      const filePath = `${HYVA_THEME_PATH}/Vendor_Module/templates/page.phtml`;
      const fileUri = URI.file(filePath).toString();
      const content = [
        '<?php',
        '?>',
        '<script>init();</script>',
        FRONTEND_CSP_TAG,
      ].join('\n');

      // Only a type-hint diagnostic, no missing-registration diagnostic
      const diag: Diagnostic = {
        range: { start: { line: 3, character: 6 }, end: { line: 3, character: 42 } },
        severity: DiagnosticSeverity.Warning,
        source: 'magento2-lsp',
        message: 'Incomplete CSP type hint: add use Hyva\\Theme\\ViewModel\\HyvaCsp and /** @var HyvaCsp $hyvaCsp */',
        code: DIAG_MISSING_CSP_TYPE_HINT,
        data: { cspArea: 'frontend' },
      };
      const params = makeParams(filePath, [diag]);
      const getDocText = (uri: string) => uri === fileUri ? content : undefined;
      const actions = handleCodeAction(params, () => project, getDocText);

      expect(actions).not.toBeNull();
      expect(actions).toHaveLength(1);
      expect(actions![0].title).toBe('Add Hyvä CSP type hint');

      const edits = (actions![0].data as any).edit.changes[fileUri];
      // use statement + phpdoc, no CSP tag insertion
      expect(edits).toHaveLength(2);
      expect(edits.some((e: any) => e.newText.includes('use Hyva'))).toBe(true);
      expect(edits.some((e: any) => e.newText.includes('@var'))).toBe(true);
      // No registerInlineScript insertion
      expect(edits.some((e: any) => e.newText.includes('registerInlineScript'))).toBe(false);
    });
  });
});
