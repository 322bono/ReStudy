import { describe, expect, it } from "vitest";
import { downloadPrivateFile, uploadPrivateFile } from "../src/services/private-files";

const path = "owner/document/source/original.pdf";
const ownedPath = (value: unknown) => {
  if (typeof value !== "string" || !value.startsWith("owner/document/") || value.includes("..")) throw new Error("foreign path");
  return value;
};
describe("segmented private originals", () => {
  it("reassembles ordered byte-identical parts below the free per-object limit", async () => {
    const files = new Map<string, Blob>();
    const source = new Blob([new Uint8Array(51 * 1024 * 1024), "last byte"], { type: "application/pdf" });
    const reference = await uploadPrivateFile(path, source, async (key, blob) => { files.set(key, blob); });
    expect(files.size).toBeGreaterThan(1);
    expect([...files.values()].every((blob) => blob.size <= 5 * 1024 * 1024)).toBe(true);
    const result = await downloadPrivateFile(path, reference, async (key) => files.get(key)!, ownedPath);
    expect(result.size).toBe(source.size);
    expect(result.type).toBe("application/pdf");
    expect(await result.slice(-9).text()).toBe("last byte");
    expect(Buffer.compare(Buffer.from(await result.arrayBuffer()), Buffer.from(await source.arrayBuffer()))).toBe(0);
  });

  it("reads existing single-object originals without a manifest", async () => {
    const result = await downloadPrivateFile(path, undefined, async (key) => {
      expect(key).toBe(path); return new Blob(["%PDF-old"], { type: "application/pdf" });
    }, ownedPath);
    expect(await result.text()).toBe("%PDF-old");
  });

  it("rejects corrupt or incomplete parts instead of returning a damaged original", async () => {
    const files = new Map<string, Blob>();
    const source = new Blob([new Uint8Array(51 * 1024 * 1024)], { type: "application/pdf" });
    const reference = await uploadPrivateFile(path, source, async (key, blob) => { files.set(key, blob); });
    const first = reference!.parts[0];
    files.set(first.path, new Blob([new Uint8Array(first.bytes).fill(1)]));
    await expect(downloadPrivateFile(path, reference, async (key) => files.get(key)!, ownedPath)).rejects.toThrow(/손상|일치/);
  });

  it("validates every manifest path before performing any download", async () => {
    let downloads = 0;
    const reference = { version: 1, bytes: 2, mime: "application/pdf", parts: [
      { path: `${path}.parts/000000.pdf`, bytes: 1, sha256: "0".repeat(64) },
      { path: "other/document/part.pdf", bytes: 1, sha256: "0".repeat(64) },
    ] };
    await expect(downloadPrivateFile(path, reference, async () => { downloads++; return new Blob(["x"]); }, ownedPath)).rejects.toThrow();
    expect(downloads).toBe(0);
  });

  it("rejects reordered part metadata before any download", async () => {
    let downloads = 0;
    const reference = { version: 1, bytes: 2, mime: "application/pdf", parts: [
      { path: `${path}.parts/000001`, bytes: 1, sha256: "0".repeat(64) },
      { path: `${path}.parts/000000`, bytes: 1, sha256: "0".repeat(64) },
    ] };
    await expect(downloadPrivateFile(path, reference, async () => { downloads++; return new Blob(["x"]); }, ownedPath)).rejects.toThrow();
    expect(downloads).toBe(0);
  });
});
