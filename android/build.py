#!/usr/bin/env python3
"""Build the standalone Android APK for IMI-LAN.

The APK runs the whole stack on the phone itself: go2rtc and the gateway are
cross-compiled to Linux ARM64/x86_64, stored as lib*.so in jniLibs so Android
extracts them to nativeLibraryDir, and started by the foreground service.
The web UI is copied from web/ into assets/web.

Requirements:
  - Python 3.10+
  - Go toolchain (pass --go /path/to/go or set GO)
  - JDK 17+ (pass --jdk /path/to/jdk or set JAVA_HOME)
  - Android SDK with platform 35 / build-tools 36.0.0 (SDK_DIR or
    ANDROID_HOME / ANDROID_SDK_ROOT)
  - Gradle 8.13+ (pass --gradle or set GRADLE)

Examples:
  python android/build.py
  python android/build.py --abi arm64-v8a --release
"""

from __future__ import annotations

import argparse
import importlib.util
import os
import re
import shutil
import struct
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ANDROID = ROOT / "android"
APP = ANDROID / "app"
ASSETS = APP / "src" / "main" / "assets"
JNILIBS = APP / "src" / "main" / "jniLibs"
DIST = ANDROID / "dist"

# ABI -> (GOARCH, ELF e_machine)
ABIS = {
    "arm64-v8a": ("arm64", 183),
    "x86_64": ("amd64", 62),
}


def info(msg: str) -> None:
    print(f"[android] {msg}", flush=True)


def die(msg: str) -> None:
    print(f"[android] ERROR: {msg}", file=sys.stderr, flush=True)
    raise SystemExit(1)


