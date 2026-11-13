"""Run with: python -m unittest discover -s tests -p test_server.py"""

import http.client
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest import mock

try:
    import server
except ModuleNotFoundError:
    server = None


class LocalServerFixture(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(server, "The local launcher is not implemented yet")
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "web"
        self.root.mkdir()
        (self.root / "index.html").write_text("<title>Local model</title>", encoding="utf-8")
        (self.root / "main.js").write_text("export const ready = true;", encoding="utf-8")
        (self.root / ".secret").write_text("PRIVATE", encoding="utf-8")
        (self.root.parent / "private.txt").write_text("PRIVATE", encoding="utf-8")
        (self.root / "folder").mkdir()
        (self.root / "folder" / "file.txt").write_text("folder file", encoding="utf-8")
        self.projects = self.root.parent / "projects"
        self.projects.mkdir()
        self.httpd = server.create_server(self.root, port=0)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.httpd.server_close)
        self.addCleanup(self.thread.join, 2)
        self.addCleanup(self.httpd.shutdown)

    def request(self, path="/", method="GET", headers=None, body=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.httpd.server_port, timeout=3)
        conn.request(method, path, body=body, headers=headers or {})
        response = conn.getresponse()
        result = response.status, dict(response.getheaders()), response.read()
        conn.close()
        return result


class LocalServerTests(LocalServerFixture):
    def test_loopback_health_and_static_module(self):
        self.assertEqual(self.httpd.server_address[0], "127.0.0.1")
        code, headers, body = self.request("/api/health")
        self.assertEqual(code, 200)
        self.assertEqual(json.loads(body)["projectId"], "pimotai")
        self.assertEqual(headers["Access-Control-Allow-Origin"] if "Access-Control-Allow-Origin" in headers else None, None)
        code, headers, body = self.request("/main.js?v=1")
        self.assertEqual(code, 200)
        self.assertTrue(headers["Content-Type"].startswith("text/javascript"))
        self.assertEqual(body, b"export const ready = true;")
        self.assertEqual(headers["X-Content-Type-Options"], "nosniff")
        self.assertEqual(self.request("/")[2], b"<title>Local model</title>")

    def test_head_uses_get_length_without_body(self):
        code, headers, body = self.request("/main.js", "HEAD")
        self.assertEqual(code, 200)
        self.assertEqual(int(headers["Content-Length"]), 26)
        self.assertEqual(body, b"")

    def test_private_files_and_path_traversal_are_inaccessible(self):
        for path in ["/../private.txt", "/%2e%2e/private.txt", "/.%2f../private.txt",
                     "/%2e%2e%5cprivate.txt", "/.secret", "/%2esecret", "/folder/../.secret",
                     "/folder/", "/%00", "/C:/Windows/win.ini", "/api/missing"]:
            with self.subTest(path=path):
                code, _, body = self.request(path)
                self.assertIn(code, [400, 403, 404])
                self.assertNotIn(b"PRIVATE", body)
        self.assertEqual(self.request("/folder/file.txt")[0], 200)

    def test_foreign_host_and_mutating_methods_are_rejected(self):
        self.assertEqual(self.request(headers={"Host": "attacker.example"})[0], 403)
        self.assertEqual(self.request("/api/upload", "POST")[0], 405)
        self.assertEqual(self.request("/main.js", "DELETE")[0], 405)

    def test_busy_port_falls_back_without_disturbing_first_server(self):
        other = server.create_server(self.root, port=self.httpd.server_port)
        try:
            self.assertNotEqual(other.server_port, self.httpd.server_port)
            self.assertEqual(other.server_address[0], "127.0.0.1")
            self.assertEqual(self.request("/api/health")[0], 200)
        finally:
            other.server_close()

    def test_launcher_reports_errors_on_non_chinese_windows(self):
        result = subprocess.run([sys.executable, str(Path(server.__file__)), "--no-browser", "--port", "-1"],
                                capture_output=True, env=dict(os.environ, PYTHONIOENCODING="ascii"))
        self.assertEqual(result.returncode, 1)
        self.assertIn("启动失败", result.stderr.decode("utf-8"))
        self.assertNotIn(b"UnicodeEncodeError", result.stderr)


