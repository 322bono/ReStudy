export type FreeProjectVerifier = (geminiKey: string) => Promise<string | undefined>;

const tokenEndpoint = "https://oauth2.googleapis.com/token";
const scope = "https://www.googleapis.com/auth/cloud-platform.read-only https://www.googleapis.com/auth/cloud-billing.readonly";
const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))
  .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
const encodeJson = (value: unknown) => encode(new TextEncoder().encode(JSON.stringify(value)));

/** Google confirms the key's owning project and its current billing linkage. */
export function createGoogleFreeProjectVerifier(
  credential: string | undefined,
  transport: typeof fetch = fetch,
): FreeProjectVerifier | undefined {
  if (!credential) return;
  let clientEmail: string, privateKey: Uint8Array<ArrayBuffer>;
  try {
    const data = JSON.parse(credential);
    if (typeof data.client_email !== "string" || !data.client_email.endsWith(".gserviceaccount.com") ||
        typeof data.private_key !== "string" || !data.private_key.startsWith("-----BEGIN PRIVATE KEY-----"))
      return;
    clientEmail = data.client_email;
    privateKey = Uint8Array.from(atob(data.private_key.replace(/-----[^-]+-----|\s/g, "")), (c) => c.charCodeAt(0));
  } catch {
    return;
  }

  let token: { value: string; expiresAt: number } | undefined;
  async function accessToken(signal: AbortSignal) {
    const now = Math.floor(Date.now() / 1000);
    if (token && token.expiresAt > now + 30) return token.value;
    const signingKey = await crypto.subtle.importKey(
      "pkcs8", privateKey, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"],
    );
    const claims = encodeJson({ iss: clientEmail, scope, aud: tokenEndpoint, iat: now, exp: now + 300 });
    const unsigned = encodeJson({ alg: "RS256", typ: "JWT" }) + "." + claims;
    const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", signingKey, new TextEncoder().encode(unsigned)));
    const response = await transport(tokenEndpoint, {
      method: "POST", redirect: "error", signal,
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: unsigned + "." + encode(signature),
      }),
    });
    if (!response.ok) return;
    const body = await response.json();
    if (typeof body.access_token !== "string" || !body.access_token || !Number.isFinite(body.expires_in)) return;
    token = { value: body.access_token, expiresAt: now + Math.min(3600, body.expires_in) };
    return token.value;
  }

  return async (geminiKey) => {
    try {
      const signal = AbortSignal.timeout(7000);
      const bearer = await accessToken(signal);
      if (!bearer) return;
      const get = async (url: string | URL) => {
        const response = await transport(url, {
          headers: { Authorization: "Bearer " + bearer },
          redirect: "error",
          signal,
        });
        return response.ok ? await response.json() : undefined;
      };
      const lookupUrl = new URL("https://apikeys.googleapis.com/v2/keys:lookupKey");
      lookupUrl.searchParams.set("keyString", geminiKey);
      const key = await get(lookupUrl);
      const match = /^projects\/(\d+)(?:\/locations\/global)?$/.exec(key?.parent);
      if (!match || typeof key.name !== "string" || !key.name.startsWith("projects/" + match[1] + "/locations/global/keys/")) return;
      const project = await get("https://cloudresourcemanager.googleapis.com/v3/projects/" + match[1]);
      if (project?.name !== "projects/" + match[1] || project.state !== "ACTIVE" ||
          typeof project.projectId !== "string" || !/^[a-z0-9][a-z0-9-]{3,62}$/.test(project.projectId)) return;
      const billing = await get("https://cloudbilling.googleapis.com/v1/projects/" + project.projectId + "/billingInfo");
      if (billing?.projectId === project.projectId && billing.billingEnabled === false &&
          (billing.billingAccountName === undefined || billing.billingAccountName === "")) return match[1];
    } catch {
      // Never surface OAuth, key-lookup URLs, secrets, or response contents.
    }
  };
}

export const verifyGoogleFreeProject = createGoogleFreeProjectVerifier(
  typeof Deno === "undefined" ? undefined : Deno.env.get("RE_GOOGLE_FREE_PROJECT_VERIFIER"),
);
