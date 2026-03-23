/**
 * Core type definitions shared across the indexer, index, cache, and handler modules.
 *
 * These types model the Magento 2 dependency injection configuration as found in di.xml files.
 * Magento's Object Manager uses di.xml to wire up class preferences, plugins (interceptors),
 * constructor arguments, and virtual types. Each of these creates a "reference" linking a
 * PHP fully-qualified class name (FQCN) to a specific location in a di.xml file.
 */

/**
 * Identifies which kind of di.xml element a reference comes from.
 *
 * Example di.xml entries and their corresponding kinds:
 *   <preference for="InterfaceFqcn" type="ImplFqcn" />
 *     -> 'preference-for' (the interface) and 'preference-type' (the implementation)
 *   <type name="ClassName">
 *     -> 'type-name'
 *   <plugin name="..." type="PluginClass" />
 *     -> 'plugin-type'
 *   <argument xsi:type="object">ClassName</argument>
 *     -> 'argument-object'
 *   <virtualType name="VTypeName" type="ParentClass">
 *     -> 'virtualtype-name' and 'virtualtype-type'
 */
export type ReferenceKind =
  | 'preference-for'
  | 'preference-type'
  | 'type-name'
  | 'plugin-type'
  | 'argument-object'
  | 'virtualtype-name'
  | 'virtualtype-type';

/**
 * A single reference to a PHP class found in a di.xml file.
 * Stores enough information to navigate to the exact position in the XML
 * and to determine config merging priority.
 */
export interface DiReference {
  /** Normalized PHP FQCN (no leading backslash, trimmed). */
  fqcn: string;
  /** Which di.xml element this reference comes from. */
  kind: ReferenceKind;
  /** Absolute filesystem path to the di.xml file containing this reference. */
  file: string;
  /** 0-based line number within the di.xml file. */
  line: number;
  /** 0-based column where the FQCN string starts (inside the attribute quotes or text content). */
  column: number;
  /** 0-based column where the FQCN string ends. */
  endColumn: number;
  /** DI scope area: 'global', 'frontend', 'adminhtml', etc. Derived from the file path. */
  area: string;
  /** Magento module name in Vendor_Module format (e.g., 'Magento_Store'). */
  module: string;
  /**
   * Position of this module in app/etc/config.php. Higher number = loaded later = higher priority.
   * Used for config merging: when multiple modules declare the same preference, the last one wins.
   */
  moduleOrder: number;
  /**
   * For preferences only: links the 'for' and 'type' sides together.
   * On a preference-for ref, this is the implementation FQCN (the type= value).
   * On a preference-type ref, this is the interface FQCN (the for= value).
   */
  pairedFqcn?: string;
  /**
   * For plugin-type refs: the FQCN of the parent <type> or <virtualType> element
   * this plugin is nested in. Set during SAX parsing from proper nesting context.
   */
  parentTypeFqcn?: string;
}

/**
 * A virtualType declaration parsed from di.xml.
 *
 * VirtualTypes are Magento's mechanism for creating named DI configurations without a real PHP class.
 * They inherit from a parent class (the `type` attribute) and can override constructor arguments.
 * Example: <virtualType name="MyVType" type="Magento\Framework\Logger">
 */
export interface VirtualTypeDecl {
  /** The virtualType name — can be a short alias or a FQCN-like string. */
  name: string;
  /** The PHP class this virtualType extends (the type= attribute). */
  parentType: string;
  /** Absolute path to the di.xml file. */
  file: string;
  /** 0-based line of the declaration. */
  line: number;
  /** 0-based column of the name attribute value. */
  column: number;
  /** DI scope area. */
  area: string;
  /** Magento module name. */
  module: string;
  /** Module load order from config.php, for config merging priority. */
  moduleOrder: number;
}

/**
 * Metadata about an active Magento module, as listed in app/etc/config.php.
 */
export interface ModuleInfo {
  /** Module name in Vendor_Module format (e.g., 'Magento_Catalog'). */
  name: string;
  /** Absolute filesystem path to the module root directory. */
  path: string;
  /** 0-based position in config.php — determines DI config merge priority (last wins). */
  order: number;
}

/**
 * A single PSR-4 autoload mapping: namespace prefix to filesystem directory.
 * Used to resolve a PHP FQCN to its source file on disk.
 */
export interface Psr4Entry {
  /** Namespace prefix ending with backslash (e.g., 'Magento\\Store\\'). */
  prefix: string;
  /** Absolute filesystem path to the directory mapped to this prefix. */
  path: string;
}

/**
 * Ordered list of PSR-4 entries, sorted by prefix length descending.
 * Longest-prefix-first ordering ensures correct matching when namespaces overlap.
 */
export type Psr4Map = Psr4Entry[];

// ---- Events.xml types ----

/**
 * A reference to an event name in events.xml.
 * Example: <event name="catalog_product_save_after">
 */
export interface EventReference {
  /** The event name string. */
  eventName: string;
  /** Absolute path to the events.xml file. */
  file: string;
  /** 0-based line of the event name attribute value. */
  line: number;
  /** 0-based column where the event name starts. */
  column: number;
  /** 0-based column where the event name ends. */
  endColumn: number;
  /** DI scope area. */
  area: string;
  /** Magento module name. */
  module: string;
}

/**
 * A reference to an observer class in events.xml.
 * Example: <observer name="my_observer" instance="Vendor\Module\Observer\MyObserver" />
 */
export interface ObserverReference {
  /** The observer PHP class FQCN (from the instance attribute). */
  fqcn: string;
  /** The event name this observer is registered for. */
  eventName: string;
  /** The observer name attribute. */
  observerName: string;
  /** Absolute path to the events.xml file. */
  file: string;
  /** 0-based line of the instance attribute value. */
  line: number;
  /** 0-based column where the FQCN starts. */
  column: number;
  /** 0-based column where the FQCN ends. */
  endColumn: number;
  /** DI scope area. */
  area: string;
  /** Magento module name. */
  module: string;
}

// ---- Layout XML types ----

export type LayoutReferenceKind =
  | 'block-class'         // <block class="Magento\Catalog\Block\Product\View">
  | 'block-template'      // <block template="Magento_Catalog::product/view.phtml">
  | 'refblock-template'   // <referenceBlock template="...">
  | 'argument-object';    // <argument xsi:type="object">ClassName</argument>

/**
 * A reference found in a layout or page_layout XML file.
 * Can be a block PHP class, a template identifier, or an object argument.
 */
export interface LayoutReference {
  kind: LayoutReferenceKind;
  /** The raw value from the XML: FQCN or template identifier. */
  value: string;
  /**
   * For templates: the fully resolved identifier (Module_Name::path).
   * If the original was a short path (no :: prefix), this is resolved using
   * the parent block's class attribute via Magento's extractModuleName convention.
   */
  resolvedTemplateId?: string;
  /** Absolute path to the layout XML file. */
  file: string;
  /** 0-based line. */
  line: number;
  /** 0-based column where the value starts. */
  column: number;
  /** 0-based column where the value ends. */
  endColumn: number;
}
