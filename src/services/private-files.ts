/** Large originals are byte segments, not separate PDFs. Reassemble before use. */
export type PrivateFileParts = {
  version: 1;
  bytes: number;
  mime: string;
  parts: { path: string; bytes: number; sha256: string }[];
};
// Free Storage allows at most 50 MB per object. Standard uploads below 6 MB
// also avoid a single long request for each segment.
const PART_BYTES = 5 * 1024 * 1024;
const SINGLE_OBJECT_BYTES = 50_000_000;
async function digest(blob: Blob): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer())), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function uploadPrivateFile(
  path: string,
  blob: Blob,
  upload: (path: string, blob: Blob) => Promise<void>,
): Promise<PrivateFileParts | undefined> {
  if (blob.size <= SINGLE_OBJECT_BYTES) {
    await upload(path, blob);
    return undefined;
  }
  const manifest: PrivateFileParts = { version: 1, bytes: blob.size, mime: blob.type, parts: [] };
  for (let offset = 0, index = 0; offset < blob.size; offset += PART_BYTES, index++) {
    const part = blob.slice(offset, offset + PART_BYTES, blob.type);
    const partPath = `${path}.parts/${String(index).padStart(6, "0")}`;
    const sha256 = await digest(part);
    await upload(partPath, part);
    manifest.parts.push({ path: partPath, bytes: part.size, sha256 });
  }
  // The caller persists this only after every part is durable.
  return manifest;
}

export async function downloadPrivateFile(
  path: string,
  reference: unknown,
  download: (path: string) => Promise<Blob>,
  ownPath: (path: unknown) => string,
): Promise<Blob> {
  ownPath(path);
  if (reference === undefined || reference === null) return download(path);
  const manifest = reference as PrivateFileParts;
  const invalid = () => new Error("분할 원본 파일 정보를 확인할 수 없습니다.");
  if (manifest.version !== 1 || !Number.isSafeInteger(manifest.bytes) || manifest.bytes < 1 || typeof manifest.mime !== "string" || !Array.isArray(manifest.parts) || !manifest.parts.length) throw invalid();
  let total = 0;
  for (const [index, part] of manifest.parts.entries()) {
    if (!part || ownPath(part.path) !== `${path}.parts/${String(index).padStart(6, "0")}` || !Number.isSafeInteger(part.bytes) || part.bytes < 1 || part.bytes > PART_BYTES || !/^[a-f0-9]{64}$/.test(part.sha256)) throw invalid();
    total += part.bytes;
  }
  if (!Number.isSafeInteger(total) || total !== manifest.bytes) throw invalid();
  const parts: Blob[] = [];
  for (const part of manifest.parts) {
    const blob = await download(part.path);
    if (!(blob instanceof Blob) || blob.size !== part.bytes || await digest(blob) !== part.sha256) throw new Error("분할 원본 파일이 누락되었거나 손상되었습니다. 저장된 원본과 일치하지 않습니다.");
    parts.push(blob);
  }
  return new Blob(parts, { type: manifest.mime });
}
