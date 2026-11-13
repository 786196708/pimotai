"""Loopback-only launcher, optional local project library and controlled Bambu open."""

import argparse
import errno
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import mimetypes
import os
from pathlib import Path
import re
import secrets
import shutil
import socket
import subprocess
import sys
from urllib.parse import quote, unquote, urlsplit
import webbrowser

VERSION = "0.1.2"
DEFAULT_PORT = 18777
MODEL_EXTENSIONS = {".stl", ".obj", ".3mf"}


def web_root():
    return Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent)) / "web"


def projects_root():
    # Frozen resources live in _MEIPASS; user projects belong beside the EXE.
    base = Path(sys.executable).resolve().parent if getattr(sys, "frozen", False) else Path(__file__).resolve().parent
    return base / "本机项目"


def valid_id(value):
    return isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}", value) is not None


def registered_path(root, relative, extensions):
    """Validate at registration and again at use; never follow a link outside root."""
    if not isinstance(relative, str) or not relative or any(c in relative for c in ("\\", "\x00", ":")):
        raise ValueError("Invalid project path")
    if relative.startswith("/") or any(not part or part.startswith(".") for part in relative.split("/")):
        raise ValueError("Invalid project path")
    candidate = (root / relative).resolve()
    if not candidate.is_relative_to(root) or candidate.suffix.lower() not in extensions:
        raise ValueError("Invalid project path")
    return candidate


def load_local_projects(directory):
    projects = {}
    try:
        children = sorted(directory.iterdir()) if directory.is_dir() else []
    except OSError:
        return projects
    for child in children:
        try:
            root = child.resolve()
            if not root.is_relative_to(directory) or not root.is_dir() or child.name.startswith("."):
                continue
            manifest_file = registered_path(root, "manifest.json", {".json"})
            if not manifest_file.is_file() or manifest_file.stat().st_size > 1024 * 1024:
                continue
            manifest = json.loads(manifest_file.read_text(encoding="utf-8-sig"))
            project_id, title = manifest["id"], manifest["title"]
            if not valid_id(project_id) or project_id in projects or not isinstance(title, str) or not title.strip():
                continue
            project_file = manifest["projectFile"]
            if not registered_path(root, project_file, {".pmt"}).is_file():
                continue
            files = {}
            for entry in manifest.get("files", []):
                file_id, relative = entry["id"], entry["relativePath"]
                name = entry.get("name", file_id)
                if not valid_id(file_id) or file_id in files or not isinstance(name, str):
                    raise ValueError("Invalid file entry")
                registered_path(root, relative, MODEL_EXTENSIONS)
                files[file_id] = {"name": name, "relativePath": relative}
            projects[project_id] = {"root": root, "title": title, "projectFile": project_file,
                                    "attribution": manifest.get("attribution", ""), "files": files}
        except (OSError, ValueError, KeyError, TypeError, RuntimeError):
            continue  # An invalid optional package must not prevent the app starting.
    return projects


def find_bambu_studio():
    """Known installation directories only; no PATH, shell commands or file associations."""
    if sys.platform == "win32":
        candidates = [Path(os.environ.get(key, default)) / "Bambu Studio" / "bambu-studio.exe"
                      for key, default in (("ProgramFiles", "C:/Program Files"),
                                           ("ProgramFiles(x86)", "C:/Program Files (x86)"))]
        if os.environ.get("LOCALAPPDATA"):
            candidates.append(Path(os.environ["LOCALAPPDATA"]) / "Programs" / "Bambu Studio" / "bambu-studio.exe")
        for candidate in candidates:
            if candidate.is_file():
                return candidate.resolve()
    raise FileNotFoundError("未找到已安装的 Bambu Studio。请先安装拓竹切片软件，或下载原件后手动打开。")


def launch_bambu(source):
    subprocess.Popen([str(find_bambu_studio()), str(source)], close_fds=True)


