import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  owner: "owner" as string | null,
  currentUser: vi.fn(),
  edgeCall: vi.fn(),
  getSession: vi.fn(),
  saveQuestion: vi.fn(),
  authChanged: undefined as undefined | ((event: string, session: any) => void),
}));
vi.mock("../src/services/supabase", () => ({
  currentUser: mocked.currentUser,
  edgeCall: mocked.edgeCall,
  getSupabase: () => ({
    auth: {
      getSession: mocked.getSession,
      onAuthStateChange: (listener: typeof mocked.authChanged) => {
        mocked.authChanged = listener;
        return { data: { subscription: { unsubscribe() {} } } };
      },
    },
  }),
}));
vi.mock("../src/services/documents", () => ({
  saveQuestion: mocked.saveQuestion,
}));
import {
  acquireImageAsset,
  assetUrl,
  clearAssetCache,
  cloudApi,
  invalidateAssetCache,
  prefetchImageAssets,
} from "../src/services/api";

const originalFetch = globalThis.fetch;
let imageFetch: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.clearAllMocks();
  mocked.owner = "owner";
  mocked.currentUser.mockResolvedValue({ id: "owner" });
  mocked.getSession.mockImplementation(async () => ({
    data: { session: mocked.owner ? { user: { id: mocked.owner } } : null },
    error: null,
  }));
  mocked.saveQuestion.mockResolvedValue({ id: "question" });
  mocked.edgeCall.mockResolvedValue({ url: "https://signed.invalid/image" });
  imageFetch = vi.fn(
    async () => new Response(new Blob(["saved image"], { type: "image/png" })),
  );
  vi.stubGlobal("fetch", imageFetch);
});
afterEach(() => {
  clearAssetCache();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("private saved-image reuse", () => {
  it("shares concurrent signing requests without remote user validation", async () => {
    const [first, second] = await Promise.all([
      assetUrl("questions/question/image/0"),
      assetUrl("questions/question/image/0"),
    ]);
    expect(first).toBe(second);
    expect(mocked.edgeCall).toHaveBeenCalledTimes(1);
    expect(mocked.currentUser).not.toHaveBeenCalled();
  });

  it("refreshes expired signed links", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1000);
    mocked.edgeCall
      .mockResolvedValueOnce({ url: "https://signed.invalid/first" })
      .mockResolvedValueOnce({ url: "https://signed.invalid/fresh" });
    expect(await assetUrl("materials/document/page/1")).toContain("first");
    now.mockReturnValue(181000);
    expect(await assetUrl("materials/document/page/1")).toContain("fresh");
  });

  it("downloads concurrent images once and reopens bytes after the signed URL expires", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1000);
    const [first, second] = await Promise.all([
      acquireImageAsset("questions/question/image/0"),
      acquireImageAsset("questions/question/image/0"),
    ]);
    expect(first.url).toBe(second.url);
    expect(await (await originalFetch(first.url)).text()).toBe("saved image");
    first.release();
    second.release();
    now.mockReturnValue(181000);
    const reopened = await acquireImageAsset("questions/question/image/0");
    expect(reopened.url).toBe(first.url);
    expect(imageFetch).toHaveBeenCalledTimes(1);
    expect(mocked.edgeCall).toHaveBeenCalledTimes(1);
    reopened.release();
  });

  it("retries failed downloads without caching the failure", async () => {
    imageFetch.mockResolvedValueOnce(
      new Response("unavailable", { status: 503 }),
    );
    await expect(
      acquireImageAsset("questions/question/image/0"),
    ).rejects.toThrow();
    const retry = await acquireImageAsset("questions/question/image/0");
    expect(await (await originalFetch(retry.url)).text()).toBe("saved image");
    retry.release();
  });

  it("does not publish image bytes downloaded across an account change", async () => {
    let finish!: (response: Response) => void;
    imageFetch.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const pending = acquireImageAsset("questions/question/image/0");
    const rejected = expect(pending).rejects.toThrow(/로그인|변경|중단/);
    await vi.waitFor(() => expect(imageFetch).toHaveBeenCalled());
    mocked.owner = "second owner";
    mocked.authChanged?.("SIGNED_IN", { user: { id: mocked.owner } });
    finish(new Response(new Blob(["first owner's image"])));
    await rejected;
  });

  it("keeps live image URLs usable during token refresh", async () => {
    const image = await acquireImageAsset("questions/question/image/0");
    mocked.authChanged?.("TOKEN_REFRESHED", { user: { id: "owner" } });
    expect(await (await originalFetch(image.url)).text()).toBe("saved image");
    image.release();
  });

  it("refreshes edited crops while keeping mounted images alive until release", async () => {
    const old = await acquireImageAsset("questions/question/image/0");
    imageFetch.mockResolvedValueOnce(
      new Response(new Blob(["new crop"], { type: "image/png" })),
    );
    await cloudApi("questions/question", "PATCH", { regions: [] });
    const updated = await acquireImageAsset("questions/question/image/0");
    expect(updated.url).not.toBe(old.url);
    expect(await (await originalFetch(updated.url)).text()).toBe("new crop");
    expect(await (await originalFetch(old.url)).text()).toBe("saved image");
    old.release();
    await expect(originalFetch(old.url)).rejects.toThrow();
    updated.release();
  });

  it("rejects stale in-flight bytes after crop invalidation", async () => {
    let finish!: (response: Response) => void;
    imageFetch.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const pending = acquireImageAsset("questions/question/image/0");
    const rejected = expect(pending).rejects.toThrow(/변경|중단/);
    await vi.waitFor(() => expect(imageFetch).toHaveBeenCalled());
    invalidateAssetCache("questions/question/");
    finish(new Response(new Blob(["old crop"])));
    await rejected;
  });

  it("prefetches images for reuse without fetching again on navigation", async () => {
    await prefetchImageAssets([
      "questions/next/image/0",
      "questions/next/image/0",
    ]);
    const image = await acquireImageAsset("questions/next/image/0");
    expect(await (await originalFetch(image.url)).text()).toBe("saved image");
    expect(imageFetch).toHaveBeenCalledTimes(1);
    image.release();
  });

  it("evicts old unused images while protecting mounted images", async () => {
    const mounted = await acquireImageAsset("questions/mounted/image/0");
    const unused = await acquireImageAsset("questions/unused/image/0");
    unused.release();
    for (let index = 0; index < 110; index++) {
      const image = await acquireImageAsset(`questions/q${index}/image/0`);
      image.release();
    }
    expect(await (await originalFetch(mounted.url)).text()).toBe("saved image");
    await expect(originalFetch(unused.url)).rejects.toThrow();
    mounted.release();
  });
});
