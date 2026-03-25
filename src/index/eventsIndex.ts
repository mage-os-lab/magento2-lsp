/**
 * In-memory index of all event/observer references from events.xml files.
 *
 * Provides lookups for:
 *   - eventName -> all ObserverReferences (for "find references" from an event name)
 *   - observerFqcn -> all ObserverReferences (for "find references" from a PHP observer class)
 *   - file -> all references in that file (for efficient per-file removal on change)
 *   - position-based lookup (for determining what the cursor is on in events.xml)
 */

import { EventReference, ObserverReference } from '../indexer/types';
import { removeFromMap, findReferenceAtPosition } from '../utils/indexHelpers';

/** Union type for anything positioned in an events.xml file. */
export type EventsXmlReference = EventReference | ObserverReference;

/** Type guard to check if a reference is an ObserverReference. */
export function isObserverReference(ref: EventsXmlReference): ref is ObserverReference {
  return 'fqcn' in ref;
}

export class EventsIndex {
  /** Event name -> all observers registered for that event. */
  private eventToObservers = new Map<string, ObserverReference[]>();
  /** Observer FQCN -> all observer registrations for that class. */
  private fqcnToObservers = new Map<string, ObserverReference[]>();
  /** Event name -> all EventReference entries (positions of the event name in XML). */
  private eventNameRefs = new Map<string, EventReference[]>();
  /** File path -> all references (events + observers) in that file. */
  private fileToRefs = new Map<string, EventsXmlReference[]>();

  addFile(
    file: string,
    events: EventReference[],
    observers: ObserverReference[],
  ): void {
    const allRefs: EventsXmlReference[] = [...events, ...observers];
    this.fileToRefs.set(file, allRefs);

    for (const event of events) {
      const existing = this.eventNameRefs.get(event.eventName) ?? [];
      existing.push(event);
      this.eventNameRefs.set(event.eventName, existing);
    }

    for (const obs of observers) {
      const byEvent = this.eventToObservers.get(obs.eventName) ?? [];
      byEvent.push(obs);
      this.eventToObservers.set(obs.eventName, byEvent);

      const byFqcn = this.fqcnToObservers.get(obs.fqcn) ?? [];
      byFqcn.push(obs);
      this.fqcnToObservers.set(obs.fqcn, byFqcn);
    }
  }

  removeFile(file: string): void {
    const refs = this.fileToRefs.get(file);
    if (!refs) return;

    for (const ref of refs) {
      if (isObserverReference(ref)) {
        removeFromMap(this.eventToObservers, ref.eventName, file);
        removeFromMap(this.fqcnToObservers, ref.fqcn, file);
      } else {
        removeFromMap(this.eventNameRefs, ref.eventName, file);
      }
    }

    this.fileToRefs.delete(file);
  }

  /** Get all observers registered for a given event name. */
  getObserversForEvent(eventName: string): ObserverReference[] {
    return this.eventToObservers.get(eventName) ?? [];
  }

  /** Get all observer registrations for a given PHP class. */
  getObserversForFqcn(fqcn: string): ObserverReference[] {
    return this.fqcnToObservers.get(fqcn) ?? [];
  }

  /** Get all event name references (positions in events.xml where the event is declared). */
  getEventNameRefs(eventName: string): EventReference[] {
    return this.eventNameRefs.get(eventName) ?? [];
  }

  /** Get all observer registrations declared by a given module. */
  getObserversByModule(moduleName: string): ObserverReference[] {
    const result: ObserverReference[] = [];
    for (const observers of this.eventToObservers.values()) {
      for (const obs of observers) {
        if (obs.module === moduleName) {
          result.push(obs);
        }
      }
    }
    return result;
  }

  /** Find which reference the cursor is on at a given position in an events.xml file. */
  getReferenceAtPosition(
    file: string,
    line: number,
    col: number,
  ): EventsXmlReference | undefined {
    return findReferenceAtPosition(this.fileToRefs.get(file), line, col);
  }

  /** Return all references in a single file (for per-file validation). */
  getRefsForFile(file: string): EventsXmlReference[] {
    return this.fileToRefs.get(file) ?? [];
  }

  /** Iterate all event names in the index. */
  getAllEventNames(): IterableIterator<string> {
    return this.eventNameRefs.keys();
  }

  /** Number of events.xml files currently indexed. */
  getFileCount(): number {
    return this.fileToRefs.size;
  }

  clear(): void {
    this.eventToObservers.clear();
    this.fqcnToObservers.clear();
    this.eventNameRefs.clear();
    this.fileToRefs.clear();
  }

}
