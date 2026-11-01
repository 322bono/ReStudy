import { useId, useRef, useState, type FormEvent } from "react";
import { Button } from "../../components/ui";
import "../styles/cloud.css";

export type LoginProps = {
  busy?: boolean;
  error?: string;
  onSubmit: (
    username: string,
    password: string,
    remember: boolean,
  ) => Promise<void> | void;
};

export default function Login({ busy = false, error, onSubmit }: LoginProps) {
  const id = useId();
  const submitting = useRef(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(false);
  const [pending, setPending] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const message = error || submitError;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || submitting.current) return;
    submitting.current = true;
    setPending(true);
    setSubmitError("");
    try {
      await onSubmit(username.trim(), password, remember);
    } catch (cause) {
      setSubmitError(
        cause instanceof Error
          ? cause.message
          : "로그인하지 못했습니다. 다시 시도해 주세요.",
      );
    } finally {
      setPassword("");
      submitting.current = false;
      setPending(false);
    }
  }

  return (
    <main className="cloud-login">
      <div className="cloud-login-card">
        <h1 className="cloud-wordmark">
          RE<span>:</span>STUDY
        </h1>
        <form className="cloud-form" onSubmit={submit} aria-label="로그인">
          <label className="cloud-field" htmlFor={`${id}-username`}>
            <span>아이디</span>
            <input
              id={`${id}-username`}
              name="username"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              disabled={busy || pending}
              required
              autoFocus
            />
          </label>
          <label className="cloud-field" htmlFor={`${id}-password`}>
            <span>비밀번호</span>
            <input
              id={`${id}-password`}
              name="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={busy || pending}
              aria-describedby={message ? `${id}-error` : undefined}
              required
            />
          </label>
          <label className="cloud-check" htmlFor={`${id}-remember`}>
            <input
              id={`${id}-remember`}
              type="checkbox"
              checked={remember}
              onChange={(event) => setRemember(event.target.checked)}
              disabled={busy || pending}
            />
            <span>로그인 상태 유지</span>
          </label>
          {message ? (
            <p id={`${id}-error`} className="cloud-feedback error" role="alert">
              {message}
            </p>
          ) : null}
          <Button
            type="submit"
            busy={busy || pending}
            disabled={!username.trim() || !password}
          >
            로그인
          </Button>
        </form>
      </div>
    </main>
  );
}
