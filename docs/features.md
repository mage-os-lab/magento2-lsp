# Feature Reference

Complete list of LSP features provided by magento2-lsp.

## di.xml Navigation

- **Go to Definition** from `di.xml`: jump from a class name to the PHP file, or from a virtualType reference to its `<virtualType>` declaration
- **Go to Definition** from a preference `for` attribute: jump directly to the effective implementation class (after config merging)
- **Find References** from `di.xml`: find all `di.xml` locations referencing a class (preferences, plugins, type declarations, constructor arguments, virtualTypes)
- **Find References** from PHP: cursor on a class/interface declaration shows all `di.xml` references, including those inherited from parent classes and interfaces

## Plugin (Interceptor) Navigation

- **Find References** from an intercepted method (e.g., `save()`): shows the plugin PHP methods (`beforeSave`, `afterSave`, etc.) and their `di.xml` `<plugin>` declarations
- **Find References** from a plugin method (e.g., `beforeSave`): shows the target class method it intercepts and the `di.xml` declaration
- **Code Lens** on target class declaration: shows `N plugins` count
- **Code Lens** on intercepted methods: shows `N plugins` count
- **Code Lens** on plugin `before`/`after`/`around` methods: shows `→ Target\Class::methodName`
- **Plugin inheritance**: plugins declared on an interface or parent class are correctly shown on all implementing/extending classes

## events.xml Navigation

- **Go to Definition** from observer `instance` attribute in `events.xml`: jump to the PHP observer class
- **Find References** from an event name in `events.xml`: shows all observers registered for that event across all modules and areas
- **Find References** from an observer `instance` in `events.xml`: shows all registrations for that observer class
- **Find References** from a PHP observer class declaration: includes `events.xml` registrations
- **Find References** from observer `execute()` method: shows the `events.xml` declarations
- **Code Lens** on observer `execute()` method: shows `→ event_name`

## Layout XML Navigation

- **Go to Definition** from a `class` attribute on `<block>` elements: jump to the PHP class file
- **Go to Definition** from `<argument xsi:type="object">` values (ViewModels, etc.): jump to the PHP class file
- **Go to Definition** from a `template` attribute on `<block>` or `<referenceBlock>`: jump to the `.phtml` file, resolved through the theme fallback hierarchy
- **Go to Definition** from `<update handle="..."/>`: jump to the layout XML files that define that handle (including Hyvä `hyva_` prefixed variants), filtered by area and theme fallback chain
- **Go to Definition** from `<referenceBlock name="...">`: jump to the original `<block name="...">` declaration (cross-file)
- **Go to Definition** from `<referenceContainer name="...">`: jump to the original `<container name="...">` declaration
- **Find References** from a class name in layout XML: shows all layout XML and `di.xml` locations referencing that class
- **Find References** from a template identifier in layout XML: shows all layout XML files using that template
- **Find References** from a block or container name: shows all declarations and `<referenceBlock>`/`<referenceContainer>` usages across layout files
- **Find References** from a PHP class declaration: includes layout XML references (block classes and object arguments)
- **Find References** from a `.phtml` template file: shows all layout XML files that reference the template
- **Template resolution** follows Magento's full fallback chain: current theme → parent themes → module area-specific (`view/frontend/templates/`) → module base (`view/base/templates/`)
- **Short template paths** (e.g., `product/view.phtml` without a module prefix) are automatically resolved using the enclosing block's class to infer the module name

## Template Override Navigation

- **Code Lens** on module templates: shows `overridden in N themes` when theme overrides exist
- **Code Lens** on theme override templates: shows `overrides Magento_Catalog::category/products.phtml`
- **Go to Definition** from a theme override template: jump to the original module template
- **Find References** from a module template: shows layout XML usages and all theme override files
- **Find References** from a theme override template: shows layout XML usages, the original module template, and other theme overrides

## PHP Navigation (Magic Methods)

- **Go to Definition** from a method call on a typed variable: when the method isn't declared on the variable's type but exists on the concrete class (resolved via DI preference), jumps to the method on the concrete class. For example, `$this->storage->getData()` where `StorageInterface` has no `getData()` but the DI preference `Storage extends DataObject` does.
- **Go to Definition** for methods resolved via `__call` or `@method` PHPDoc annotations
- **Code Lens** on magic method calls: shows `→ ClassName::methodName` (or `→ ClassName::__call` for `__call`-dispatched methods)
- Walks ancestor chains (parent classes, interfaces, traits) and resolves return types through method call chains

