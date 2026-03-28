# MCP Tools Reference

Full parameter and response reference for all Magento 2 LSP MCP tools.

Every tool requires a `filePath` parameter - an absolute path to any file or directory inside the Magento project. The project root is auto-detected by walking up parent directories to find `app/etc/di.xml`.

---

## magento_get_di_config

Get the complete DI configuration for a PHP class/interface after Magento config merging.

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `filePath` | string | yes | Path inside the Magento project |
| `fqcn` | string | yes | Fully-qualified PHP class name (e.g., `Magento\Catalog\Api\ProductRepositoryInterface`) |
| `area` | string | no | DI scope: `global`, `frontend`, `adminhtml`. Defaults to `global` |

### Response

```json
{
  "fqcn": "Magento\\Catalog\\Api\\ProductRepositoryInterface",
  "area": "global",
  "classFile": "vendor/magento/module-catalog/Api/ProductRepositoryInterface.php",
  "preference": {
    "implementation": "Magento\\Catalog\\Model\\ProductRepository",
    "declaredIn": "vendor/magento/module-catalog/etc/di.xml",
    "area": "global",
    "module": "Magento_Catalog"
  },
  "plugins": [
    {
      "pluginClass": "Magento\\Catalog\\Plugin\\...",
      "methods": ["beforeSave", "afterGet"],
      "declaredIn": "vendor/magento/.../etc/di.xml",
      "area": "global",
      "module": "Magento_..."
    }
  ],
  "virtualTypes": [
    {
      "name": "VirtualTypeName",
      "declaredIn": "...",
      "area": "global",
      "module": "...",
      "effectiveParentType": "..."
    }
  ],
  "argumentInjections": [
    { "declaredIn": "...", "area": "global", "module": "..." }
  ],
  "layoutReferences": [
    { "kind": "block-class", "file": "..." }
  ]
}
```

---

## magento_get_plugins_for_method

Get all plugins (before/after/around interceptors) for a specific method, including inherited ones.

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `filePath` | string | yes | Path inside the Magento project |
| `fqcn` | string | yes | Target class FQCN |
| `method` | string | yes | Method name to check |

### Response

```json
{
  "targetClass": "Magento\\Catalog\\Model\\Product",
  "targetMethod": "save",
  "plugins": [
    {
      "prefix": "before",
      "pluginClass": "Vendor\\Module\\Plugin\\ProductPlugin",
      "pluginMethod": "beforeSave",
      "pluginFile": "app/code/Vendor/Module/Plugin/ProductPlugin.php",
      "declaredIn": "app/code/Vendor/Module/etc/di.xml",
      "area": "global",
      "module": "Vendor_Module",
      "inherited": false
    }
  ]
}
```

---

## magento_get_event_observers

Bidirectional event/observer lookup. Provide `eventName` or `observerClass` (at least one).

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `filePath` | string | yes | Path inside the Magento project |
| `eventName` | string | no | Event name (e.g., `catalog_product_save_after`) |
| `observerClass` | string | no | Observer PHP class FQCN |

### Response (by event name)

```json
{
  "eventName": "catalog_product_save_after",
  "observers": [
    {
      "observerName": "clean_cache",
      "observerClass": "Magento\\Catalog\\Observer\\...",
      "declaredIn": "vendor/magento/.../etc/events.xml",
      "area": "global",
      "module": "Magento_Catalog"
    }
  ]
}
```

### Response (by observer class)

```json
{
  "observerClass": "Magento\\Catalog\\Observer\\...",
  "events": [
    {
      "eventName": "catalog_product_save_after",
      "observerName": "clean_cache",
      "declaredIn": "...",
      "area": "global",
      "module": "..."
    }
  ]
}
```

---

## magento_get_template_overrides

Find theme overrides and layout XML usages for a template.

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `filePath` | string | yes | Path inside the Magento project |
| `templateId` | string | yes | Template in `Module_Name::path` format (e.g., `Magento_Catalog::product/view.phtml`) |
| `area` | string | no | `frontend` or `adminhtml`. Defaults to `frontend` |