class LocalProjectTests(LocalServerFixture):
    """Real HTTP requests and local files; only the external GUI launch is replaced."""

    def setUp(self):
        super().setUp()
        self.httpd.shutdown()
        self.thread.join(2)
        self.httpd.server_close()
        self.project = self.projects / "example"
        (self.project / "originals").mkdir(parents=True)
        (self.project / "project.pmt").write_text('{"projectId":"example"}', encoding="utf-8")
        (self.project / "originals" / "part.stl").write_bytes(b"solid local part")
        (self.project / "unregistered.stl").write_bytes(b"PRIVATE")
        self.manifest = {
            "id": "example-local", "title": "Local example", "projectFile": "project.pmt",
            "attribution": {"license": "Local model terms"},
            "files": [{"id": "part-1", "name": "Part one.stl", "relativePath": "originals/part.stl"},
                      {"id": "missing", "name": "Missing.stl", "relativePath": "originals/missing.stl"}],
        }
        self.write_manifest()
        self.opened = []
        self.httpd = server.create_server(self.root, port=0, projects_directory=self.projects,
                                          launch=lambda path: self.opened.append(path))
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.httpd.server_close)
        self.addCleanup(self.thread.join, 2)
        self.addCleanup(self.httpd.shutdown)

    def write_manifest(self):
        (self.project / "manifest.json").write_text(json.dumps(self.manifest), encoding="utf-8")

    def token(self):
        code, _, body = self.request("/api/local-projects")
        self.assertEqual(code, 200)
        return json.loads(body)["token"]

    def post_open(self, data=None, headers=None):
        return self.request("/api/open-source", "POST", headers or {
            "X-Local-Token": self.token(), "Content-Type": "application/json",
            "Origin": f"http://127.0.0.1:{self.httpd.server_port}",
        }, json.dumps(data or {"projectId": "example-local", "fileId": "part-1"}))

    def test_lists_registered_projects_without_disclosing_disk_paths(self):
        code, headers, body = self.request("/api/local-projects")
        self.assertEqual(code, 200)
        payload = json.loads(body)
        self.assertGreaterEqual(len(payload["token"]), 32)
        self.assertEqual(payload["projects"], [{
            "id": "example-local", "title": "Local example",
            "projectUrl": "/api/local-project/example-local/project",
            "attribution": {"license": "Local model terms"},
            "files": [{"id": "part-1", "name": "Part one.stl"}],
        }])
        self.assertNotIn(str(self.projects).encode(), body)
        self.assertNotIn("Access-Control-Allow-Origin", headers)
        self.assertEqual(self.request("/api/local-projects", headers={"Host": "attacker.example"})[0], 403)

    def test_project_and_original_download_use_only_registered_files(self):
        self.assertEqual(self.request("/api/local-project/example-local/project")[2], b'{"projectId":"example"}')
        code, headers, body = self.request("/api/local-project/example-local/files/part-1")
        self.assertEqual((code, body), (200, b"solid local part"))
        self.assertIn("attachment", headers["Content-Disposition"])
        for path in ["/api/local-project/example-local/files/missing", "/api/local-project/example-local/files/unregistered.stl",
                     "/api/local-project/example-local/manifest.json", "/api/local-project/example-local/project.pmt",
                     "/api/local-project/unknown/project"]:
            with self.subTest(path=path):
                code, _, body = self.request(path)
                self.assertEqual(code, 404)
                self.assertNotIn(b"PRIVATE", body)

    def test_open_source_launches_only_registered_existing_original(self):
        code, _, body = self.post_open()
        self.assertEqual(code, 200)
        self.assertEqual(json.loads(body), {"opened": True})
        self.assertEqual(self.opened, [(self.project / "originals" / "part.stl").resolve()])
        self.assertEqual(self.post_open({"projectId": "example-local", "fileId": "missing"})[0], 404)
        self.assertEqual(len(self.opened), 1)

    def test_open_source_rejects_csrf_foreign_host_and_bad_input(self):
        for headers in [
            {"Content-Type": "application/json"},
            {"Content-Type": "application/json", "X-Local-Token": "wrong"},
            {"Content-Type": "application/json", "X-Local-Token": self.token(), "Origin": "https://attacker.example"},
            {"Content-Type": "application/json", "X-Local-Token": self.token(), "Origin": "null"},
            {"Content-Type": "application/json", "X-Local-Token": self.token(), "Origin": "http://127.0.0.1:1"},
            {"Content-Type": "application/json", "X-Local-Token": self.token(), "Host": "attacker.example"},
        ]:
            with self.subTest(headers=headers):
                self.assertEqual(self.post_open(headers=headers)[0], 403)
        for data in [{"projectId": "example-local", "fileId": "../unregistered.stl"},
                     {"projectId": "example-local", "fileId": "part-1", "path": "C:/not-allowed.stl"},
                     {"projectId": "example-local", "fileId": "part-1", "command": "calc"},
                     ["example-local", "part-1"]]:
            with self.subTest(data=data):
                self.assertEqual(self.post_open(data)[0], 400)
        self.assertEqual(self.opened, [])
        self.assertEqual(self.request("/api/open-source", "GET")[0], 404)
        self.assertEqual(self.request("/api/open-source", "OPTIONS")[0], 405)

    def test_open_source_reports_missing_bambu_without_fallback(self):
        def missing(_path):
            raise FileNotFoundError("Bambu Studio is not installed")
        self.httpd.launch_source = missing
        code, _, body = self.post_open()
        self.assertEqual(code, 503)
        self.assertIn("Bambu Studio", json.loads(body)["error"])
        self.assertEqual(self.opened, [])

    def test_deleted_or_replaced_original_is_not_available(self):
        (self.project / "originals" / "part.stl").unlink()
        self.assertEqual(json.loads(self.request("/api/local-projects")[2])["projects"][0]["files"], [])
        self.assertEqual(self.post_open()[0], 404)
        self.assertEqual(self.request("/api/local-project/example-local/files/part-1")[0], 404)
        self.assertEqual(self.opened, [])

    def test_symlink_outside_project_cannot_be_downloaded_or_opened(self):
        original = self.project / "originals" / "part.stl"
        original.unlink()
        try:
            original.symlink_to(self.root.parent / "private.txt")
        except OSError as exc:
            if sys.platform != "win32":
                self.skipTest(f"Symbolic links unavailable: {exc}")
            # Directory junctions exercise the same resolved-path boundary without
            # requiring Windows' optional symbolic-link privilege.
            import _winapi
            outside = self.root.parent / "outside"
            outside.mkdir()
            (outside / "part.stl").write_bytes(b"PRIVATE")
            original.parent.rmdir()
            _winapi.CreateJunction(str(outside), str(original.parent))
        self.assertEqual(self.request("/api/local-project/example-local/files/part-1")[0], 404)
        self.assertEqual(self.post_open()[0], 404)
        self.assertEqual(self.opened, [])


