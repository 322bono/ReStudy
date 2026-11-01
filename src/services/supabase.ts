import { createClient, type SupabaseClient } from "@supabase/supabase-js";
const url = import.meta.env.VITE_SUPABASE_URL,
  key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
let client: SupabaseClient | undefined;
export const configured = !!url && !!key;
export function getSupabase() {
  if (!configured)
    throw new Error(
      "Supabase 연결 설정이 필요합니다. 실행 안내를 확인해 주세요.",
    );
  if (!client)
    client = createClient(url, key, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
        storage: {
          getItem: (name) =>
            localStorage.getItem(name) || sessionStorage.getItem(name),
          setItem: (name, value) => {
            (localStorage.getItem("restudy.remember") === "0"
              ? sessionStorage
              : localStorage
            ).setItem(name, value);
          },
          removeItem: (name) => {
            localStorage.removeItem(name);
            sessionStorage.removeItem(name);
          },
        },
      },
    });
  return client;
}
export async function currentUser() {
  const {
    data: { user },
    error,
  } = await getSupabase().auth.getUser();
  if (error || !user) throw new Error("다시 로그인해 주세요.");
  return user;
}
export async function edgeCall(name: string, body: unknown) {
  const { data, error } = await getSupabase().functions.invoke(name, {
    body: body as Record<string, unknown>,
  });
  if (error) {
    let message = "요청을 처리하지 못했습니다.";
    if (error.context instanceof Response) {
      try {
        message = (await error.context.json()).error || message;
      } catch {}
    }
    throw new Error(message);
  }
  if (data?.error) throw new Error(data.error);
  return data;
}
export async function login(
  username: string,
  password: string,
  remember: boolean,
) {
  localStorage.setItem("restudy.remember", remember ? "1" : "0");
  const result = await edgeCall("auth-helpers", {
    action: "login",
    username,
    password,
  });
  const { error } = await getSupabase().auth.setSession({
    access_token: result.session.access_token,
    refresh_token: result.session.refresh_token,
  });
  if (error) throw new Error("로그인 상태를 저장하지 못했습니다.");
  return result.user;
}
export async function logout() {
  const { error } = await getSupabase().auth.signOut();
  if (error) throw new Error("로그아웃하지 못했습니다.");
}
