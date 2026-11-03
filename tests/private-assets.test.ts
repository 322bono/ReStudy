import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocked = vi.hoisted(() => ({
  currentUser: vi.fn(),
  edgeCall: vi.fn(),
  loadOriginalBlob: vi.fn(),
  getSession: vi.fn(),
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
  loadOriginalBlob: mocked.loadOriginalBlob,
}));
import { assetUrl, clearAssetCache } from "../src/services/api";
beforeEach(() => {
  vi.clearAllMocks();
  mocked.currentUser.mockResolvedValue({ id: "owner" });
  mocked.getSession.mockImplementation(async () => ({
    data: { session: { user: await mocked.currentUser() } },
    error: null,
  }));
  mocked.loadOriginalBlob.mockResolvedValue(
    new Blob(["%PDF-reassembled"], { type: "application/pdf" }),
  );
  mocked.edgeCall.mockResolvedValue({ url: "https://signed.invalid/image" });
});
afterEach(() => clearAssetCache());
describe("private original viewer URLs", () => {
  it("shares concurrent signed URL requests and reuses them without remote user validation", async () => {
    const [first, second] = await Promise.all([
      assetUrl("questions/question/image/0"),
      assetUrl("questions/question/image/0"),
    ]);
    expect(first).toBe(second);
    expect(mocked.edgeCall).toHaveBeenCalledTimes(1);
    expect(mocked.getSession).toHaveBeenCalled();
  });
  it("does not reuse a different account's private original URL", async () => {
    mocked.loadOriginalBlob
      .mockResolvedValueOnce(new Blob(["owner A"]))
      .mockResolvedValueOnce(new Blob(["owner B"]));
    const first = await assetUrl("materials/document/file");
    mocked.currentUser.mockResolvedValue({ id: "second owner" });
    const second = await assetUrl("materials/document/file");
    expect(first).not.toBe(second);
    expect(await (await fetch(second)).text()).toBe("owner B");
  });
  it("opens the reassembled original as a browser object URL and revokes it on logout", async () => {
    const url = await assetUrl("materials/document/file");
    expect(url.startsWith("blob:")).toBe(true);
    expect(await (await fetch(url)).text()).toBe("%PDF-reassembled");
    clearAssetCache();
    await expect(fetch(url)).rejects.toThrow();
  });
  it("does not publish a URL after logout while the original was downloading", async () => {
    let finish!: (blob: Blob) => void;
    mocked.loadOriginalBlob.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const pending = assetUrl("materials/document/file");
    const rejected = expect(pending).rejects.toThrow(/로그인|변경|중단/);
    await vi.waitFor(() => expect(mocked.loadOriginalBlob).toHaveBeenCalled());
    clearAssetCache();
    finish(new Blob(["private"]));
    await rejected;
  });
});
