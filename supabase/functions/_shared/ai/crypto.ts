export type Provider = "nvidia" | "gemini";
export type EncryptedKey = { ciphertext: string; iv: string; key_version: number };
const encoder = new TextEncoder();
export function encode64(bytes: Uint8Array): string {
  let text = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) text += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(text);
}
function decode64(text: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(text), (value) => value.charCodeAt(0));
}
async function masterKey(value: string): Promise<CryptoKey> {
  let bytes: Uint8Array<ArrayBuffer>;
  try { bytes = decode64(value); } catch { throw new Error("credential_master_key_invalid"); }
  if (bytes.length !== 32) throw new Error("credential_master_key_invalid");
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}
function binding(userId: string, provider: Provider, version: number): Uint8Array<ArrayBuffer> {
  return encoder.encode(JSON.stringify(["RE:STUDY", userId, provider, version]));
}
export async function encryptKey(secret: string, userId: string, provider: Provider, master: string): Promise<EncryptedKey> {
  if (!secret || secret.length > 4096 || /[\r\n]/.test(secret)) throw new Error("credential_invalid");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: binding(userId, provider, 1), tagLength: 128 }, await masterKey(master), encoder.encode(secret));
  return { ciphertext: encode64(new Uint8Array(encrypted)), iv: encode64(iv), key_version: 1 };
}
export async function decryptKey(record: EncryptedKey, userId: string, provider: Provider, master: string): Promise<string> {
  if (record.key_version !== 1) throw new Error("credential_version_unsupported");
  const iv = decode64(record.iv);
  if (iv.length !== 12) throw new Error("credential_invalid");
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: binding(userId, provider, record.key_version), tagLength: 128 }, await masterKey(master), decode64(record.ciphertext));
    return new TextDecoder().decode(plain);
  } catch { throw new Error("credential_decryption_failed"); }
}
