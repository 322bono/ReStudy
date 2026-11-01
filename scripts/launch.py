"""One-time local setup, then an entirely offline localhost application."""

from pathlib import Path
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request
import venv
import webbrowser

ROOT = Path(__file__).resolve().parents[1]
PYTHON = ROOT / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
URL = "http://127.0.0.1:3000"


def run(args):
    result = subprocess.run([str(a) for a in args], cwd=ROOT)
    if result.returncode:
        raise RuntimeError("준비 작업이 완료되지 않았습니다. 위 오류를 확인해 주세요.")


def health():
    try:
        with urllib.request.urlopen(URL + "/api/health", timeout=1) as response:
            return json.load(response).get("app") == "RE"
    except Exception:
        return False


def open_browser():
    if os.environ.get("RE_NO_BROWSER") != "1":
        webbrowser.open(URL)


def main():
    if sys.version_info < (3, 11):
        raise RuntimeError("Python 3.11 이상이 필요합니다.")
    if health():
        open_browser()
        return
    if not PYTHON.exists():
        print(
            "로컬 실행 환경을 준비합니다. 처음 한 번은 인터넷 연결이 필요합니다.",
            flush=True,
        )
        venv.EnvBuilder(with_pip=True).create(ROOT / ".venv")
    requirements = ROOT / "requirements.txt"
    digest = hashlib.sha256(requirements.read_bytes()).hexdigest()
    marker = ROOT / ".venv" / "re-requirements.sha256"
    if not marker.exists() or marker.read_text() != digest:
        expected = [
            line.strip().split("==", 1)
            for line in requirements.read_text().splitlines()
            if "==" in line and not line.startswith("#")
        ]
        local_check = subprocess.run(
            [
                str(PYTHON),
                "-c",
                "import importlib.metadata as m,json,sys; expected=json.loads(sys.argv[1]); sys.exit(0 if all(m.version(n)==v for n,v in expected) else 1)",
                json.dumps(expected),
            ],
            cwd=ROOT,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        if local_check.returncode:
            run([PYTHON, "-m", "pip", "install", "-r", requirements])
        marker.write_text(digest)
    # This is first-time dependency setup only; a prepared installation stays offline.
    if os.name == "nt" and not os.environ.get("TESSERACT_CMD"):
        from setup_ocr import install

        install()
    inputs = [
        ROOT / "package-lock.json",
        ROOT / "main.tsx",
        ROOT / "index.html",
        ROOT / "vite.config.ts",
        ROOT / "frontend.css",
        ROOT / "app" / "globals.css",
        *list((ROOT / "components").glob("*.tsx")),
        *list((ROOT / "lib").glob("*.ts")),
    ]
    index = ROOT / "dist" / "index.html"
    if not index.exists() or any(
        p.exists() and p.stat().st_mtime > index.stat().st_mtime for p in inputs
    ):
        npm = shutil.which("npm.cmd" if os.name == "nt" else "npm")
        if not npm:
            raise RuntimeError(
                "첫 화면 빌드에는 Node.js 22.12 이상이 필요합니다. 설치 후 다시 실행해 주세요."
            )
        lock = ROOT / "package-lock.json"
        lock_digest = hashlib.sha256(lock.read_bytes()).hexdigest()
        node_marker = ROOT / "node_modules" / ".re-lock.sha256"
        if not node_marker.exists() or node_marker.read_text() != lock_digest:
            run([npm, "ci"])
            node_marker.write_text(lock_digest)
        run([npm, "run", "build"])
    print("RE를 시작합니다. 이 창을 닫으면 학습 서버가 종료됩니다.", flush=True)
    process = subprocess.Popen(
        [
            str(PYTHON),
            "-m",
            "uvicorn",
            "backend.main:app",
            "--host",
            "127.0.0.1",
            "--port",
            "3000",
        ],
        cwd=ROOT,
    )
    try:
        for _ in range(100):
            if process.poll() is not None:
                raise RuntimeError(
                    "서버가 시작되지 않았습니다. 3000번 포트를 확인해 주세요."
                )
            if health():
                open_browser()
                break
            time.sleep(0.1)
        process.wait()
    except KeyboardInterrupt:
        pass
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)
