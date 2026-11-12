import { lazy, Suspense, useEffect, useState, type FormEvent } from "react";
const RestudyApp = lazy(() => import("../components/app"));
import Login from "./pages/Login";
const Settings = lazy(() => import("./pages/Settings"));
const MemberAdmin = lazy(() => import("./pages/MemberAdmin"));
import type { AccountAccess } from "./domain/account-access";
import { Button } from "../components/ui";
import {
  configured,
  edgeCall,
  getSupabase,
  login,
  logout,
} from "./services/supabase";
import { clearAssetCache, cloudApi, settingsTransport } from "./services/api";

import { clearOwnerCache } from "./services/cache";
import "./styles/study-content.css";

function Bootstrap({ onReady }: { onReady: () => void }) {
  const [username, setUsername] = useState(""),
    [password, setPassword] = useState(""),
    [confirm, setConfirm] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const token =
    new URLSearchParams(location.hash.split("?")[1] || "").get("token") || "";
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (password !== confirm) {
      setError("비밀번호가 일치하지 않습니다.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await edgeCall("auth-helpers", {
        action: "bootstrap",
        token,
        username,
        password,
      });
      await login(username, password, true);
      location.hash = "";
      onReady();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPassword("");
      setConfirm("");
      setBusy(false);
    }
  }
  return (
    <main className="cloud-login">
      <form className="cloud-login-card" onSubmit={submit}>
        <h1>RE:STUDY</h1>
        <p>개인 계정 만들기</p>
        <label>
          아이디
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            pattern="[a-zA-Z0-9_-]{3,32}"
            required
          />
        </label>
        <label>
          비밀번호
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            minLength={12}
            required
          />
        </label>
        <label>
          비밀번호 확인
          <input
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
            minLength={12}
            required
          />
        </label>
        <small>영문 아이디 3~32자 · 비밀번호 12자 이상</small>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <Button type="submit" busy={busy}>
          계정 만들기
        </Button>
      </form>
    </main>
  );
}
export default function App() {
  const [user, setUser] = useState<string | null | undefined>(),
    [accountPage, setAccountPage] = useState(location.hash),
    [error, setError] = useState("");
  const [permission, setPermission] = useState<{ user: string; access?: AccountAccess; error?: string }>();
  const settings = accountPage === "#settings";
  const members = accountPage === "#members";
  const access = permission?.user === user ? permission?.access : undefined;
  function accountRoute(hash: string) {
    location.hash = hash;
    setAccountPage(hash ? `#${hash}` : "");
  }
  useEffect(()=>{
    const sync=()=>setAccountPage(location.hash);
    window.addEventListener('hashchange',sync);
    return()=>window.removeEventListener('hashchange',sync);
  },[]);
  useEffect(() => {
    if (!configured) {
      setUser(null);
      return;
    }
    let alive = true;
    let previousOwner:string|null|undefined;
    const client = getSupabase();
    client.auth.getSession().then(({ data }) => {
      if (alive&&previousOwner===undefined){previousOwner=data.session?.user.id||null;setUser(previousOwner);}
    });
    const {
      data: { subscription },
    } = client.auth.onAuthStateChange((_event, session) => {
      const nextOwner=session?.user.id||null;
      // Token refresh keeps the same owner. Revoking its live PDF blob URLs
      // here used to break an active viewer/export in Safari.
      if(previousOwner!==nextOwner)clearAssetCache();
      previousOwner=nextOwner;
      if (alive) setUser(nextOwner);
    });
    return () => {
      alive = false;
      subscription.unsubscribe();
    };
  }, []);
  useEffect(() => {
    if (!user) return;
    let current = true;
    let lastLoad = 0;
    const load = () => {
      if (Date.now() - lastLoad < 5000) return;
      lastLoad = Date.now();
      cloudApi<AccountAccess>("account/access").then(
        (access) => { if (current) setPermission({ user, access }); },
        (error) => {
          if (current) setPermission((previous) =>
            previous?.user === user && previous.access && !/사용이 중지된 계정|다시 로그인/.test(error.message)
              ? previous : { user, error: error.message });
        },
      );
    };
    load();
    const visible = () => { if (!document.hidden) load(); };
    document.addEventListener("visibilitychange", visible);
    return () => {
      current = false;
      document.removeEventListener("visibilitychange", visible);
    };
  }, [user]);
  useEffect(() => {
    if(!user)return;
    let alive=true,timer:ReturnType<typeof setTimeout>|undefined;
    const resume=async()=>{
      try{const pending=await import('./services/documents');const retry=await pending.resumePending();if(alive&&typeof retry==='number')timer=setTimeout(resume,Math.max(1000,retry));}
      catch(e){if(alive)setError((e as Error).message);}
    };
    void resume();
    return()=>{alive=false;if(timer)clearTimeout(timer);};
  }, [user]);
  if (!configured)
    return (
      <main className="cloud-login">
        <div className="cloud-login-card">
          <h1>RE:STUDY</h1>
          <p>Supabase 연결 설정이 필요합니다.</p>
          <p>실행 안내의 공개 연결 주소와 키를 설정한 뒤 다시 시작하세요.</p>
        </div>
      </main>
    );
  if (location.hash.startsWith("#setup"))
    return <Bootstrap onReady={() => accountRoute("")} />;
  if (user === undefined)
    return <main className="app-loading">학습 공간을 여는 중…</main>;
  if (!user)
    return (
      <Login
        error={error}
        onSubmit={async (username, password, remember) => {
          setError("");
          await login(username, password, remember);
        }}
      />
    );
  const signOut = async () => {
    await logout();
    if (user) await clearOwnerCache(user);
    clearAssetCache();
    setPermission(undefined);
    accountRoute("");
    setUser(null);
  };
  if (!access) return (
    <main className="app-loading">
      {permission?.user === user && permission?.error ? <>
        <p className="error" role="alert">{permission.error}</p>
        <Button variant="secondary" onClick={() => void signOut()}>로그아웃</Button>
      </> : "계정 권한을 불러오는 중…"}
    </main>
  );
  if (members && access.administrator) return (
    <Suspense fallback={<main className="app-loading">구성원 관리를 여는 중…</main>}>
      <MemberAdmin onClose={() => accountRoute("settings")} />
    </Suspense>
  );
  if (settings)
    return (
      <Suspense fallback={<main className="app-loading">설정을 여는 중…</main>}>
        <Settings
          onClose={() => accountRoute("")}
          onLogout={signOut}
          access={access}
          onMemberAdmin={access.administrator ? () => accountRoute("members") : undefined}
          transport={async (action, payload) => {
            const result = await settingsTransport(action, payload);
            if (action === "account.password" && result.signInAgain) {
              await getSupabase().auth.signOut({ scope: "local" });
              setUser(null);
              accountRoute("");
            }
            return result;
          }}
        />
      </Suspense>
    );
  return (
    <Suspense
      fallback={<main className="app-loading">학습 공간을 여는 중…</main>}
    >
      <RestudyApp
        key={user}
        userId={user}
        access={access}
        onSettings={() => accountRoute("settings")}
      />
    </Suspense>
  );
}
