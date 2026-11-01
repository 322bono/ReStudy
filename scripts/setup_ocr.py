"""Prepare verified, portable Windows OCR files once. No installer or admin access.

Runtime PDF processing never imports this module or downloads anything.
Sources: official Tesseract Windows provider, official tessdata_fast, official 7-Zip.
"""

from pathlib import Path
import hashlib
import os
import subprocess
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
TARGET = ROOT / "tools" / "tesseract"
PACKAGES = {
    "7zr.exe": (
        "https://github.com/ip7z/7zip/releases/download/26.05/7zr.exe",
        "9bf582b894dfa665f852d7e9112b02290a1c303c2d95a21fcdc41ffcb03143b7",
    ),
    "7zip.exe": (
        "https://github.com/ip7z/7zip/releases/download/26.05/7z2605-x64.exe",
        "fd99e86f57d8f429ef5ed045bf98315af962e2309b0f1ba87a147a44c71647d0",
    ),
    "tesseract.exe": (
        "https://github.com/UB-Mannheim/tesseract/releases/download/v5.4.0.20240606/tesseract-ocr-w64-setup-5.4.0.20240606.exe",
        "c885fff6998e0608ba4bb8ab51436e1c6775c2bafc2559a19b423e18678b60c9",
    ),
    "kor.traineddata": (
        "https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/main/kor.traineddata",
        "6b85e11d9bbf07863b97b3523b1b112844c43e713df8b66418a081fd1060b3b2",
    ),
}


def ready(target=TARGET):
    return all(
        (target / name).is_file()
        for name in [
            "tesseract.exe",
            "tessdata/eng.traineddata",
            "tessdata/kor.traineddata",
        ]
    )


def download(name, folder):
    url, expected = PACKAGES[name]
    path = folder / name
    with urllib.request.urlopen(url, timeout=60) as response:
        data = response.read()
    if hashlib.sha256(data).hexdigest() != expected:
        raise RuntimeError(f"OCR 준비 파일의 검증 값이 다릅니다: {name}")
    path.write_bytes(data)
    return path


def install(target=TARGET):
    target = Path(target).resolve()
    if ready(target):
        return
    if os.name != "nt":
        raise RuntimeError("이 OCR 준비 도구는 Windows x64용입니다.")
    print("스캔 문서를 위한 로컬 한국어 OCR을 한 번 준비합니다.", flush=True)
    target.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="re-ocr-") as folder:
        work = Path(folder).resolve()
        extractor = download("7zr.exe", work)
        archive = download("7zip.exe", work)
        bundle = download("tesseract.exe", work)
        language = download("kor.traineddata", work)
        for command in [
            [extractor, "x", archive, f"-o{work / '7zip'}", "-y"],
            [work / "7zip/7z.exe", "x", bundle, f"-o{target}", "-y"],
        ]:
            result = subprocess.run(
                [str(a) for a in command],
                capture_output=True,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            # 7-Zip may return 1 for the verified NSIS executable's trailing data.
            if result.returncode not in (0, 1):
                raise RuntimeError("로컬 OCR 압축을 풀지 못했습니다.")
        (target / "tessdata/kor.traineddata").write_bytes(language.read_bytes())
    if not ready(target):
        raise RuntimeError("로컬 OCR 실행 파일을 준비하지 못했습니다.")
    subprocess.run(
        [str(target / "tesseract.exe"), "--list-langs"],
        check=True,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )


if __name__ == "__main__":
    install()