### Response

```json
{
  "templateId": "Magento_Catalog::product/view.phtml",
  "area": "frontend",
  "moduleTemplate": "vendor/magento/module-catalog/view/frontend/templates/product/view.phtml",
  "themeOverrides": [
    { "theme": "Vendor/theme", "file": "app/design/frontend/Vendor/theme/Magento_Catalog/templates/product/view.phtml" }
  ],
  "layoutUsages": [
    { "kind": "block-template", "file": "vendor/magento/.../layout/catalog_product_view.xml" }
  ]
}
```

---

## magento_get_class_context

Get the full Magento context for a PHP class file.

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `filePath` | string | yes | Absolute path to a PHP class file |

### Response

```json
{
  "fqcn": "Magento\\Catalog\\Model\\Product",
  "file": "vendor/magento/module-catalog/Model/Product.php",
  "module": "Magento_Catalog",
  "preference": { "implementation": "...", "declaredIn": "...", "area": "...", "module": "..." },
  "pluginsByMethod": {
    "save": [
      {
        "prefix": "before",
        "pluginClass": "...",
        "pluginMethod": "beforeSave",
        "pluginFile": "...",
        "declaredIn": "...",
        "area": "...",
        "module": "...",
        "inherited": false
      }
    ]
  },
  "events": [
    { "eventName": "...", "observerName": "...", "declaredIn": "...", "area": "...", "module": "..." }
  ],
  "virtualTypes": [],
  "argumentInjections": [],
  "layoutReferences": [],
  "isPlugin": false,
  "pluginTargets": []
}
```

`isPlugin` and `pluginTargets` are only present when the class is a plugin.

---

## magento_get_module_overview

Get an overview of what a module declares. Automatically summarizes large modules.

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `filePath` | string | yes | Path inside the Magento project |
| `moduleName` | string | no | Module in `Vendor_Module` format. Auto-detected from `filePath` if omitted |
| `detail` | boolean | no | When `true`, always return full arrays even for large modules. Default: `false` |

### Response

For small modules, all sections are full arrays. For large modules (30+ items across collapsible sections), `preferences`, `plugins`, `virtualTypes`, `observers`, and `webapiEndpoints` collapse to `{ "count": N }`. Pass `detail: true` to override this and get full arrays regardless of size.

```json
{
  "moduleName": "Magento_Catalog",
  "modulePath": "vendor/magento/module-catalog",
  "loadOrder": 34,
  "preferences": { "count": 102 },
  "plugins": { "count": 48 },
  "virtualTypes": { "count": 37 },
  "observers": { "count": 27 },
  "routes": [
    { "routeId": "catalog", "frontName": "catalog", "routerType": "standard", "area": "frontend" }
  ],
  "webapiEndpoints": { "count": 81 },
  "dbTables": ["catalog_product_entity", "catalog_category_entity"],
  "aclResources": [
    { "id": "Magento_Catalog::catalog", "title": "Catalog" }
  ]
}
```

When not summarized (small modules), `preferences`, `plugins`, `virtualTypes`, `observers`, and `webapiEndpoints` are arrays:

- **preferences**: `[{ interface, implementation, area, file }]`
- **plugins**: `[{ targetClass, pluginClass, area, file }]`
- **virtualTypes**: `[{ name, parentType, area, file }]`
- **observers**: `[{ eventName, observerName, observerClass, area, file }]`
- **webapiEndpoints**: `[{ url, httpMethod, serviceClass, serviceMethod }]`

---

## magento_resolve_class

Lightweight PSR-4 resolution between FQCN and file path.

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `filePath` | string | yes | Path inside the Magento project |
| `fqcn` | string | no | FQCN to resolve to a file path |
| `phpFile` | string | no | PHP file path to resolve to a FQCN |

At least one of `fqcn` or `phpFile` must be provided.

### Response

```json
{
  "fqcn": "Magento\\Catalog\\Model\\Product",
  "resolvedFile": "vendor/magento/module-catalog/Model/Product.php",
  "phpFile": "vendor/magento/module-catalog/Model/Product.php",
  "resolvedFqcn": "Magento\\Catalog\\Model\\Product",
  "module": "Magento_Catalog"
}
```

