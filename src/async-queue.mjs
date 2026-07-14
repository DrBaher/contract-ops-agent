// Minimal single-consumer async queue: push values, iterate them, close to end.
// Used to feed user turns into a session's event loop.
export function makeInputQueue() {
  const items = [];
  let wake = null;
  let closed = false;
  return {
    push(v) { items.push(v); if (wake) { const w = wake; wake = null; w(); } },
    close() { closed = true; if (wake) { const w = wake; wake = null; w(); } },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        while (items.length) yield items.shift();
        if (closed) return;
        await new Promise((res) => { wake = res; });
      }
    },
  };
}
