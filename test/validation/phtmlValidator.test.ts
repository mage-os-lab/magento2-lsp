import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DiagnosticSeverity } from 'vscode-languageserver/node';
import { DIAG_MISSING_CSP_REGISTRATION, DIAG_MISSING_CSP_TYPE_HINT } from '../../src/validation/diagnosticCodes';
import { validatePhtml, clearHyvaModulePathsCache } from '../../src/validation/phtmlValidator';
import { ThemeResolver } from '../../src/project/themeResolver';
import { CompatModuleIndex } from '../../src/index/compatModuleIndex';
import type { ProjectContext } from '../../src/project/projectManager';
import type { ThemeInfo } from '../../src/project/themeResolver';

// --- Mocks ---

/**
 * Mock fs so we can control which directories "exist" for isHyvaTheme detection.
 * The existsSync mock returns true for paths in the hyvaThemeTailwindPaths set.
 */
const hyvaThemeTailwindPaths = new Set<string>();

vi.mock('fs', async () => {
  const actual = await vi.importActual('fs');
  return {
    ...actual,
    existsSync: (p: string) => hyvaThemeTailwindPaths.has(p),
  };
});

/**
 * Mock composerPackages so we can control which modules have Hyvä dependencies.
 * The mockComposerPackages array is populated per test.
 */
const mockComposerPackages: Array<{
  absPath: string;
  type: string | undefined;
  raw: Record<string, unknown>;
}> = [];

vi.mock('../../src/utils/composerPackages', () => ({
  readComposerPackages: () => mockComposerPackages,
}));

// --- Helpers ---

const PROJECT_ROOT = '/project';
const HYVA_THEME_PATH = '/project/vendor/hyva/default';
const NON_HYVA_THEME_PATH = '/project/vendor/magento/theme-frontend-luma';
const MODULE_PATH = '/project/vendor/test/module';
const HYVA_MODULE_PATH = '/project/vendor/hyva-themes/some-module';

const FRONTEND_CSP = '<?php $hyvaCsp->registerInlineScript(); ?>';
const BASE_CSP = '<?php if (isset($hyvaCsp)) $hyvaCsp->registerInlineScript(); ?>';

function makeHyvaTheme(): ThemeInfo {
  return {
    code: 'frontend/Custom/theme',
    shortCode: 'Custom/theme',
    area: 'frontend',
    path: HYVA_THEME_PATH,
  };
}

function makeNonHyvaTheme(): ThemeInfo {
  return {
    code: 'frontend/Magento/luma',
    shortCode: 'Magento/luma',
    area: 'frontend',
    path: NON_HYVA_THEME_PATH,
  };
}

/**
 * Build a minimal ProjectContext for testing.
 * The themeResolver and compatModule index are real instances that can be
 * configured per test.
 */
function makeProject(opts?: {
  themes?: ThemeInfo[];
  compatMappings?: Array<{ original: string; compat: string; compatPath: string }>;
}): ProjectContext {
  const themeResolver = new ThemeResolver();
  // Inject themes directly via the internal map (test-only access)
  const themes = opts?.themes ?? [];
  for (const theme of themes) {
    (themeResolver as any).themes.set(theme.code, theme);
    (themeResolver as any).pathToTheme.set(theme.path, theme);
  }

  const compatModule = new CompatModuleIndex();
  for (const mapping of opts?.compatMappings ?? []) {
    compatModule.addMapping(mapping.original, mapping.compat, mapping.compatPath);
  }

  return {
    root: PROJECT_ROOT,
    modules: [
      { name: 'Test_Module', path: MODULE_PATH, order: 0 },
      { name: 'Hyva_SomeModule', path: HYVA_MODULE_PATH, order: 1 },
    ],
    psr4Map: [],
    indexes: {
      di: {} as any,
      pluginMethod: {} as any,
      magicMethod: {} as any,
      events: {} as any,
      layout: {} as any,
      compatModule,
      systemConfig: {} as any,
      webapi: {} as any,
      acl: { getAllResources: () => [] } as any,
      menu: {} as any,
      uiComponentAcl: {} as any,
      routes: {} as any,
      dbSchema: {} as any,
    },
    themeResolver,
    cache: {} as any,
    symbolIndex: {} as any,
    symbolMatcher: {} as any,
    symbolsCache: {} as any,
    indexingComplete: true,
  } as ProjectContext;
}