def load_fpk_build():
    path = ROOT / "fpk" / "build.py"
    spec = importlib.util.spec_from_file_location("fpk_build", path)
    if spec is None or spec.loader is None:
        die(f"cannot load {path}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def ensure_source(fpk) -> Path:
    """Download, extract and patch go2rtc once; reuse the patched tree."""
    src = fpk.BUILD / f"go2rtc-{fpk.GO2RTC_VERSION}" / f"go2rtc-{fpk.GO2RTC_VERSION}"
    marker = src / ".imi-patched"
    if marker.is_file():
        info(f"reusing patched go2rtc source: {src}")
        return src
    tar = fpk.download_source()
    src = fpk.extract_source(tar)
    fpk.apply_patch(src)
    marker.write_text("patched by android/build.py\n", encoding="utf-8")
    return src


def elf_machine(path: Path) -> int:
    with path.open("rb") as f:
        head = f.read(20)
    if len(head) < 20 or head[:4] != b"\x7fELF":
        die(f"{path} is not an ELF file")
    if head[4] != 2 or head[5] != 1:
        die(f"{path} is not a 64-bit little-endian ELF")
    return struct.unpack_from("<H", head, 18)[0]


def read_version() -> tuple[str, int]:
    text = (ROOT / "fpk" / "manifest").read_text(encoding="utf-8")
    m = re.search(r"^version\s*=\s*(\S+)", text, flags=re.M)
    if not m:
        die("cannot read version from fpk/manifest")
    version = m.group(1)
    parts = [int(x) for x in re.findall(r"\d+", version)[:3]]
    while len(parts) < 3:
        parts.append(0)
    code = parts[0] * 10000 + parts[1] * 100 + parts[2]
    return version, code


def stage_assets(fpk) -> None:
    web = ASSETS / "web"
    if web.exists():
        shutil.rmtree(web)
    info("copying web/ -> app/src/main/assets/web")
    fpk.copy_tree(ROOT / "web", web)
    for need in ("index.html", "app.js", "style.css"):
        if not (web / need).is_file():
            die(f"missing web/{need}")


def stage_libs(fpk, go: str, src: Path, abis: list[str]) -> None:
    if JNILIBS.exists():
        shutil.rmtree(JNILIBS)
    for abi in abis:
        goarch, machine = ABIS[abi]
        dest = JNILIBS / abi
        dest.mkdir(parents=True)
        engine = dest / "libgo2rtc.so"
        gateway = dest / "libimi-gateway.so"
        fpk.build_go(go, src, engine, goos="linux", goarch=goarch)
        fpk.build_go(go, ROOT / "fpk" / "gateway", gateway, goos="linux", goarch=goarch)
        for bin_path in (engine, gateway):
            if elf_machine(bin_path) != machine:
                die(f"{bin_path} is not {abi}")


def write_local_properties(sdk: str) -> None:
    path = ANDROID / "local.properties"
    text = "sdk.dir=" + sdk.replace("\\", "/") + "\n"
    if path.is_file() and path.read_text(encoding="utf-8") == text:
        return
    info(f"writing {path.name}")
    path.write_text(text, encoding="utf-8")


def find_sdk(explicit: str | None) -> str:
    for cand in (explicit, os.environ.get("SDK_DIR"),
                 os.environ.get("ANDROID_HOME"), os.environ.get("ANDROID_SDK_ROOT")):
        if cand and (Path(cand) / "platforms").is_dir():
            return str(Path(cand).resolve())
    default = Path(os.environ.get("LOCALAPPDATA", "")) / "Android" / "Sdk"
    if (default / "platforms").is_dir():
        return str(default)
    die("Android SDK not found; pass --sdk or set ANDROID_HOME")


def find_gradle(explicit: str | None) -> str:
    for cand in (explicit, os.environ.get("GRADLE")):
        if cand and Path(cand).is_file():
            return str(Path(cand).resolve())
    for name in ("gradle.bat", "gradle"):
        found = shutil.which(name)
        if found:
            return found
    die("Gradle not found; pass --gradle /path/to/gradle.bat or set GRADLE")


def run_gradle(gradle: str, sdk: str, jdk: str | None, tasks: list[str],
               version: str, code: int) -> None:
    env = os.environ.copy()
    env["ANDROID_HOME"] = sdk
    env["ANDROID_SDK_ROOT"] = sdk
    if jdk:
        env["JAVA_HOME"] = jdk
    env.setdefault("GRADLE_OPTS", "-Dfile.encoding=UTF-8")
    cmd = [
        gradle, "--no-daemon", "-p", str(ANDROID),
        f"-PimiVersionName={version}",
        f"-PimiVersionCode={code}",
        *tasks,
    ]
    info("running " + " ".join(cmd))
    res = subprocess.run(cmd, env=env)
    if res.returncode != 0:
        die(f"gradle {' '.join(tasks)} failed")


def collect_apks(build_type: str, abis: list[str], version: str) -> list[Path]:
    out_dir = APP / "build" / "outputs" / "apk" / build_type
    if not out_dir.is_dir():
        die(f"gradle produced no {out_dir}")
    suffix = "debug" if build_type == "debug" else "release"
    produced = sorted(out_dir.glob("*.apk"))
    if not produced:
        die(f"no APK in {out_dir}")
    DIST.mkdir(parents=True, exist_ok=True)
    results: list[Path] = []
    # app-arm64-v8a-debug.apk / app-arm64-v8a-release.apk / app-debug.apk
    for abi in abis:
        match = [p for p in produced if abi in p.name]
        if not match:
            die(f"no {abi} APK in {out_dir}")
        target = DIST / f"imi-lan_{version}_{abi.replace('-v8a', '')}_{suffix}.apk"
        shutil.copy2(match[0], target)
        verify_apk(target, abi)
        results.append(target)
    return results


def verify_apk(path: Path, abi: str) -> None:
    with zipfile.ZipFile(path) as zf:
        names = set(zf.namelist())
    engine = f"lib/{abi}/libgo2rtc.so"
    gateway = f"lib/{abi}/libimi-gateway.so"
    for need in (engine, gateway, "assets/web/index.html", "assets/go2rtc.yaml",
                 "assets/ca.pem"):
        if need not in names:
            die(f"{path.name}: missing {need}")
    size = path.stat().st_size
    info(f"{path.name}: {size / 1024 / 1024:.1f} MB, libs + web ok")


FPK = None


def main() -> None:
    global FPK
    ap = argparse.ArgumentParser(description="build the standalone Android APK")
    ap.add_argument("--go", default=os.environ.get("GO", "go"),
                    help="Go executable (default: $GO or go in PATH)")
    ap.add_argument("--gradle", default=None, help="gradle executable")
    ap.add_argument("--jdk", default=None, help="JAVA_HOME for gradle")
    ap.add_argument("--sdk", default=None, help="Android SDK directory")
    ap.add_argument("--abi", action="append", choices=sorted(ABIS),
                    help="target ABI (repeatable; default: arm64-v8a and x86_64)")
    ap.add_argument("--release", action="store_true", help="build release APK")
    ap.add_argument("--skip-native", action="store_true",
                    help="reuse existing jniLibs binaries")
    ap.add_argument("--no-clean", action="store_true",
                    help="keep app/build (faster, but the APK can grow with padding)")
    args = ap.parse_args()

    go = shutil.which(args.go) if not Path(args.go).is_file() else str(Path(args.go))
    if not go:
        die("Go not found; pass --go /path/to/go or set GO")
    info(f"using Go: {go}")

    version, code = read_version()
    info(f"version {version} (versionCode {code})")

    abis = args.abi or ["arm64-v8a", "x86_64"]
    sdk = find_sdk(args.sdk)
    write_local_properties(sdk)

    FPK = load_fpk_build()
    stage_assets(FPK)
    if args.skip_native:
        for abi in abis:
            if not (JNILIBS / abi / "libgo2rtc.so").is_file():
                die(f"--skip-native given but jniLibs/{abi} is empty")
        info("reusing existing jniLibs binaries (--skip-native)")
    else:
        src = ensure_source(FPK)
        stage_libs(FPK, go, src, abis)

    gradle = find_gradle(args.gradle)
    build_type = "release" if args.release else "debug"
    tasks = [f"assemble{build_type.capitalize()}"]
    if not args.no_clean:
        # Gradle 增量打包会在 APK 里留下上一次的填充；clean 后体积才正常。
        tasks.insert(0, "clean")
    run_gradle(gradle, sdk, args.jdk, tasks, version, code)

    results = collect_apks(build_type, abis, version)
    for path in results:
        info(f"built {path}")


if __name__ == "__main__":
    main()
