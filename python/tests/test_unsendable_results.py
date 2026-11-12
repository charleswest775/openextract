"""
A result the engine can't write as JSON must not end it (in-app reports OE-26 to OE-28).

An iOS 6 backup's photos came back with their UUIDs as raw bytes. json.dumps
raised outside handle_request's try, so the engine exited, and every call
waiting behind it failed with "Sidecar exited with code 1", then "Python
sidecar is not running". These drive SidecarServer.run() over in-memory
streams, one JSON-RPC line per request, the way Electron drives the engine.
"""

import io
import json
import sys
import uuid
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from rpc_contract_support import load_engine_module  # noqa: E402


@pytest.fixture
def engine(monkeypatch, tmp_path):
    module = load_engine_module()
    log = tmp_path / "engine.log"
    monkeypatch.setattr(module, "_LOG_PATH", str(log))
    server = module.SidecarServer()

    def exchange(*requests):
        out = io.StringIO()
        monkeypatch.setattr(module, "_rpc_out", out)
        monkeypatch.setattr(sys, "stdin", io.StringIO("".join(json.dumps(r) + "\n" for r in requests)))
        server.run()
        ready, *lines = out.getvalue().splitlines()
        assert json.loads(ready) == {"status": "ready"}
        return [json.loads(line) for line in lines]

    def log_text():
        return log.read_text(encoding="utf-8") if log.exists() else ""

    return server, exchange, log_text


def test_raw_bytes_go_as_text_and_the_engine_answers_the_next_call(engine):
    server, exchange, log_text = engine
    server.methods["photos_with_bytes"] = lambda params: {"photos": [
        {"uuid": uuid.UUID(int=1).bytes, "filename": b"IMG_0001.JPG"},
        {"uuid": b"\xff\xfe\x00\x01", "filename": "IMG_0002.JPG"},
    ]}

    first, second = exchange(
        {"id": 1, "method": "photos_with_bytes", "params": {}},
        {"id": 2, "method": "ping", "params": {}},
    )

    assert first == {"id": 1, "result": {"photos": [
        {"uuid": "00000000000000000000000000000001", "filename": "IMG_0001.JPG"},  # binary → hex
        {"uuid": "fffe0001", "filename": "IMG_0002.JPG"},  # not UTF-8 → hex
    ]}}
    assert second == {"id": 2, "result": {"status": "ok", "version": "0.1.0"}}
    # Where they were, so the reader that returned them can be fixed; never their contents.
    note = ("[RPC ERROR] photos_with_bytes: sent raw bytes as text at "
            "result.photos[].uuid (2 values), result.photos[].filename")
    assert note in log_text()


def test_bytes_that_are_text_come_out_as_that_text(engine):
    server, exchange, _ = engine
    server.methods["text_as_bytes"] = lambda params: {"title": "Café".encode("utf-8") + b"\x00", "tags": (b"a",)}

    (response,) = exchange({"id": "x", "method": "text_as_bytes", "params": {}})

    assert response == {"id": "x", "result": {"title": "Café", "tags": ["a"]}}


def test_a_result_that_cant_be_written_is_an_error_naming_the_method(engine):
    server, exchange, log_text = engine
    server.methods["odd_result"] = lambda params: {"when": object()}

    first, second = exchange(
        {"id": 7, "method": "odd_result", "params": {}},
        {"id": 8, "method": "ping", "params": {}},
    )

    assert first["id"] == 7 and "result" not in first
    assert first["error"]["code"] == -32603
    assert "odd_result" in first["error"]["message"]
    assert second["result"]["status"] == "ok"
    assert "[RPC ERROR] odd_result: couldn't send the result: TypeError" in log_text()


def test_an_ordinary_result_is_written_as_before(engine):
    _, exchange, log_text = engine
    (response,) = exchange({"id": 3, "method": "ping", "params": {}})
    assert response == {"id": 3, "result": {"status": "ok", "version": "0.1.0"}}
    assert "[RPC ERROR]" not in log_text()
