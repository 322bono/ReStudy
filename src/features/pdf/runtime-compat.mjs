/**
 * PDF.js 6 uses for-await over native streams even in its legacy build.
 * Safari 18 has getReader(), but does not implement stream async iteration.
 * Keep this module dependency-free: the asset builder also prepends it to the
 * PDF worker, whose global/prototypes are independent from the browser window.
 */
export function installPdfStreamCompatibility() {
  if (typeof ReadableStream === "undefined") return;
  const prototype = ReadableStream.prototype;
  if (typeof prototype[Symbol.asyncIterator] === "function") return;

  /** @this {ReadableStream<unknown>} @param {{preventCancel?: boolean}} [options] */
  function values(options = {}) {
    const preventCancel = Boolean(options?.preventCancel);
    const reader = this.getReader();
    let finished = false;
    let ongoing = Promise.resolve();
    const release = () => {
      finished = true;
      reader.releaseLock();
    };
    // Async iterator operations must run in order, including return() after a
    // pending next(). A rejected read must not poison later return/next calls.
    const enqueue = (operation) => {
      const result = ongoing.then(operation);
      ongoing = result.then(() => undefined, () => undefined);
      return result;
    };
    return {
      next() {
        return enqueue(async () => {
          if (finished) return { done: true, value: undefined };
          try {
            const result = await reader.read();
            if (result.done) release();
            return result;
          } catch (error) {
            release();
            throw error;
          }
        });
      },
      return(value) {
        return enqueue(async () => {
          if (!finished) {
            let cancelling;
            try {
              if (!preventCancel) cancelling = reader.cancel(value);
            } finally {
              release();
            }
            await cancelling;
          }
          return { done: true, value };
        });
      },
      [Symbol.asyncIterator]() { return this; },
    };
  }
  if (typeof prototype.values !== "function") {
    Object.defineProperty(prototype, "values", {
      value: values, writable: true, configurable: true,
    });
  }
  Object.defineProperty(prototype, Symbol.asyncIterator, {
    value: prototype.values, writable: true, configurable: true,
  });
}
