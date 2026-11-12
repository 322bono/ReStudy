import { accountAccess, accessColumns } from "./access.ts";
import { AppError, type context } from "./context.ts";
import { defaultMemberPermissions, type MemberPermissions } from "../../../src/domain/account-access.ts";

type Context = Awaited<ReturnType<typeof context>>;
const pageSize = 20;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
function checked<T>(response: { data: T; error: unknown }): T {
  if (response.error) throw new AppError("구성원 정보를 처리하지 못했습니다.", 500);
  return response.data;
}
function password(value: unknown): string {
  if (typeof value !== "string" || value.length < 12 || new TextEncoder().encode(value).length > 72) {
    throw new AppError("비밀번호는 12자 이상, UTF-8 72바이트 이하로 입력해 주세요.");
  }
  return value;
}
function permissions(value: unknown): MemberPermissions {
  const keys = Object.keys(defaultMemberPermissions) as (keyof MemberPermissions)[];
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AppError("계정 권한을 확인해 주세요.");
  const raw = value as Record<string, unknown>;
  if (keys.some((key) => typeof raw[key] !== "boolean")) throw new AppError("계정 권한을 확인해 주세요.");
  return Object.fromEntries(keys.map((key) => [key, raw[key]])) as MemberPermissions;
}
function page<T>(rows: T[] | null) {
  return { items: (rows ?? []).slice(0, pageSize), hasMore: (rows?.length ?? 0) > pageSize };
}
function text(value: unknown): string {
  return typeof value === "string" ? value.slice(0, 240) : "";
}

