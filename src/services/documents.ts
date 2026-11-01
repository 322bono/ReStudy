import type { PDFDocumentProxy } from "pdfjs-dist";
import { getSupabase, currentUser } from "./supabase";
import {
  closeOcr,
  detectProblems,
  openPdf,
  preparePage,
  prepareNumberMarkers,
  NUMBER_LAYER_VERSION,
  renderRegions,
  type PreparedPage,
  type Region,
} from "../features/pdf/processor";
import { selectPages, tocPages } from "../domain/pages";
import { cacheGet, cachePut } from "./cache";
import { storagePageText } from "../domain/pdf-text";
import {pageOcrIndex,extractLocalOutline}from'../domain/pdf-index';
import {edgeCall}from'./supabase';

export const PDF_ENGINE_VERSION = "browser-pdf-2026-11-01-v1";
const BUCKET = "study-files",
  MAX_BYTES = 50 * 1024 * 1024,
  MAX_PAGES = 500;
type Row = Record<string, any>;
type Context = { db: ReturnType<typeof getSupabase>; user: { id: string } };
type Job = {
  id: string;
  userId: string;
  token: string;
  force: boolean;
  controller: AbortController;
  page?: number;
  retryPage?: number;
};
const jobs = new Map<string, Job>();
let workQueue: Promise<void> = Promise.resolve();
let activeJob: Job | undefined;
const watchedClients = new WeakSet<object>();
async function context(): Promise<Context> {
  const db = getSupabase(),
    user = await currentUser();
  if (!watchedClients.has(db)) {
    watchedClients.add(db);
    db.auth.onAuthStateChange((event, session) => {
      if (event !== "SIGNED_OUT" && (!session || session.user.id === user.id))
        return;
      for (const job of jobs.values())
        if (event === "SIGNED_OUT" || job.userId !== session?.user.id)
          job.controller.abort();
      if (activeJob?.controller.signal.aborted) void closeOcr().catch(() => {});
    });
  }
  return { db, user };
}
const failure = (message: string) => new Error(message);
const cancelled = () =>
  new DOMException("자료 분석을 중단했습니다.", "AbortError");
