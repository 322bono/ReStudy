import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({ db: null as any, user: "11111111-1111-4111-8111-111111111111",edgeCall:vi.fn(),openPdf: vi.fn(), preparePage: vi.fn(),prepareNumberMarkers:vi.fn(),renderRegions: vi.fn(), detectProblems: vi.fn(), closeOcr: vi.fn() }));
vi.mock("../src/services/supabase", () => ({ getSupabase: () => mocked.db,edgeCall:mocked.edgeCall,currentUser: async () => ({ id: mocked.user }) }));
vi.mock("../src/features/pdf/processor", () => ({ openPdf: mocked.openPdf, preparePage: mocked.preparePage,prepareNumberMarkers:mocked.prepareNumberMarkers,NUMBER_LAYER_VERSION:'test-number-layer',renderRegions: mocked.renderRegions, detectProblems: mocked.detectProblems, closeOcr: mocked.closeOcr }));
import { PDF_ENGINE_VERSION, pauseMaterial, resumeMaterial, resumePending, saveQuestion, uploadMaterials } from "../src/services/documents";

type Row = Record<string, any>;
function database() {
  const tables: Record<string, Row[]> = { documents: [], document_pages: [], problems: [], problem_regions: [] };
  const files = new Map<string, Blob>();
  const uploads: string[] = [];
  let clock = 0;
  let authChanged: ((event: string, session: any) => void) | undefined;
  let failUpload: boolean | ((path: string) => boolean) = false;
  const db: any = {
    tables, files, uploads, failUploads: (predicate?: (path: string) => boolean) => { failUpload = predicate || true; }, resumeUploads: () => { failUpload = false; },
    auth: { onAuthStateChange: (callback: typeof authChanged) => { authChanged = callback; return { data: { subscription: { unsubscribe: () => {} } } }; } },
    signOut: () => authChanged?.("SIGNED_OUT", null),
    from(table: string) {
      let operation = "read", values: any, single = false;
      const predicates: ((r: Row) => boolean)[] = [];
      let start = 0, end = Infinity;
      const query: any = {
        select: () => query, eq: (key: string, value: any) => { predicates.push((r) => r[key] === value); return query; },
        in: (key: string, value: any[]) => { predicates.push((r) => value.includes(r[key])); return query; },
        order: () => query, limit: (count: number) => { end = count - 1; return query; },
        range: (a: number, b: number) => { start = a; end = b; return query; },
        insert: (value: any) => { operation = "insert"; values = value; return query; },
        update: (value: any) => { operation = "update"; values = value; return query; },
        maybeSingle: () => { single = true; return query; }, single: () => { single = true; return query; },
        then(resolve: any, reject: any) {
          return Promise.resolve().then(() => {
            const list = tables[table] ||= [];
            let rows = list.filter((r) => predicates.every((p) => p(r)));
            if (operation === "insert") {
              const pending = Array.isArray(values) ? values : [values];
              for (const value of pending) {
                if (table === "documents" && list.some((r) => r.user_id === value.user_id && r.content_hash === value.content_hash)
                  || table === "document_pages" && list.some((r) => r.document_id === value.document_id && r.number === value.number)) return { data: null, error: { code: "23505" } };
              }
              rows = pending.map((r: Row) => ({ id: crypto.randomUUID(), ...structuredClone(r), updated_at: String(++clock) })); list.push(...rows);
            } else if (operation === "update") {
              for (const row of rows) Object.assign(row, structuredClone(values), { updated_at: String(++clock) });
            }
            rows = rows.slice(start, end + 1);
            return { data: structuredClone(single ? rows[0] ?? null : rows), error: null };
          }).then(resolve, reject);
        },
      };
      return query;
    },
    storage: { from: () => ({
      upload: async (path: string, file: Blob, options: any) => {
        if (typeof failUpload === "function" ? failUpload(path) : failUpload) return { error: { message: "upload interrupted" } };
        if (files.has(path)) return { error: { message: "overwrite forbidden" } };
        expect(options.upsert).toBe(false); files.set(path, file); uploads.push(path); return { error: null, data: { path } };
      },
      download: async (path: string) => ({ error: files.has(path) ? null : { message: "missing" }, data: files.get(path) }),
    }) },
    rpc: vi.fn(async (name: string, args: any) => {
      if(name==='retire_unmatched_pdf_candidates'){for(const q of tables.problems)if(q.document_id===args.p_document&&!args.p_keep.includes(q.id)&&!q.data.confirmed&&q.data.source!=='manual')q.data.autoRetired=true;return{data:{retired:0},error:null};}
      expect(name).toBe("save_problem_regions");
      const p = args.p_problem, old = tables.problems.find((r) => r.id === p.id);
      if (old && (old.data.revision ?? null) !== args.p_expected_revision) return { data: null, error: { message: "revision conflict" } };
      const next = { ...old, ...p, user_id: mocked.user, data: { ...old?.data, ...p.data }, updated_at: String(++clock) };
      tables.problems = tables.problems.filter((r) => r.id !== p.id).concat(next);
      tables.problem_regions = tables.problem_regions.filter((r) => r.problem_id !== p.id).concat(args.p_regions.map((r: Row) => ({ ...r, problem_id: p.id, user_id: mocked.user })));
      return { data: structuredClone(next), error: null };
    }),
  };
  return db;
}