export async function manageMembers(ctx: Context, body: Record<string, unknown>) {
  if (!ctx.access.administrator) throw new AppError("관리자만 이용할 수 있습니다.", 403);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new AppError("요청을 확인해 주세요.");
  const admin = ctx.admin;
  const offset = body.offset ?? 0;
  if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0 || offset > 10000) {
    throw new AppError("목록 위치를 확인해 주세요.");
  }
  if (body.action === "list") {
    const aliases = checked(await admin.from("login_aliases").select("user_id,username")
      .neq("user_id", ctx.user.id).order("username").range(offset, offset + pageSize));
    const rows = page(aliases);
    if (!rows.items.length) return rows;
    const access = checked(await admin.from("restudy_account_access").select(`user_id,${accessColumns}`)
      .in("user_id", rows.items.map((item) => item.user_id)));
    const byId = new Map((access ?? []).map(({ user_id, ...row }) => [user_id, accountAccess(row)]));
    return {
      ...rows,
      items: rows.items.map(({ user_id, username }) => ({ id: user_id, username, access: byId.get(user_id) ?? accountAccess() })),
    };
  }
  if (body.action === "create") {
    const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
    if (!/^[a-z0-9_-]{3,32}$/.test(username) || username === "bono") {
      throw new AppError("아이디는 영문 소문자·숫자·밑줄·하이픈으로 3~32자 입력해 주세요.");
    }
    const access = permissions(body.access);
    const newPassword = password(body.password);
    const alias = checked(await admin.from("login_aliases").select("user_id").eq("username", username).maybeSingle());
    if (alias) throw new AppError("이미 사용 중인 아이디입니다.", 409);
    const email = `${crypto.randomUUID()}@accounts.restudy.invalid`;
    const created = await admin.auth.admin.createUser({ email, password: newPassword, email_confirm: true });
    const user = created.data.user;
    if (created.error || !user) throw new AppError("계정을 만들지 못했습니다. 비밀번호 조건을 확인해 주세요.", 422);
    const saved = await admin.rpc("provision_restudy_member", { p_id: user.id, p_username: username, p_email: email, p_access: access });
    if (saved.error) {
      if (/^[0-9A-Z]{5}$/.test(saved.error.code)) await admin.auth.admin.deleteUser(user.id);
      if (saved.error.code === "23505") throw new AppError("이미 사용 중인 아이디입니다.", 409);
      throw new AppError("구성원 계정을 저장하지 못했습니다. 목록을 확인하고 다시 시도해 주세요.", 500);
    }
    return { id: user.id, username, access };
  }

  const id = body.memberId;
  if (typeof id !== "string" || !uuid.test(id) || id === ctx.user.id) {
    throw new AppError("관리할 구성원을 선택해 주세요.");
  }
  const member = checked(await admin.from("restudy_account_access").select("user_id,administrator").eq("user_id", id).maybeSingle());
  if (!member || member.administrator) throw new AppError("구성원 계정을 찾을 수 없습니다.", 404);
  if (body.action === "permissions") {
    const access = permissions(body.access);
    const changed = checked(await admin.from("restudy_account_access").update({
      active: access.active, ai: access.ai, personal_keys: access.personalKeys,
      shared_keys: access.sharedKeys, mistakes: access.mistakes, study: access.study,
    }).eq("user_id", id).eq("administrator", false).select(accessColumns).single());
    return { access: accountAccess(changed) };
  }
  if (body.action === "password") {
    const result = await admin.auth.admin.updateUserById(id, { password: password(body.password) });
    if (result.error) throw new AppError("비밀번호를 재설정하지 못했습니다.", 422);
    return { updated: true };
  }
  if (body.action === "activity") {
    return page(checked(await admin.rpc("restudy_member_activity", { p_id: id, p_offset: offset })));
  }
  if (body.action === "documents") {
    return page(checked(await admin.from("documents")
      .select("id,title,subject,kind,status,created_at,pages:data->pageCount,mime:data->>mime,archived:data->archived")
      .eq("user_id", id).order("created_at", { ascending: false }).order("id").range(offset, offset + pageSize)));
  }
  if (body.action === "mistakes") {
    const result = checked(await admin.from("wrong_answers")
      .select("id,created_at,resolved:data->resolved,archived:data->archived,reviewCount:data->reviewCount,problem:problems(number,page,document:documents(title,subject))")
      .eq("user_id", id).order("created_at", { ascending: false }).order("id").range(offset, offset + pageSize));
    return page(result);
  }
  if (body.action === "original") {
    if (typeof body.documentId !== "string" || !uuid.test(body.documentId)) throw new AppError("자료를 선택해 주세요.");
    const document = checked(await admin.from("documents")
      .select("id,title,path:data->>originalPath,reference:data->originalStorage,mime:data->>mime")
      .eq("user_id", id).eq("id", body.documentId).maybeSingle());
    if (!document) throw new AppError("자료를 찾을 수 없습니다.", 404);
    const { path, reference } = document;
    const prefix = `${id}/${document.id}/source/`;
    if (typeof path !== "string" || !path.startsWith(prefix) || !/^original\.[a-z0-9]{1,12}$/i.test(path.slice(prefix.length))) {
      throw new AppError("원본 파일 경로를 확인할 수 없습니다.", 404);
    }
    const invalid = () => new AppError("분할 원본 파일 정보를 확인할 수 없습니다.", 404);
    const mime = text(document.mime);
    let manifest;
    if (reference != null) {
      if (typeof reference !== "object" || Array.isArray(reference) || reference.version !== 1 ||
          !Array.isArray(reference.parts) || !reference.parts.length || reference.parts.length > 1000) throw invalid();
      const parts = reference.parts.map((part, index) => {
        const expected = `${path}.parts/${String(index).padStart(6, "0")}`;
        if (!part || typeof part !== "object" || Array.isArray(part) || part.path !== expected ||
            typeof part.bytes !== "number" || !Number.isSafeInteger(part.bytes) || part.bytes < 1 || part.bytes > 5 * 1024 * 1024 ||
            typeof part.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(part.sha256)) throw invalid();
        return { path: expected, bytes: part.bytes, sha256: part.sha256 };
      });
      const bytes = parts.reduce((sum, part) => sum + part.bytes, 0);
      if (bytes !== reference.bytes) throw invalid();
      manifest = { version: 1, bytes, mime, parts };
    }
    const paths = manifest?.parts.map((part) => part.path) ?? [path];
    const links = checked(await admin.storage.from("study-files").createSignedUrls(paths, 180));
    if (!links || links.length !== paths.length || links.some((link) => !link.signedUrl || link.error)) {
      throw new AppError("저장된 원본을 열 수 없습니다.", 404);
    }
    return { path, reference: manifest, mime, title: text(document.title), links: links.map((link) => ({ path: link.path, url: link.signedUrl })) };
  }
  throw new AppError("지원하지 않는 구성원 관리 요청입니다.");
}