Fields present depend on which parameters were provided.

---

## magento_search_symbols

Search for Magento symbols by name substring across all indexed data.

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `filePath` | string | yes | Path inside the Magento project |
| `query` | string | yes | Search string (minimum 2 characters, case-insensitive) |

### Response

Returns up to 100 results, with up to 25 per category to ensure all symbol types are represented.

```json
{
  "query": "customer",
  "resultCount": 100,
  "results": [
    { "name": "Magento\\Customer\\Api\\CustomerRepositoryInterface", "kind": "class", "file": "...", "classFile": "..." },
    { "name": "CustomerAddressSnapshot", "kind": "virtualType", "file": "..." },
    { "name": "customer_login", "kind": "event", "file": "..." },
    { "name": "customer_entity", "kind": "table", "file": "..." },
    { "name": "customer/account_share/scope", "kind": "configPath", "file": "..." },
    { "name": "Magento_Customer::manage", "kind": "aclResource", "file": "..." },
    { "name": "customer", "kind": "route", "file": "..." }
  ]
}
```

**Symbol kinds**: `class`, `virtualType`, `event`, `table`, `configPath`, `aclResource`, `route`

---

## magento_get_class_hierarchy

Get the inheritance chain for a PHP class.

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `filePath` | string | yes | Path inside the Magento project |
| `fqcn` | string | yes | Fully-qualified PHP class name |

### Response

```json
{
  "fqcn": "Magento\\Catalog\\Model\\Product",
  "classFile": "vendor/magento/module-catalog/Model/Product.php",
  "module": "Magento_Catalog",
  "parentClass": "Magento\\Catalog\\Model\\AbstractModel",
  "interfaces": ["Magento\\Catalog\\Api\\Data\\ProductInterface"],
  "ancestors": [
    "Magento\\Catalog\\Model\\AbstractModel",
    "Magento\\Framework\\Model\\AbstractExtensibleModel",
    "Magento\\Catalog\\Api\\Data\\ProductInterface"
  ]
}
```

---

## magento_get_db_schema

Get the merged database table schema from all db_schema.xml files across modules.

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `filePath` | string | yes | Path inside the Magento project |
| `tableName` | string | yes | Database table name (e.g., `catalog_product_entity`) |

### Response

```json
{
  "tableName": "catalog_product_entity",
  "comment": "Catalog Product Table",
  "resource": "default",
  "engine": "innodb",
  "columns": [
    {
      "name": "entity_id",
      "type": "int",
      "nullable": false,
      "identity": true,
      "unsigned": true,
      "comment": "Entity ID",
      "module": "Magento_Catalog"
    },
    {
      "name": "sku",
      "type": "varchar",
      "length": "64",
      "nullable": false,
      "identity": false,
      "comment": "SKU",
      "module": "Magento_Catalog"
    }
  ],
  "foreignKeys": [
    {
      "referenceId": "CAT_PRD_ENTT_ATTR_SET_ID_EAV_ATTR_SET_ATTR_SET_ID",
      "column": "attribute_set_id",
      "referenceTable": "eav_attribute_set",
      "referenceColumn": "attribute_set_id",
      "onDelete": "CASCADE"
    }
  ],
  "declaredIn": [
    { "module": "Magento_Catalog", "file": "vendor/magento/module-catalog/etc/db_schema.xml" }
  ]
}
```

Column objects may also include: `length`, `default`, `precision`, `scale`, `unsigned`.

---

## magento_reindex

Rebuild all in-memory indexes. Call after modifying XML configuration files.

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `filePath` | string | yes | Path inside the Magento project |

### Response

```json
{
  "projectRoot": "/path/to/magento",
  "moduleCount": 417,
  "diXmlFiles": 1200,
  "eventsXmlFiles": 150,
  "layoutXmlFiles": 800,
  "routesXmlFiles": 45,
  "themes": 3
}
```
