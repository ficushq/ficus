"""Offline adjudication on the untouched saved artifact; no model calls or repairs."""
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from datagate_app.api import create_app

results = {}
for name, raw in [
    ("angle_header", b"<name>,n\nA,2\n"),
    ("quoted_angle_header", b'"<name>",n\nA,2\n'),
    ("actual_html", b"<html><body>Hello</body></html>"),
]:
    response = create_app(fetcher=lambda _: raw).test_client().get(
        "/convert", query_string={"source": "http://fixture/data.csv"}
    )
    results[name] = {"status": response.status_code, "body": response.get_json()}
assert results["angle_header"]["status"] == 400
assert results["quoted_angle_header"]["status"] == 200
assert results["actual_html"]["status"] == 400


class Redirect(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(302)
        self.send_header("Location", "http://..../a" if self.path == "/unicode" else "http://[bad/a")
        self.end_headers()

    def log_message(self, *args):
        pass


server = ThreadingHTTPServer(("127.0.0.1", 0), Redirect)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
try:
    for path in ("/ipv6", "/unicode"):
        response = create_app().test_client().get(
            "/convert", query_string={"source": f"http://127.0.0.1:{server.server_port}{path}"}
        )
        results["redirect" + path] = {"status": response.status_code, "body": response.get_json()}
        assert response.status_code == 500
finally:
    server.shutdown()
    server.server_close()
    thread.join(timeout=5)
    assert not thread.is_alive()

client = create_app().test_client()
for method in ("GET", "OPTIONS"):
    response = client.open("/unknown", method=method)
    results["unknown_" + method] = {"status": response.status_code, "body": response.get_json()}
assert results["unknown_GET"]["status"] == 404
assert results["unknown_OPTIONS"]["status"] == 200

client = create_app(fetcher=lambda _: b"name,n\nA,2\nB,1\n").test_client()
endpoint = client.get("/convert", query_string={"source": "http://fixture/data.csv"}).get_json()["endpoint"]
plain = client.get(endpoint, query_string={"_shape": "objects"}).get_json()["rows"]
sorted_rows = client.get(endpoint, query_string={"_shape": "objects", "_sort": "n"}).get_json()["rows"]
results["target_rowid"] = {"actual_ids": [x["rowid"] for x in plain],
    "sorted_ids": [x["rowid"] for x in sorted_rows], "original_expected_ids": [2, 3],
    "amended_expected_ids": [1, 2]}
assert results["target_rowid"]["actual_ids"] == [1, 2]
assert results["target_rowid"]["sorted_ids"] == [2, 1]
print(json.dumps(results, indent=2))