const DOC = "22222222-2222-4222-8222-222222222222";
const Q = "33333333-3333-4333-8333-333333333333";
const region = { page: 1, x: 0.05, y: 0.1, w: 0.8, h: 0.5 };
const prepared = (number: number) => ({ number, width: 600, height: 800, text: `${number}. 원본 문제`, items: [], kind: "content", source: "text", warnings: [], image: new Blob(["png"], { type: "image/png" }) });
function seedDoc(status = "uploaded") {
  const data = { mime: "application/pdf", bytes: 100, pageCount: 2, progress: 0, originalPath: `${mocked.user}/${DOC}/original.pdf`, pdfPath: `${mocked.user}/${DOC}/original.pdf`, paused: false, engineVersion: PDF_ENGINE_VERSION };
  mocked.db.tables.documents.push({ id: DOC, user_id: mocked.user, title: "원본", subject: "수학", kind: "문제집", status, content_hash: "hash", data, updated_at: "initial" });
  mocked.db.files.set(data.pdfPath, new Blob(["%PDF-1.4 test"], { type: "application/pdf" }));
  return mocked.db.tables.documents[0];
}
function seedPage(number: number, extra: Row = {}) {
  const { image, ...data } = prepared(number);
  const path = `${mocked.user}/${DOC}/page-${number}.png`;
  mocked.db.files.set(path, image);
  mocked.db.tables.document_pages.push({ id: crypto.randomUUID(), user_id: mocked.user, document_id: DOC, number, image_path: path, data: { ...data, engineVersion: PDF_ENGINE_VERSION, checkpointComplete: true, ...extra }, updated_at: "page-initial" });
}
beforeEach(() => {
  mocked.db = database();
  vi.clearAllMocks();
  mocked.openPdf.mockResolvedValue({ numPages: 2, loadingTask: { destroy: vi.fn(async () => {}) } });
  mocked.preparePage.mockImplementation(async (_pdf, n) => prepared(n));
  mocked.prepareNumberMarkers.mockResolvedValue([]);
  mocked.edgeCall.mockResolvedValue({saved:0});
  mocked.renderRegions.mockResolvedValue([new Blob(["crop"], { type: "image/png" })]);
  mocked.detectProblems.mockReturnValue([{ number: 17, page: 1, unit: "", text: "원본", regions: [region], confidence: 0.7, confirmed: false, source: "text", sharedRegionCount: 0 }]);
  mocked.closeOcr.mockResolvedValue(undefined);
});
const finished = () => vi.waitFor(() => expect(["needs_review", "ready", "error"]).toContain(mocked.db.tables.documents[0].status));

