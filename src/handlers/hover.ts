/**
 * LSP "textDocument/hover" handler.
 *
 * Shows contextual information when hovering over references in XML config files
 * and PHP files:
 *   - di.xml: effective DI config (preferences, plugins, virtualTypes)
 *   - events.xml: observer counts for events, event names for observers
 *   - layout XML: block class info, template resolution paths
 *   - PHP: ACL resource info for ADMIN_RESOURCE constants and isAllowed() calls
 */

import {
  CancellationToken,
  Hover,
  HoverParams,
  MarkupKind,
  Range,
} from 'vscode-languageserver';
import { URI } from 'vscode-uri';
import { ProjectContext } from '../project/projectManager';
import { isObserverReference } from '../index/eventsIndex';
import { realpath } from '../utils/realpath';
import { createPhpAclRegex } from '../utils/phpAclGrep';
import * as fs from 'fs';

/** Magento's default block class when no class attribute is specified in layout XML. */
const MAGENTO_DEFAULT_BLOCK_CLASS = 'Magento\\Framework\\View\\Element\\Template';

export function handleHover(
  params: HoverParams,
  getProject: (uri: string) => ProjectContext | undefined,
  getDocumentText: (uri: string) => string | undefined,
  token?: CancellationToken,
): Hover | null {
  if (token?.isCancellationRequested) return null;
  const filePath = realpath(URI.parse(params.textDocument.uri).fsPath);

  // Handle PHP files: show ACL resource info for ADMIN_RESOURCE and isAllowed() patterns
  if (filePath.endsWith('.php')) {
    return handlePhpHover(filePath, params, getProject, getDocumentText, token);
  }

  if (!filePath.endsWith('.xml')) return null;

  const project = getProject(filePath);
  if (!project) return null;

  const { line, character } = params.position;

  // --- Try di.xml ---
  const diRef = project.indexes.di.getReferenceAtPosition(filePath, line, character);
  if (diRef) {
    let value: string;
    const range = Range.create(diRef.line, diRef.column, diRef.line, diRef.endColumn);

    switch (diRef.kind) {
      case 'preference-for': {
        const effective = project.indexes.di.getEffectivePreferenceType(diRef.fqcn, diRef.area);
        value = effective
          ? `**Preference**\n\n\`${diRef.fqcn}\` → \`${effective.fqcn}\`\n\nModule: ${effective.module}, Area: ${effective.area}`
          : `**Preference**\n\n\`${diRef.fqcn}\` — no effective implementation`;
        break;
      }
      case 'preference-type': {
        value = diRef.pairedFqcn
          ? `**Preference implementation** for \`${diRef.pairedFqcn}\`\n\nModule: ${diRef.module}, Area: ${diRef.area}`
          : `**Preference implementation**\n\n\`${diRef.fqcn}\``;
        break;
      }
      case 'type-name': {
        const pluginCount = project.indexes.pluginMethod.getTotalPluginCount(diRef.fqcn);
        value = pluginCount > 0
          ? `**Type**\n\n\`${diRef.fqcn}\`\n\n${pluginCount} plugin${pluginCount === 1 ? '' : 's'}`
          : `**Type**\n\n\`${diRef.fqcn}\``;
        break;
      }
      case 'plugin-type': {
        const target = diRef.parentTypeFqcn ?? 'unknown';
        value = `**Plugin** for \`${target}\`\n\nPlugin class: \`${diRef.fqcn}\``;
        break;
      }
      case 'virtualtype-name': {
        const vt = project.indexes.di.getEffectiveVirtualType(diRef.fqcn);
        value = vt
          ? `**VirtualType**\n\n\`${vt.name}\` extends \`${vt.parentType}\``
          : `**VirtualType**\n\n\`${diRef.fqcn}\``;
        break;
      }
      case 'virtualtype-type': {
        value = `**VirtualType parent**\n\n\`${diRef.fqcn}\``;
        break;
      }
      case 'argument-object': {
        value = `**DI argument**\n\n\`${diRef.fqcn}\``;
        break;
      }
      default:
        return null;
    }

    return {
      contents: { kind: MarkupKind.Markdown, value },
      range,
    };
  }

  // --- Try system.xml ---
  const sysRef = project.indexes.systemConfig.getReferenceAtPosition(filePath, line, character);
  if (sysRef) {
    const range = Range.create(sysRef.line, sysRef.column, sysRef.line, sysRef.endColumn);
    const isPartial = filePath.includes('/etc/adminhtml/system/');
    const pathDisplay = isPartial ? `…/${sysRef.configPath}` : sysRef.configPath;
    let value: string;

    switch (sysRef.kind) {
      case 'section-id':
        value = `**Config section** \`${pathDisplay}\``;
        if (sysRef.label) value += `\n\nLabel: ${sysRef.label}`;
        value += `\n\nModule: ${sysRef.module}`;
        if (isPartial) value += `\n\n*Include partial — full path has a prefix from parent system.xml*`;
        break;
      case 'group-id':
        value = `**Config group** \`${pathDisplay}\``;
        if (sysRef.label) value += `\n\nLabel: ${sysRef.label}`;
        value += `\n\nModule: ${sysRef.module}`;
        if (isPartial) value += `\n\n*Include partial — full path has a prefix from parent system.xml*`;
        break;
      case 'field-id':
        value = `**Config field** \`${pathDisplay}\``;
        if (sysRef.label) value += `\n\nLabel: ${sysRef.label}`;
        value += `\n\nModule: ${sysRef.module}`;
        if (isPartial) value += `\n\n*Include partial — full path has a prefix from parent system.xml*`;
        break;
      case 'source-model':
        value = `**Source model** for \`${pathDisplay}\`\n\nClass: \`${sysRef.fqcn}\``;
        break;
      case 'backend-model':
        value = `**Backend model** for \`${pathDisplay}\`\n\nClass: \`${sysRef.fqcn}\``;
        break;
      case 'frontend-model':
        value = `**Frontend model** for \`${pathDisplay}\`\n\nClass: \`${sysRef.fqcn}\``;
        break;
      case 'section-resource': {
        const aclDef = project.indexes.acl.getResource(sysRef.aclResourceId ?? '');
        value = `**ACL Resource** \`${sysRef.aclResourceId}\``;
        if (aclDef?.title) {
          value += `\n\nTitle: ${aclDef.title}`;
          if (aclDef.hierarchyPath.length > 1) {
            const pathTitles = aclDef.hierarchyPath.map((id) => {
              const res = project.indexes.acl.getResource(id);
              return res?.title || id;
            });
            value += `\n\nPath: ${pathTitles.join(' > ')}`;
          }
        }
        value += `\n\nConfig section: \`${pathDisplay}\``;
        break;
      }
      default:
        return null;
    }

    return { contents: { kind: MarkupKind.Markdown, value }, range };
  }

  // --- Try webapi.xml ---
  const webapiRef = project.indexes.webapi.getReferenceAtPosition(filePath, line, character);
  if (webapiRef) {
    const range = Range.create(webapiRef.line, webapiRef.column, webapiRef.line, webapiRef.endColumn);
    let value: string;
    switch (webapiRef.kind) {
      case 'service-class':
        value = `**REST Service**\n\n\`${webapiRef.httpMethod} ${webapiRef.routeUrl}\`\n\nClass: \`${webapiRef.value}\``;
        break;
      case 'service-method':
        value = `**REST Method**\n\n\`${webapiRef.httpMethod} ${webapiRef.routeUrl}\`\n\nMethod: \`${webapiRef.fqcn}::${webapiRef.value}\``;
        break;
      case 'resource-ref':
        if (webapiRef.value === 'self') {
          value = `**ACL** \`self\` — requires authenticated customer\n\nRoute: \`${webapiRef.httpMethod} ${webapiRef.routeUrl}\``;
        } else if (webapiRef.value === 'anonymous') {
          value = `**ACL** \`anonymous\` — no authentication required\n\nRoute: \`${webapiRef.httpMethod} ${webapiRef.routeUrl}\``;
        } else {
          // Enrich with title and hierarchy from acl.xml when available
          const aclDef = project.indexes.acl.getResource(webapiRef.value);
          value = `**ACL Resource** \`${webapiRef.value}\``;
          if (aclDef?.title) {
            value += `\n\nTitle: ${aclDef.title}`;
            // Show hierarchy path using titles where available
            if (aclDef.hierarchyPath.length > 1) {
              const pathTitles = aclDef.hierarchyPath.map((id) => {
                const res = project.indexes.acl.getResource(id);
                return res?.title || id;
              });
              value += `\n\nPath: ${pathTitles.join(' > ')}`;
            }
          }
          value += `\n\nRoute: \`${webapiRef.httpMethod} ${webapiRef.routeUrl}\``;
        }
        break;
      default:
        return null;
    }
    return { contents: { kind: MarkupKind.Markdown, value }, range };
  }

  // --- Try acl.xml ---
  const aclResource = project.indexes.acl.getResourceAtPosition(filePath, line, character);
  if (aclResource) {
    const range = Range.create(aclResource.line, aclResource.column, aclResource.line, aclResource.endColumn);
    let value = `**ACL Resource** \`${aclResource.id}\``;
    if (aclResource.title) {
      value += `\n\nTitle: ${aclResource.title}`;
    }
    // Show hierarchy path using titles where available
    if (aclResource.hierarchyPath.length > 1) {
      const pathTitles = aclResource.hierarchyPath.map((id) => {
        const res = project.indexes.acl.getResource(id);
        return res?.title || id;
      });
      value += `\n\nPath: ${pathTitles.join(' > ')}`;
    }
    value += `\n\nModule: ${aclResource.module}`;
    // Show usage counts across all XML types that reference ACL resources
    const refCounts: string[] = [];
    const webapiRefs = project.indexes.webapi.getRefsForResource(aclResource.id);
    if (webapiRefs.length > 0) refCounts.push(`${webapiRefs.length} webapi.xml route${webapiRefs.length === 1 ? '' : 's'}`);
    const systemRefs = project.indexes.systemConfig.getRefsForAclResource(aclResource.id);
    if (systemRefs.length > 0) refCounts.push(`${systemRefs.length} system.xml section${systemRefs.length === 1 ? '' : 's'}`);
    const menuRefs = project.indexes.menu.getRefsForResource(aclResource.id);
    if (menuRefs.length > 0) refCounts.push(`${menuRefs.length} menu item${menuRefs.length === 1 ? '' : 's'}`);
    const uiRefs = project.indexes.uiComponentAcl.getRefsForResource(aclResource.id);
    if (uiRefs.length > 0) refCounts.push(`${uiRefs.length} UI component${uiRefs.length === 1 ? '' : 's'}`);
    if (refCounts.length > 0) {
      value += `\n\nReferenced in ${refCounts.join(', ')}`;
    }
    return { contents: { kind: MarkupKind.Markdown, value }, range };
  }

  // --- Try menu.xml ---
  const menuRef = project.indexes.menu.getReferenceAtPosition(filePath, line, character);
  if (menuRef) {
    const range = Range.create(menuRef.line, menuRef.column, menuRef.line, menuRef.endColumn);
    const aclDef = project.indexes.acl.getResource(menuRef.value);
    let value = `**ACL Resource** \`${menuRef.value}\``;
    if (aclDef?.title) {
      value += `\n\nTitle: ${aclDef.title}`;
      if (aclDef.hierarchyPath.length > 1) {
        const pathTitles = aclDef.hierarchyPath.map((id) => {
          const res = project.indexes.acl.getResource(id);
          return res?.title || id;
        });
        value += `\n\nPath: ${pathTitles.join(' > ')}`;
      }
    }
    value += `\n\nMenu item: ${menuRef.menuItemTitle || menuRef.menuItemId}`;
    return { contents: { kind: MarkupKind.Markdown, value }, range };
  }

  // --- Try UI component aclResource ---
  const uiAclRef = project.indexes.uiComponentAcl.getReferenceAtPosition(filePath, line, character);
  if (uiAclRef) {
    const range = Range.create(uiAclRef.line, uiAclRef.column, uiAclRef.line, uiAclRef.endColumn);
    const aclDef = project.indexes.acl.getResource(uiAclRef.value);
    let value = `**ACL Resource** \`${uiAclRef.value}\``;
    if (aclDef?.title) {
      value += `\n\nTitle: ${aclDef.title}`;
      if (aclDef.hierarchyPath.length > 1) {
        const pathTitles = aclDef.hierarchyPath.map((id) => {
          const res = project.indexes.acl.getResource(id);
          return res?.title || id;
        });
        value += `\n\nPath: ${pathTitles.join(' > ')}`;
      }
    }
    return { contents: { kind: MarkupKind.Markdown, value }, range };
  }

  // --- Try db_schema.xml ---
  const dbSchemaRef = project.indexes.dbSchema.getReferenceAtPosition(filePath, line, character);
  if (dbSchemaRef) {
    const range = Range.create(dbSchemaRef.line, dbSchemaRef.column, dbSchemaRef.line, dbSchemaRef.endColumn);
    let value = '';

    switch (dbSchemaRef.kind) {
      case 'table-name': {
        value = `**Table** \`${dbSchemaRef.value}\``;
        if (dbSchemaRef.tableComment) value += `\n\n${dbSchemaRef.tableComment}`;
        if (dbSchemaRef.tableResource) value += `\n\nResource: ${dbSchemaRef.tableResource}`;
        if (dbSchemaRef.tableEngine) value += `  \nEngine: ${dbSchemaRef.tableEngine}`;
        value += `\n\nModule: ${dbSchemaRef.module}`;
        // Count how many modules define this table
        const allDefs = project.indexes.dbSchema.getTableDefs(dbSchemaRef.value);
        if (allDefs.length > 1) {
          value += `\n\nDefined in ${allDefs.length} modules`;
        }
        // Count columns across all modules
        const allCols = project.indexes.dbSchema.getColumnsForTable(dbSchemaRef.value);
        if (allCols.length > 0) {
          value += `\n\n${allCols.length} column${allCols.length === 1 ? '' : 's'}`;
        }
        if (dbSchemaRef.disabled) value += `\n\n*disabled*`;
        break;
      }
      case 'column-name': {
        value = `**Column** \`${dbSchemaRef.tableName}\`.\`${dbSchemaRef.value}\``;
        if (dbSchemaRef.columnType) value += `\n\nType: ${dbSchemaRef.columnType}`;
        if (dbSchemaRef.columnLength) value += `  \nLength: ${dbSchemaRef.columnLength}`;
        if (dbSchemaRef.columnPrecision) value += `  \nPrecision: ${dbSchemaRef.columnPrecision}`;
        if (dbSchemaRef.columnScale) value += `  \nScale: ${dbSchemaRef.columnScale}`;
        if (dbSchemaRef.columnNullable) value += `  \nNullable: ${dbSchemaRef.columnNullable}`;
        if (dbSchemaRef.columnUnsigned) value += `  \nUnsigned: ${dbSchemaRef.columnUnsigned}`;
        if (dbSchemaRef.columnIdentity === 'true') value += `  \nAuto-increment: yes`;
        if (dbSchemaRef.columnDefault !== undefined) value += `  \nDefault: ${dbSchemaRef.columnDefault}`;
        if (dbSchemaRef.columnComment) value += `\n\n${dbSchemaRef.columnComment}`;
        value += `\n\nModule: ${dbSchemaRef.module}`;
        if (dbSchemaRef.disabled) value += `\n\n*disabled*`;
        break;
      }
      case 'fk-ref-table': {
        value = `**FK Reference** → \`${dbSchemaRef.fkRefTable}\``;
        if (dbSchemaRef.fkColumn && dbSchemaRef.fkRefColumn) {
          value += `\n\n\`${dbSchemaRef.fkTable || dbSchemaRef.tableName}\`.\`${dbSchemaRef.fkColumn}\` → \`${dbSchemaRef.fkRefTable}\`.\`${dbSchemaRef.fkRefColumn}\``;
        }
        if (dbSchemaRef.fkOnDelete) value += `\n\nON DELETE ${dbSchemaRef.fkOnDelete}`;
        // Show info about the referenced table
        const refTableDefs = project.indexes.dbSchema.getTableDefs(dbSchemaRef.value);
        if (refTableDefs.length > 0 && refTableDefs[0].tableComment) {
          value += `\n\n*${refTableDefs[0].tableComment}*`;
        }
        break;
      }
      case 'fk-ref-column': {
        value = `**FK Reference Column** \`${dbSchemaRef.fkRefTable}\`.\`${dbSchemaRef.value}\``;
        if (dbSchemaRef.fkColumn) {
          value += `\n\n\`${dbSchemaRef.fkTable || dbSchemaRef.tableName}\`.\`${dbSchemaRef.fkColumn}\` → \`${dbSchemaRef.fkRefTable}\`.\`${dbSchemaRef.value}\``;
        }
        if (dbSchemaRef.fkOnDelete) value += `\n\nON DELETE ${dbSchemaRef.fkOnDelete}`;
        // Show column type from the referenced table
        const refCols = project.indexes.dbSchema.getColumnsForTable(dbSchemaRef.fkRefTable ?? '');
        const refCol = refCols.find((c) => c.value === dbSchemaRef.value);
        if (refCol?.columnType) {
          value += `\n\nType: ${refCol.columnType}`;
        }
        break;
      }
      default:
        return null;
    }

    return { contents: { kind: MarkupKind.Markdown, value }, range };
  }

  // --- Try routes.xml ---
  const routesRef = project.indexes.routes.getReferenceAtPosition(filePath, line, character);
  if (routesRef) {
    const range = Range.create(routesRef.line, routesRef.column, routesRef.line, routesRef.endColumn);
    const fnDisplay = routesRef.frontName || '*- empty -*';
    let value = '';
    if (routesRef.kind === 'route-frontname') {
      value = `**Route** \`${routesRef.value}\`\n\nRouter: ${routesRef.routerType}  \nArea: ${routesRef.area}`;
      const moduleRefs = project.indexes.routes.getRefsForFrontName(routesRef.value)
        .filter((r) => r.kind === 'route-module');
      if (moduleRefs.length > 0) {
        value += '\n\nModules:\n' + moduleRefs.map((r) => `- ${r.value}`).join('\n');
      }
    } else if (routesRef.kind === 'route-module') {
      value = `**Route module** \`${routesRef.value}\`\n\nFrontName: ${fnDisplay}  \nRouter: ${routesRef.routerType}  \nArea: ${routesRef.area}`;
      if (routesRef.before) value += `  \nBefore: ${routesRef.before}`;
      if (routesRef.after) value += `  \nAfter: ${routesRef.after}`;
      if (routesRef.frontName) {
        value += `\n\nURL pattern: \`${routesRef.frontName}/{controller}/{action}\``;
      }
    } else {
      // route-id
      value = `**Route** \`${routesRef.value}\` (frontName: ${fnDisplay})\n\nRouter: ${routesRef.routerType}  \nArea: ${routesRef.area}`;
      const moduleRefs = project.indexes.routes.getRefsForRouteId(routesRef.value)
        .filter((r) => r.kind === 'route-module');
      if (moduleRefs.length > 0) {
        value += '\n\nModules:\n' + moduleRefs.map((r) => `- ${r.value}`).join('\n');
      }
    }
    return { contents: { kind: MarkupKind.Markdown, value }, range };
  }

  // --- Try events.xml ---
  const eventsRef = project.indexes.events.getReferenceAtPosition(filePath, line, character);
  if (eventsRef) {
    const range = Range.create(eventsRef.line, eventsRef.column, eventsRef.line, eventsRef.endColumn);

    if (isObserverReference(eventsRef)) {
      const value = `**Observer** for \`${eventsRef.eventName}\`\n\nClass: \`${eventsRef.fqcn}\`\n\nName: ${eventsRef.observerName}`;
      return { contents: { kind: MarkupKind.Markdown, value }, range };
    } else {
      const observers = project.indexes.events.getObserversForEvent(eventsRef.eventName);
      const count = observers.length;
      const value = count > 0
        ? `**Event** \`${eventsRef.eventName}\`\n\n${count} observer${count === 1 ? '' : 's'}`
        : `**Event** \`${eventsRef.eventName}\`\n\nNo observers`;
      return { contents: { kind: MarkupKind.Markdown, value }, range };
    }
  }

  // --- Try layout XML ---
  const layoutRef = project.indexes.layout.getReferenceAtPosition(filePath, line, character);
  if (layoutRef) {
    const range = Range.create(layoutRef.line, layoutRef.column, layoutRef.line, layoutRef.endColumn);

    if (layoutRef.kind === 'block-template' || layoutRef.kind === 'refblock-template') {
      const templateId = layoutRef.resolvedTemplateId ?? layoutRef.value;
      const area = project.themeResolver.getAreaForFile(filePath) ?? 'frontend';
      const resolved = project.themeResolver.resolveTemplate(
        templateId,
        area,
        undefined,
        project.modules,
      );
      const value = resolved.length > 0
        ? `**Template** \`${templateId}\`\n\nResolved: ${resolved[0]}`
        : `**Template** \`${templateId}\``;
      return { contents: { kind: MarkupKind.Markdown, value }, range };
    }

    if (layoutRef.kind === 'block-class' || layoutRef.kind === 'argument-object') {
      const value = `**Block class**\n\n\`${layoutRef.value}\``;
      return { contents: { kind: MarkupKind.Markdown, value }, range };
    }

    if (layoutRef.kind === 'block-name') {
      let value = `**Block** \`${layoutRef.value}\``;
      const blockClass = layoutRef.blockClass || MAGENTO_DEFAULT_BLOCK_CLASS;
      value += `\n\nClass: \`${blockClass}\``;
      return { contents: { kind: MarkupKind.Markdown, value }, range };
    }

    if (layoutRef.kind === 'container-name') {
      let value = `**Container** \`${layoutRef.value}\``;
      if (layoutRef.containerLabel) {
        value += `\n\nLabel: ${layoutRef.containerLabel}`;
      }
      return { contents: { kind: MarkupKind.Markdown, value }, range };
    }

    if (layoutRef.kind === 'reference-block') {
      let value = `**referenceBlock** \`${layoutRef.value}\``;
      // Look up the original block declaration to show its class
      const decl = project.indexes.layout.getRefsForName(layoutRef.value)
        .find((r) => r.kind === 'block-name');
      const blockClass = decl?.blockClass || MAGENTO_DEFAULT_BLOCK_CLASS;
      value += `\n\nClass: \`${blockClass}\``;
      return { contents: { kind: MarkupKind.Markdown, value }, range };
    }

    if (layoutRef.kind === 'reference-container') {
      let value = `**referenceContainer** \`${layoutRef.value}\``;
      // Look up the original container declaration to show its label
      const decl = project.indexes.layout.getRefsForName(layoutRef.value)
        .find((r) => r.kind === 'container-name' && r.containerLabel);
      if (decl?.containerLabel) {
        value += `\n\nLabel: ${decl.containerLabel}`;
      }
      return { contents: { kind: MarkupKind.Markdown, value }, range };
    }
  }

  return null;
}

