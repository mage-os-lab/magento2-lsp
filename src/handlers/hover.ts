/**
 * LSP "textDocument/hover" handler.
 *
 * Shows contextual information when hovering over references in XML config files:
 *   - di.xml: effective DI config (preferences, plugins, virtualTypes)
 *   - events.xml: observer counts for events, event names for observers
 *   - layout XML: block class info, template resolution paths
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

export function handleHover(
  params: HoverParams,
  getProject: (uri: string) => ProjectContext | undefined,
  _token?: CancellationToken,
): Hover | null {
  const filePath = realpath(URI.parse(params.textDocument.uri).fsPath);
  if (!filePath.endsWith('.xml')) return null;

  const project = getProject(filePath);
  if (!project) return null;

  const { line, character } = params.position;

  // --- Try di.xml ---
  const diRef = project.index.getReferenceAtPosition(filePath, line, character);
  if (diRef) {
    let value: string;
    const range = Range.create(diRef.line, diRef.column, diRef.line, diRef.endColumn);

    switch (diRef.kind) {
      case 'preference-for': {
        const effective = project.index.getEffectivePreferenceType(diRef.fqcn, diRef.area);
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
        const pluginCount = project.pluginMethodIndex.getTotalPluginCount(diRef.fqcn);
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
        const vt = project.index.getEffectiveVirtualType(diRef.fqcn);
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
  const sysRef = project.systemConfigIndex.getReferenceAtPosition(filePath, line, character);
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
      default:
        return null;
    }

    return { contents: { kind: MarkupKind.Markdown, value }, range };
  }

  // --- Try webapi.xml ---
  const webapiRef = project.webapiIndex.getReferenceAtPosition(filePath, line, character);
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
          const aclDef = project.aclIndex.getResource(webapiRef.value);
          value = `**ACL Resource** \`${webapiRef.value}\``;
          if (aclDef?.title) {
            value += `\n\nTitle: ${aclDef.title}`;
            // Show hierarchy path using titles where available
            if (aclDef.hierarchyPath.length > 1) {
              const pathTitles = aclDef.hierarchyPath.map((id) => {
                const res = project.aclIndex.getResource(id);
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
  const aclResource = project.aclIndex.getResourceAtPosition(filePath, line, character);
  if (aclResource) {
    const range = Range.create(aclResource.line, aclResource.column, aclResource.line, aclResource.endColumn);
    let value = `**ACL Resource** \`${aclResource.id}\``;
    if (aclResource.title) {
      value += `\n\nTitle: ${aclResource.title}`;
    }
    // Show hierarchy path using titles where available
    if (aclResource.hierarchyPath.length > 1) {
      const pathTitles = aclResource.hierarchyPath.map((id) => {
        const res = project.aclIndex.getResource(id);
        return res?.title || id;
      });
      value += `\n\nPath: ${pathTitles.join(' > ')}`;
    }
    value += `\n\nModule: ${aclResource.module}`;
    // Show how many webapi.xml routes reference this resource
    const webapiRefs = project.webapiIndex.getRefsForResource(aclResource.id);
    if (webapiRefs.length > 0) {
      value += `\n\nReferenced in ${webapiRefs.length} webapi.xml route${webapiRefs.length === 1 ? '' : 's'}`;
    }
    return { contents: { kind: MarkupKind.Markdown, value }, range };
  }

  // --- Try events.xml ---
  const eventsRef = project.eventsIndex.getReferenceAtPosition(filePath, line, character);
  if (eventsRef) {
    const range = Range.create(eventsRef.line, eventsRef.column, eventsRef.line, eventsRef.endColumn);

    if (isObserverReference(eventsRef)) {
      const value = `**Observer** for \`${eventsRef.eventName}\`\n\nClass: \`${eventsRef.fqcn}\`\n\nName: ${eventsRef.observerName}`;
      return { contents: { kind: MarkupKind.Markdown, value }, range };
    } else {
      const observers = project.eventsIndex.getObserversForEvent(eventsRef.eventName);
      const count = observers.length;
      const value = count > 0
        ? `**Event** \`${eventsRef.eventName}\`\n\n${count} observer${count === 1 ? '' : 's'}`
        : `**Event** \`${eventsRef.eventName}\`\n\nNo observers`;
      return { contents: { kind: MarkupKind.Markdown, value }, range };
    }
  }

  // --- Try layout XML ---
  const layoutRef = project.layoutIndex.getReferenceAtPosition(filePath, line, character);
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
  }

  return null;
}
