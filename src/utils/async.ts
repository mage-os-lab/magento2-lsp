/** Yield to the event loop so pending LSP requests can be processed. */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
