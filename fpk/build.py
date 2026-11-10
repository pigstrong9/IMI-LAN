#!/usr/bin/env python3
"""Build the fnOS .fpk package for IMI-LAN.

Requirements:
  - Python 3.10+
  - Go toolchain (pass --go /path/to/go or set GO)
  - patch (from Git for Windows or the OS)

The script downloads a pinned go2rtc source tarball, applies
fpk/patches/xiaomi-login.patch, cross-compiles the Linux binaries, and
assembles a deterministic .fpk with explicit file modes.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import os
import re
import shutil
import struct
import subprocess
import sys
import tarfile
import urllib.request
from pathlib import Path

GO2RTC_VERSION = "1.9.15"
GO2RTC_URL = f"https://github.com/AlexxIT/go2rtc/archive/refs/tags/v{GO2RTC_VERSION}.tar.gz"
GO2RTC_SHA256 = "08901ecc03ec031b1af13268e6e62370ba7f887b30f98866624d683e0486c084"

ROOT = Path(__file__).resolve().parent.parent
FPK = ROOT / "fpk"
BUILD = FPK / ".build"
DIST = FPK / "dist"
FIXED_MTIME = 1600000000


def info(msg: str) -> None:
    print(f"[build] {msg}", flush=True)


def die(msg: str) -> None:
    print(f"[build] ERROR: {msg}", file=sys.stderr, flush=True)
    raise SystemExit(1)


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def download_source() -> Path:
    cache = BUILD / "cache"
    cache.mkdir(parents=True, exist_ok=True)
    target = cache / f"go2rtc-{GO2RTC_VERSION}.tar.gz"
    if not target.exists() or sha256_file(target) != GO2RTC_SHA256:
        info(f"downloading go2rtc {GO2RTC_VERSION}")
        tmp = target.with_suffix(".part")
        with urllib.request.urlopen(GO2RTC_URL, timeout=120) as res, tmp.open("wb") as f:
            shutil.copyfileobj(res, f)
        got = sha256_file(tmp)
        if got != GO2RTC_SHA256:
            tmp.unlink(missing_ok=True)
            die(f"go2rtc source sha256 mismatch: {got}")
        tmp.replace(target)
    return target


def extract_source(src_tar: Path) -> Path:
    dest = BUILD / f"go2rtc-{GO2RTC_VERSION}"
    if dest.exists():
        shutil.rmtree(dest)
    dest.mkdir(parents=True)
    with tarfile.open(src_tar, "r:gz") as tf:
        members = []
        for m in tf.getmembers():
            parts = Path(m.name).parts
            if m.name.startswith("/") or ".." in parts:
                die(f"unsafe tar member: {m.name}")
            members.append(m)
        try:
            tf.extractall(dest, members=members, filter="data")
        except TypeError:  # Python < 3.12
            tf.extractall(dest, members=members)
    roots = [p for p in dest.iterdir() if p.is_dir()]
    if len(roots) != 1:
        die(f"unexpected go2rtc archive layout: {roots}")
    return roots[0]


def apply_patch(src_dir: Path) -> None:
    patch_file = FPK / "patches" / "xiaomi-login.patch"
    if not patch_file.exists():
        die(f"missing patch: {patch_file}")
    env = os.environ.copy()
    env.setdefault("LC_ALL", "C")
    for cmd in (
        ["patch", "-p1", "--forward", "--batch", "-i", str(patch_file)],
        ["git", "apply", "-p1", "--whitespace=nowarn", str(patch_file)],
    ):
        exe = shutil.which(cmd[0])
        if not exe:
            continue
        info(f"applying xiaomi login patch with {cmd[0]}")
        res = subprocess.run([exe, *cmd[1:]], cwd=src_dir, env=env,
                             capture_output=True, text=True)
        if res.returncode == 0:
            return
        print(res.stdout, res.stderr, file=sys.stderr)
    die("could not apply fpk/patches/xiaomi-login.patch")


def go_env() -> dict[str, str]:
    env = os.environ.copy()
    env.update({
        "GOOS": "linux",
        "GOARCH": "amd64",
        "CGO_ENABLED": "0",
        "GO111MODULE": "on",
        "GOTOOLCHAIN": "local",
        "GOCACHE": str(BUILD / "gocache"),
        "GOMODCACHE": str(BUILD / "gomodcache"),
    })
    env.setdefault("GOPROXY", "https://goproxy.cn,direct")
    return env


def build_go(go: str, cwd: Path, out: Path) -> None:
    info(f"building {out.name}")
    cmd = [go, "build", "-trimpath", "-ldflags", "-s -w", "-o", str(out), "."]
    res = subprocess.run(cmd, cwd=cwd, env=go_env())
    if res.returncode != 0:
        die(f"go build failed in {cwd}")


def copy_tree(src: Path, dst: Path) -> None:
    for p in src.rglob("*"):
        if p.name == ".DS_Store":
            continue
        rel = p.relative_to(src)
        target = dst / rel
        if p.is_dir():
            target.mkdir(parents=True, exist_ok=True)
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(p, target)


def stage_app(engine: Path, gateway: Path, ffmpeg: Path | None) -> Path:
    stage = BUILD / "stage"
    if stage.exists():
        shutil.rmtree(stage)
    app = stage / "app"
    (app / "server").mkdir(parents=True)
    (app / "www").mkdir(parents=True)

    copy_tree(ROOT / "web", app / "www")
    copy_tree(FPK / "app" / "ui", app / "ui")
    shutil.copy2(ROOT / "qr-login.js", app / "server" / "qr-login.js")
    shutil.copy2(engine, app / "server" / "go2rtc")
    shutil.copy2(gateway, app / "server" / "imi-gateway")

    if ffmpeg is not None:
        (app / "bin").mkdir()
        shutil.copy2(ffmpeg, app / "bin" / "ffmpeg")
        info(f"bundled ffmpeg: {ffmpeg}")
    return app


def mode_for(rel: str) -> int:
    if rel in ("server/go2rtc", "server/imi-gateway", "bin/ffmpeg"):
        return 0o755
    return 0o644


def add_path(tf: tarfile.TarFile, base: Path, arc: str, mode: int,
             data: bytes | None = None, mtime: int = FIXED_MTIME) -> None:
    ti = tarfile.TarInfo(arc)
    ti.mode = mode
    ti.uid = ti.gid = 0
    ti.uname = ti.gname = ""
    ti.mtime = mtime
    if data is not None:
        ti.size = len(data)
        tf.addfile(ti, io.BytesIO(data))
        return
    src = base / arc
    if src.is_dir():
        ti.type = tarfile.DIRTYPE
        ti.size = 0
        tf.addfile(ti)
    else:
        with src.open("rb") as f:
            ti.size = src.stat().st_size
            tf.addfile(ti, f)


def write_tgz(out: Path, entries: list[tuple[str, Path, bytes | None, int]]) -> None:
    with out.open("wb") as raw, gzip.GzipFile(fileobj=raw, mode="wb", mtime=0) as gz:
        with tarfile.open(fileobj=gz, mode="w", format=tarfile.GNU_FORMAT) as tf:
            for arc, base, data, mode in entries:
                add_path(tf, base, arc, mode, data)


def app_tgz(app: Path) -> bytes:
    entries: list[tuple[str, Path, bytes | None, int]] = []
    for dirpath, dirnames, filenames in os.walk(app):
        dirnames.sort()
        filenames.sort()
        d = Path(dirpath)
        rel_dir = d.relative_to(app).as_posix()
        if rel_dir != ".":
            entries.append((rel_dir, app, None, 0o755))
        for name in filenames:
            rel = (d / name).relative_to(app).as_posix()
            entries.append((rel, app, None, mode_for(rel)))
    buf = io.BytesIO()
    with gzip.GzipFile(fileobj=buf, mode="wb", mtime=0) as gz:
        with tarfile.open(fileobj=gz, mode="w", format=tarfile.GNU_FORMAT) as tf:
            for arc, base, data, mode in entries:
                add_path(tf, base, arc, mode, data)
    return buf.getvalue()


def manifest_text(version: str, checksum: str) -> bytes:
    text = (FPK / "manifest").read_text(encoding="utf-8")
    text = re.sub(r"^version\s*=.*$", f"version               = {version}",
                  text, count=1, flags=re.M)
    if re.search(r"^checksum\s*=.*$", text, flags=re.M):
        text = re.sub(r"^checksum\s*=.*$", f"checksum              = {checksum}",
                      text, count=1, flags=re.M)
    else:
        text = text.rstrip("\n") + f"\nchecksum              = {checksum}\n"
    return text.encode("utf-8")


def outer_entries(version: str, payload: bytes) -> list[tuple[str, Path, bytes | None, int]]:
    entries: list[tuple[str, Path, bytes | None, int]] = []
    checksum = hashlib.md5(payload).hexdigest()
    entries.append(("manifest", FPK, manifest_text(version, checksum), 0o644))
    entries.append(("app.tgz", FPK, payload, 0o644))

    for sub, mode in (("cmd", 0o755), ("config", 0o644), ("wizard", 0o644)):
        d = FPK / sub
        for p in sorted(d.rglob("*")):
            rel = p.relative_to(FPK).as_posix()
            if p.is_dir():
                entries.append((rel, FPK, None, 0o755))
            else:
                entries.append((rel, FPK, None, mode))

    for name in ("ICON.PNG", "ICON_256.PNG", "imi-lan.sc"):
        entries.append((name, FPK, None, 0o644))
    return entries


def elf_machine(path: Path) -> int:
    with path.open("rb") as f:
        head = f.read(20)
    if len(head) < 20 or head[:4] != b"\x7fELF":
        die(f"{path} is not an ELF file")
    if head[4] != 2 or head[5] != 1:
        die(f"{path} is not a 64-bit little-endian ELF")
    return struct.unpack_from("<H", head, 18)[0]


def verify(fpk_path: Path, version: str) -> None:
    info("verifying package")
    with tarfile.open(fpk_path, "r:gz") as tf:
        names = set(tf.getnames())
        for need in ("manifest", "app.tgz", "cmd/main", "config/privilege",
                     "config/resource", "ICON.PNG", "ICON_256.PNG",
                     "wizard/install", "imi-lan.sc"):
            if need not in names:
                die(f"missing {need} in fpk")
        manifest = tf.extractfile("manifest").read().decode("utf-8")
        if f"version               = {version}" not in manifest:
            die("manifest version mismatch")
        payload = tf.extractfile("app.tgz").read()
        m = re.search(r"^checksum\s*=\s*([0-9a-f]{32})\s*$", manifest, flags=re.M)
        if not m or m.group(1) != hashlib.md5(payload).hexdigest():
            die("app.tgz checksum mismatch")

    with tarfile.open(fileobj=io.BytesIO(payload), mode="r:gz") as tf:
        names = set(tf.getnames())
        for need in ("server/go2rtc", "server/imi-gateway", "server/qr-login.js",
                     "www/index.html", "www/app.js", "ui/config"):
            if need not in names:
                die(f"missing {need} in app.tgz")
        for p in tf.getmembers():
            if p.name in ("server/go2rtc", "server/imi-gateway"):
                if elf_machine_from_member(tf, p) != 62:
                    die(f"{p.name} is not x86_64")
    info("verification ok")


def elf_machine_from_member(tf: tarfile.TarFile, member: tarfile.TarInfo) -> int:
    f = tf.extractfile(member)
    head = f.read(20)
    if head[:4] != b"\x7fELF":
        die(f"{member.name} is not ELF")
    return struct.unpack_from("<H", head, 18)[0]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--go", default=os.environ.get("GO", "go"),
                    help="Go executable (default: $GO or go in PATH)")
    ap.add_argument("--version", default=None, help="override manifest version")
    ap.add_argument("--ffmpeg", default=None,
                    help="optional Linux ffmpeg binary to bundle for transcoding")
    args = ap.parse_args()

    go = shutil.which(args.go) if not Path(args.go).is_file() else args.go
    if not go:
        die("Go not found; pass --go /path/to/go or set GO")
    info(f"using Go: {go}")

    text = (FPK / "manifest").read_text(encoding="utf-8")
    version = args.version or re.search(r"^version\s*=\s*(\S+)", text, flags=re.M).group(1)
    BUILD.mkdir(parents=True, exist_ok=True)
    DIST.mkdir(parents=True, exist_ok=True)

    src_tar = download_source()
    src = extract_source(src_tar)
    apply_patch(src)

    bin_dir = BUILD / "bin"
    bin_dir.mkdir(exist_ok=True)
    engine = bin_dir / "go2rtc"
    gateway = bin_dir / "imi-gateway"
    build_go(go, src, engine)
    build_go(go, FPK / "gateway", gateway)

    if elf_machine(engine) != 62 or elf_machine(gateway) != 62:
        die("compiled binary is not x86_64")

    ffmpeg = Path(args.ffmpeg).resolve() if args.ffmpeg else None
    if ffmpeg is not None and not ffmpeg.is_file():
        die(f"ffmpeg not found: {ffmpeg}")

    app = stage_app(engine, gateway, ffmpeg)
    payload = app_tgz(app)
    entries = outer_entries(version, payload)

    out = DIST / f"imi-lan_{version}_x86.fpk"
    write_tgz(out, entries)
    digest = sha256_file(out)
    (out.with_suffix(out.suffix + ".sha256")).write_text(
        f"{digest}  {out.name}\n", encoding="utf-8")
    verify(out, version)
    info(f"built {out} ({out.stat().st_size / 1024 / 1024:.1f} MB)")
    info(f"sha256 {digest}")


if __name__ == "__main__":
    main()
