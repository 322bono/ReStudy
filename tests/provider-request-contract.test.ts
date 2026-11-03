import { expect, test, vi } from "vitest";
import {
  generate,
  checkConnection,
} from "../supabase/functions/_shared/ai/providers";
import { modelFor } from "../supabase/functions/_shared/ai/catalog";
import { runTask } from "../supabase/functions/_shared/ai/router";

const model = "gemma-4-26b-a4b-it";
const response = () =>
  new Response(
    JSON.stringify({
      candidates: [
        { content: { parts: [{ text: "{}" }] }, finishReason: "STOP" },
      ],
    }),
  );

test.each(["gemma-4-26b-a4b-it", "gemma-4-31b-it"])(
  "outgoing %s wire request uses documented REST headers and typed fields",
  async (id) => {
    let seenUrl = "",
      seenInit: RequestInit | undefined;
    const transport = vi.fn(async (url: any, init?: RequestInit) => {
      seenUrl = String(url);
      seenInit = init;
      return response();
    });
    await generate(
      "gemini",
      id,
      "test-key",
      {
        kind: "restudy_v1",
        prompt: "출력 계약",
        images: [{ mimeType: "image/png", data: "dGVzdA==" }],
      },
      transport as typeof fetch,
      0,
    );
    expect(seenUrl).toBe(
      `https://generativelanguage.googleapis.com/v1beta/models/${id}:generateContent`,
    );
    expect(seenUrl).not.toContain("test-key");
    expect(seenInit?.method).toBe("POST");
    const headers = new Headers(seenInit?.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.get("x-goog-api-key")).toBe("test-key");
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("api-revision")).toBeNull(); // Interactions API uses a different revision contract.
    const body = JSON.parse(String(seenInit?.body));
    expect(Object.keys(body).sort()).toEqual([
      "contents",
      "generationConfig",
      "systemInstruction",
    ]);
    expect(body.contents).toEqual([
      {
        role: "user",
        parts: [
          { text: "출력 계약" },
          { inlineData: { mimeType: "image/png", data: "dGVzdA==" } },
        ],
      },
    ]);
    expect(Number.isInteger(body.generationConfig.maxOutputTokens)).toBe(true);
    expect(body.generationConfig.maxOutputTokens).toBeLessThanOrEqual(8192);
    expect(body.generationConfig.thinkingConfig).toEqual({
      thinkingLevel: "MINIMAL",
    });
    expect(body.generationConfig.responseMimeType).toBeUndefined();
    expect(body.generationConfig.responseFormat).toBeUndefined();
    expect(body.tools).toBeUndefined();
  },
);

test.each([
  { prompt: 8 },
  { prompt: "" },
  { prompt: " ".repeat(4) },
  { prompt: "x".repeat(48001) },
  { prompt: "본문", images: "not-an-array" },
  { prompt: "본문", kind: "unknown-task" },
  { prompt: "본문", images: [null] },
  { prompt: "본문", images: Array.from({length:7},()=>({mimeType:'image/png',data:'dGVzdA=='})) },
  {
    prompt: "본문",
    images: [{ mimeType: "application/pdf", data: "dGVzdA==" }],
  },
  {
    prompt: "본문",
    images: [{ mimeType: "image/png", data: "data:image/png;base64,dGVzdA==" }],
  },
  { prompt: "본문", images: [{ mimeType: "image/png", data: "dGVzdA=" }] },
  { prompt: "본문", images: [{ mimeType: "image/png", data: "====" }] },
  { prompt: "본문", images: [{ mimeType: "image/png", data: "dGVzdA==\n" }] },
  { prompt: "본문", images: [{ mimeType: "image/png", data: 12 }] },
])(
  "rejects malformed provider input before any HTTP request, case %#",
  async (malformed) => {
    const transport = vi.fn(async () => response());
    await expect(
      generate(
        "gemini",
        model,
        "test-key",
        { kind: "restudy_v1", ...malformed } as any,
        transport as typeof fetch,
        0,
      ),
    ).rejects.toMatchObject({ code: "request_invalid" });
    expect(transport).not.toHaveBeenCalled();
  },
);

test.each(["", "  ", "key\r\nX-Header: value"])(
  "rejects invalid header credentials before generation or metadata probing",
  async (key) => {
    const transport = vi.fn(async () => response());
    await expect(
      generate(
        "gemini",
        model,
        key,
        { kind: "restudy_v1", prompt: "본문" },
        transport as typeof fetch,
        0,
      ),
    ).rejects.toMatchObject({ code: "auth_error" });
    await expect(
      checkConnection("gemini", model, key, transport as typeof fetch),
    ).rejects.toMatchObject({ code: "auth_error" });
    expect(transport).not.toHaveBeenCalled();
  },
);

test("inline request bound includes base64 and serialized JSON overhead", async () => {
  const transport = vi.fn(async () => response());
  const image = { mimeType: "image/png", data: "A".repeat(5_000_000) };
  await expect(
    generate(
      "gemini",
      model,
      "test-key",
      {
        kind: "restudy_v1",
        prompt: "본문",
        images: [image, image, image, image],
      },
      transport as typeof fetch,
      0,
    ),
  ).rejects.toMatchObject({
    code: "request_invalid",
    diagnostic: "request_size_exceeded",
  });
  expect(transport).not.toHaveBeenCalled();
});

test("NVIDIA model-specific reasoning fields follow current documentation while Bolt retains its required gateway alias", () => {
  for (const id of [
    "nvidia/nemotron-3-super-120b-a12b",
    "nvidia/nemotron-3-ultra-550b-a55b",
    "nvidia/nemotron-3.5-super-vl-120b-a12b",
  ]) {
    expect(modelFor("nvidia", id)).toMatchObject({
      nvidiaReasoningEffort: "none",
    });
    expect(modelFor("nvidia", id)?.nvidiaThinking).toBeUndefined();
  }
  expect(modelFor("nvidia", "nvidia/nemotron-3.5-bolt-e4b")).toMatchObject({
    requestModel: "stg/nvidia/nemotron-3.5-bolt-e4b",
    nvidiaThinking: "disabled",
  });
});

test("router reports oversized input before loading keys instead of saying no provider is available", async () => {
  const getKey = vi.fn(async () => "test-key"),
    transport = vi.fn(async () => response()),
    health = vi.fn(async () => {}),
    log = vi.fn(async () => {});
  const result = await runTask(
    { kind: "restudy_v1", prompt: "x".repeat(48001), sourceIds: [] },
    {
      providers: [
        {
          provider: "gemini",
          enabled: true,
          model,
          access: "free_confirmed",
          status: "connected",
        },
      ],
      mode: "gemini_only",
      rotationIndex: 0,
      allowPaid: false,
      getKey,
      fetch: transport as typeof fetch,
      updateProvider: health,
      log,
    },
  );
  expect(result).toMatchObject({
    status: "paused",
    reason: "all_providers_failed",
    lastError: "request_invalid",
  });
  expect(getKey).not.toHaveBeenCalled();
  expect(transport).not.toHaveBeenCalled();
  expect(health).not.toHaveBeenCalled();
  expect(log).toHaveBeenCalledWith(
    expect.objectContaining({ diagnostic: "prompt_invalid", attempt: 0 }),
  );
  expect(JSON.stringify(log.mock.calls).length).toBeLessThan(500);
});