function ownPath(ctx: Context, id: string, path: unknown): string {
  if (
    typeof path !== "string" ||
    !path.startsWith(`${ctx.user.id}/${id}/`) ||
    path.includes("..") ||
    path.includes("\\")
  )
    throw failure("원본 파일 경로를 확인할 수 없습니다.");
  return path;
}
function material(row: Row): any {
  return {
    ...row.data,
    id: row.id,
    title: row.title,
    subject: row.subject,
    kind: row.kind,
    status: row.status,
    hash: row.content_hash,
    createdAt: row.data?.createdAt || row.created_at,
  };
}
async function one(
  ctx: Context,
  table: string,
  id: string,
  optional = false,
): Promise<Row | undefined> {
  const { data, error } = await ctx.db
    .from(table)
    .select("*")
    .eq("user_id", ctx.user.id)
    .eq("id", id)
    .maybeSingle();
  if (error || (!data && !optional))
    throw failure("자료를 찾거나 읽을 수 없습니다.");
  return data ?? undefined;
}
async function list(
  ctx: Context,
  table: string,
  column?: string,
  value?: any,
): Promise<Row[]> {
  const rows: Row[] = [];
  for (let offset = 0; ; offset += 1000) {
    let query = ctx.db
      .from(table)
      .select("*")
      .eq("user_id", ctx.user.id)
      .order("id")
      .range(offset, offset + 999);
    if (column) query = query.eq(column, value);
    const { data, error } = await query;
    if (error) throw failure("저장된 페이지와 문항을 읽지 못했습니다.");
    rows.push(...data);
    if (data.length < 1000) return rows;
  }
}
/** Fresh JSON merge plus compare-and-swap protects simultaneous pause/edit. */
async function patchDocument(
  ctx: Context,
  id: string,
  patch: Row,
  status?: string,
  job?: Job,
): Promise<Row> {
  for (let attempt = 0; attempt < 5; attempt++) {
    if (job?.controller.signal.aborted) throw cancelled();
    const row = (await one(ctx, "documents", id))!;
    if (job && (row.data.paused || row.data.processingToken !== job.token))
      throw cancelled();
    const { data, error } = await ctx.db
      .from("documents")
      .update({
        data: { ...row.data, ...patch },
        ...(status ? { status } : {}),
      })
      .eq("user_id", ctx.user.id)
      .eq("id", id)
      .eq("updated_at", row.updated_at)
      .select("*")
      .maybeSingle();
    if (error) throw failure("자료의 진행 상태를 저장하지 못했습니다.");
    if (data) return data;
  }
  throw failure("자료가 다른 화면에서 변경되었습니다. 다시 시도해 주세요.");
}
async function ensureJob(ctx: Context, job: Job): Promise<Row> {
  if (job.controller.signal.aborted || (await currentUser()).id !== ctx.user.id)
    throw cancelled();
  const doc = (await one(ctx, "documents", job.id))!;
  if (
    doc.data.paused ||
    doc.data.archived ||
    doc.data.processingToken !== job.token
  )
    throw cancelled();
  return doc;
}
async function upload(ctx: Context, path: string, blob: Blob): Promise<void> {
  const { error } = await ctx.db.storage
    .from(BUCKET)
    .upload(path, blob, {
      contentType: blob.type || "application/octet-stream",
      cacheControl: "31536000",
      upsert: false,
    });
  if (error)
    throw failure(
      "비공개 원본 이미지를 저장하지 못했습니다. 다시 시도해 주세요.",
    );
}
async function processingPdf(
  ctx: Context,
  doc: Row,
): Promise<PDFDocumentProxy> {
  const path = ownPath(ctx, doc.id, doc.data.pdfPath || doc.data.originalPath);
  const cached = await cacheGet<Blob>(ctx.user.id, `pdf:${path}`);
  if (cached instanceof Blob) return openPdf(cached);
  const { data, error } = await ctx.db.storage.from(BUCKET).download(path);
  if (error || !data) throw failure("비공개 원본 파일을 내려받지 못했습니다.");
  await cachePut(ctx.user.id, `pdf:${path}`, data);
  return openPdf(data);
}
async function sha256(bytes: ArrayBuffer): Promise<string> {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (n) => n.toString(16).padStart(2, "0"),
  ).join("");
}
async function stableProblemId(
  documentId: string,
  number: number,
  page: number,
  occurrence: number,
): Promise<string> {
  const hash = await sha256(
    new TextEncoder().encode(`${documentId}:${page}:${number}:${occurrence}`)
      .buffer,
  );
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-${((parseInt(hash[16], 16) & 3) | 8).toString(16)}${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
function sniff(bytes: Uint8Array): string {
  const starts = (values: number[]) => values.every((v, i) => bytes[i] === v);
  if (new TextDecoder("latin1").decode(bytes.slice(0, 1024)).includes("%PDF-"))
    return "application/pdf";
  if (starts([137, 80, 78, 71, 13, 10, 26, 10])) return "image/png";
  if (starts([255, 216, 255])) return "image/jpeg";
  if (
    new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" &&
    new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP"
  )
    return "image/webp";
  throw failure(
    "PDF, PNG, JPG, WebP 파일만 추가할 수 있습니다. 파일 내용과 형식을 확인해 주세요.",
  );
}
async function imageToPdf(file: File, mime: string): Promise<Blob> {
  let image: ImageBitmap | HTMLImageElement;
  let url: string | undefined;
  try {
    if (typeof createImageBitmap === "function")
      image = await createImageBitmap(file);
    else {
      url = URL.createObjectURL(file);
      const element = new Image();
      element.src = url;
      await element.decode();
      image = element;
    }
    const width = image.width,
      height = image.height;
    if (!width || !height || width * height > 40_000_000)
      throw failure(
        "이미지가 너무 크거나 읽을 수 없습니다. 4천만 화소 이하의 이미지를 사용해 주세요.",
      );
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    try {
      const drawing = canvas.getContext("2d");
      if (!drawing) throw failure("이미지를 원본 PDF로 변환할 수 없습니다.");
      drawing.fillStyle = "white";
      drawing.fillRect(0, 0, width, height);
      drawing.drawImage(image, 0, 0);
      const encoded = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (blob) =>
            blob
              ? resolve(blob)
              : reject(failure("원본 이미지를 변환하지 못했습니다.")),
          mime === "image/jpeg" ? "image/jpeg" : "image/png",
          0.98,
        ),
      );
      const { PDFDocument } = await import("pdf-lib");
      const pdf = await PDFDocument.create();
      const embedded =
        mime === "image/jpeg"
          ? await pdf.embedJpg(await encoded.arrayBuffer())
          : await pdf.embedPng(await encoded.arrayBuffer());
      const ratio = Math.min(1, 1200 / Math.max(width, height));
      pdf
        .addPage([width * ratio, height * ratio])
        .drawImage(embedded, {
          x: 0,
          y: 0,
          width: width * ratio,
          height: height * ratio,
        });
      return new Blob([(await pdf.save()) as Uint8Array<ArrayBuffer>], {
        type: "application/pdf",
      });
    } finally {
      canvas.width = 0;
      canvas.height = 0;
      if ("close" in image) image.close();
    }
  } finally {
    if (url) URL.revokeObjectURL(url);
  }
}
type UploadFile = {
  file: File;
  hash: string;
  mime: string;
  pdf: Blob;
  pages: number;
};
async function preflight(file: File): Promise<UploadFile> {
  const bytes = await file.arrayBuffer(),
    mime = sniff(new Uint8Array(bytes));
  if (
    file.type &&
    file.type !== mime &&
    file.type !== "application/octet-stream"
  )
    throw failure(
      `${file.name}: 파일의 표시 형식과 실제 내용을 확인해 주세요.`,
    );
  const pdf =
    mime === "application/pdf"
      ? new Blob([bytes], { type: mime })
      : await imageToPdf(file, mime);
  if (pdf.size > MAX_BYTES)
    throw failure(`${file.name}: 처리용 PDF가 50MB를 넘습니다.`);
  const opened = await openPdf(pdf);
  try {
    if (opened.numPages < 1 || opened.numPages > MAX_PAGES)
      throw failure("PDF는 파일당 500쪽까지 추가할 수 있습니다.");
    return {
      file,
      hash: await sha256(bytes),
      mime,
      pdf,
      pages: opened.numPages,
    };
  } finally {
    await opened.loadingTask.destroy();
  }
}
/** All selected files are checked before the first persistence operation. */
export async function uploadMaterials(
  form: FormData,
): Promise<{ materials: any[] }> {
  const files = form
    .getAll("files")
    .filter((value): value is File => value instanceof File);
  const subject = String(form.get("subject") || "").trim(),
    kind = String(form.get("kind") || "문제집");
  if (!subject || subject.length > 40)
    throw failure("과목을 40자 이내로 입력해 주세요.");
  if (!["문제집", "교과서", "학습지", "필기", "기타"].includes(kind))
    throw failure("자료 종류를 확인해 주세요.");
  if (
    !files.length ||
    files.length > 10 ||
    files.some((f) => !f.size) ||
    files.reduce((sum, f) => sum + f.size, 0) > MAX_BYTES
  )
    throw failure(
      "한 번에 파일 10개, 합계 50MB까지 추가할 수 있습니다. 빈 파일은 추가할 수 없습니다.",
    );
  const inputs: UploadFile[] = [];
  for (const file of files) inputs.push(await preflight(file));
  let rawOptions: any[] = [];
  try {
    rawOptions = JSON.parse(String(form.get("fileOptions") || "[]"));
    if (!Array.isArray(rawOptions)) throw Error();
  } catch {
    throw failure("파일별 분석 범위 설정을 확인하세요.");
  }
  const options = inputs.map((input, index) => {
    const o = rawOptions[index] || {},
      method = o.analysisMethod || "auto";
    if (!["auto", "external", "later"].includes(method))
      throw failure("분석 방식을 확인하세요.");
    return {
      title: String(o.title || input.file.name.replace(/\.[^.]+$/, ""))
        .trim()
        .slice(0, 160),
      analysisRange: String(o.analysisRange || ""),
      excludedPages: String(o.excludedPages || ""),
      tocRange: String(o.tocRange || ""),
      selectedPages: selectPages(
        String(o.analysisRange || ""),
        input.pages,
        String(o.excludedPages || ""),
      ),
      tocPages: tocPages(String(o.tocRange || ""), input.pages),
      analysisMethod: method,
      printedPageOffset: Number.isInteger(o.printedPageOffset)
        ? o.printedPageOffset
        : null,
      paused: method === "later",
    };
  });
  const ctx = await context(),
    result: Row[] = [];
  for (const [index, input] of inputs.entries()) {
    const option = options[index];
    if (result.some((r) => r.content_hash === input.hash)) continue;
    const existing = await ctx.db
      .from("documents")
      .select("*")
      .eq("user_id", ctx.user.id)
      .eq("content_hash", input.hash)
      .maybeSingle();
    if (existing.error) throw failure("중복 자료를 확인하지 못했습니다.");
    if (existing.data) {
      let duplicate = existing.data;
      if (rawOptions[index])
        duplicate = await patchDocument(
          ctx,
          duplicate.id,
          { ...option, archived: false, processingToken: null },
          "uploaded",
        );
      else if (duplicate.data.archived)
        duplicate = await patchDocument(ctx, duplicate.id, { archived: false });
      result.push(duplicate);
      continue;
    }
    const id = crypto.randomUUID(),
      extension =
        input.mime === "application/pdf"
          ? "pdf"
          : input.mime === "image/jpeg"
            ? "jpg"
            : input.mime.split("/")[1];
    const originalPath = `${ctx.user.id}/${id}/source/original.${extension}`,
      pdfPath =
        input.mime === "application/pdf"
          ? originalPath
          : `${ctx.user.id}/${id}/source/processing.pdf`;
    await upload(
      ctx,
      originalPath,
      new Blob([await input.file.arrayBuffer()], { type: input.mime }),
    );
    if (pdfPath !== originalPath) await upload(ctx, pdfPath, input.pdf);
    const now = new Date().toISOString();
    const row = {
      id,
      user_id: ctx.user.id,
      title: option.title || "학습 자료",
      subject,
      kind,
      content_hash: input.hash,
      status: "uploaded",
      data: {
        mime: input.mime,
        bytes: input.file.size,
        pageCount: input.pages,
        progress: 0,
        message: option.paused
          ? "원본을 보관했습니다. 분석은 나중에 시작할 수 있습니다."
          : "원본을 저장했습니다. 선택한 페이지를 준비합니다.",
        originalPath,
        pdfPath,
        engineVersion: PDF_ENGINE_VERSION,
        warnings: [],
        createdAt: now,
        lastOpenedAt: now,
        ...option,
      },
    };
    const inserted = await ctx.db
      .from("documents")
      .insert(row)
      .select("*")
      .single();
    if (inserted.error) {
      if (inserted.error.code === "23505") {
        const duplicate = await ctx.db
          .from("documents")
          .select("*")
          .eq("user_id", ctx.user.id)
          .eq("content_hash", input.hash)
          .single();
        if (!duplicate.error && duplicate.data) {
          result.push(duplicate.data);
          continue;
        }
      }
      throw failure(
        "원본은 전송했지만 자료 등록을 완료하지 못했습니다. 다시 시도해 주세요.",
      );
    }
    result.push(inserted.data);
  }
  for (const row of result)
    if (["uploaded", "processing"].includes(row.status) && !row.data.paused)
      await resumeMaterial(row.id);
  return { materials: result.map(material) };
}