class LocalHandler(BaseHTTPRequestHandler):
    server_version = "Pimotai/" + VERSION
    sys_version = ""

    def log_message(self, _format, *_args):
        pass  # Model names and browsing paths are not written to a log.

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_HEAD(self):
        self.do_GET()

    def local_host_allowed(self):
        allowed_hosts = {f"127.0.0.1:{self.server.server_port}", f"localhost:{self.server.server_port}"}
        if len(self.headers.get_all("Host", [])) != 1 or self.headers.get("Host", "").lower() not in allowed_hosts:
            self.send_error(403, "Only the local app address is allowed")
            return False
        return True

    def request_path(self):
        if not self.local_host_allowed():
            return None
        try:
            parsed = urlsplit(self.path)
            path = unquote(parsed.path, errors="strict")
        except (ValueError, UnicodeError):
            self.send_error(400, "Invalid path")
            return None
        if parsed.scheme or parsed.netloc or any(c in path for c in ("\\", "\x00", ":")):
            self.send_error(400, "Invalid path")
            return None
        if any(part.startswith(".") for part in path.split("/") if part):
            self.send_error(403, "Hidden files and traversal are not served")
            return None
        return path

    def send_json(self, status, value):
        body = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def source_file(self, project, file_id):
        entry = project["files"].get(file_id)
        if entry is None:
            return None
        try:
            candidate = registered_path(project["root"], entry["relativePath"], MODEL_EXTENSIONS)
            return candidate if candidate.is_file() else None
        except (OSError, ValueError, RuntimeError):
            return None

    def do_GET(self):
        path = self.request_path()
        if path is None:
            return
        if path == "/api/health":
            self.send_json(200, {"projectId": "pimotai", "version": VERSION, "localOnly": True})
            return
        if path == "/api/local-projects":
            self.send_json(200, {"projects": [{
                "id": project_id, "title": project["title"],
                "projectUrl": f"/api/local-project/{project_id}/project", "attribution": project["attribution"],
                "files": [{"id": file_id, "name": entry["name"]}
                          for file_id, entry in project["files"].items() if self.source_file(project, file_id)],
            } for project_id, project in self.server.local_projects.items()], "token": self.server.local_token})
            return
        if path.startswith("/api/local-project/"):
            segments = path.split("/")
            project = self.server.local_projects.get(segments[3]) if len(segments) >= 5 else None
            candidate = None
            attachment = False
            if project:
                try:
                    if len(segments) == 5 and segments[4] == "project":
                        candidate = registered_path(project["root"], project["projectFile"], {".pmt"})
                    elif len(segments) == 6 and segments[4] == "files":
                        candidate = self.source_file(project, segments[5])
                        attachment = True
                except (OSError, ValueError, RuntimeError):
                    pass
            if candidate is None or not candidate.is_file():
                self.send_error(404, "Registered project file not found")
                return
            self.send_file(candidate, attachment=attachment)
            return
        if path.startswith("/api/"):
            self.send_error(404, "API not found")
            return
        root = self.server.web_directory
        candidate = (root / ("index.html" if path == "/" else path.lstrip("/"))).resolve()
        if not candidate.is_relative_to(root) or not candidate.is_file():
            self.send_error(404, "File not found")
            return
        self.send_file(candidate)

    def send_file(self, candidate, attachment=False):
        content_type = {
            ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
            ".html": "text/html", ".json": "application/json", ".pmt": "application/json", ".wasm": "application/wasm",
        }.get(candidate.suffix.lower()) or mimetypes.guess_type(candidate.name)[0] or "application/octet-stream"
        if content_type.startswith("text/") or content_type == "application/json":
            content_type += "; charset=utf-8"
        try:
            with candidate.open("rb") as stream:
                self.send_response(200)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(candidate.stat().st_size))
                if attachment:
                    self.send_header("Content-Disposition", "attachment; filename*=UTF-8''" + quote(candidate.name, safe=""))
                self.end_headers()
                if self.command != "HEAD":
                    shutil.copyfileobj(stream, self.wfile)
        except (ConnectionError, BrokenPipeError):
            pass
        except OSError:
            self.send_error(404, "File not found")

    def reject_write(self):
        self.send_error(405, "This local app only serves read-only assets")

    def do_POST(self):
        path = self.request_path()
        if path is None:
            return
        if path != "/api/open-source":
            self.reject_write()
            return
        supplied = self.headers.get("X-Local-Token", "")
        origins = {f"http://127.0.0.1:{self.server.server_port}", f"http://localhost:{self.server.server_port}"}
        if (len(self.headers.get_all("X-Local-Token", [])) != 1
                or not hmac.compare_digest(supplied.encode("utf-8"), self.server.local_token.encode("ascii"))
                or len(self.headers.get_all("Origin", [])) > 1
                or ("Origin" in self.headers and self.headers["Origin"] not in origins)):
            self.send_json(403, {"error": "本机请求验证失败，请刷新工作台后重试。"})
            return
        try:
            if self.headers.get_content_type() != "application/json" or self.headers.get("Transfer-Encoding"):
                raise ValueError("Expected JSON")
            if len(self.headers.get_all("Content-Length", [])) != 1:
                raise ValueError("Expected one body length")
            length = int(self.headers["Content-Length"])
            if not 0 < length <= 4096:
                raise ValueError("Invalid body length")
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            if (not isinstance(payload, dict) or set(payload) != {"projectId", "fileId"}
                    or not valid_id(payload["projectId"]) or not valid_id(payload["fileId"])):
                raise ValueError("Expected registered IDs")
        except (ValueError, UnicodeError):
            self.send_json(400, {"error": "只能打开登记的项目与原件编号。"})
            return
        project = self.server.local_projects.get(payload["projectId"])
        candidate = self.source_file(project, payload["fileId"]) if project else None
        if candidate is None:
            self.send_json(404, {"error": "未找到登记原件，请检查本机项目包是否完整。"})
            return
        try:
            self.server.launch_source(candidate)
        except FileNotFoundError:
            self.send_json(503, {"error": "未找到已安装的 Bambu Studio。请先安装拓竹切片软件，或下载原件后手动打开。"})
            return
        except OSError:
            self.send_json(503, {"error": "Bambu Studio 启动失败，请下载原件后手动打开。"})
            return
        self.send_json(200, {"opened": True})

    do_PUT = do_PATCH = do_DELETE = do_OPTIONS = reject_write


