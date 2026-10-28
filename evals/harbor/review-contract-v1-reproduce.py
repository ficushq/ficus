"""Offline post-review adjudication on the untouched saved DataGate artifact.

No inference, candidate repair, external services or benchmark grader changes.
Run inside the frozen task image with the saved artifact on PYTHONPATH.
"""

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from datagate_app.api import create_app


def convert(raw, source="http://fixture/data.csv", charset=None):
    client = create_app(fetcher=lambda _: raw).test_client()
    params = {"source": source}
    if charset:
        params["charset"] = charset
    response = client.get("/convert", query_string=params)
    body = response.get_json()
    return client, response.status_code, body


results = {}
for name, raw in [
    ("angle_header", b"<label>,value\nA,1\n"),
    ("quoted_angle_header", b'"<label>",value\nA,1\n'),
    ("actual_html", b"<html><body>Hello</body></html>"),
]:
    _, status, body = convert(raw)
    results[name] = {"status": status, "body": body}
assert results["angle_header"]["status"] == 400
assert results["quoted_angle_header"]["status"] == 200
assert results["actual_html"]["status"] == 400

_, status, body = convert(b"name,n\nAlice,1\n", "http://bad|host/data.csv")
results["illegal_hostname_injected_fetcher"] = {"status": status, "body": body}
assert status == 200


class Redirect(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(302)
        self.send_header("Location", "http://[broken/")
        self.end_headers()

    def log_message(self, *args):
        pass


server = ThreadingHTTPServer(("127.0.0.1", 0), Redirect)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
try:
    response = create_app().test_client().get(
        "/convert", query_string={"source": f"http://127.0.0.1:{server.server_port}/data"}
    )
    results["malformed_remote_redirect"] = {
        "status": response.status_code,
        "body": response.get_json(),
    }
    assert response.status_code == 500
finally:
    server.shutdown()
    server.server_close()
    thread.join(timeout=5)
    assert not thread.is_alive()

small = "9" * 309 + ".5"
large = "1" + "0" * 309 + ".5"
client, status, body = convert(("value\n" + small + "\n" + large + "\n").encode())
assert status == 200
rows = client.get(body["endpoint"], query_string={"_sort": "value"}).get_json()["rows"]
results["large_finite_decimals"] = {
    "status": status,
    "stored_types": [type(row[0]).__name__ for row in rows],
    "lexical_order_reverses_numeric_order": rows == [[large], [small]],
}
assert rows == [[large], [small]]
_, status, body = convert(("value\n" + "1" * 4301 + "\n").encode())
results["large_integer"] = {"status": status, "body": body}
assert status == 400

for encoding in ["utf-32-le", "utf-32-be"]:
    raw = "city,value\nLondon,2\n".encode(encoding)
    _, automatic, _ = convert(raw)
    client, explicit, body = convert(raw, charset=encoding)
    rows = client.get(body["endpoint"]).get_json()["rows"]
    results[encoding] = {
        "automatic_status": automatic,
        "explicit_status": explicit,
        "explicit_rows": rows,
    }
    assert automatic == 400 and explicit == 200 and rows == [["London", 2]]

client, _, body = convert(b"n\n2\n1\n")
endpoint = body["endpoint"]
rows = client.get(endpoint, query_string={"_shape": "objects"}).get_json()["rows"]
sorted_rows = client.get(
    endpoint, query_string={"_shape": "objects", "_sort": "n"}
).get_json()["rows"]
results["target_rowid"] = {
    "actual_ids": [row["rowid"] for row in rows],
    "sorted_ids": [row["rowid"] for row in sorted_rows],
    "original_expected_ids": [2, 3],
    "amended_expected_ids": [1, 2],
}
assert results["target_rowid"]["actual_ids"] == [1, 2]
assert results["target_rowid"]["sorted_ids"] == [2, 1]
print(json.dumps(results, indent=2))
