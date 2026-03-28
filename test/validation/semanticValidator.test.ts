import { describe, it, expect, vi } from 'vitest';
import { DiagnosticSeverity } from 'vscode-languageserver/node';
import {
  DIAG_CLASS_NOT_FOUND,
  DIAG_OBSERVER_CLASS_NOT_FOUND,
  DIAG_DUPLICATE_PLUGIN_NAME,
  DIAG_TEMPLATE_NOT_FOUND,
  DIAG_MODEL_CLASS_NOT_FOUND,
} from '../../src/validation/diagnosticCodes';
import { validateSemantics } from '../../src/validation/semanticValidator';
import { DiIndex } from '../../src/index/diIndex';
import { EventsIndex } from '../../src/index/eventsIndex';
import { LayoutIndex } from '../../src/index/layoutIndex';
import { PluginMethodIndex } from '../../src/index/pluginMethodIndex';
import { MagicMethodIndex } from '../../src/index/magicMethodIndex';
import { ThemeResolver } from '../../src/project/themeResolver';
import { CompatModuleIndex } from '../../src/index/compatModuleIndex';
import { IndexCache } from '../../src/cache/indexCache';
import type { Psr4Map, ModuleInfo } from '../../src/indexer/types';
import type { ProjectContext } from '../../src/project/projectManager';

// Classes that "exist" for PSR-4 resolution
const EXISTING_CLASSES = new Set([
  'Vendor\\Module\\Model\\Existing',
  'Vendor\\Module\\Block\\TestBlock',
  'Vendor\\Module\\Plugin\\MyPlugin',
  'Vendor\\Module\\Observer\\GoodObserver',
  'Vendor\\Module\\Api\\ExistingInterface',
]);

