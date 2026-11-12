import { useEffect, useState, type FormEvent } from "react";
import { ArrowLeft, ExternalLink, Plus, Users } from "lucide-react";
import { Button, Dialog, Empty } from "../../components/ui";
import { defaultMemberPermissions, type MemberPermissions } from "../domain/account-access";
import { downloadPrivateFile } from "../services/private-files";
import { edgeCall } from "../services/supabase";
import "../styles/member-admin.css";

type Member = { id: string; username: string; access: MemberPermissions };
type Page<T> = { items: T[]; hasMore: boolean };
type Document = { id: string; title: string; subject: string; pages: number; mime: string; archived: boolean; created_at: string };
type Mistake = { id: string; created_at: string; resolved: boolean; archived: boolean; reviewCount: number; problem?: { number: number; page: number; document?: { title: string; subject: string } } };
type Activity = { kind: string; at: string };
type Section = "permissions" | "documents" | "mistakes" | "activity";
const sections = [
  ["permissions", "권한"], ["documents", "자료"], ["mistakes", "오답"], ["activity", "활동"],
] as const;
const fields: [keyof MemberPermissions, string][] = [
  ["active", "계정 사용"],
  ["ai", "AI 기능 사용"],
  ["personalKeys", "개인 API 키 등록·사용"],
  ["sharedKeys", "관리자 공용 API 사용"],
  ["mistakes", "오답 노트"],
  ["study", "학습하기"],
];
const activityLabels: Record<string, string> = {
  login: "최근 로그인", upload: "자료 업로드", mistake: "오답 등록",
  solve: "오답 풀이 저장", study: "학습 기록 저장", ai: "AI 호출 시도",
};
const request = (action: string, payload: Record<string, unknown> = {}) => edgeCall("member-admin", { action, ...payload });
const date = (value: string) => new Date(value).toLocaleString("ko-KR", { dateStyle: "short", timeStyle: "short" });

function Permissions({ value, onChange }: { value: MemberPermissions; onChange: (next: MemberPermissions) => void }) {
  return (
    <fieldset className="member-permissions">
      <legend>사용 권한</legend>
      {fields.map(([key, label]) => (
        <label key={key}>
          <span>{label}</span>
          <input type="checkbox" checked={value[key]} onChange={(event) => onChange({ ...value, [key]: event.target.checked })} />
        </label>
      ))}
    </fieldset>
  );
}

function AccountForm({ onClose, member, onDone }: { onClose: () => void; member?: Member; onDone: (newMember?: Member) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [access, setAccess] = useState(defaultMemberPermissions);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await request(member ? "password" : "create", member ? { memberId: member.id, password } : { username, password, access });
      setPassword("");
      onDone(member ? undefined : result);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog title={member ? `${member.username} 비밀번호 재설정` : "구성원 추가"} onClose={() => { if (!busy) onClose(); }}>
      <form className="member-form" onSubmit={submit}>
        {!member && <label>아이디<input required minLength={3} maxLength={32} pattern="[a-zA-Z0-9_\-]{3,32}" autoCapitalize="none" autoComplete="off" value={username} onChange={(e) => setUsername(e.target.value)} /></label>}
        <label>{member ? "새 비밀번호" : "초기 비밀번호"}<input required minLength={12} maxLength={72} type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} /><small>12자 이상</small></label>
        {!member && <Permissions value={access} onChange={setAccess} />}
        {error && <p className="error" role="alert">{error}</p>}
        <div className="member-actions">
          <Button type="button" variant="secondary" disabled={busy} onClick={onClose}>취소</Button>
          <Button type="submit" busy={busy}>{member ? "재설정" : "계정 만들기"}</Button>
        </div>
      </form>
    </Dialog>
  );
}

