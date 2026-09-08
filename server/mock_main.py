"""Offline mock of main.py — same request/response contract, no API key needed.

This single file replaces mock_main.py, mock_main2.py and mock_main3.py. Having four
near-identical server variants is what caused bug C2 in the first place: /ask was added
to main.py and never copied into main_gemini.py or the mocks, so anyone following the
README's recommended path got a 404 the moment they used "Read this page & ask questions".

One real server (main.py, which auto-selects Anthropic or Gemini) plus one mock is enough.
Delete main_gemini.py, mock_main2.py and mock_main3.py.

Run:
    uvicorn mock_main:app --host 127.0.0.1 --port 8000 --reload
"""

import os
import secrets

from fastapi import FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv

load_dotenv()

app = FastAPI(title="SIH26171 Decision Server (MOCK)")

allowed_origins = [
    o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "*").split(",") if o.strip()
]
SHARED_SECRET = os.environ.get("AGENT_SHARED_SECRET", "").strip()

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_methods=["POST", "GET", "OPTIONS"],
    allow_headers=["Content-Type", "X-Agent-Secret"],
)


def require_secret(x_agent_secret):
    if not SHARED_SECRET:
        return
    if not x_agent_secret or not secrets.compare_digest(x_agent_secret, SHARED_SECRET):
        raise HTTPException(status_code=401, detail="Invalid or missing X-Agent-Secret header")


# Every request is logged so you can inspect exactly what the extension transmitted —
# useful for confirming the redaction pipeline without spending API credits.
call_log = []


@app.post("/act")
async def act(req: dict, x_agent_secret: str | None = Header(default=None)):
    require_secret(x_agent_secret)

    elements = req.get("elements", [])
    screenshot = req.get("screenshot")

    available_files = req.get("availableFiles", [])
    call_log.append(
        {
            "task": req.get("task"),
            "visionAvailable": req.get("visionAvailable", True),
            "screenshotBytes": len(screenshot) if screenshot else 0,
            "numElements": len(elements),
            "numAvailableFiles": len(available_files),
            "numRecentActions": len(req.get("recentActions", [])),
            # Proves no raw field contents were transmitted — see content.js scanPage().
            "elementKeys": sorted(elements[0].keys()) if elements else [],
        }
    )

    # Drive the loop off real page state rather than a fixed script, so the mock
    # exercises the same isFilled / recentActions logic the real prompt depends on.
    already = {a.get("selector") for a in req.get("recentActions", [])}

    for el in elements:
        if el.get("isFilled"):
            continue
        if el.get("selector") in already:
            continue

        # Handle file upload controls
        if (el.get("tag") == "input" and el.get("type") == "file") or ("upload" in (el.get("text") or "").lower() and "btn" in (el.get("selector") or "").lower()):
            if available_files:
                text_low = (el.get("text") or el.get("selector") or "").lower()
                chosen = available_files[0]
                for f in available_files:
                    f_label = f.get("label", "").lower()
                    if ("photo" in text_low or "image" in text_low) and ("photo" in f_label or "image" in f_label):
                        chosen = f
                        break
                    if ("resume" in text_low or "cv" in text_low) and ("resume" in f_label or "cv" in f_label):
                        chosen = f
                        break
                return {"action": "upload", "selector": el["selector"], "fileId": chosen["id"]}

        if el.get("tag") not in ("input", "textarea", "select"):
            continue

        role = el.get("role")
        if role in ("name", "email", "phone"):
            return {"action": "type", "selector": el["selector"], "value": "{{%s}}" % role}
        if el.get("tag") == "select" and el.get("options"):
            return {"action": "select", "selector": el["selector"], "value": el["options"][0]["value"]}
        return {"action": "type", "selector": el["selector"], "value": "mock value"}

    for el in elements:
        text = (el.get("text") or "").lower()
        if el.get("tag") == "button" and any(w in text for w in ("submit", "apply", "send")):
            if el.get("selector") not in already:
                return {"action": "click", "selector": el["selector"]}

    return {"action": "done"}


@app.post("/ask")
async def ask(req: dict, x_agent_secret: str | None = Header(default=None)):
    require_secret(x_agent_secret)
    blocks = req.get("pageContext", []) + req.get("documentContext", [])
    return {
        "answer": (
            f"[MOCK] Received {len(blocks)} context block(s). "
            f"Question was: {req.get('question', '')}"
        )
    }


@app.get("/calls")
def get_calls():
    return call_log


@app.get("/health")
def health():
    return {
        "status": "ok",
        "provider": "mock",
        "model": "none",
        "authRequired": bool(SHARED_SECRET),
        "allowedOrigins": allowed_origins,
    }
