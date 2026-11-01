import { useEffect, useState } from "react";
import { assetUrl, download } from "../src/services/api";
export function SecureImage({
  path,
  ...props
}: React.ImgHTMLAttributes<HTMLImageElement> & { path: string }) {
  const [url, setUrl] = useState(""),
    [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    setUrl("");
    setFailed(false);
    assetUrl(path)
      .then((u) => {
        if (alive) setUrl(u);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [path]);
  return url ? (
    <img {...props} src={url} />
  ) : props.hidden ? null : failed ? (
    <span role="status">원본을 열 수 없습니다</span>
  ) : (
    <span className="asset-loading" role="status">
      원본 준비 중…
    </span>
  );
}
export function SecureLink({
  path,
  children,
  ...props
}: React.AnchorHTMLAttributes<HTMLAnchorElement> & { path: string }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    let alive = true;
    assetUrl(path)
      .then((u) => {
        if (alive) setUrl(u);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [path]);
  return (
    <a {...props} href={url || undefined} aria-disabled={!url}>
      {children}
    </a>
  );
}
export function DownloadLink({
  path,
  children,
  ...props
}: React.AnchorHTMLAttributes<HTMLAnchorElement> & { path: string }) {
  const [error, setError] = useState("");
  return (
    <>
      <a
        {...props}
        href="#"
        onClick={async (e) => {
          e.preventDefault();
          setError("");
          try {
            await download(path);
          } catch (e) {
            setError((e as Error).message);
          }
        }}
      >
        {children}
      </a>
      {error && (
        <span role="alert" className="error">
          {error}
        </span>
      )}
    </>
  );
}
