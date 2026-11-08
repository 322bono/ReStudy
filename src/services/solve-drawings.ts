import type { Stroke } from "../../lib/types";

/** One ordered save stream; fast navigation retains local ink until persisted. */
export function createDrawingSaver(
  save: (id: string, strokes: Stroke[]) => Promise<unknown>,
) {
  const pending = new Map<string, Stroke[]>();
  let running: Promise<void> | undefined;
  const flush = (): Promise<void> => {
    if (running) return running;
    if (!pending.size) return Promise.resolve();
    const work = async () => {
      while (pending.size) {
        const [id, strokes] = pending.entries().next().value!;
        await save(id, strokes);
        if (pending.get(id) === strokes) pending.delete(id);
      }
    };
    running = work().finally(() => {
      running = undefined;
    });
    return running;
  };
  return {
    change: (id: string, strokes: Stroke[]) => pending.set(id, strokes),
    flush,
    dirty: () => pending.size > 0,
  };
}