vi.mock('../../src/indexer/phpClassLocator', () => ({
  resolveClassFile: (fqcn: string, _psr4Map: Psr4Map) => {
    if (EXISTING_CLASSES.has(fqcn)) {
      return `/project/vendor/test/module/${fqcn.replace(/\\/g, '/')}.php`;
    }
    return undefined;
  },
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual('fs');
  return {
    ...actual,
    readFileSync: (filePath: string, encoding: string) => {
      if (filePath.includes('GoodObserver')) {
        return `<?php
namespace Vendor\\Module\\Observer;
use Magento\\Framework\\Event\\ObserverInterface;
class GoodObserver implements ObserverInterface {
  public function execute(\\Magento\\Framework\\Event\\Observer $observer) {}
}`;
      }
      return (actual as any).readFileSync(filePath, encoding);
    },
  };
});

const MODULE_PATH = '/project/vendor/test/module';

function makeProject(): ProjectContext {
  return {
    root: '/project',
    modules: [{ name: 'Test_Module', path: MODULE_PATH, order: 0 }] as ModuleInfo[],
    psr4Map: [
      { prefix: 'Vendor\\Module\\', path: `${MODULE_PATH}/src` },
      { prefix: 'Missing\\', path: '/project/vendor/missing/module/src' },
      { prefix: 'Target\\', path: '/project/vendor/target/module/src' },
      { prefix: 'Magento\\', path: '/project/vendor/magento/framework/src' },
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

const DI_FILE = `${MODULE_PATH}/etc/di.xml`;
const EVENTS_FILE = `${MODULE_PATH}/etc/events.xml`;
const LAYOUT_FILE = `${MODULE_PATH}/view/frontend/layout/default.xml`;

function diXml(body: string): string {
  return `<?xml version="1.0"?>
<config xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="urn:magento:framework:ObjectManager/etc/config.xsd">
${body}
</config>`;
}

function eventsXml(body: string): string {
  return `<?xml version="1.0"?>
<config xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="urn:magento:framework:Event/etc/events.xsd">
${body}
</config>`;
}

function layoutXml(body: string): string {
  return `<?xml version="1.0"?>
<page xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="urn:magento:framework:View/Layout/etc/page_configuration.xsd">
  <body>
${body}
  </body>
</page>`;
}

// --- Tests ---

describe('semanticValidator', () => {
  describe('di.xml validation', () => {
    it('reports error for broken class reference in type name', () => {
      const content = diXml('  <type name="Vendor\\Module\\Model\\NonExistent" />');
      const project = makeProject();

      const diags = validateSemantics(DI_FILE, content, project, false);
      expect(diags).toHaveLength(1);
      expect(diags[0].severity).toBe(DiagnosticSeverity.Error);
      expect(diags[0].message).toContain('NonExistent');
      expect(diags[0].source).toBe('magento2-lsp');
      expect(diags[0].code).toBe(DIAG_CLASS_NOT_FOUND);
      expect(diags[0].data).toEqual({ fqcn: 'Vendor\\Module\\Model\\NonExistent' });
    });

    it('does not report error for existing class', () => {
      const content = diXml('  <type name="Vendor\\Module\\Model\\Existing" />');
      const project = makeProject();

      const diags = validateSemantics(DI_FILE, content, project, false);
      expect(diags).toHaveLength(0);
    });

    it('does not report error for virtual type declared in same file', () => {
      const content = diXml(`
  <virtualType name="myVirtualType" type="Vendor\\Module\\Model\\Existing" />
  <type name="myVirtualType" />`);
      const project = makeProject();

      const diags = validateSemantics(DI_FILE, content, project, false);
      expect(diags).toHaveLength(0);
    });

    it('does not report error for virtual type declared in another file (project index)', () => {
      const content = diXml('  <type name="someGlobalVType" />');
      const project = makeProject();
      // Virtual type exists in the project-wide index from another file
      project.indexes.di.addFile('/project/vendor/other/module/etc/di.xml', [], [
        { name: 'someGlobalVType', parentType: 'Vendor\\Module\\Model\\Existing',
          file: '/project/vendor/other/module/etc/di.xml', line: 0, column: 0,
          area: 'global', module: 'Other_Module', moduleOrder: 1 },
      ]);

      const diags = validateSemantics(DI_FILE, content, project, false);
      expect(diags).toHaveLength(0);
    });

    it('reports broken preference-for and preference-type', () => {
      const content = diXml(
        '  <preference for="Missing\\Interface" type="Missing\\Implementation" />',
      );
      const project = makeProject();

      const diags = validateSemantics(DI_FILE, content, project, false);
      expect(diags).toHaveLength(2);
      expect(diags.every((d) => d.severity === DiagnosticSeverity.Error)).toBe(true);
      expect(diags.every((d) => d.code === DIAG_CLASS_NOT_FOUND)).toBe(true);
      expect((diags[0].data as any).fqcn).toBe('Missing\\Interface');
      expect((diags[1].data as any).fqcn).toBe('Missing\\Implementation');
    });

    it('reports broken plugin-type', () => {
      const content = diXml(`
  <type name="Vendor\\Module\\Model\\Existing">
    <plugin name="test_plugin" type="Missing\\Plugin\\Class" />
  </type>`);
      const project = makeProject();

      const diags = validateSemantics(DI_FILE, content, project, false);
      expect(diags).toHaveLength(1);
      expect(diags[0].message).toContain('Missing\\Plugin\\Class');
    });

    it('reports broken argument-object', () => {
      const content = diXml(`
  <type name="Vendor\\Module\\Model\\Existing">
    <arguments>
      <argument name="dep" xsi:type="object">Missing\\Dependency\\Class</argument>
    </arguments>
  </type>`);
      const project = makeProject();

      const diags = validateSemantics(DI_FILE, content, project, false);
      expect(diags).toHaveLength(1);
      expect(diags[0].message).toContain('Missing\\Dependency\\Class');
    });

    it('does not report virtualtype-name declarations as broken', () => {
      const content = diXml(
        '  <virtualType name="SomeNewVType" type="Vendor\\Module\\Model\\Existing" />',
      );
      const project = makeProject();

      const diags = validateSemantics(DI_FILE, content, project, false);
      expect(diags).toHaveLength(0);
    });

    it('detects duplicate plugin names on save', () => {
      const content = diXml(`
  <type name="Vendor\\Module\\Model\\Existing">
    <plugin name="my_plugin" type="Vendor\\Module\\Plugin\\MyPlugin" />
    <plugin name="my_plugin" type="Vendor\\Module\\Plugin\\MyPlugin" />
  </type>`);
      const project = makeProject();

      // Not detected on keystroke
      const diagsKeystroke = validateSemantics(DI_FILE, content, project, false);
      expect(diagsKeystroke.filter((d) => d.message.includes('Duplicate'))).toHaveLength(0);

      // Detected on save
      const diagsSave = validateSemantics(DI_FILE, content, project, true);
      const dupWarnings = diagsSave.filter((d) => d.message.includes('Duplicate'));
      expect(dupWarnings).toHaveLength(2);
      expect(dupWarnings[0].severity).toBe(DiagnosticSeverity.Warning);
      expect(dupWarnings[0].code).toBe(DIAG_DUPLICATE_PLUGIN_NAME);
    });

    it('detects duplicate plugin name across files via project index', () => {
      const content = diXml(`
  <type name="Vendor\\Module\\Model\\Existing">
    <plugin name="my_plugin" type="Vendor\\Module\\Plugin\\MyPlugin" />
  </type>`);
      const project = makeProject();
      // Another file in the project index already has a plugin with the same name + target
      const otherFile = '/project/vendor/other/module/etc/di.xml';
      project.indexes.di.addFile(otherFile, [
        {
          fqcn: 'Vendor\\Module\\Plugin\\MyPlugin',
          kind: 'plugin-type',
          file: otherFile,
          line: 5, column: 10, endColumn: 40,
          area: 'global', module: 'Other_Module', moduleOrder: 1,
          parentTypeFqcn: 'Vendor\\Module\\Model\\Existing',
          pluginName: 'my_plugin',
        },
      ], []);

      const diags = validateSemantics(DI_FILE, content, project, true);
      const dupWarnings = diags.filter((d) => d.message.includes('already declared'));
      expect(dupWarnings).toHaveLength(1);
      expect(dupWarnings[0].severity).toBe(DiagnosticSeverity.Warning);
    });

    it('does not flag different plugin names as duplicates', () => {
      const content = diXml(`
  <type name="Vendor\\Module\\Model\\Existing">
    <plugin name="plugin_a" type="Vendor\\Module\\Plugin\\MyPlugin" />
    <plugin name="plugin_b" type="Vendor\\Module\\Plugin\\MyPlugin" />
  </type>`);
      const project = makeProject();

      const diags = validateSemantics(DI_FILE, content, project, true);
      expect(diags.filter((d) => d.message.includes('Duplicate'))).toHaveLength(0);
    });
  });

  describe('events.xml validation', () => {
    it('reports error for missing observer class', () => {
      const content = eventsXml(`
  <event name="test_event">
    <observer name="test" instance="Vendor\\Module\\Observer\\NonExistent" />
  </event>`);
      const project = makeProject();

      const diags = validateSemantics(EVENTS_FILE, content, project, false);
      expect(diags).toHaveLength(1);
      expect(diags[0].severity).toBe(DiagnosticSeverity.Error);
      expect(diags[0].message).toContain('Observer class');
      expect(diags[0].message).toContain('not found');
      expect(diags[0].code).toBe(DIAG_OBSERVER_CLASS_NOT_FOUND);
      expect(diags[0].data).toEqual({ fqcn: 'Vendor\\Module\\Observer\\NonExistent' });
    });

    it('does not report error for existing observer class', () => {
      const content = eventsXml(`
  <event name="test_event">
    <observer name="test" instance="Vendor\\Module\\Observer\\GoodObserver" />
  </event>`);
      const project = makeProject();

      const diags = validateSemantics(EVENTS_FILE, content, project, false);
      expect(diags).toHaveLength(0);
    });

    it('does not flag event name elements', () => {
      const content = eventsXml(`
  <event name="some_event_name">
  </event>`);
      const project = makeProject();

      const diags = validateSemantics(EVENTS_FILE, content, project, false);
      expect(diags).toHaveLength(0);
    });
  });

  describe('layout XML validation', () => {
    it('reports error for broken block class', () => {
      const content = layoutXml(
        '    <block class="Vendor\\Module\\Block\\NonExistent" name="test" />',
      );
      const project = makeProject();

      const diags = validateSemantics(LAYOUT_FILE, content, project, false);
      expect(diags).toHaveLength(1);
      expect(diags[0].severity).toBe(DiagnosticSeverity.Error);
      expect(diags[0].message).toContain('not found');
    });

    it('does not report error for existing block class', () => {
      const content = layoutXml(
        '    <block class="Vendor\\Module\\Block\\TestBlock" name="test" />',
      );
      const project = makeProject();

      const diags = validateSemantics(LAYOUT_FILE, content, project, false);
      expect(diags).toHaveLength(0);
    });

    it('reports warning for broken template reference', () => {
      const content = layoutXml(
        '    <block class="Vendor\\Module\\Block\\TestBlock" name="test" template="Vendor_Module::nonexistent/template.phtml" />',
      );
      const project = makeProject();

      const diags = validateSemantics(LAYOUT_FILE, content, project, false);
      // One for the template (block class is valid)
      const templateDiags = diags.filter((d) => d.message.includes('Template'));
      expect(templateDiags).toHaveLength(1);
      expect(templateDiags[0].severity).toBe(DiagnosticSeverity.Warning);
      expect(templateDiags[0].code).toBe(DIAG_TEMPLATE_NOT_FOUND);
      expect((templateDiags[0].data as any).templateId).toBe('Vendor_Module::nonexistent/template.phtml');
      expect((templateDiags[0].data as any).area).toBe('frontend');
    });
  });

  describe('system.xml validation', () => {
    const SYSTEM_FILE = `${MODULE_PATH}/etc/adminhtml/system.xml`;

    function systemXml(body: string): string {
      return `<?xml version="1.0"?>
<config xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="urn:magento:module:Magento_Config:etc/system_file.xsd">
  <system>
    <section id="payment">
      <group id="account">
${body}
      </group>
    </section>
  </system>
</config>`;
    }

    it('reports error for broken source_model class', () => {
      const content = systemXml(
        '        <field id="active"><source_model>Missing\\Source\\Model</source_model></field>',
      );
      const project = makeProject();

      const diags = validateSemantics(SYSTEM_FILE, content, project, false);
      expect(diags).toHaveLength(1);
      expect(diags[0].severity).toBe(DiagnosticSeverity.Error);
      expect(diags[0].message).toContain('Source model');
      expect(diags[0].message).toContain('not found');
      expect(diags[0].code).toBe(DIAG_MODEL_CLASS_NOT_FOUND);
      expect(diags[0].data).toEqual({ fqcn: 'Missing\\Source\\Model' });
    });

    it('reports error for broken backend_model class', () => {
      const content = systemXml(
        '        <field id="active"><backend_model>Missing\\Backend\\Model</backend_model></field>',
      );
      const project = makeProject();

      const diags = validateSemantics(SYSTEM_FILE, content, project, false);
      expect(diags).toHaveLength(1);
      expect(diags[0].message).toContain('Backend model');
    });

    it('reports error for broken frontend_model class', () => {
      const content = systemXml(
        '        <field id="active"><frontend_model>Missing\\Frontend\\Model</frontend_model></field>',
      );
      const project = makeProject();

      const diags = validateSemantics(SYSTEM_FILE, content, project, false);
      expect(diags).toHaveLength(1);
      expect(diags[0].message).toContain('Frontend model');
    });

    it('does not report error for existing model class', () => {
      const content = systemXml(
        '        <field id="active"><source_model>Vendor\\Module\\Model\\Existing</source_model></field>',
      );
      const project = makeProject();

      const diags = validateSemantics(SYSTEM_FILE, content, project, false);
      expect(diags).toHaveLength(0);
    });

    it('does not flag section/group/field IDs as class errors', () => {
      const content = systemXml('        <field id="active"></field>');
      const project = makeProject();

      const diags = validateSemantics(SYSTEM_FILE, content, project, false);
      expect(diags).toHaveLength(0);
    });
  });

  describe('generated class suffixes', () => {
    it('does not flag \\Proxy suffix when base class exists', () => {
      const content = diXml(`
  <type name="Vendor\\Module\\Model\\Existing">
    <arguments>
      <argument name="dep" xsi:type="object">Vendor\\Module\\Model\\Existing\\Proxy</argument>
    </arguments>
  </type>`);
      const project = makeProject();

      const diags = validateSemantics(DI_FILE, content, project, false);
      expect(diags).toHaveLength(0);
    });

    it('does not flag Factory suffix when base class exists', () => {
      const content = diXml(`
  <type name="Vendor\\Module\\Model\\Existing">
    <arguments>
      <argument name="factory" xsi:type="object">Vendor\\Module\\Model\\ExistingFactory</argument>
    </arguments>
  </type>`);
      const project = makeProject();

      const diags = validateSemantics(DI_FILE, content, project, false);
      expect(diags).toHaveLength(0);
    });

    it('does not flag \\Interceptor suffix when base class exists', () => {
      const content = diXml(`
  <type name="Vendor\\Module\\Model\\Existing">
    <arguments>
      <argument name="dep" xsi:type="object">Vendor\\Module\\Model\\Existing\\Interceptor</argument>
    </arguments>
  </type>`);
      const project = makeProject();

      const diags = validateSemantics(DI_FILE, content, project, false);
      expect(diags).toHaveLength(0);
    });

    it('does not flag \\ProxyDeferred suffix when base class exists', () => {
      const content = diXml(`
  <type name="Vendor\\Module\\Model\\Existing">
    <arguments>
      <argument name="dep" xsi:type="object">Vendor\\Module\\Model\\Existing\\ProxyDeferred</argument>
    </arguments>
  </type>`);
      const project = makeProject();

      const diags = validateSemantics(DI_FILE, content, project, false);
      expect(diags).toHaveLength(0);
    });

    it('does not flag SearchResults suffix when base class exists', () => {
      const content = diXml(`
  <type name="Vendor\\Module\\Model\\Existing">
    <arguments>
      <argument name="dep" xsi:type="object">Vendor\\Module\\Model\\ExistingSearchResults</argument>
    </arguments>
  </type>`);
      const project = makeProject();

      const diags = validateSemantics(DI_FILE, content, project, false);
      expect(diags).toHaveLength(0);
    });

    it('does not flag ExtensionInterface suffix when base Interface exists', () => {
      // ExistingExtensionInterface resolves to ExistingInterface (the base)
      const content = diXml(`
  <preference for="Vendor\\Module\\Api\\ExistingInterface"
              type="Vendor\\Module\\Api\\ExistingExtensionInterface" />`);
      const project = makeProject();

      const diags = validateSemantics(DI_FILE, content, project, false);
      expect(diags).toHaveLength(0);
    });

    it('does not flag ExtensionInterfaceFactory (compound generated type)', () => {
      // ExistingExtensionInterfaceFactory → ExistingExtensionInterface → ExistingInterface
      const content = diXml(`
  <type name="Vendor\\Module\\Model\\Existing">
    <arguments>
      <argument name="dep" xsi:type="object">Vendor\\Module\\Api\\ExistingExtensionInterfaceFactory</argument>
    </arguments>
  </type>`);
      const project = makeProject();

      const diags = validateSemantics(DI_FILE, content, project, false);
      expect(diags).toHaveLength(0);
    });

    it('flags \\Proxy suffix when base class does not exist', () => {
      const content = diXml(`
  <type name="Vendor\\Module\\Model\\Existing">
    <arguments>
      <argument name="dep" xsi:type="object">Missing\\Class\\Proxy</argument>
    </arguments>
  </type>`);
      const project = makeProject();

      const diags = validateSemantics(DI_FILE, content, project, false);
      expect(diags).toHaveLength(1);
      expect(diags[0].message).toContain('not found');
    });

    it('flags \\Interceptor suffix when base class does not exist', () => {
      const content = diXml(`
  <type name="Vendor\\Module\\Model\\Existing">
    <arguments>
      <argument name="dep" xsi:type="object">Missing\\Class\\Interceptor</argument>
    </arguments>
  </type>`);
      const project = makeProject();

      const diags = validateSemantics(DI_FILE, content, project, false);
      expect(diags).toHaveLength(1);
      expect(diags[0].message).toContain('not found');
    });
  });

  describe('unknown vendor namespace handling', () => {
    it('does not flag class when vendor namespace is not in PSR-4 map', () => {
      // Adyen is not in the PSR-4 map, so we can't verify if the class exists
      const content = diXml('  <type name="Adyen\\Payment\\Model\\SomeClass" />');
      const project = makeProject();

      const diags = validateSemantics(DI_FILE, content, project, false);
      expect(diags).toHaveLength(0);
    });

    it('flags class when vendor namespace IS known in PSR-4 map', () => {
      // "Vendor\" is known via the PSR-4 entry "Vendor\Module\"
      const content = diXml('  <type name="Vendor\\Module\\Model\\NonExistent" />');
      const project = makeProject();

      const diags = validateSemantics(DI_FILE, content, project, false);
      expect(diags).toHaveLength(1);
    });
  });

  describe('edge cases', () => {
    it('returns empty when indexing not complete', () => {
      const content = diXml('  <type name="Vendor\\Module\\Model\\NonExistent" />');
      const project = makeProject();
      project.indexingComplete = false;

      const diags = validateSemantics(DI_FILE, content, project, false);
      expect(diags).toHaveLength(0);
    });

    it('returns empty for non-Magento XML files', () => {
      const content = '<root><element /></root>';
      const project = makeProject();

      const diags = validateSemantics('/project/some/random/file.xml', content, project, false);
      expect(diags).toHaveLength(0);
    });

    it('handles malformed XML gracefully', () => {
      const content = '<?xml version="1.0"?><config><type name="Missing\\Class" />';
      const project = makeProject();

      // Should not throw, may or may not produce diagnostics depending on parser tolerance
      const diags = validateSemantics(DI_FILE, content, project, false);
      expect(Array.isArray(diags)).toBe(true);
    });

    it('validates area-scoped di.xml files', () => {
      const frontendDiFile = `${MODULE_PATH}/etc/frontend/di.xml`;
      const content = diXml('  <type name="Vendor\\Module\\Model\\NonExistent" />');
      const project = makeProject();

      const diags = validateSemantics(frontendDiFile, content, project, false);
      expect(diags).toHaveLength(1);
    });
  });
});