function MemberDetail({ member, onUpdate }: { member: Member; onUpdate: (member: Member) => void }) {
  const [section, setSection] = useState<Section>("permissions");
  const [draft, setDraft] = useState(member.access);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setNotice("");
    setError("");
    try {
      const { access } = await request("permissions", { memberId: member.id, access: draft });
      setDraft(access);
      onUpdate({ ...member, access });
      setNotice("권한을 저장했습니다.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <section className="panel member-detail">
      <header><h2>{member.username}</h2><span>{member.access.active ? "사용 중" : "중지"}</span></header>
      <nav className="member-tabs" aria-label="구성원 정보">
        {sections.map(([key, label]) => <Button key={key} variant="ghost" aria-pressed={section === key} onClick={() => setSection(key)}>{label}</Button>)}
      </nav>
      {section === "permissions" ? (
        <form className="member-form" onSubmit={save}>
          <Permissions value={draft} onChange={setDraft} />
          <p className="muted">공용 API의 요청 한도는 해당 키를 쓰는 계정끼리 공유합니다.</p>
          {error && <p className="error" role="alert">{error}</p>}
          {notice && <p role="status">{notice}</p>}
          <div className="member-actions">
            <Button type="button" variant="secondary" onClick={() => setPasswordOpen(true)}>비밀번호 재설정</Button>
            <Button type="submit" busy={saving}>권한 저장</Button>
          </div>
        </form>
      ) : <MemberRecords key={section} section={section} memberId={member.id} />}
      {passwordOpen && <AccountForm member={member} onClose={() => setPasswordOpen(false)} onDone={() => { setPasswordOpen(false); setNotice("비밀번호를 재설정했습니다."); }} />}
    </section>
  );
}

function MemberRecords({ section, memberId }: { section: Exclude<Section, "permissions">; memberId: string }) {
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<Page<Document | Mistake | Activity>>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  const [original, setOriginal] = useState<{ id: string; url: string; title: string; mime: string }>();
  const [preview, setPreview] = useState(false);
  const [opening, setOpening] = useState("");
  useEffect(() => {
    let current = true;
    setBusy(true);
    setError("");
    request(section, { memberId, offset }).then((result) => {
      if (current) setData(result);
    }).catch((e) => { if (current) setError(e.message); })
      .finally(() => { if (current) setBusy(false); });
    return () => { current = false; };
  }, [memberId, section, offset]);
  useEffect(() => () => { if (original) URL.revokeObjectURL(original.url); }, [original]);
  const [load, setLoad] = useState<{ id: string }>();
  useEffect(() => {
    if (!load) return;
    const controller = new AbortController();
    const open = async () => {
      try {
        const file = await request("original", { memberId, documentId: load.id });
        if (controller.signal.aborted) return;
        const links = new Map<string, string>(file.links.map((entry: { path: string; url: string }) => [entry.path, entry.url]));
        const blob = await downloadPrivateFile(file.path, file.reference, async (path) => {
          const link = links.get(path);
          if (!link) throw new Error("분할 원본을 찾을 수 없습니다.");
          const response = await fetch(link, { signal: controller.signal, credentials: "omit" });
          if (!response.ok) throw new Error("분할 원본을 열 수 없습니다.");
          return response.blob();
        }, (path) => {
          if (typeof path !== "string" || (!links.has(path) && path !== file.path)) throw new Error("원본 경로를 확인해 주세요.");
          return path;
        });
        if (!controller.signal.aborted) {
          const mime = /^(application\/pdf|image\/(png|jpeg|webp|gif))$/.test(file.mime) ? file.mime : "application/octet-stream";
          setOriginal({ id: load.id, url: URL.createObjectURL(blob.slice(0, blob.size, mime)), title: file.title, mime });
          setPreview(true);
        }
      } catch (e) {
        if (!controller.signal.aborted) setError((e as Error).message);
      } finally {
        if (!controller.signal.aborted) setOpening("");
      }
    };
    void open();
    return () => controller.abort();
  }, [memberId, load]);
  return (
    <div className="member-records">
      {section === "activity" && <p className="muted">최근 90일의 저장 기록과 마지막 로그인을 표시합니다.</p>}
      {error && <p className="error" role="alert">{error}</p>}
      {busy ? <p role="status">불러오는 중…</p> : data && (
        <>
          {!data.items.length ? <p className="muted">아직 기록이 없습니다.</p> : (
            <ul className="member-record-list">
              {data.items.map((item, index) => {
                if (section === "documents") {
                  const doc = item as Document;
                  return <li key={doc.id}><span><strong>{doc.title}</strong><small>{doc.subject} · {doc.pages || "–"}쪽 · {date(doc.created_at)}{doc.archived ? " · 보관됨" : ""}</small></span>
                    <Button variant="secondary" busy={opening === doc.id} disabled={!!opening} onClick={() => {
                      setError("");
                      if (original?.id === doc.id) { setPreview(true); return; }
                      setOpening(doc.id);
                      setLoad({ id: doc.id });
                    }}>원본 열기</Button>
                  </li>;
                }
                if (section === "mistakes") {
                  const wrong = item as Mistake;
                  return <li key={wrong.id}><span><strong>{wrong.problem?.document?.title || "자료"} · {wrong.problem?.number || "–"}번</strong><small>PDF {wrong.problem?.page || "–"}쪽 · {date(wrong.created_at)} · 재풀이 {wrong.reviewCount ?? 0}회</small></span><span>{wrong.archived ? "보관됨" : wrong.resolved ? "맞힘" : "다시 풀기"}</span></li>;
                }
                const activity = item as Activity;
                return <li key={`${activity.at}-${index}`}><strong>{activityLabels[activity.kind] || "학습 활동"}</strong><time dateTime={activity.at}>{date(activity.at)}</time></li>;
              })}
            </ul>
          )}
          {(offset > 0 || data.hasMore) && <div className="member-actions">
            <Button variant="secondary" disabled={offset === 0} onClick={() => setOffset(offset - 20)}>이전</Button>
            <Button variant="secondary" disabled={!data.hasMore} onClick={() => setOffset(offset + 20)}>다음</Button>
          </div>}
        </>
      )}
      {preview && original && <Dialog title={original.title} wide onClose={() => setPreview(false)}>
        <div className="member-original">
          {original.mime === "application/pdf" ? <iframe title={original.title} src={original.url} /> :
            /^image\/(png|jpeg|webp|gif)$/.test(original.mime) ? <img alt={original.title} src={original.url} /> : null}
          {original.mime === "application/octet-stream" ?
            <a className="button secondary" href={original.url} download={original.title}>파일 내려받기</a> :
            <a className="button secondary" href={original.url} target="_blank" rel="noreferrer">새 탭에서 열기 <ExternalLink size={14} /></a>}
        </div>
      </Dialog>}
    </div>
  );
}

export default function MemberAdmin({ onClose }: { onClose: () => void }) {
  const [members, setMembers] = useState<Page<Member>>();
  const [selected, setSelected] = useState<Member>();
  const [creating, setCreating] = useState(false);
  const [offset, setOffset] = useState(0);
  const [version, setVersion] = useState(0);
  const [error, setError] = useState("");
  useEffect(() => {
    let current = true;
    request("list", { offset }).then((result) => {
      if (current) setMembers(result);
    }).catch((e) => { if (current) setError(e.message); });
    return () => { current = false; };
  }, [offset, version]);
  return (
    <main className="member-admin">
      <Button variant="ghost" onClick={onClose}><ArrowLeft size={16} /> 설정</Button>
      <div className="page-heading">
        <h1>구성원 관리</h1>
        <Button onClick={() => setCreating(true)}><Plus size={17} /> 구성원 추가</Button>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="member-layout">
        <section className="panel member-directory">
          <h2><Users size={17} /> 구성원</h2>
          {!members && !error && <p role="status">불러오는 중…</p>}
          {members?.items.map((member) => (
            <button key={member.id} aria-pressed={selected?.id === member.id} onClick={() => setSelected(member)}>
              <strong>{member.username}</strong><small>{member.access.active ? "사용 중" : "중지"}</small>
            </button>
          ))}
          {members?.items.length === 0 && <p className="muted">등록된 구성원이 없습니다.</p>}
          {(offset > 0 || members?.hasMore) && <div className="member-actions">
            <Button variant="ghost" disabled={!offset} onClick={() => setOffset(offset - 20)}>이전</Button>
            <Button variant="ghost" disabled={!members?.hasMore} onClick={() => setOffset(offset + 20)}>다음</Button>
          </div>}
        </section>
        {selected ? <MemberDetail key={selected.id} member={selected} onUpdate={(member) => {
          setSelected(member);
          setMembers((current) => current && { ...current, items: current.items.map((item) => item.id === member.id ? member : item) });
        }} /> : <div className="panel"><Empty title="관리할 구성원을 선택하세요" /></div>}
      </div>
      {creating && <AccountForm onClose={() => setCreating(false)} onDone={(member) => {
        setCreating(false);
        setSelected(member);
        setError("");
        setVersion(version + 1);
      }} />}
    </main>
  );
}