// --- Tests ---

beforeEach(() => {
  hyvaThemeTailwindPaths.clear();
  mockComposerPackages.length = 0;
  clearHyvaModulePathsCache();
});

describe('phtmlValidator', () => {
  // ----- Hyvä theme detection -----

  describe('Hyvä theme templates (frontend area)', () => {
    it('warns when </script> is not followed by CSP registration', () => {
      hyvaThemeTailwindPaths.add(`${HYVA_THEME_PATH}/web/tailwind`);
      const project = makeProject({ themes: [makeHyvaTheme()] });
      const filePath = `${HYVA_THEME_PATH}/Magento_Catalog/templates/product/view.phtml`;
      const content = '<div>\n<script>console.log("hi");</script>\n</div>';

      const diags = validatePhtml(filePath, content, project);

      expect(diags).toHaveLength(1);
      expect(diags[0].severity).toBe(DiagnosticSeverity.Warning);
      expect(diags[0].code).toBe(DIAG_MISSING_CSP_REGISTRATION);
      expect(diags[0].message).toContain(FRONTEND_CSP);
      expect(diags[0].source).toBe('magento2-lsp');
    });

    it('does not warn about missing registration when CSP tag is present', () => {
      hyvaThemeTailwindPaths.add(`${HYVA_THEME_PATH}/web/tailwind`);
      const project = makeProject({ themes: [makeHyvaTheme()] });
      const filePath = `${HYVA_THEME_PATH}/Magento_Catalog/templates/product/view.phtml`;
      const content = `<script>console.log("hi");</script>\n${FRONTEND_CSP}\n</div>`;

      const diags = validatePhtml(filePath, content, project);

      expect(diags.filter((d) => d.code === DIAG_MISSING_CSP_REGISTRATION)).toHaveLength(0);
    });

    it('accepts whitespace and newlines between </script> and CSP tag', () => {
      hyvaThemeTailwindPaths.add(`${HYVA_THEME_PATH}/web/tailwind`);
      const project = makeProject({ themes: [makeHyvaTheme()] });
      const filePath = `${HYVA_THEME_PATH}/Magento_Catalog/templates/product/view.phtml`;
      const content = `<script>x();</script>  \n\t  \n  ${FRONTEND_CSP}`;

      const diags = validatePhtml(filePath, content, project);

      expect(diags.filter((d) => d.code === DIAG_MISSING_CSP_REGISTRATION)).toHaveLength(0);
    });
  });

  // ----- Non-Hyvä theme (no diagnostics) -----

  describe('non-Hyvä theme templates', () => {
    it('does not warn for templates in a non-Hyvä theme', () => {
      // No tailwind dir exists for this theme → not a Hyvä theme
      const project = makeProject({ themes: [makeNonHyvaTheme()] });
      const filePath = `${NON_HYVA_THEME_PATH}/Magento_Catalog/templates/product/view.phtml`;
      const content = '<script>console.log("hi");</script>';

      const diags = validatePhtml(filePath, content, project);

      expect(diags).toHaveLength(0);
    });
  });

  // ----- Hyvä compat module -----

  describe('Hyvä compat module templates', () => {
    it('warns when </script> is missing CSP in a compat module template', () => {
      const compatPath = '/project/vendor/hyva/compat-catalog';
      const project = makeProject({
        compatMappings: [{
          original: 'Magento_Catalog',
          compat: 'Hyva_CompatCatalog',
          compatPath,
        }],
      });
      const filePath = `${compatPath}/view/frontend/templates/product/view.phtml`;
      const content = '<script>doStuff();</script>';

      const diags = validatePhtml(filePath, content, project);

      expect(diags).toHaveLength(1);
      expect(diags[0].message).toContain(FRONTEND_CSP);
    });

    it('does not warn about missing registration in compat module when CSP is present', () => {
      const compatPath = '/project/vendor/hyva/compat-catalog';
      const project = makeProject({
        compatMappings: [{
          original: 'Magento_Catalog',
          compat: 'Hyva_CompatCatalog',
          compatPath,
        }],
      });
      const filePath = `${compatPath}/view/frontend/templates/product/view.phtml`;
      const content = `<script>doStuff();</script>\n${FRONTEND_CSP}`;

      const diags = validatePhtml(filePath, content, project);

      expect(diags.filter((d) => d.code === DIAG_MISSING_CSP_REGISTRATION)).toHaveLength(0);
    });
  });

  // ----- Module with hyva-themes/magento2-theme-module dependency -----

  describe('modules depending on hyva-themes/magento2-theme-module', () => {
    it('warns for frontend template missing CSP in a Hyvä-dependent module', () => {
      mockComposerPackages.push({
        absPath: HYVA_MODULE_PATH,
        type: 'magento2-module',
        raw: { require: { 'hyva-themes/magento2-theme-module': '*' } },
      });
      const project = makeProject();
      const filePath = `${HYVA_MODULE_PATH}/view/frontend/templates/page/header.phtml`;
      const content = '<script>init();</script>';

      const diags = validatePhtml(filePath, content, project);

      expect(diags).toHaveLength(1);
      expect(diags[0].message).toContain(FRONTEND_CSP);
    });

    it('warns for base template missing CSP in a Hyvä-dependent module (isset variant)', () => {
      mockComposerPackages.push({
        absPath: HYVA_MODULE_PATH,
        type: 'magento2-module',
        raw: { require: { 'hyva-themes/magento2-theme-module': '*' } },
      });
      const project = makeProject();
      const filePath = `${HYVA_MODULE_PATH}/view/base/templates/page/header.phtml`;
      const content = '<script>init();</script>';

      const diags = validatePhtml(filePath, content, project);

      expect(diags).toHaveLength(1);
      expect(diags[0].message).toContain(BASE_CSP);
    });

    it('warns when module is in a subdirectory of a Hyvä-dependent composer package', () => {
      // A composer package can contain multiple Magento modules in subdirectories.
      // E.g., hyva-themes/commerce-module-cms/ contains src/liveview-editor/ as a module.
      const composerPkgPath = '/project/vendor/hyva-themes/commerce-module-cms';
      const subModulePath = `${composerPkgPath}/src/liveview-editor`;
      mockComposerPackages.push({
        absPath: composerPkgPath,
        type: 'magento2-module',
        raw: { require: { 'hyva-themes/magento2-theme-module': '*' } },
      });
      const project = makeProject();
      // Add the sub-module to the project's module list
      project.modules.push({ name: 'Hyva_CmsLiveviewEditor', path: subModulePath, order: 2 });

      const filePath = `${subModulePath}/view/frontend/templates/scripts/ignore-expected-errors.phtml`;
      const content = '<script>init();</script>';

      const diags = validatePhtml(filePath, content, project);

      expect(diags).toHaveLength(1);
      expect(diags[0].message).toContain(FRONTEND_CSP);
    });

    it('does not warn for modules without the Hyvä dependency', () => {
      // MODULE_PATH has no Hyvä dependency in mockComposerPackages
      const project = makeProject();
      const filePath = `${MODULE_PATH}/view/frontend/templates/page/header.phtml`;
      const content = '<script>init();</script>';

      const diags = validatePhtml(filePath, content, project);

      expect(diags).toHaveLength(0);
    });
  });

  // ----- Base area templates with project-wide Hyvä presence -----

  describe('base area templates in project with Hyvä themes', () => {
    it('warns for base area template when project has a Hyvä theme', () => {
      hyvaThemeTailwindPaths.add(`${HYVA_THEME_PATH}/web/tailwind`);
      const project = makeProject({ themes: [makeHyvaTheme()] });
      const filePath = `${MODULE_PATH}/view/base/templates/widget/list.phtml`;
      const content = '<script>run();</script>';

      const diags = validatePhtml(filePath, content, project);

      expect(diags).toHaveLength(1);
      expect(diags[0].message).toContain(BASE_CSP);
    });

    it('does not warn about missing registration when CSP with isset is present', () => {
      hyvaThemeTailwindPaths.add(`${HYVA_THEME_PATH}/web/tailwind`);
      const project = makeProject({ themes: [makeHyvaTheme()] });
      const filePath = `${MODULE_PATH}/view/base/templates/widget/list.phtml`;
      const content = `<script>run();</script>\n${BASE_CSP}`;

      const diags = validatePhtml(filePath, content, project);

      expect(diags.filter((d) => d.code === DIAG_MISSING_CSP_REGISTRATION)).toHaveLength(0);
    });

    it('does not warn for base area template when project has no Hyvä theme', () => {
      // No Hyvä theme in the project
      const project = makeProject({ themes: [makeNonHyvaTheme()] });
      const filePath = `${MODULE_PATH}/view/base/templates/widget/list.phtml`;
      const content = '<script>run();</script>';

      const diags = validatePhtml(filePath, content, project);

      expect(diags).toHaveLength(0);
    });
  });

  // ----- Multiple script tags -----

  describe('multiple </script> tags', () => {
    it('warns only for </script> tags missing CSP, not for those with it', () => {
      hyvaThemeTailwindPaths.add(`${HYVA_THEME_PATH}/web/tailwind`);
      const project = makeProject({ themes: [makeHyvaTheme()] });
      const filePath = `${HYVA_THEME_PATH}/Magento_Catalog/templates/view.phtml`;
      const content = [
        '<script>first();</script>',
        FRONTEND_CSP,
        '<script>second();</script>',
        '<!-- oops, no CSP here -->',
        '<script>third();</script>',
        FRONTEND_CSP,
      ].join('\n');

      const diags = validatePhtml(filePath, content, project);

      // Only the second </script> is missing its CSP tag
      const regDiags = diags.filter((d) => d.code === DIAG_MISSING_CSP_REGISTRATION);
      expect(regDiags).toHaveLength(1);
      expect(regDiags[0].range.start.line).toBe(2); // 0-indexed, line of "second" script
    });
  });

  // ----- Edge cases -----

  describe('edge cases', () => {
    it('returns empty for template without any script tags', () => {
      hyvaThemeTailwindPaths.add(`${HYVA_THEME_PATH}/web/tailwind`);
      const project = makeProject({ themes: [makeHyvaTheme()] });
      const filePath = `${HYVA_THEME_PATH}/Magento_Catalog/templates/product/view.phtml`;
      const content = '<div><?php echo $block->getHtml(); ?></div>';

      const diags = validatePhtml(filePath, content, project);

      expect(diags).toHaveLength(0);
    });

    it('returns empty for empty file', () => {
      hyvaThemeTailwindPaths.add(`${HYVA_THEME_PATH}/web/tailwind`);
      const project = makeProject({ themes: [makeHyvaTheme()] });
      const filePath = `${HYVA_THEME_PATH}/Magento_Catalog/templates/empty.phtml`;

      const diags = validatePhtml(filePath, '', project);

      expect(diags).toHaveLength(0);
    });

    it('returns empty for non-.phtml files (defensive)', () => {
      const project = makeProject();
      const diags = validatePhtml('/project/some/file.xml', '<script></script>', project);

      expect(diags).toHaveLength(0);
    });

    it('handles </script> tags with extra whitespace inside', () => {
      hyvaThemeTailwindPaths.add(`${HYVA_THEME_PATH}/web/tailwind`);
      const project = makeProject({ themes: [makeHyvaTheme()] });
      const filePath = `${HYVA_THEME_PATH}/Magento_Catalog/templates/view.phtml`;
      const content = '<script>x();</script  >\n<!-- no CSP -->';

      const diags = validatePhtml(filePath, content, project);

      expect(diags).toHaveLength(1);
    });

    it('is case-insensitive for </script> tag matching', () => {
      hyvaThemeTailwindPaths.add(`${HYVA_THEME_PATH}/web/tailwind`);
      const project = makeProject({ themes: [makeHyvaTheme()] });
      const filePath = `${HYVA_THEME_PATH}/Magento_Catalog/templates/view.phtml`;
      const content = '<script>x();</SCRIPT>';

      const diags = validatePhtml(filePath, content, project);

      expect(diags).toHaveLength(1);
    });

    it('places diagnostic range on the </script> tag', () => {
      hyvaThemeTailwindPaths.add(`${HYVA_THEME_PATH}/web/tailwind`);
      const project = makeProject({ themes: [makeHyvaTheme()] });
      const filePath = `${HYVA_THEME_PATH}/Magento_Catalog/templates/view.phtml`;
      const content = 'prefix</script>suffix';

      const diags = validatePhtml(filePath, content, project);

      expect(diags).toHaveLength(1);
      // </script> starts at column 6, length 9
      expect(diags[0].range.start.character).toBe(6);
      expect(diags[0].range.end.character).toBe(15);
    });

    it('detects Hyvä theme via compat module presence (no theme needed)', () => {
      // Project has compat module entries but no explicit Hyvä theme
      const compatPath = '/project/vendor/hyva/compat-checkout';
      const project = makeProject({
        compatMappings: [{
          original: 'Magento_Checkout',
          compat: 'Hyva_CompatCheckout',
          compatPath,
        }],
      });
      const filePath = `${MODULE_PATH}/view/base/templates/cart.phtml`;
      const content = '<script>cart();</script>';

      // projectHasHyvaTheme returns true because compatModule.hasEntries() is true
      const diags = validatePhtml(filePath, content, project);

      expect(diags).toHaveLength(1);
      expect(diags[0].message).toContain(BASE_CSP);
    });
  });

  // ----- Default Hyvä theme exclusion -----

  describe('default Hyvä theme exclusion', () => {
    it('does not warn for templates in the default Hyvä theme package', () => {
      const defaultThemePath = '/project/vendor/hyva-themes/magento2-default-theme';
      const theme: ThemeInfo = {
        code: 'frontend/Hyva/default',
        shortCode: 'Hyva/default',
        area: 'frontend',
        path: defaultThemePath,
      };
      hyvaThemeTailwindPaths.add(`${defaultThemePath}/web/tailwind`);
      const project = makeProject({ themes: [theme] });
      const filePath = `${defaultThemePath}/Magento_Theme/templates/html/header.phtml`;
      const content = '<script>console.log("hi");</script>';

      const diags = validatePhtml(filePath, content, project);

      expect(diags).toHaveLength(0);
    });
  });

  // ----- Script type filtering -----

  describe('script type filtering', () => {
    it('does not warn for <script type="application/json">', () => {
      hyvaThemeTailwindPaths.add(`${HYVA_THEME_PATH}/web/tailwind`);
      const project = makeProject({ themes: [makeHyvaTheme()] });
      const filePath = `${HYVA_THEME_PATH}/Magento_Catalog/templates/view.phtml`;
      const content = '<script type="application/json">{"key": "value"}</script>';

      const diags = validatePhtml(filePath, content, project);

      expect(diags).toHaveLength(0);
    });

    it('does not warn for <script type="text/json">', () => {
      hyvaThemeTailwindPaths.add(`${HYVA_THEME_PATH}/web/tailwind`);
      const project = makeProject({ themes: [makeHyvaTheme()] });
      const filePath = `${HYVA_THEME_PATH}/Magento_Catalog/templates/view.phtml`;
      const content = '<script type="text/json">{"key": "value"}</script>';

      const diags = validatePhtml(filePath, content, project);

      expect(diags).toHaveLength(0);
    });

    it('does not warn for <script type="application/ld+json">', () => {
      hyvaThemeTailwindPaths.add(`${HYVA_THEME_PATH}/web/tailwind`);
      const project = makeProject({ themes: [makeHyvaTheme()] });
      const filePath = `${HYVA_THEME_PATH}/Magento_Catalog/templates/view.phtml`;
      const content = '<script type="application/ld+json">{"@context": "https://schema.org"}</script>';

      const diags = validatePhtml(filePath, content, project);

      expect(diags).toHaveLength(0);
    });

    it('does not warn for <script type="module">', () => {
      hyvaThemeTailwindPaths.add(`${HYVA_THEME_PATH}/web/tailwind`);
      const project = makeProject({ themes: [makeHyvaTheme()] });
      const filePath = `${HYVA_THEME_PATH}/Magento_Catalog/templates/view.phtml`;
      const content = '<script type="module" src="app.js"></script>';

      const diags = validatePhtml(filePath, content, project);

      expect(diags).toHaveLength(0);
    });

    it('warns for <script type="text/javascript"> without CSP', () => {
      hyvaThemeTailwindPaths.add(`${HYVA_THEME_PATH}/web/tailwind`);
      const project = makeProject({ themes: [makeHyvaTheme()] });
      const filePath = `${HYVA_THEME_PATH}/Magento_Catalog/templates/view.phtml`;
      const content = '<script type="text/javascript">var x = 1;</script>';

      const diags = validatePhtml(filePath, content, project);

      expect(diags).toHaveLength(1);
      expect(diags[0].code).toBe(DIAG_MISSING_CSP_REGISTRATION);
    });

    it('warns for <script type="speculationrules"> without CSP', () => {
      hyvaThemeTailwindPaths.add(`${HYVA_THEME_PATH}/web/tailwind`);
      const project = makeProject({ themes: [makeHyvaTheme()] });
      const filePath = `${HYVA_THEME_PATH}/Magento_Catalog/templates/view.phtml`;
      const content = '<script type="speculationrules">{"prefetch": []}</script>';

      const diags = validatePhtml(filePath, content, project);

      expect(diags).toHaveLength(1);
      expect(diags[0].code).toBe(DIAG_MISSING_CSP_REGISTRATION);
    });

    it('does not warn when JS script has CSP and JSON script does not', () => {
      hyvaThemeTailwindPaths.add(`${HYVA_THEME_PATH}/web/tailwind`);
      const project = makeProject({ themes: [makeHyvaTheme()] });
      const filePath = `${HYVA_THEME_PATH}/Magento_Catalog/templates/view.phtml`;
      const content = [
        '<script>var x = 1;</script>',
        FRONTEND_CSP,
        '<script type="application/json">{"key": "value"}</script>',
      ].join('\n');

      const diags = validatePhtml(filePath, content, project);

      expect(diags.filter((d) => d.code === DIAG_MISSING_CSP_REGISTRATION)).toHaveLength(0);
    });

    it('warns only for JS script when mixed with JSON script', () => {
      hyvaThemeTailwindPaths.add(`${HYVA_THEME_PATH}/web/tailwind`);
      const project = makeProject({ themes: [makeHyvaTheme()] });
      const filePath = `${HYVA_THEME_PATH}/Magento_Catalog/templates/view.phtml`;
      const content = [
        '<script>var x = 1;</script>',
        '<script type="application/json">{"key": "value"}</script>',
      ].join('\n');

      const diags = validatePhtml(filePath, content, project);

      const regDiags = diags.filter((d) => d.code === DIAG_MISSING_CSP_REGISTRATION);
      expect(regDiags).toHaveLength(1);
      // Diagnostic should be on line 0 (the JS script), not on the JSON script
      expect(regDiags[0].range.start.line).toBe(0);
    });
  });

  // ----- Missing CSP type hints -----

  describe('missing CSP type hints', () => {
    it('warns when use statement is missing but registerInlineScript is present', () => {
      hyvaThemeTailwindPaths.add(`${HYVA_THEME_PATH}/web/tailwind`);
      const project = makeProject({ themes: [makeHyvaTheme()] });
      const filePath = `${HYVA_THEME_PATH}/Magento_Catalog/templates/product/view.phtml`;
      const content = [
        '<script>init();</script>',
        FRONTEND_CSP,
      ].join('\n');

      const diags = validatePhtml(filePath, content, project);
      const hintDiags = diags.filter((d) => d.code === DIAG_MISSING_CSP_TYPE_HINT);

      expect(hintDiags).toHaveLength(1);
      expect(hintDiags[0].message).toContain('use Hyva\\Theme\\ViewModel\\HyvaCsp');
      expect(hintDiags[0].message).toContain('/** @var HyvaCsp $hyvaCsp */');
    });

    it('warns when only @var is missing', () => {
      hyvaThemeTailwindPaths.add(`${HYVA_THEME_PATH}/web/tailwind`);
      const project = makeProject({ themes: [makeHyvaTheme()] });
      const filePath = `${HYVA_THEME_PATH}/Magento_Catalog/templates/product/view.phtml`;
      const content = [
        '<?php',
        'use Hyva\\Theme\\ViewModel\\HyvaCsp;',
        '?>',
        '<script>init();</script>',
        FRONTEND_CSP,
      ].join('\n');

      const diags = validatePhtml(filePath, content, project);
      const hintDiags = diags.filter((d) => d.code === DIAG_MISSING_CSP_TYPE_HINT);

      expect(hintDiags).toHaveLength(1);
      expect(hintDiags[0].message).not.toContain('use Hyva');
      expect(hintDiags[0].message).toContain('/** @var HyvaCsp $hyvaCsp */');
    });

    it('warns when only use statement is missing', () => {
      hyvaThemeTailwindPaths.add(`${HYVA_THEME_PATH}/web/tailwind`);
      const project = makeProject({ themes: [makeHyvaTheme()] });
      const filePath = `${HYVA_THEME_PATH}/Magento_Catalog/templates/product/view.phtml`;
      const content = [
        '<?php',
        '/** @var HyvaCsp $hyvaCsp */',
        '?>',
        '<script>init();</script>',
        FRONTEND_CSP,
      ].join('\n');

      const diags = validatePhtml(filePath, content, project);
      const hintDiags = diags.filter((d) => d.code === DIAG_MISSING_CSP_TYPE_HINT);

      expect(hintDiags).toHaveLength(1);
      expect(hintDiags[0].message).toContain('use Hyva\\Theme\\ViewModel\\HyvaCsp');
      expect(hintDiags[0].message).not.toContain('@var');
    });

    it('does not warn when both use and @var are present', () => {
      hyvaThemeTailwindPaths.add(`${HYVA_THEME_PATH}/web/tailwind`);
      const project = makeProject({ themes: [makeHyvaTheme()] });
      const filePath = `${HYVA_THEME_PATH}/Magento_Catalog/templates/product/view.phtml`;
      const content = [
        '<?php',
        'use Hyva\\Theme\\ViewModel\\HyvaCsp;',
        '/** @var HyvaCsp $hyvaCsp */',
        '?>',
        '<script>init();</script>',
        FRONTEND_CSP,
      ].join('\n');

      const diags = validatePhtml(filePath, content, project);

      expect(diags).toHaveLength(0);
    });

    it('does not warn when file has no registerInlineScript call', () => {
      hyvaThemeTailwindPaths.add(`${HYVA_THEME_PATH}/web/tailwind`);
      const project = makeProject({ themes: [makeHyvaTheme()] });
      const filePath = `${HYVA_THEME_PATH}/Magento_Catalog/templates/product/view.phtml`;
      const content = '<div><?php echo $block->getHtml(); ?></div>';

      const diags = validatePhtml(filePath, content, project);
      const hintDiags = diags.filter((d) => d.code === DIAG_MISSING_CSP_TYPE_HINT);

      expect(hintDiags).toHaveLength(0);
    });

    it('places diagnostic on the registerInlineScript call', () => {
      hyvaThemeTailwindPaths.add(`${HYVA_THEME_PATH}/web/tailwind`);
      const project = makeProject({ themes: [makeHyvaTheme()] });
      const filePath = `${HYVA_THEME_PATH}/Magento_Catalog/templates/product/view.phtml`;
      const content = [
        '<script>init();</script>',
        FRONTEND_CSP,
      ].join('\n');

      const diags = validatePhtml(filePath, content, project);
      const hintDiags = diags.filter((d) => d.code === DIAG_MISSING_CSP_TYPE_HINT);

      expect(hintDiags).toHaveLength(1);
      // The diagnostic should be on line 1 (the CSP tag line)
      expect(hintDiags[0].range.start.line).toBe(1);
    });

    it('carries cspArea in data for the code action handler', () => {
      hyvaThemeTailwindPaths.add(`${HYVA_THEME_PATH}/web/tailwind`);
      const project = makeProject({ themes: [makeHyvaTheme()] });
      const filePath = `${HYVA_THEME_PATH}/Magento_Catalog/templates/product/view.phtml`;
      const content = [
        '<script>init();</script>',
        FRONTEND_CSP,
      ].join('\n');

      const diags = validatePhtml(filePath, content, project);
      const hintDiags = diags.filter((d) => d.code === DIAG_MISSING_CSP_TYPE_HINT);

      expect(hintDiags).toHaveLength(1);
      expect((hintDiags[0].data as any).cspArea).toBe('frontend');
    });
  });
});
