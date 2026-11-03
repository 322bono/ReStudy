import { afterEach, expect, it, vi } from "vitest";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { installPdfStreamCompatibility } from "../src/features/pdf/runtime-compat.mjs";
import { writePdfWorkerAsset } from "../scripts/pdf-worker-asset.mjs";

const NativeReadableStream = ReadableStream;

function safariStreams() {
  class SafariReadableStream<R> extends NativeReadableStream<R> {}
  Object.defineProperties(SafariReadableStream.prototype, {
    [Symbol.asyncIterator]: { value: undefined, configurable: true },
    values: { value: undefined, configurable: true },
  });
  vi.stubGlobal("ReadableStream", SafariReadableStream);
  installPdfStreamCompatibility();
  return SafariReadableStream;
}

afterEach(() => vi.unstubAllGlobals());

it("reads stream chunks in order and releases the lock at the actual end", async () => {
  const Stream = safariStreams();
  const stream = new Stream<number>({ start(controller) {
    controller.enqueue(11); controller.enqueue(22); controller.close();
  } });
  const iterator = stream.values();
  expect(stream.locked).toBe(true);
  const first = iterator.next(), second = iterator.next(), end = iterator.next();
  expect(await first).toEqual({ value: 11, done: false });
  expect(await second).toEqual({ value: 22, done: false });
  expect(await end).toEqual({ value: undefined, done: true });
  expect(stream.locked).toBe(false);
  expect(await iterator.next()).toEqual({ value: undefined, done: true });
});

it("cancels the underlying source when a for-await consumer breaks early", async () => {
  const Stream = safariStreams();
  const cancellations: unknown[] = [];
  const stream = new Stream<number>({
    start(controller) { controller.enqueue(11); controller.enqueue(22); },
    cancel(reason) { cancellations.push(reason); },
  });
  const read: number[] = [];
  for await (const chunk of stream) { read.push(chunk); break; }
  expect(read).toEqual([11]);
  expect(cancellations).toEqual([undefined]);
  expect(stream.locked).toBe(false);
});

it("allows a reader to resume after preventCancel iteration", async () => {
  const Stream = safariStreams();
  const cancellations: unknown[] = [];
  const stream = new Stream<number>({
    start(controller) { controller.enqueue(11); controller.enqueue(22); controller.close(); },
    cancel(reason) { cancellations.push(reason); },
  });
  for await (const _ of stream.values({ preventCancel: true })) break;
  expect(stream.locked).toBe(false);
  const reader = stream.getReader();
  try { expect(await reader.read()).toEqual({ value: 22, done: false }); }
  finally { reader.releaseLock(); }
  expect(cancellations).toEqual([]);
});

it("propagates a failed read without hiding it or leaving a locked stream", async () => {
  const Stream = safariStreams();
  const failure = new Error("real PDF stream failure");
  const stream = new Stream({ start(controller) { controller.error(failure); } });
  const iterator = stream.values();
  await expect(iterator.next()).rejects.toBe(failure);
  expect(stream.locked).toBe(false);
  expect(await iterator.next()).toEqual({ done: true, value: undefined });
});

it("does not lock the stream when iterator option conversion fails", () => {
  const Stream = safariStreams();
  const stream = new Stream();
  const failure = new Error("invalid iterator options");
  expect(() => stream.values({ get preventCancel() { throw failure; } })).toThrow(failure);
  expect(stream.locked).toBe(false);
});

it("releases a cancelled reader immediately and preserves a cancellation rejection", async () => {
  const Stream = safariStreams();
  let rejectCancel!: (error: Error) => void;
  const cancelling = new Promise<void>((_, reject) => { rejectCancel = reject; });
  const stream = new Stream({ cancel() { return cancelling; } });
  const returning = stream.values().return!("stopped");
  // The Streams Standard releases the reader before waiting for source cleanup.
  await Promise.resolve();
  expect(stream.locked).toBe(false);
  const failure = new Error("source cleanup failed");
  const rejected = expect(returning).rejects.toBe(failure);
  rejectCancel(failure);
  await rejected;
});

it("finishes a pending read before a queued return cancels the stream", async () => {
  const Stream = safariStreams();
  let controller!: ReadableStreamDefaultController<number>;
  const cancellations: unknown[] = [];
  const stream = new Stream<number>({
    start(value) { controller = value; }, cancel(reason) { cancellations.push(reason); },
  });
  const iterator = stream.values();
  const reading = iterator.next(), returning = iterator.return!("stop after read");
  await Promise.resolve();
  expect(stream.locked).toBe(true);
  expect(cancellations).toEqual([]);
  controller.enqueue(11);
  expect(await reading).toEqual({ value: 11, done: false });
  expect(await returning).toEqual({ value: "stop after read", done: true });
  expect(cancellations).toEqual(["stop after read"]);
  expect(stream.locked).toBe(false);
});

it("keeps working native stream iterators", () => {
  const iterator = NativeReadableStream.prototype[Symbol.asyncIterator];
  const values = NativeReadableStream.prototype.values;
  installPdfStreamCompatibility();
  expect(NativeReadableStream.prototype[Symbol.asyncIterator]).toBe(iterator);
  expect(NativeReadableStream.prototype.values).toBe(values);
});

it("installs compatibility inside the generated PDF worker's separate global", async () => {
  const directory = resolve("test-results/pdf-stream-worker");
  await mkdir(directory, { recursive: true });
  const workerFile = resolve(directory, "pdf.worker.legacy.min.mjs");
  writePdfWorkerAsset(workerFile);
  const worker = new Worker(`
    const { parentPort, workerData } = require("node:worker_threads");
    delete ReadableStream.prototype[Symbol.asyncIterator];
    delete ReadableStream.prototype.values;
    import(workerData).then(async (pdfjs) => {
      const stream = new ReadableStream({ start(controller) {
        controller.enqueue(37); controller.enqueue(80); controller.close();
      } });
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      parentPort.postMessage({ chunks, locked: stream.locked, handler: typeof pdfjs.WorkerMessageHandler });
    }).catch((error) => { throw error; });
  `, { eval: true, workerData: pathToFileURL(workerFile).href });
  try {
    const result = await new Promise((resolve, reject) => {
      worker.once("message", resolve); worker.once("error", reject);
    });
    expect(result).toEqual({ chunks: [37, 80], locked: false, handler: "function" });
  } finally { await worker.terminate(); }
});