class LocalServer(ThreadingHTTPServer):
    daemon_threads = True
    # Windows exclusive binding avoids sharing the port with another process.
    allow_reuse_address = False

    def server_bind(self):
        if sys.platform == "win32":
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def create_server(directory=None, port=DEFAULT_PORT, projects_directory=None, launch=None):
    root = Path(directory or web_root()).resolve()
    if not (root / "index.html").is_file():
        raise FileNotFoundError("The web/index.html resource is missing; extract the complete app folder.")
    if not 0 <= port <= 65535:
        raise ValueError("Port must be between 0 and 65535")
    projects = load_local_projects(Path(projects_directory if projects_directory is not None else projects_root()).resolve())
    ports = [0] if port == 0 else list(range(port, min(port + 21, 65536))) + [0]
    for candidate in ports:
        try:
            httpd = LocalServer(("127.0.0.1", candidate), LocalHandler)
            httpd.web_directory = root
            httpd.local_projects = projects
            httpd.local_token = secrets.token_urlsafe(32)
            httpd.launch_source = launch if launch is not None else launch_bambu
            return httpd
        except OSError as exc:
            if exc.errno not in {errno.EADDRINUSE, errno.EACCES, 10048, 10013}:
                raise
    raise OSError("No local port is available")


def main():
    for stream in (sys.stdout, sys.stderr):
        if stream is not None and hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(description="拼模台：本机模型分析与拼装工作台")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help="preferred local port (default: 18777; 0: automatic)")
    parser.add_argument("--no-browser", action="store_true", help="serve without opening the default browser")
    parser.add_argument("--projects-dir", type=Path, help="optional local project directory (default: 本机项目 beside the app)")
    parser.add_argument("--version", action="version", version=VERSION)
    args = parser.parse_args()
    try:
        httpd = create_server(port=args.port, projects_directory=args.projects_dir)
    except (OSError, ValueError) as exc:
        print(f"启动失败 / Startup failed: {exc}", file=sys.stderr, flush=True)
        return 1
    url = f"http://127.0.0.1:{httpd.server_port}/"
    print(f"拼模台 {VERSION}\n{url}\n仅在本机运行。保留此窗口，关闭窗口即可退出。\nLocal only. Keep this window open; close it to stop.", flush=True)
    if httpd.server_port != args.port and args.port:
        print(f"首选端口 {args.port} 已占用；已自动改用 {httpd.server_port}。", flush=True)
    if not args.no_browser:
        try:
            webbrowser.open(url)
        except webbrowser.Error:
            print("请在浏览器中打开上方地址。Open the address above in your browser.", flush=True)
    try:
        httpd.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
