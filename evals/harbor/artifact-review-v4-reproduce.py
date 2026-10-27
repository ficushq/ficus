"""Offline public-API checks of the frozen HTTPX artifact; no repairs."""

import json

import anyio
import httpx


def invalid_charset_sync():
    response = httpx.Response(
        200,
        content=b"[]",
        headers={"Content-Type": 'application/json; charset="utf-8\x00"'},
    )
    try:
        list(response.iter_json())
    except Exception as exc:
        return {"error": type(exc).__name__, "message": str(exc)}
    return {"error": None}


class CleanupStream(httpx.AsyncByteStream):
    def __init__(self, raises):
        self.raises = raises
        self.closed = 0
        self.cleaned = False

    async def __aiter__(self):
        try:
            yield b"[] trailing"
            yield b" unread"
        finally:
            self.cleaned = True
            if self.raises:
                raise httpx.ReadError("audit iterator cleanup failed")

    async def aclose(self):
        self.closed += 1


async def async_cases():
    result = {}
    for raises in (False, True):
        stream = CleanupStream(raises)
        response = httpx.Response(
            200, stream=stream, headers={"Content-Type": "application/json"}
        )
        try:
            _ = [value async for value in response.aiter_json()]
            error = None
        except Exception as exc:
            error = type(exc).__name__
        result[f"cleanup_raises={raises}"] = {
            "error": error,
            "response_closed": response.is_closed,
            "stream_close_calls": stream.closed,
            "iterator_cleaned": stream.cleaned,
        }
        await (
            response.aclose()
        )  # Explicit operator cleanup only after recording the defect.
    response = httpx.Response(
        200,
        content=b"[]",
        headers={"Content-Type": 'application/json; charset="utf-8\x00"'},
    )
    try:
        _ = [value async for value in response.aiter_json()]
        result["invalid_charset"] = {"error": None}
    except Exception as exc:
        result["invalid_charset"] = {"error": type(exc).__name__, "message": str(exc)}
    return result


observed = {"invalid_charset_sync": invalid_charset_sync()}
for backend in ("asyncio", "trio"):
    observed[backend] = anyio.run(async_cases, backend=backend)
assert observed["invalid_charset_sync"]["error"] == "ValueError"
for backend in ("asyncio", "trio"):
    values = observed[backend]
    assert values["invalid_charset"]["error"] == "ValueError"
    assert values["cleanup_raises=False"] == {
        "error": "DecodingError",
        "response_closed": True,
        "stream_close_calls": 1,
        "iterator_cleaned": True,
    }
    assert values["cleanup_raises=True"] == {
        "error": "ReadError",
        "response_closed": False,
        "stream_close_calls": 0,
        "iterator_cleaned": True,
    }
print(json.dumps(observed, indent=2))
