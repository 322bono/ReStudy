import { expect, it, vi } from "vitest";
import { createGoogleFreeProjectVerifier } from "../supabase/functions/_shared/ai/google-free-project";

it("binds a Gemini key to its Google project and rechecks that billing is unlinked before use", async () => {
  const keys = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true, ["sign", "verify"],
  );
  const encoded = Buffer.from(await crypto.subtle.exportKey("pkcs8", keys.privateKey)).toString("base64");
  let billing: unknown = { projectId: "free-project", billingEnabled: false };
  const fetcher = vi.fn(async (input: URL | Request | string, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === "oauth2.googleapis.com") {
      expect(String(init?.body)).toContain("assertion=");
      return Response.json({ access_token: "test-google-token", expires_in: 3600 });
    }
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-google-token");
    if (url.hostname === "apikeys.googleapis.com") {
      expect(url.searchParams.get("keyString")).toBe("fake-gemini-key");
      return Response.json({ parent: "projects/123/locations/global", name: "projects/123/locations/global/keys/one" });
    }
    if (url.hostname === "cloudresourcemanager.googleapis.com") {
      expect(url.pathname).toBe("/v3/projects/123");
      return Response.json({ name: "projects/123", projectId: "free-project", state: "ACTIVE" });
    }
    expect(url.pathname).toBe("/v1/projects/free-project/billingInfo");
    return Response.json(billing);
  });
  const verify = createGoogleFreeProjectVerifier(JSON.stringify({
    client_email: "verifier@example.iam.gserviceaccount.com",
    private_key: `-----BEGIN PRIVATE KEY-----\n${encoded}\n-----END PRIVATE KEY-----`,
  }), fetcher)!;
  await expect(verify("fake-gemini-key")).resolves.toBe("123");
  billing = { projectId: "free-project", billingEnabled: true };
  await expect(verify("fake-gemini-key")).resolves.toBeUndefined();
  billing = { projectId: "free-project", billingEnabled: false, billingAccountName: "billingAccounts/linked" };
  await expect(verify("fake-gemini-key")).resolves.toBeUndefined();
  billing = { billingEnabled: false, projectId: "different-project" };
  await expect(verify("fake-gemini-key")).resolves.toBeUndefined();
  expect(fetcher.mock.calls.filter(([url]) => String(url).includes("billingInfo"))).toHaveLength(4);
});

it("fails closed without a valid server verifier credential", () => {
  expect(createGoogleFreeProjectVerifier(undefined)).toBeUndefined();
  expect(createGoogleFreeProjectVerifier('{"client_email":"test"}')).toBeUndefined();
});
