import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  acquireAssetUrl,
  acquireImageAsset,
  assetCacheVersion,
  download,
  subscribeAssetCache,
  type AssetLease,
} from "../src/services/api";
export { prefetchImageAssets as prefetchSecureImages } from "../src/services/api";
export function SecureImage({
  path,
  onFailure,
  onError,
  ...props
}: React.ImgHTMLAttributes<HTMLImageElement> & {
  path: string;
  onFailure?: (error: Error) => void;
}) {
  const version = useSyncExternalStore(subscribeAssetCache, assetCacheVersion);
  const [nearViewport, setNearViewport] = useState(false);
  const placeholder = useRef<HTMLSpanElement>(null);
  const waitForViewport = props.loading === "lazy" && !nearViewport &&
    typeof IntersectionObserver !== "undefined";
  const [asset, setAsset] = useState({
    path: "",
    version: -1,
    url: "",
    failed: false,
  });
  const failureRef = useRef(onFailure);
  failureRef.current = onFailure;
  useEffect(() => {
    if (!waitForViewport || !placeholder.current) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        observer.disconnect();
        setNearViewport(true);
      }
    }, { rootMargin: "250px" });
    observer.observe(placeholder.current);
    return () => observer.disconnect();
  }, [waitForViewport]);
  useEffect(() => {
    if (waitForViewport) return;
    let alive = true;
    let lease: AssetLease | undefined;
    acquireImageAsset(path)
      .then((loaded) => {
        if (!alive) {
          loaded.release();
          return;
        }
        lease = loaded;
        setAsset({ path, version, url: loaded.url, failed: false });
      })
      .catch((error: Error) => {
        if (alive) {
          setAsset({ path, version, url: "", failed: true });
          failureRef.current?.(error);
        }
      });
    return () => {
      alive = false;
      lease?.release();
    };
  }, [path, version, waitForViewport]);
  const current = asset.path === path && asset.version === version;
  const url = current ? asset.url : "",
    failed = current && asset.failed;
  return url ? (
    <img
      {...props}
      src={url}
      onError={(event) => {
        setAsset({ path, version, url: "", failed: true });
        onError?.(event);
        failureRef.current?.(
          new Error("저장된 원본 이미지를 표시할 수 없습니다."),
        );
      }}
    />
  ) : props.hidden ? null : failed ? (
    <span role="status">원본을 열 수 없습니다</span>
  ) : (
    <span ref={placeholder} className="asset-loading" role="status">
      원본 준비 중…
    </span>
  );
}
export function SecureLink({
  path,
  children,
  onClick,
  ...props
}: React.AnchorHTMLAttributes<HTMLAnchorElement> & { path: string }) {
  const version = useSyncExternalStore(subscribeAssetCache, assetCacheVersion);
  const [asset, setAsset] = useState({ path: "", version: -1, url: "" });
  const [opening, setOpening] = useState(false),
    [error, setError] = useState("");
  const requestRef = useRef<{
    path: string;
    version: number;
    load: () => Promise<string>;
  } | null>(null);
  const original = /^\/?(?:api\/)?materials\/[^/?]+\/file$/.test(path);
  useEffect(() => {
    let alive = true;
    let lease: AssetLease | undefined;
    let pending: Promise<string> | undefined;
    const request = {
      path,
      version,
      load: () =>
        (pending ||= acquireAssetUrl(path)
          .then((loaded) => {
            if (!alive) {
              loaded.release();
              throw new Error("원본 열기를 중단했습니다.");
            }
            lease = loaded;
            setAsset({ path, version, url: loaded.url });
            return loaded.url;
          })
          .catch((reason) => {
            pending = undefined;
            throw reason;
          })),
    };
    requestRef.current = request;
    setOpening(false);
    setError("");
    // Resolving a reassembled PDF means downloading all of its chunks. Wait
    // for the original link to be used instead of slowing down page images.
    if (!original) void request.load().catch(() => {});
    return () => {
      alive = false;
      lease?.release();
      if (requestRef.current === request) requestRef.current = null;
    };
  }, [path, version, original]);
  const url = asset.path === path && asset.version === version ? asset.url : "";
  return (
    <>
      <a
        {...props}
        href={url || "#"}
        aria-disabled={opening}
        aria-busy={opening}
        onClick={async (event) => {
          onClick?.(event);
          if (event.defaultPrevented || url) return;
          event.preventDefault();
          const request = requestRef.current;
          if (
            opening ||
            !request ||
            request.path !== path ||
            request.version !== version
          )
            return;
          // Safari requires the new tab to open within the original click.
          const popup =
            props.target === "_blank"
              ? window.open("about:blank", "_blank")
              : null;
          if (popup) popup.opener = null;
          setOpening(true);
          setError("");
          try {
            const ready = await request.load();
            if (popup && !popup.closed) popup.location.replace(ready);
            else if (props.target !== "_blank") window.location.assign(ready);
            else if (!popup)
              setError("원본이 준비됐습니다. 링크를 다시 눌러 열어 주세요.");
          } catch (reason) {
            popup?.close();
            if (requestRef.current === request)
              setError((reason as Error).message);
          } finally {
            if (requestRef.current === request) setOpening(false);
          }
        }}
      >
        {opening ? "원본 준비 중…" : children}
      </a>
      {error && (
        <span className="error" role="alert">
          {error}
        </span>
      )}
    </>
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