## system.xml / Config Path Navigation

- **Go to Definition** from `source_model`, `backend_model`, or `frontend_model` in `system.xml`: jump to the PHP class
- **Go to Definition** from PHP `scopeConfig->getValue('section/group/field')` or `isSetFlag(...)`: jump to the `<field>` declaration in `system.xml`
- **Find References** from a `<field>` in `system.xml`: shows all system.xml declarations for that config path across modules, plus all PHP files referencing the config path string
- **Find References** from a `source_model`/`backend_model`/`frontend_model` FQCN in `system.xml`: shows all system.xml and di.xml references to that class
- **Find References** from a PHP class declaration: includes system.xml model references
- **Find References** from a PHP config path string: shows system.xml field declarations and PHP usages
- **Hover** on `<section>`, `<group>`, `<field>` IDs: shows the config path, label, and module name
- **Hover** on model FQCNs: shows the model type, parent config path, and class name
- **Include partials** (e.g., `etc/adminhtml/system/*.xml`) are parsed and indexed — hover indicates partial paths with `…/` prefix
- **Nested groups** are fully supported (config paths can have 4+ segments)

## webapi.xml Navigation

- **Go to Definition** from `class` attribute on `<service>`: jump to the PHP service interface
- **Go to Definition** from `method` attribute on `<service>`: jump to the specific method on the PHP service interface
- **Find References** from a service class in `webapi.xml`: shows all `webapi.xml` routes and `di.xml` references for that class
- **Find References** from a service method in `webapi.xml`: shows all routes using that method on the same interface
- **Find References** from a `<resource ref="...">` in `webapi.xml`: shows all routes using that ACL resource plus the acl.xml definition
- **Find References** from a PHP class declaration: includes `webapi.xml` service class references (checks implemented interfaces)
- **Find References** from a PHP method declaration: shows `webapi.xml` routes that map to that method (checks the class itself and its interfaces)
- **Code Lens** on PHP service interface methods: shows the REST route (e.g., `GET /V1/customers/:customerId`) for each method referenced in `webapi.xml`
- **Hover** on service class: shows REST route URL, HTTP method, and class name
- **Hover** on service method: shows REST route URL, HTTP method, and fully qualified method reference
- **Hover** on `<resource ref="...">`: shows ACL resource with title, hierarchy path, and route context; special explanations for `self` (requires authenticated customer) and `anonymous` (no authentication required)

## acl.xml Navigation

- **Go to Definition** from `<resource ref="...">` in `webapi.xml`: jump to the `<resource>` declaration in acl.xml
- **Go to Definition** from `resource="..."` attribute in `menu.xml`: jump to acl.xml
- **Go to Definition** from `<aclResource>` text in UI component XML: jump to acl.xml
- **Go to Definition** from `<resource>` text inside `<section>` in `system.xml`: jump to acl.xml
- **Go to Definition** from `const ADMIN_RESOURCE = '...'` in PHP: jump to acl.xml
- **Go to Definition** from `->isAllowed('...')` in PHP: jump to acl.xml
- **Find References** from a `<resource>` in `acl.xml`: shows all usages across webapi.xml routes, system.xml sections, menu.xml items, UI component files, and PHP files
- **Find References** from an ACL resource in any referencing file (XML or PHP): shows all usages of that ACL resource across file types plus the acl.xml definition
- **Hover** on `<resource>` in `acl.xml`: shows resource title, hierarchy path, module, and usage counts by file type
- **Hover** on ACL resource references in `webapi.xml`, `menu.xml`, `system.xml`, UI component XML, and PHP: shows resource title and hierarchy from acl.xml

## Semantic Diagnostics

