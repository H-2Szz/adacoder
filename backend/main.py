from __future__ import annotations

import argparse
from typing import Any, Literal

import uvicorn
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from src import LLMConfig
from src.session_service import SessionStore


class LLMSettingsRequest(BaseModel):
    provider: str = "other"
    base_url: str = ""
    api_key: str = ""
    model: str = Field(min_length=1)


class CreateSessionRequest(BaseModel):
    problem: str = Field(min_length=1)
    test_text: str = ""
    test_mode: Literal["manual", "generate"] = "manual"
    resolved_test_code: str = ""
    llm: LLMSettingsRequest
    context_enabled: bool = False
    max_rounds: int = Field(default=3, ge=1, le=10)


class UpdateSessionRequest(BaseModel):
    plan: str | None = None
    problem: str | None = None
    test_text: str | None = None
    test_mode: Literal["manual", "generate"] | None = None
    resolved_test_code: str | None = None
    context_enabled: bool | None = None
    max_rounds: int | None = Field(default=None, ge=1, le=10)


class SessionActionRequest(BaseModel):
    action: Literal["generate", "evaluate", "plan", "regenerate", "restart", "auto", "auto_resume", "generate_tests"]
    problem: str | None = None
    test_text: str | None = None
    test_mode: Literal["manual", "generate"] | None = None
    resolved_test_code: str | None = None
    use_error_feedback: bool = True
    max_rounds: int | None = Field(default=None, ge=1, le=10)
    context_enabled: bool | None = None
    plan_override: str | None = None


store = SessionStore()
app = FastAPI(title="AdaAssist Backend", version="0.1.0")


def ok(session: dict[str, Any], **extra: Any) -> dict[str, Any]:
    payload = {"ok": True, "session": session}
    payload.update(extra)
    return payload


def get_session_or_404(session_id: str):
    try:
        return store.get_session(session_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.get("/health")
def health() -> dict[str, bool]:
    return {"ok": True}


@app.get("/api/sessions")
def list_sessions() -> dict[str, Any]:
    return {"ok": True, "sessions": store.list_sessions()}


@app.post("/api/sessions")
def create_session(request: CreateSessionRequest) -> dict[str, Any]:
    llm_config = LLMConfig(
        provider=request.llm.provider,  # type: ignore[arg-type]
        base_url=request.llm.base_url,
        api_key=request.llm.api_key,
        model=request.llm.model,
    )
    session = store.create_session(
        problem_statement=request.problem,
        test_text=request.test_text,
        llm_config=llm_config,
        test_mode=request.test_mode,
        context_enabled=request.context_enabled,
        max_rounds=request.max_rounds,
    )
    if request.resolved_test_code.strip():
        session.update_options(resolved_test_code=request.resolved_test_code)
    return ok(session.to_dict())


@app.get("/api/sessions/{session_id}")
def get_session(session_id: str) -> dict[str, Any]:
    session = get_session_or_404(session_id)
    return ok(session.to_dict())


@app.patch("/api/sessions/{session_id}")
def update_session(session_id: str, request: UpdateSessionRequest) -> dict[str, Any]:
    session = get_session_or_404(session_id)
    with session.lock:
        session.update_options(
            problem_statement=request.problem,
            test_text=request.test_text,
            test_mode=request.test_mode,
            resolved_test_code=request.resolved_test_code,
            context_enabled=request.context_enabled,
            max_rounds=request.max_rounds,
            plan=request.plan,
            announce_resolved_tests=request.resolved_test_code is not None,
        )
        return ok(session.to_dict())


@app.delete("/api/sessions/{session_id}")
def delete_session(session_id: str) -> dict[str, Any]:
    _ = get_session_or_404(session_id)
    store.delete_session(session_id)
    return {"ok": True}


@app.post("/api/sessions/{session_id}/interrupt")
def interrupt_session(session_id: str) -> dict[str, Any]:
    session = get_session_or_404(session_id)
    session.request_interrupt()
    return ok(session.to_dict(), stage_result={
        "stage": "interrupt",
        "message": "Interrupt requested. The workflow will pause after the current stage.",
        "interrupted": True,
        "passed": session.passed,
    })


@app.post("/api/sessions/{session_id}/actions")
def run_action(session_id: str, request: SessionActionRequest) -> dict[str, Any]:
    session = get_session_or_404(session_id)

    with session.lock:
        if request.context_enabled is not None or request.max_rounds is not None:
            session.update_options(
                problem_statement=request.problem,
                test_text=request.test_text,
                test_mode=request.test_mode,
                context_enabled=request.context_enabled,
                max_rounds=request.max_rounds,
            )
        elif request.problem is not None or request.test_text is not None or request.test_mode is not None:
            session.update_options(
                problem_statement=request.problem,
                test_text=request.test_text,
                test_mode=request.test_mode,
            )
        if request.plan_override is not None:
            session.update_options(plan=request.plan_override)
        if request.resolved_test_code is not None:
            session.update_options(resolved_test_code=request.resolved_test_code)

        try:
            if request.action == "generate":
                stage_result = session.run_generate(use_plan=False)
            elif request.action == "evaluate":
                stage_result = session.run_evaluate()
            elif request.action == "generate_tests":
                stage_result = session.run_generate_tests()
            elif request.action == "plan":
                stage_result = session.run_plan(use_error_feedback=request.use_error_feedback)
            elif request.action == "regenerate":
                stage_result = session.run_generate(use_plan=True)
            elif request.action == "restart":
                session.reset_progress(reset_context=True)
                stage_result = session.run_generate(use_plan=False, from_prompt=False)
            elif request.action == "auto":
                stage_result = session.run_auto(max_rounds=request.max_rounds, resume=False)
            elif request.action == "auto_resume":
                stage_result = session.run_auto(max_rounds=request.max_rounds, resume=True)
            else:
                raise HTTPException(status_code=400, detail=f"Unsupported action: {request.action}")
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except RuntimeError as exc:
            raise HTTPException(status_code=500, detail=str(exc)) from exc

        return ok(session.to_dict(), stage_result=stage_result)


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the AdaAssist backend server.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()

    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
