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