describe("private browser document checkpoints", () => {
  it("preflights every file before any DB or storage persistence", async () => {
    const form = new FormData(); form.set("subject", "수학"); form.set("kind", "문제집");
    form.append("files", new File(["%PDF-1.4 valid"], "valid.pdf", { type: "application/pdf" }));
    form.append("files", new File(["executable"], "bad.png", { type: "image/png" }));
    await expect(uploadMaterials(form)).rejects.toThrow();
    expect(mocked.db.tables.documents).toHaveLength(0); expect(mocked.db.uploads).toHaveLength(0);
  });

  it("reuses committed pages and keeps old IDs, manual regions, answers and manual page kinds", async () => {
    seedDoc(); seedPage(1); seedPage(2, { manualKind: true, kind: "answers" });
    mocked.db.tables.problems.push({ id: Q, user_id: mocked.user, document_id: DOC, number: 17, page: 1, data: { regions: [region], confirmed: true, source: "manual", answer: "3", explanation: "기존 해설", revision: "old" } });
    mocked.db.tables.problem_regions.push({ id: crypto.randomUUID(), user_id: mocked.user, problem_id: Q, part: 0, page: 1, image_path: `${mocked.user}/${DOC}/old-crop.png`, data: region });
    await resumeMaterial(DOC); await finished();
    expect(mocked.preparePage).not.toHaveBeenCalled();
    expect(mocked.db.tables.document_pages[1].data.kind).toBe("answers");
    expect(mocked.db.tables.problems[0]).toMatchObject({ id: Q, data: { answer: "3", explanation: "기존 해설", revision: "old", confirmed: true } });
    expect(mocked.renderRegions).not.toHaveBeenCalled();
  });

  it("repairs a missing saved crop without changing a confirmed question's geometry or answer", async () => {
    seedDoc(); seedPage(1); seedPage(2);
    mocked.db.tables.problems.push({ id: Q, user_id: mocked.user, document_id: DOC, number: 17, page: 1, data: { regions: [region], confirmed: true, source: "manual", answer: "3", revision: "old" } });
    await resumeMaterial(DOC); await finished();
    expect(mocked.db.tables.problem_regions).toHaveLength(1);
    expect(mocked.db.tables.problems[0]).toMatchObject({ id: Q, data: { answer: "3", source: "manual", confirmed: true, regions: [region] } });
    expect(mocked.renderRegions).toHaveBeenCalledTimes(1);
  });

  it("does not commit a late OCR page after pause and resumes from prior checkpoints", async () => {
    seedDoc(); seedPage(1);
    let resolvePage!: (value: any) => void;
    mocked.preparePage.mockImplementation(() => new Promise((resolve) => { resolvePage = resolve; }));
    await resumeMaterial(DOC);
    await vi.waitFor(() => expect(mocked.preparePage).toHaveBeenCalledTimes(1));
    await pauseMaterial(DOC);
    resolvePage(prepared(2));
    await vi.waitFor(() => expect(mocked.closeOcr).toHaveBeenCalled());
    expect(mocked.db.tables.document_pages).toHaveLength(1);
    expect(mocked.db.tables.documents[0].data.paused).toBe(true);
    expect(mocked.db.tables.documents[0].status).toBe("uploaded");
  });

  it("deduplicates an explicit re-upload by the authenticated user's content hash", async () => {
    const doc = seedDoc("needs_review"), source = new File(["%PDF-1.4 valid"], "same.pdf", { type: "application/pdf" });
    doc.content_hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await source.arrayBuffer())), (v) => v.toString(16).padStart(2, "0")).join("");
    const form = new FormData(); form.set("subject", "수학"); form.append("files", source);
    const result = await uploadMaterials(form);
    expect(result.materials.map((m) => m.id)).toEqual([DOC]);
    expect(mocked.db.tables.documents).toHaveLength(1); expect(mocked.db.uploads).toHaveLength(0);
  });

  it("checkpoints each page, leaves an interrupted crop as an error, and retries without OCR", async () => {
    seedDoc(); mocked.db.failUploads((path: string) => path.includes("/questions/"));
    await resumeMaterial(DOC); await finished();
    expect(mocked.db.tables.documents[0].status).toBe("error");
    expect(mocked.db.tables.problems).toHaveLength(0);
    expect(mocked.db.tables.document_pages).toHaveLength(2);
    expect(mocked.preparePage).toHaveBeenCalledTimes(2);
    mocked.db.resumeUploads();
    await resumeMaterial(DOC); await finished();
    expect(mocked.db.tables.documents[0].status).toBe("needs_review");
    expect(mocked.preparePage).toHaveBeenCalledTimes(2);
    expect(mocked.db.tables.problems).toHaveLength(1);
  });

  it("manual crop saves are atomic and retain old image files and answer fields", async () => {
    seedDoc("needs_review"); seedPage(1);
    const oldPath = `${mocked.user}/${DOC}/old.png`; mocked.db.files.set(oldPath, new Blob(["old"]));
    mocked.db.tables.problems.push({ id: Q, user_id: mocked.user, document_id: DOC, number: 17, page: 1, data: { answer: "3", explanation: "기존 해설", revision: "old", regions: [region], conceptIds: ["kept"] } });
    const saved = await saveQuestion(Q, { materialId: DOC, number: 17, page: 1, regions: [region], confirmed: true });
    expect(saved.id).toBe(Q); expect(saved.answer).toBeUndefined();
    expect(mocked.db.tables.problems[0].data).toMatchObject({ answer: "3", explanation: "기존 해설", conceptIds: ["kept"], source: "manual", confirmed: true });
    expect(mocked.db.files.has(oldPath)).toBe(true);
    expect(mocked.db.tables.problem_regions[0].image_path).not.toBe(oldPath);
    expect(mocked.db.rpc.mock.calls.filter(([name])=>name==="save_problem_regions")).toHaveLength(1);
  });

  it("rejects answer pages and invalid start pages before rendering a manual crop", async () => {
    seedDoc("needs_review"); seedPage(1, { kind: "answers", manualKind: true });
    await expect(saveQuestion(undefined, { materialId: DOC, number: 17, page: 1, regions: [region] })).rejects.toThrow();
    await expect(saveQuestion(undefined, { materialId: DOC, number: 17, page: 2, regions: [region] })).rejects.toThrow();
    expect(mocked.renderRegions).not.toHaveBeenCalled(); expect(mocked.db.rpc.mock.calls.filter(([name])=>name==="save_problem_regions")).toHaveLength(0);
  });

  it("auto-resume leaves deliberately paused materials alone", async () => {
    const doc = seedDoc(); doc.data.paused = true;
    await resumePending();
    expect(mocked.openPdf).not.toHaveBeenCalled(); expect(doc.data.paused).toBe(true);
    await pauseMaterial(DOC);
    expect(mocked.db.tables.documents[0].data.paused).toBe(true);
  });

  it("concurrent resume requests schedule one OCR run and one problem ID", async () => {
    seedDoc();
    await Promise.all([resumeMaterial(DOC), resumeMaterial(DOC), resumePending()]);
    await finished();
    expect(mocked.preparePage).toHaveBeenCalledTimes(2);
    expect(mocked.db.tables.document_pages).toHaveLength(2);
    expect(mocked.db.tables.problems).toHaveLength(1);
    expect(mocked.db.rpc.mock.calls.filter(([name])=>name==="save_problem_regions")).toHaveLength(1);
  });

  it("stops browser work on sign-out without deleting resumable checkpoints", async () => {
    seedDoc(); seedPage(1);
    let finishPage!: (value: any) => void;
    mocked.preparePage.mockImplementation(() => new Promise((resolve) => { finishPage = resolve; }));
    await resumeMaterial(DOC);
    await vi.waitFor(() => expect(mocked.preparePage).toHaveBeenCalledTimes(1));
    mocked.db.signOut(); finishPage(prepared(2));
    await vi.waitFor(() => expect(mocked.closeOcr).toHaveBeenCalled());
    expect(mocked.db.tables.document_pages).toHaveLength(1);
    expect(mocked.db.tables.problems).toHaveLength(0);
  });

  it("does not switch a manual revision when the final PNG upload fails", async () => {
    seedDoc("needs_review"); seedPage(1); seedPage(2);
    const oldPath = `${mocked.user}/${DOC}/old.png`; mocked.db.files.set(oldPath, new Blob(["old"]));
    mocked.db.tables.problems.push({ id: Q, user_id: mocked.user, document_id: DOC, number: 17, page: 1, data: { revision: "old", answer: "3", regions: [region] } });
    mocked.renderRegions.mockResolvedValue([new Blob(["part1"]), new Blob(["part2"])]);
    mocked.db.failUploads((path: string) => path.endsWith("/1.png"));
    await expect(saveQuestion(Q, { materialId: DOC, number: 17, page: 1, regions: [region, { ...region, page: 2 }] })).rejects.toThrow();
    expect(mocked.db.rpc.mock.calls.filter(([name])=>name==="save_problem_regions")).toHaveLength(0);
    expect(mocked.db.tables.problems[0].data.revision).toBe("old");
    expect(mocked.db.files.has(oldPath)).toBe(true);
  });

  it("preserves a newer manual revision if editing finishes while automatic PNG rendering is running", async () => {
    seedDoc(); seedPage(1); seedPage(2);
    mocked.db.tables.problems.push({ id: Q, user_id: mocked.user, document_id: DOC, number: 17, page: 1, data: { revision: "old", regions: [region], source: "text", confirmed: false } });
    let finishRender!: (value: Blob[]) => void;
    mocked.renderRegions.mockImplementation(() => new Promise((resolve) => { finishRender = resolve; }));
    await resumeMaterial(DOC);
    await vi.waitFor(() => expect(mocked.renderRegions).toHaveBeenCalledTimes(1));
    Object.assign(mocked.db.tables.problems[0].data, { revision: "manual-new", source: "manual", confirmed: true });
    mocked.db.tables.problem_regions.push({ problem_id: Q, user_id: mocked.user, part: 0, page: 1, image_path: `${mocked.user}/${DOC}/manual-new.png`, data: region });
    finishRender([new Blob(["automatic-old"])]); await finished();
    expect(mocked.db.tables.problems[0].data.revision).toBe("manual-new");
    expect(mocked.db.rpc.mock.calls.filter(([name])=>name==="save_problem_regions")).toHaveLength(0);
  });
});
