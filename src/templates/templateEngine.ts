/**
 * Minimal template engine for code generation.
 *
 * Replaces {{variable}} placeholders with values from a variable map.
 * No conditionals, loops, or escaping — just straightforward substitution.
 * Backslashes in values (e.g., PHP namespaces) are preserved as-is.
 */

export interface TemplateVariables {
  namespace: string;
  className: string;
  fqcn: string;
  moduleName: string;
  year: string;
  date: string;
}

const PLACEHOLDER_RE = /\{\{(\w+)\}\}/g;

/**
 * Replace all `{{key}}` placeholders in a template string.
 * Unknown placeholders are left unchanged.
 */
export function renderTemplate(template: string, vars: TemplateVariables): string {
  return template.replace(PLACEHOLDER_RE, (match, key: string) => {
    const value = vars[key as keyof TemplateVariables];
    return value !== undefined ? value : match;
  });
}

/**
 * Build template variables from a FQCN and module name.
 */
export function buildTemplateVariables(fqcn: string, moduleName: string): TemplateVariables {
  const lastSep = fqcn.lastIndexOf('\\');
  const namespace = lastSep > 0 ? fqcn.slice(0, lastSep) : '';
  const className = lastSep > 0 ? fqcn.slice(lastSep + 1) : fqcn;
  const now = new Date();

  return {
    namespace,
    className,
    fqcn,
    moduleName,
    year: String(now.getFullYear()),
    date: now.toISOString().slice(0, 10),
  };
}