- **Broken class references** in `di.xml`, `events.xml`, and layout XML: error when a FQCN doesn't resolve to a PHP file via PSR-4 (virtual types, generated classes like `\Proxy` and `Factory`, and uninstalled vendor namespaces are excluded)
- **Broken template references** in layout XML: warning when a `Module_Name::path/to/template.phtml` identifier doesn't resolve to any `.phtml` file through module or theme paths
- **Duplicate plugin names**: warning when a `<plugin name="...">` duplicates a name already declared for the same target type, either in the same file or across modules
- **Missing ObserverInterface**: warning when an observer `instance` class exists but doesn't implement `Magento\Framework\Event\ObserverInterface`
- **Broken model references** in `system.xml`: error when a `source_model`, `backend_model`, or `frontend_model` FQCN doesn't resolve to a PHP file
- **Broken service class references** in `webapi.xml`: error when a `<service class="..."/>` FQCN doesn't resolve to a PHP file
- **Missing service methods** in `webapi.xml`: warning when a `<service method="..."/>` method is not found on the service class (checked on save)
- **Undefined ACL resource** in `webapi.xml`, `menu.xml`, `system.xml`, UI component XML, and PHP files: warning when an ACL resource reference is not defined in any acl.xml file

Diagnostics update on every keystroke (debounced). Expensive checks (duplicate plugins, ObserverInterface) also run on file open and save.

## XSD Validation and URN Navigation

- **XML Validation** against declared XSD schemas: diagnostics are published on file open, save, and edit (requires `xmllint` on `$PATH`)
- **Go to Definition** from XSD URN references in XML and XSD files: jump to the resolved `.xsd` file (e.g., `urn:magento:framework:ObjectManager/etc/config.xsd` → the actual XSD file)

## Hover Information

- **Hover** on class names in `di.xml`: shows effective DI config summary (preferences, plugins, virtual types)
- **Hover** on event names in `events.xml`: shows observer count and registrations
- **Hover** on observer `instance` in `events.xml`: shows which events the observer handles
- **Hover** on class and template references in layout XML: shows block class info and template resolution paths
- **Hover** on block names in layout XML: shows block class (or default `Magento\Framework\View\Element\Template`)
- **Hover** on container names in layout XML: shows container label when available
- **Hover** on `<referenceBlock>` / `<referenceContainer>` names: shows class or label from the original declaration
- **Hover** on `system.xml` elements: shows config path, label, module, and model class info
- **Hover** on `webapi.xml` elements: shows REST route, HTTP method, service class/method, and ACL resource info
- **Hover** on `acl.xml` resources: shows resource title, hierarchy path, module, and usage counts across file types
- **Hover** on `menu.xml` resource attributes: shows ACL resource title, hierarchy, and menu item context
- **Hover** on `<aclResource>` in UI components: shows ACL resource title and hierarchy
- **Hover** on `<resource>` in `system.xml` sections: shows ACL resource title, hierarchy, and config section
- **Hover** on ACL resource IDs in PHP (`ADMIN_RESOURCE` constants and `isAllowed()` calls): shows resource title, hierarchy, and module

## Document Symbols (Outline / Breadcrumbs)

- **di.xml**: preferences (interface → implementation), type declarations with nested plugins, virtual types
- **events.xml**: events with nested observers — tree view shows event_name > ObserverClass
- **layout XML**: hierarchical tree of body, containers, blocks, referenceBlock/referenceContainer, and handle updates — nesting reflects actual XML structure
- **system.xml**: hierarchical section > group > field tree, with source/backend/frontend model and ACL resource children
- **webapi.xml**: service classes, methods, and ACL resources — each with HTTP method and route URL context
- **acl.xml**: hierarchical resource tree reconstructed from parent-child relationships
- **menu.xml**: menu items showing title and ACL resource
- **UI component XML**: ACL resource references

## Workspace Symbol Search

- **Workspace Symbol** search (e.g., `Ctrl+T` in VS Code, `:Telescope lsp_workspace_symbols` in Neovim): find DI preferences, plugins, virtual types, and event observers across all indexed projects

## Hyvä Compatibility Module Override Navigation

Supports [automatic template overrides](https://docs.hyva.io/hyva-themes/compatibility-modules/technical-deep-dive.html#automatic-template-overrides) from Hyvä compatibility modules (requires `hyva-themes/magento2-compat-module-fallback`). Compat module registrations are discovered from `etc/frontend/di.xml` files.

- **Code Lens** on module templates: shows `overridden in Hyvä compat module Hyva_Catalog` when a compat module provides an override (shown as a separate lens alongside theme override lenses)
- **Code Lens** on compat module override templates: shows `Hyvä compat override: Magento_Catalog::category/products.phtml`
- **Go to Definition** from a compat module override template: jump to the original module template
- **Find References** from a module template: includes compat module override files alongside theme overrides
- **Find References** from a compat module override: shows the original module template, layout XML usages, and other overrides
