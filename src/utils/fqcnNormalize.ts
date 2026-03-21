/**
 * Normalize a PHP fully-qualified class name (FQCN) for consistent index lookups.
 *
 * In di.xml files, class names are almost always written without a leading backslash:
 *   <preference for="Magento\Store\Model\StoreManager" .../>
 *
 * However, a few entries (notably in app/etc/di.xml) use a leading backslash:
 *   <preference for="\Magento\Framework\Setup\SchemaSetupInterface" .../>
 *
 * This function strips the leading backslash so both forms resolve to the same key.
 * It also trims whitespace, which can appear in text content of <argument> elements.
 */
export function normalizeFqcn(fqcn: string): string {
  const trimmed = fqcn.trim();
  if (trimmed.startsWith('\\')) {
    return trimmed.slice(1);
  }
  return trimmed;
}