/**
 * Handle hover for PHP files.
 *
 * Shows ACL resource information when hovering over resource IDs in:
 *   - `const ADMIN_RESOURCE = 'Vendor_Module::resource'`
 *   - `->isAllowed('Vendor_Module::resource')`
 *
 * Displays the resource title, hierarchy path, and module — matching
 * the same format used for ACL hovers in menu.xml and UI component files.
 */
function handlePhpHover(
  filePath: string,
  params: HoverParams,
  getProject: (uri: string) => ProjectContext | undefined,
  getDocumentText: (uri: string) => string | undefined,
  token?: CancellationToken,
): Hover | null {
  if (token?.isCancellationRequested) return null;
  const project = getProject(filePath);
  if (!project) return null;

  const content = getDocumentText(params.textDocument.uri) ?? readFileSafe(filePath);
  if (!content) return null;

  const lines = content.split('\n');
  const line = lines[params.position.line];
  if (!line) return null;

  const re = createPhpAclRegex();
  let match;
  while ((match = re.exec(line)) !== null) {
    const fullMatch = match[0];
    const aclId = match[1];
    const idStart = match.index + fullMatch.indexOf(aclId);
    const idEnd = idStart + aclId.length;

    // Use <= to give a slightly generous hit area (one char past the token)
    if (params.position.character >= idStart && params.position.character <= idEnd) {
      const range = Range.create(
        params.position.line, idStart,
        params.position.line, idEnd,
      );
      const aclDef = project.indexes.acl.getResource(aclId);

      let value = `**ACL Resource** \`${aclId}\``;
      if (aclDef?.title) {
        value += `\n\nTitle: ${aclDef.title}`;
        // Show hierarchy path using titles where available
        if (aclDef.hierarchyPath.length > 1) {
          const pathTitles = aclDef.hierarchyPath.map((id) => {
            const res = project.indexes.acl.getResource(id);
            return res?.title || id;
          });
          value += `\n\nPath: ${pathTitles.join(' > ')}`;
        }
        value += `\n\nModule: ${aclDef.module}`;
      }

      return { contents: { kind: MarkupKind.Markdown, value }, range };
    }
  }

  return null;
}

/** Safely read a file from disk, returning undefined on any error. */
function readFileSafe(filePath: string): string | undefined {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return undefined;
  }
}