class ProjectManifestTests(unittest.TestCase):
    def test_invalid_and_escaping_manifests_are_not_registered(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            web = root / "web"
            web.mkdir()
            (web / "index.html").write_text("app")
            projects = root / "projects"
            project = projects / "unsafe"
            project.mkdir(parents=True)
            (project / "project.pmt").write_text("{}")
            (root / "private.stl").write_text("PRIVATE")
            for relative in ["../../private.stl", str((root / "private.stl").resolve()),
                             "C:/Windows/private.stl", "originals\\part.stl", "script.exe"]:
                manifest = {"id": "unsafe", "title": "Unsafe", "projectFile": "project.pmt",
                            "files": [{"id": "one", "name": "one", "relativePath": relative}]}
                (project / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
                httpd = server.create_server(web, port=0, projects_directory=projects)
                try:
                    self.assertEqual(httpd.local_projects, {}, relative)
                finally:
                    httpd.server_close()

    def test_each_server_session_has_its_own_token_and_no_project_is_required(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "index.html").write_text("app")
            first = server.create_server(root, port=0, projects_directory=root / "missing")
            second = server.create_server(root, port=0, projects_directory=root / "missing")
            try:
                self.assertEqual(first.local_projects, {})
                self.assertNotEqual(first.local_token, second.local_token)
            finally:
                first.server_close()
                second.server_close()

    def test_frozen_project_root_is_beside_executable_not_internal_resources(self):
        with mock.patch.object(server.sys, "frozen", True, create=True), \
             mock.patch.object(server.sys, "executable", str(Path(tempfile.gettempdir()) / "portable" / "app.exe")), \
             mock.patch.object(server.sys, "_MEIPASS", str(Path(tempfile.gettempdir()) / "internal"), create=True):
            # Windows TEMP may use an 8.3 alias for the same directory.
            self.assertEqual(server.projects_root(), (Path(tempfile.gettempdir()) / "portable" / "本机项目").resolve())

    def test_bambu_launch_uses_fixed_executable_and_one_file_argument(self):
        source = Path(tempfile.gettempdir()) / "part; calc.stl"
        executable = Path(tempfile.gettempdir()) / "Bambu Studio" / "bambu-studio.exe"
        with mock.patch.object(server, "find_bambu_studio", return_value=executable), \
             mock.patch.object(server.subprocess, "Popen") as popen:
            server.launch_bambu(source)
        popen.assert_called_once_with([str(executable), str(source)], close_fds=True)


if __name__ == "__main__":
    unittest.main()
