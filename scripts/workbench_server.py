"""Own the isolated loopback service for as long as the Hyper Bot host is alive."""
import asyncio
import hashlib
import json
import os
from secrets import compare_digest
import socket
import sys
import threading
from pathlib import Path

root = Path(sys.argv[1]).resolve()
sys.path.insert(0, str(root / "backend"))

if sys.argv[2:] == ["--locate"]:
    from settings import STATE, DATA

    locator = hashlib.sha256(str(root).encode()).hexdigest()[:20]
    print(json.dumps({"base": str(root), "projects": str(DATA),
                      "manifest": str(STATE / "services" / (locator + ".json"))}), flush=True)
    raise SystemExit(0)

import uvicorn
from app import app, JSONResponse

bridge_key = os.environ["HYPER_BOT_WORKBENCH_BRIDGE"].encode()


@app.middleware("http")
async def authorized_bridge(request, call_next):
    key = request.headers.get("x-hyper-bot-bridge", "").encode()
    if not compare_digest(bridge_key, key):
        return JSONResponse({"detail": "仅对当前 Hyper Bot 宿主开放"}, status_code=403)
    return await call_next(request)


async def start():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
        server = uvicorn.Server(uvicorn.Config(app, log_level="error", access_log=False))

        def watch_parent():
            sys.stdin.buffer.read(1)
            server.should_exit = True

        threading.Thread(target=watch_parent, daemon=True).start()
        print(json.dumps({"port": port}), flush=True)
        await server.serve(sockets=[listener])


if __name__ == "__main__":
    asyncio.run(start())