function cachedPage(row: Row | undefined, force: boolean): row is Row {
  return (
    !!row &&
    !force &&
    row.data.engineVersion === PDF_ENGINE_VERSION &&
    row.data.checkpointComplete === true &&
    typeof row.image_path === "string" &&
    Number.isFinite(row.data.width) &&
    Number.isFinite(row.data.height) &&
    Array.isArray(row.data.items)
  );
}
function preparedFromRow(row: Row): PreparedPage {
  return { ...row.data, number: row.number, image: new Blob() };
}
async function pageCheckpoint(
  ctx: Context,
  job: Job,
  page: PreparedPage,
  imagePath: string,
): Promise<Row> {
  for (let attempt = 0; attempt < 5; attempt++) {
    await ensureJob(ctx, job);
    const { data: old, error } = await ctx.db
      .from("document_pages")
      .select("*")
      .eq("user_id", ctx.user.id)
      .eq("document_id", job.id)
      .eq("number", page.number)
      .maybeSingle();
    if (error) throw failure("페이지 체크포인트를 확인하지 못했습니다.");
    const { image: _, ...fields } = storagePageText(page);
    const data = {
      ...old?.data,
      ...fields,
      engineVersion: PDF_ENGINE_VERSION,
      checkpointComplete: true,
      ocrIndex:pageOcrIndex(job.id,storagePageText(page)),
      ...(old?.data.manualKind
        ? { manualKind: true, kind: old.data.kind }
        : {}),
    };
    const base = {
      user_id: ctx.user.id,
      document_id: job.id,
      number: page.number,
      image_path: imagePath,
      data,
    };
    const saved = old
      ? await ctx.db
          .from("document_pages")
          .update(base)
          .eq("user_id", ctx.user.id)
          .eq("id", old.id)
          .eq("updated_at", old.updated_at)
          .select("*")
          .maybeSingle()
      : await ctx.db
          .from("document_pages")
          .insert({ id: crypto.randomUUID(), ...base })
          .select("*")
          .single();
    if (saved.error?.code === "23505") continue;
    if (saved.error) {
      const code = /^[A-Z0-9]{5}$/.test(saved.error.code || "") ? ` (${saved.error.code})` : "";
      throw failure(`${page.number}쪽의 원본·텍스트 체크포인트를 저장하지 못했습니다${code}. 저장된 페이지는 보관했습니다.`);
    }
    if (saved.data) return saved.data;
  }
  throw failure(
    "페이지가 다른 화면에서 변경되었습니다. 이 페이지를 다시 시도해 주세요.",
  );
}
function normalizedRegions(
  regions: unknown,
  pages: Row[],
  count: number,
  startPage: number,
): Region[] {
  if (!Array.isArray(regions) || !regions.length || regions.length > 30)
    throw failure("문항 영역을 1~30개 지정해 주세요.");
  const result = regions.map((r: any) => {
    if (
      !r ||
      ![r.page, r.x, r.y, r.w, r.h].every(Number.isFinite) ||
      !Number.isInteger(r.page) ||
      r.page < 1 ||
      r.page > count ||
      r.x < 0 ||
      r.y < 0 ||
      r.w <= 0 ||
      r.h <= 0 ||
      r.x + r.w > 1 + 1e-9 ||
      r.y + r.h > 1 + 1e-9
    )
      throw failure("문항 영역은 원본 페이지 안에 있어야 합니다.");
    const page = pages.find((p) => p.number === r.page);
    if (!page || page.data.kind === "answers")
      throw failure(
        "정답·해설 페이지 또는 미처리 페이지는 문항 원본으로 사용할 수 없습니다.",
      );
    return { page: r.page, x: r.x, y: r.y, w: r.w, h: r.h };
  });
  if (!Number.isInteger(startPage) || !result.some((r) => r.page === startPage))
    throw failure("시작 페이지는 지정한 문항 영역에 포함되어야 합니다.");
  return result;
}
function cropText(regions: Region[], pages: Row[]): string {
  return regions
    .map((r) =>
      (pages.find((p) => p.number === r.page)?.data.items || [])
        .filter(
          (i: any) =>
            i.x < r.x + r.w &&
            i.x + i.width > r.x &&
            i.y < r.y + r.h &&
            i.y + i.height > r.y,
        )
        .sort((a: any, b: any) => a.y - b.y || a.x - b.x)
        .map((i: any) => i.text)
        .join("\n"),
    )
    .join("\n");
}
async function commitCrop(
  ctx: Context,
  doc: Row,
  pdf: PDFDocumentProxy,
  old: Row | undefined,
  id: string,
  fields: Row,
  regions: Region[],
  job?: Job,
): Promise<Row> {
  const revision = crypto.randomUUID(),
    blobs = await renderRegions(pdf, regions);
  if (blobs.length !== regions.length || blobs.some((b) => !b.size))
    throw failure(
      "모든 원본 크롭을 만들지 못했습니다. 기존 문항을 보관했습니다.",
    );
  const paths: string[] = [];
  for (let part = 0; part < blobs.length; part++) {
    if (job) await ensureJob(ctx, job);
    const path = `${ctx.user.id}/${doc.id}/questions/${id}/${revision}/${part}.png`;
    await upload(ctx, path, blobs[part]);
    paths.push(path);
  }
  if (job) {
    await ensureJob(ctx, job);
    const fresh = await one(ctx, "problems", id, true);
    if (
      fresh &&
      (fresh.data.confirmed || fresh.data.source === "manual") &&
      !(old?.data.confirmed || old?.data.source === "manual")
    )
      return fresh;
  }
  const { data, error } = await ctx.db.rpc("save_problem_regions", {
    p_problem: {
      id,
      document_id: doc.id,
      number: fields.number,
      page: fields.page,
      data: {
        ...fields,
        regions,
        imagePaths: paths,
        revision,
        cropEngineVersion: PDF_ENGINE_VERSION,
        index:{document_id:doc.id,pdf_page:fields.page,q_number:String(fields.number),chapter_id:fields.chapterId??old?.data.chapterId??null,regions:regions.map(r=>({page:r.page,bbox:[r.x,r.y,r.x+r.w,r.y+r.h]})),confidence:fields.confidence??0,needs_review:!fields.confirmed},
      },
    },
    p_regions: regions.map((r, part) => ({
      part,
      page: r.page,
      image_path: paths[part],
      data: r,
    })),
    p_expected_revision: old?.data.revision ?? null,
  });
  if (error || !data)
    throw failure(
      "문항이 다른 화면에서 변경되었거나 크롭을 저장하지 못했습니다. 기존 문항을 확인하고 다시 시도해 주세요.",
    );
  return data;
}
function completeParts(
  ctx: Context,
  docId: string,
  regions: Region[],
  parts: Row[],
): boolean {
  return (
    regions.length > 0 &&
    parts.length === regions.length &&
    [...parts]
      .sort((a, b) => a.part - b.part)
      .every(
        (p, index) =>
          p.part === index &&
          p.page === regions[index].page &&
          typeof p.image_path === "string" &&
          p.image_path.startsWith(`${ctx.user.id}/${docId}/`),
      )
  );
}
async function runDocument(ctx: Context, job: Job): Promise<void> {
  let pdf: PDFDocumentProxy | undefined;
  try {
    const starting = (await one(ctx, "documents", job.id))!;
    if (
      job.controller.signal.aborted ||
      starting.data.paused ||
      starting.data.archived
    )
      return;
    await patchDocument(
      ctx,
      job.id,
      {
        paused: false,
        processingToken: job.token,
        error: null,
        failedPage: null,
        message: "원본 PDF를 열고 저장된 체크포인트를 확인하고 있어요.",
      },
      "processing",
    );
    await ensureJob(ctx, job);
    pdf = await processingPdf(ctx, starting);
    if (pdf.numPages < 1 || pdf.numPages > MAX_PAGES)
      throw failure(
        "PDF 페이지 수를 확인해 주세요. 파일당 500쪽까지 처리합니다.",
      );
    const previousPages = await list(
      ctx,
      "document_pages",
      "document_id",
      job.id,
    );
    const selected = Array.isArray(starting.data.selectedPages)
      ? starting.data.selectedPages
      : Array.from({ length: pdf.numPages }, (_, i) => i + 1);
    const targetPages = [
      ...new Set<number>([...selected, ...(starting.data.tocPages || [])]),
    ]
      .filter((n) => Number.isInteger(n) && n >= 1 && n <= pdf!.numPages)
      .sort((a, b) => a - b);
    for (const [position, number] of targetPages.entries()) {
      await ensureJob(ctx, job);
      job.page = number;
      const old = previousPages.find((r) => r.number === number);
      if (cachedPage(old, job.force || job.retryPage===number)) {
        ownPath(ctx, job.id, old.image_path);
        if(!old.data.ocrIndex||old.data.source==='ocr'&&old.data.numberLayerVersion!==NUMBER_LAYER_VERSION){
          await patchDocument(ctx,job.id,{message:old.data.source==='ocr'?`PDF ${number}쪽 · 저장된 본문을 재사용하고 숫자 영역만 보완 인식합니다.`:`PDF ${number}쪽 · 저장된 페이지의 좌표 인덱스를 정리합니다.`},undefined,job);
          const numberMarkers=old.data.source==='ocr'&&old.data.numberLayerVersion!==NUMBER_LAYER_VERSION?await prepareNumberMarkers(pdf,number):old.data.numberMarkers??[];
          await pageCheckpoint(ctx,job,{...preparedFromRow(old),numberMarkers,numberLayerVersion:NUMBER_LAYER_VERSION},old.image_path);
        }
        continue;
      }
      await patchDocument(
        ctx,
        job.id,
        {
          progress: Math.floor((position / targetPages.length) * 70),
          message: `PDF ${number}쪽 · 선택 범위 ${position + 1}/${targetPages.length}쪽 처리`,
        },
        undefined,
        job,
      );
      const cachedFields=!job.force&&job.retryPage!==number?await cacheGet<any>(ctx.user.id,`prepared:${job.id}:${number}:${PDF_ENGINE_VERSION}`):null;
      const cachedImage=cachedFields?await cacheGet<Blob>(ctx.user.id,`prepared-image:${job.id}:${number}:${PDF_ENGINE_VERSION}`):null;
      const prepared:PreparedPage=cachedFields?.numberLayerVersion===NUMBER_LAYER_VERSION&&cachedImage instanceof Blob?{...cachedFields,image:cachedImage}:await preparePage(pdf, number);
      const {image:preparedImage,...preparedFields}=storagePageText(prepared);
      await cachePut(ctx.user.id,`prepared:${job.id}:${number}:${PDF_ENGINE_VERSION}`,preparedFields);
      await cachePut(ctx.user.id,`prepared-image:${job.id}:${number}:${PDF_ENGINE_VERSION}`,preparedImage);
      await ensureJob(ctx, job);
      const imagePath = `${ctx.user.id}/${job.id}/pages/${number}/${crypto.randomUUID()}.png`;
      await upload(ctx, imagePath, prepared.image);
      await pageCheckpoint(ctx, job, prepared, imagePath);
      await patchDocument(
        ctx,
        job.id,
        {
          pageCount: pdf.numPages,
          completedPages: position + 1,
          progress: Math.floor(((position + 1) / targetPages.length) * 70),
          message: `PDF ${number}쪽 · 선택 범위 ${position + 1}/${targetPages.length}쪽 저장`,
        },
        undefined,
        job,
      );
    }
    job.page = undefined;
    const pages = await list(ctx, "document_pages", "document_id", job.id);
    const prepared = pages
      .filter((p) => targetPages.includes(p.number))
      .sort((a, b) => a.number - b.number)
      .map(preparedFromRow);
    if (prepared.length !== targetPages.length)
      throw failure(
        "선택 범위에 아직 저장되지 않은 페이지가 있습니다. 분석을 다시 시도해 주세요.",
      );
    const localOutline=extractLocalOutline(prepared,starting.data.tocPages??[],pdf.numPages,starting.data.printedPageOffset);
    await edgeCall('app',{path:`materials/${job.id}/outline`,method:'POST',body:{outline:localOutline,processingToken:job.token}});
    const chapters=await list(ctx,'document_chapters','document_id',job.id);
    const candidates = detectProblems(prepared),
      warnings = prepared.flatMap((p) =>
        (p.warnings || []).map((w) => `${p.number}쪽: ${w}`),
      );
    const existing = await list(ctx, "problems", "document_id", job.id),
      used = new Set<string>(),
      occurrences = new Map<string, number>();
    for (let index = 0; index < candidates.length; index++) {
      const candidate = candidates[index],
        key = `${candidate.page}:${candidate.number}`,
        occurrence = occurrences.get(key) ?? 0;
      occurrences.set(key, occurrence + 1);
      await ensureJob(ctx, job);
      const old = existing.find(
        (q) =>
          !used.has(q.id) &&
          q.number === candidate.number &&
          q.page === candidate.page,
      );
      if (old) used.add(old.id);
      const id =
        old?.id ||
        (await stableProblemId(
          job.id,
          candidate.number,
          candidate.page,
          occurrence,
        ));
      used.add(id);
      const current = await one(ctx, "problems", id, true);
      if (current?.data.confirmed || current?.data.source === "manual")
        continue;
      const regions = normalizedRegions(
          candidate.regions,
          pages,
          pdf.numPages,
          candidate.page,
        ),
        parts = current
          ? await list(ctx, "problem_regions", "problem_id", id)
          : [];
      if (
        !job.force && !regions.some(r=>r.page===job.retryPage) && current?.data.layoutVersion==='local-layout-2026-11-02-v2' &&
        current?.data.cropEngineVersion === PDF_ENGINE_VERSION &&
        JSON.stringify(current.data.regions) === JSON.stringify(regions) &&
        parts.length === regions.length &&
        parts.every(
          (p) =>
            typeof p.image_path === "string" &&
            p.image_path.startsWith(`${ctx.user.id}/${job.id}/`),
        )
      )
        continue;
      const chapter=chapters.filter(c=>candidate.page>=c.start_page&&candidate.page<=c.end_page).sort((a,b)=>(a.end_page-a.start_page)-(b.end_page-b.start_page))[0];
      const fields = {
        number: candidate.number,
        page: candidate.page,
        materialId: job.id,
        unit: current?.data.unit || candidate.unit,
        text: candidate.text,
        confirmed: false,
        source: candidate.source,
        confidence: candidate.confidence,
        sharedRegionCount: candidate.sharedRegionCount || 0,
        autoRetired:false,
        layoutVersion:'local-layout-2026-11-02-v2',
        chapterId:current?.data.chapterId??chapter?.id??null,
        index:{document_id:job.id,pdf_page:candidate.page,q_number:String(candidate.number),chapter_id:current?.data.chapterId??chapter?.id??null,regions:regions.map(r=>({page:r.page,bbox:[r.x,r.y,r.x+r.w,r.y+r.h]})),confidence:candidate.confidence,needs_review:true},
      };
      await commitCrop(ctx, starting, pdf, current, id, fields, regions, job);
      await patchDocument(
        ctx,
        job.id,
        {
          progress:
            70 +
            Math.floor(((index + 1) / Math.max(1, candidates.length)) * 29),
          message: `${index + 1}/${candidates.length}개 문항 후보의 모든 원본 영역을 저장했습니다.`,
        },
        undefined,
        job,
      );
    }
    if (!candidates.length)
      warnings.push(
        "자동으로 확정할 수 있는 문항 번호가 없습니다. 페이지 내용을 확인하고 필요한 문항 영역을 지정하세요.",
      );
    await ensureJob(ctx,job);
    const retired=await ctx.db.rpc('retire_unmatched_pdf_candidates',{p_document:job.id,p_keep:[...used],p_token:job.token,p_layout_version:'local-layout-2026-11-02-v2'});
    if(retired.error)throw failure('새 문항 인덱스를 저장하지 못했습니다. 기존 후보와 기록은 보관했습니다.');
    const savedQuestions = (await list(ctx, "problems", "document_id", job.id)).filter(q=>!q.data.autoRetired);
    // Retain unmatched historical/manual questions, repairing missing PNGs from
    // their own saved geometry before declaring the document finished.
    for (const saved of savedQuestions) {
      await ensureJob(ctx, job);
      const parts = await list(ctx, "problem_regions", "problem_id", saved.id),
        storedRegions =
          saved.data.regions ||
          parts.sort((a, b) => a.part - b.part).map((p) => p.data);
      if (
        storedRegions.some((r: Region) =>
          pages.some((p) => p.number === r.page && p.data.kind === "answers"),
        )
      )
        continue;
      if (completeParts(ctx, job.id, storedRegions, parts)) continue;
      const regions = normalizedRegions(
        storedRegions,
        pages,
        pdf.numPages,
        saved.page,
      );
      await commitCrop(
        ctx,
        starting,
        pdf,
        saved,
        saved.id,
        {
          number: saved.number,
          page: saved.page,
          materialId: job.id,
          unit: saved.data.unit || "",
          text: saved.data.text || cropText(regions, pages),
          confirmed: !!saved.data.confirmed,
          source: saved.data.source || "manual",
          confidence: saved.data.confidence ?? 1,
          sharedRegionCount: saved.data.sharedRegionCount || 0,
        },
        regions,
        job,
      );
    }
    const needsReview =
      warnings.length > 0 ||
      savedQuestions.some((q) => !q.data.confirmed) ||
      !savedQuestions.length;
    await patchDocument(
      ctx,
      job.id,
      {
        progress: 100,
        completedPages: targetPages.length,
        processedPages: targetPages,
        pageCount: pdf.numPages,
        engineVersion: PDF_ENGINE_VERSION,
        warnings: [...new Set(warnings)],
        processingToken: null,
        error: null,
        message: needsReview
          ? "선택 범위의 페이지와 문항 후보를 저장했습니다. 영역과 내용을 확인하세요."
          : "선택 범위의 확인된 원본 문항과 페이지를 저장했습니다.",
      },
      needsReview ? "needs_review" : "ready",
      job,
    );
  } catch (error) {
    if (
      !job.controller.signal.aborted &&
      !(error instanceof Error && error.name === "AbortError")
    ) {
      try {
        await patchDocument(
          ctx,
          job.id,
          {
            error:
              error instanceof Error
                ? error.message
                : "자료 분석을 완료하지 못했습니다.",
            failedPage: job.page || null,
            message:
              "저장된 체크포인트를 보관했습니다. 다시 시도하면 완료된 페이지를 재사용합니다.",
            processingToken: null,
          },
          "error",
          job,
        );
      } catch {
        /* A newer run, pause, or logout owns the status. */
      }
    }
  } finally {
    if (pdf) await pdf.loadingTask.destroy().catch(() => {});
  }
}
/** Returns after scheduling, rather than waiting for the OCR workload. */
export async function resumeMaterial(id: string, force = false,options:{reindex?:boolean;retryPage?:number}={}): Promise<void> {
  const ctx = await context(),
    doc = (await one(ctx, "documents", id))!;
  if(options.retryPage!==undefined&&(!Number.isInteger(options.retryPage)||options.retryPage<1||options.retryPage>doc.data.pageCount||![...(doc.data.selectedPages??[]),...(doc.data.tocPages??[])].includes(options.retryPage)))throw failure('분석 범위 안의 PDF 페이지를 선택하세요.');
  if (doc.data.archived) throw failure("보관된 자료는 먼저 복원해 주세요.");
  const key = `${ctx.user.id}:${id}`,
    pending = jobs.get(key);
  if (pending && !pending.controller.signal.aborted) return;
  if (
    !force && !options.reindex && !options.retryPage &&
    ["ready", "needs_review"].includes(doc.status) &&
    !doc.data.paused
  )
    return;
  const job: Job = {
    id,
    userId: ctx.user.id,
    token: crypto.randomUUID(),
    force,
    retryPage:options.retryPage,
    controller: new AbortController(),
  };
  jobs.set(key, job);
  try {
    await patchDocument(
      ctx,
      id,
      {
        paused: false,
        error: null,
        message: "저장된 페이지부터 분석을 이어서 준비하고 있어요.",
      },
      "uploaded",
    );
  } catch (error) {
    if (jobs.get(key) === job) jobs.delete(key);
    throw error;
  }
  workQueue = workQueue
    .catch(() => {})
    .then(async () => {
      if (job.controller.signal.aborted) {
        if (jobs.get(key) === job) jobs.delete(key);
        return;
      }
      activeJob = job;
      try {
        await runDocument(ctx, job);
      } finally {
        if (activeJob === job) {
          activeJob = undefined;
          await closeOcr().catch(() => {});
        }
        if (jobs.get(key) === job) jobs.delete(key);
      }
    });
}
export async function pauseMaterial(id: string): Promise<void> {
  const ctx = await context(),
    key = `${ctx.user.id}:${id}`,
    job = jobs.get(key);
  job?.controller.abort();
  if (activeJob === job && job) await closeOcr();
  await patchDocument(
    ctx,
    id,
    {
      paused: true,
      processingToken: null,
      message:
        "분석을 일시 중지했습니다. 완료된 페이지와 원본 크롭은 보관됩니다.",
    },
    "uploaded",
  );
}
export async function resumePending(): Promise<void> {
  const ctx = await context(),
    docs = await list(ctx, "documents");
  for (const doc of docs)
    if (
      ["uploaded", "processing"].includes(doc.status) &&
      !doc.data.paused &&
      !doc.data.archived
    )
      await resumeMaterial(doc.id);
}
export async function updateMaterialRange(
  id: string,
  options: {
    analysisRange: string;
    excludedPages: string;
    tocRange: string;
    analysisMethod?: string;
    printedPageOffset?: number | null;
  },
) {
  const ctx = await context(),
    doc = (await one(ctx, "documents", id))!;
  if (jobs.has(`${ctx.user.id}:${id}`)) await pauseMaterial(id);
  const selected = selectPages(
      options.analysisRange,
      doc.data.pageCount,
      options.excludedPages,
    ),
    toc = tocPages(options.tocRange, doc.data.pageCount);
  await patchDocument(
    ctx,
    id,
    {
      ...options,
      selectedPages: selected,
      tocPages: toc,
      paused: false,
      processingToken: null,
      initialContentJobId: null,
    },
    "uploaded",
  );
  await resumeMaterial(id);
}
/** Export copies of the selected physical pages; the stored whole PDF stays intact. */
export async function downloadSelectedPdf(id: string, pages: number[]) {
  const ctx = await context(),
    doc = (await one(ctx, "documents", id))!;
  const selected = selectPages(pages.join(","), doc.data.pageCount);
  if (!pages.length) throw failure("내보낼 페이지를 선택하세요.");
  const path = ownPath(ctx, id, doc.data.pdfPath || doc.data.originalPath);
  let blob = await cacheGet<Blob>(ctx.user.id, `pdf:${path}`);
  if (!(blob instanceof Blob)) {
    const result = await ctx.db.storage.from(BUCKET).download(path);
    if (result.error || !result.data)
      throw failure("원본 PDF를 읽지 못했습니다.");
    blob = result.data;
    await cachePut(ctx.user.id, `pdf:${path}`, blob);
  }
  const { PDFDocument } = await import("pdf-lib"),
    source = await PDFDocument.load(await blob.arrayBuffer()),
    output = await PDFDocument.create();
  for (const page of await output.copyPages(
    source,
    selected.map((p) => p - 1),
  ))
    output.addPage(page);
  const url = URL.createObjectURL(
      new Blob([(await output.save()) as Uint8Array<ArrayBuffer>], {
        type: "application/pdf",
      }),
    ),
    link = document.createElement("a");
  link.href = url;
  link.download = `${doc.title.replace(/[<>:"/\\|?*]/g, "_")}-선택범위.pdf`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
/** Every new PNG is durable before the atomic crop-revision switch. */
export async function saveQuestion(
  id: string | undefined,
  body: any,
): Promise<any> {
  const ctx = await context(),
    old = id ? await one(ctx, "problems", id) : undefined,
    materialId = body?.materialId || old?.document_id;
  if (!materialId || (old && old.document_id !== materialId))
    throw failure("문항의 원본 자료는 변경할 수 없습니다.");
  const doc = (await one(ctx, "documents", materialId))!;
  if (doc.data.archived)
    throw failure("보관된 자료의 문항은 수정할 수 없습니다.");
  const pages = await list(ctx, "document_pages", "document_id", materialId),
    number = body?.number ?? old?.number,
    page = body?.page ?? old?.page;
  if (!Number.isInteger(number) || number < 1 || number > 9999)
    throw failure("문제 번호를 1~9999 사이의 정수로 입력해 주세요.");
  const regions = normalizedRegions(
    body?.regions ?? old?.data.regions,
    pages,
    doc.data.pageCount,
    page,
  );
  const originalShared =
      body?.sharedRegionCount ?? old?.data.sharedRegionCount ?? 0,
    sharedRegionCount =
      regions[originalShared]?.page === page
        ? originalShared
        : regions.findIndex((r) => r.page === page);
  const fields = {
    number,
    page,
    materialId,
    unit: String(body?.unit ?? old?.data.unit ?? "")
      .trim()
      .slice(0, 120),
    text:
      typeof body?.text === "string"
        ? body.text.slice(0, 100000)
        : cropText(regions, pages) || old?.data.text || "",
    confirmed: body?.confirmed !== false,
    source: "manual",
    confidence: 1,
    sharedRegionCount,
  };
  const pdf = await processingPdf(ctx, doc);
  try {
    const saved = await commitCrop(
        ctx,
        doc,
        pdf,
        old,
        id || crypto.randomUUID(),
        fields,
        regions,
      ),
      { answer: _, explanation: __, ...safe } = saved.data;
    return {
      ...safe,
      id: saved.id,
      materialId,
      number: saved.number,
      page: saved.page,
    };
  } finally {
    await pdf.loadingTask.destroy();
  }
}
