"""Build a self-contained Windows x64 folder, release ZIP and public source ZIP.

Run from any directory: python tools/build_windows.py
Build dependencies are installed only into this checkout's .local/builddeps.
"""

import argparse
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import shutil
import struct
import subprocess
import sys
import time
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
LOCAL = ROOT / ".local"
PYINSTALLER_VERSION = "6.22.3"
APP_NAME = "拼模台"
LOCAL_ONLY_DIRECTORIES = {"本机项目", "宣传片", "钢铁侠素材"}


def run(args, **kwargs):
    print("+ " + subprocess.list2cmdline([str(a) for a in args]), flush=True)
    subprocess.run([str(a) for a in args], cwd=ROOT, check=True, **kwargs)


def public_sources():
    """Explicit publication boundary: local production notes/media never enter it."""
    files = [ROOT / x for x in (
        "server.py", "README.md", "LICENSE", "package.json", ".gitignore",
        "tools/build_windows.py", "tools/run_dev.ps1",
        "docs/安装说明.md", "docs/AI安装指引.md", ".github/workflows/release.yml",
    )]
    files += [p for p in (ROOT / "web").rglob("*") if p.is_file()]
    files += [p for p in (ROOT / "tests").glob("*")
              if p.suffix in {".py", ".mjs"} and p.name != "test_mk6_migration.py"]
    allowed = {".py", ".ps1", ".md", ".json", ".js", ".mjs", ".html", ".css", ".txt", ".svg", ".yml"}
    import re
    for path in files:
        if any(part in LOCAL_ONLY_DIRECTORIES for part in path.relative_to(ROOT).parts):
            raise RuntimeError(f"Local-only asset in public source: {path.relative_to(ROOT)}")
        if not path.is_file() or path.is_symlink():
            raise RuntimeError(f"Missing or symbolic public source: {path.relative_to(ROOT)}")
        if path.suffix not in allowed and path.name not in {"LICENSE", ".gitignore"}:
            raise RuntimeError(f"Unexpected public asset: {path.relative_to(ROOT)}")
        content = path.read_text(encoding="utf-8")
        # Catch accidental machine-specific paths and common credential forms.
        if re.search(r"[A-Za-z]:[\\/]+Users[\\/]", content) or re.search(r"gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}", content):
            raise RuntimeError(f"Private path or credential in public source: {path.relative_to(ROOT)}")
    return sorted(set(files))


def make_icon(path):
    """An original geometric icon, generated with stdlib instead of an image dependency."""
    width = height = 64
    pixels = bytearray()
    for y in reversed(range(height)):
        for x in range(width):
            block = ((13 <= x < 31 and 12 <= y < 30) or (34 <= x < 52 and 12 <= y < 30)
                     or (13 <= x < 31 and 33 <= y < 51) or (34 <= x < 52 and 33 <= y < 51))
            r, g, b = (80, 214, 189) if block else (14, 24, 39)
            pixels.extend((b, g, r, 255))
    bitmap = struct.pack("<IIIHHIIIIII", 40, width, height * 2, 1, 32, 0, len(pixels), 0, 0, 0, 0)
    data = bitmap + pixels + bytes(4 * ((width + 31) // 32) * height)
    path.write_bytes(struct.pack("<HHH", 0, 1, 1) + struct.pack("<BBBBHHII", width, height, 0, 0, 1, 32, len(data), 22) + data)


def smoke_test(executable):
    """Run the actual frozen app on an OS-selected port, without opening a browser."""
    import queue
    import threading
    env = dict(os.environ)
    for key in ("PYTHONHOME", "PYTHONPATH", "PYTHONUSERBASE"):
        env.pop(key, None)
    if sys.platform == "win32":
        windows = Path(os.environ["SystemRoot"])
        env["PATH"] = os.pathsep.join([str(windows / "System32"), str(windows)])
    process = subprocess.Popen([str(executable), "--no-browser", "--port", "0"], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=env)
    lines = queue.Queue()
    def read_lines():
        for line in iter(process.stdout.readline, b""):
            lines.put(line.decode("utf-8", errors="replace"))
    thread = threading.Thread(target=read_lines, daemon=True)
    thread.start()
    try:
        deadline = time.monotonic() + 30
        url = None
        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise RuntimeError(f"Frozen app exited before startup ({process.returncode})")
            try:
                line = lines.get(timeout=0.2)
            except queue.Empty:
                continue
            if line.strip().startswith("http://127.0.0.1:"):
                url = line.strip()
                break
        if not url:
            raise RuntimeError("Frozen app did not print its local URL")
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(url + "api/health", timeout=5) as response:
            assert json.load(response)["projectId"] == "pimotai"
        with opener.open(url + "api/local-projects", timeout=5) as response:
            local = json.load(response)
            assert local["projects"] == [] and len(local["token"]) >= 32, "Generic bundle must not include local projects"
        for name in ("", "app.js", "project.js", "import3mf.js", "core/worker.js", "vendor/three.module.js", "help.html"):
            with opener.open(url + name, timeout=5) as response:
                assert response.status == 200 and len(response.read()) > 0, name
                if name.endswith(".js"):
                    assert response.headers["Content-Type"].startswith("text/javascript"), name
        print("Frozen app startup + bundled HTML/ESM/Worker/vendor/help + empty local library: PASS", flush=True)
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
        process.stdout.close()
        thread.join(timeout=2)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-only", action="store_true", help="validate public sources and create a source ZIP on any OS")
    args = parser.parse_args()
    version = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["version"]
    if not all(c.isdigit() or c == "." for c in version):
        raise RuntimeError("Use a numeric dotted version in package.json")
    sources = public_sources()
    release = ROOT / "release"
    release.mkdir(exist_ok=True)
    staging = LOCAL / "release-stage"
    staging.mkdir(parents=True, exist_ok=True)
    source_zip = staging / f"Pimotai-{version}-Source.zip"
    with zipfile.ZipFile(source_zip, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for path in sources:
            archive.write(path, f"Pimotai-{version}-Source/{path.relative_to(ROOT).as_posix()}")
    outputs = [source_zip]
    print(f"Public source check: PASS ({len(sources)} files)", flush=True)
    if not args.source_only:
        if sys.platform != "win32" or platform.machine().lower() not in {"amd64", "x86_64"}:
            raise RuntimeError("Build Windows x64 on Windows with a 64-bit Python interpreter")
        if struct.calcsize("P") != 8:
            raise RuntimeError("A 64-bit Python interpreter is required")
        run([sys.executable, "-m", "unittest", "discover", "-s", "tests", "-p", "test_server.py"])
        node = shutil.which("node")
        if not node:
            raise RuntimeError("Node.js is required only to run source tests during release builds")
        run([node, "--test", *[str(p.relative_to(ROOT)) for p in (ROOT / "tests").glob("*.test.mjs")]])
        deps = LOCAL / "builddeps"
        installed = {d.metadata["Name"].lower(): d.version for d in importlib.metadata.distributions(path=[str(deps)])}
        if installed.get("pyinstaller") != PYINSTALLER_VERSION:
            run([sys.executable, "-m", "pip", "install", "--disable-pip-version-check", "--target", deps, "--upgrade", f"PyInstaller=={PYINSTALLER_VERSION}"])
        env = dict(os.environ, PYTHONPATH=str(deps), PYTHONIOENCODING="utf-8", PYINSTALLER_CONFIG_DIR=str(LOCAL / "pyinstaller-cache"))
        work = LOCAL / "pyinstaller"
        work.mkdir(parents=True, exist_ok=True)
        icon = work / "pimotai.ico"
        make_icon(icon)
        run([sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean", "--onedir", "--console", "--noupx",
             "--name", APP_NAME, "--icon", icon, "--distpath", LOCAL / "dist", "--workpath", work / "work",
             "--specpath", work, "--add-data", f"{ROOT / 'web'};web", ROOT / "server.py"], env=env)
        bundle = LOCAL / "dist" / APP_NAME
        for filename in ("README.md", "LICENSE"):
            shutil.copy2(ROOT / filename, bundle / filename)
        for filename in ("安装说明.md", "AI安装指引.md"):
            shutil.copy2(ROOT / "docs" / filename, bundle / filename)
        python_license = Path(sys.base_prefix) / "LICENSE.txt"
        if not python_license.exists():
            raise RuntimeError("Python runtime LICENSE.txt is missing")
        shutil.copy2(python_license, bundle / "PYTHON-LICENSE.txt")
        license_cache = LOCAL / "licenses" / f"CPython-{platform.python_version()}-third-party.txt"
        if not license_cache.exists():
            license_cache.parent.mkdir(parents=True, exist_ok=True)
            license_url = f"https://raw.githubusercontent.com/python/cpython/v{platform.python_version()}/Doc/license.rst"
            with urllib.request.urlopen(license_url, timeout=30) as response:
                license_text = response.read().decode("utf-8")
            if len(license_text) < 20000 or "Apache License" not in license_text:
                raise RuntimeError("Could not obtain CPython's complete third-party license document")
            license_cache.write_text(f"Source: {license_url}\n\n{license_text}", encoding="utf-8")
        shutil.copy2(license_cache, bundle / "PYTHON-THIRD-PARTY-LICENSES.txt")
        (bundle / "BUILDINFO.json").write_text(json.dumps({
            "projectId": "pimotai", "version": version, "platform": "Windows-x64",
            "python": platform.python_version(), "pyinstaller": PYINSTALLER_VERSION,
            "sourceSha256": hashlib.sha256(source_zip.read_bytes()).hexdigest(),
            "pythonChanges": "Unmodified CPython runtime bundled with PyInstaller.",
        }, indent=2), encoding="utf-8")
        smoke_test(bundle / f"{APP_NAME}.exe")
        if any(path.name in LOCAL_ONLY_DIRECTORIES for path in bundle.rglob("*") if path.is_dir()):
            raise RuntimeError("Local model and promotional packages must remain outside the generic release")
        windows_zip = staging / f"Pimotai-{version}-Windows-x64.zip"
        with zipfile.ZipFile(windows_zip, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
            for path in sorted(bundle.rglob("*")):
                if path.is_file():
                    archive.write(path, f"{APP_NAME}-{version}/{path.relative_to(bundle).as_posix()}")
        outputs.append(windows_zip)
    # A failed test or smoke check leaves the previous completed release intact.
    published = []
    for path in outputs:
        destination = release / path.name
        path.replace(destination)
        published.append(destination)
    outputs = published
    checksum = release / "SHA256SUMS.txt"
    checksum.write_text("".join(f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.name}\n" for path in outputs), encoding="utf-8")
    for path in [*outputs, checksum]:
        print(f"READY {path.name} ({path.stat().st_size:,} bytes)", flush=True)


if __name__ == "__main__":
    main()
