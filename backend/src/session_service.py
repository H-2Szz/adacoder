from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from threading import RLock
from typing import Any, Literal
from uuid import uuid4

from .Adacoder import Adacoder
from .llm_clients import LLMConfig

SessionAction = Literal["generate", "evaluate", "plan", "regenerate", "restart", "auto", "auto_resume", "generate_tests"]
TestMode = Literal["manual", "generate"]


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def summarize_evaluation(evaluation: dict[str, Any] | None) -> str:
    if not evaluation:
        return "No evaluation result."
    if evaluation.get("passed"):
        return "Evaluation passed."

    parts = [
        f"Stage: {evaluation.get('stage', '')}".strip(),
        f"Error Type: {evaluation.get('error_type', '')}".strip(),
        f"Error: {evaluation.get('error', '')}".strip(),
    ]
    return "\n".join(part for part in parts if part and not part.endswith(": "))


@dataclass
class WorkflowSession:
    problem_statement: str
    test_text: str
    llm_config: LLMConfig
    test_mode: TestMode = "manual"
    context_enabled: bool = False
    max_rounds: int = 3
    session_id: str = field(default_factory=lambda: uuid4().hex)
    created_at: str = field(default_factory=utc_now)
    updated_at: str = field(default_factory=utc_now)
    status: str = "idle"
    current_stage: str = "session"
    current_code: str = ""
    current_plan: str = ""
    latest_evaluation: dict[str, Any] | None = None
    passed: bool = False
    attempt_count: int = 0
    regeneration_count: int = 0
    resolved_test_code: str = ""
    interrupt_requested: bool = False
    context_entries: list[dict[str, Any]] = field(default_factory=list)
    events: list[dict[str, Any]] = field(default_factory=list)
    lock: RLock = field(default_factory=RLock)

    def __post_init__(self) -> None:
        self.engine = Adacoder(self.llm_config)
        self.add_event(
            stage="session",
            status="ready",
            title="Session Created",
            message="Workflow session initialized.",
        )
        self._seed_context_entries()

    def _seed_context_entries(self) -> None:
        self.context_entries = []
        self.add_context(
            role="user",
            kind="problem",
            title="Initial Problem",
            content=self.problem_statement,
        )
        if self.test_mode == "manual" and self.test_text.strip():
            self.add_context(
                role="user",
                kind="tests",
                title="Initial Test Input",
                content=self.test_text,
            )

    def add_event(
        self,
        *,
        stage: str,
        status: str,
        title: str,
        message: str,
        data: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        event = {
            "id": uuid4().hex,
            "stage": stage,
            "status": status,
            "title": title,
            "message": message,
            "data": data or {},
            "created_at": utc_now(),
        }
        self.events.append(event)
        self.updated_at = event["created_at"]
        self.status = status
        self.current_stage = stage
        return event

    def request_interrupt(self) -> None:
        self.interrupt_requested = True
        self.updated_at = utc_now()

    def clear_interrupt(self) -> None:
        self.interrupt_requested = False
        self.updated_at = utc_now()

    def add_context(self, *, role: str, kind: str, title: str, content: str) -> None:
        cleaned = content.strip()
        if not cleaned:
            return
        self.context_entries.append(
            {
                "role": role,
                "kind": kind,
                "title": title,
                "content": cleaned,
                "created_at": utc_now(),
            }
        )
        self.context_entries = self.context_entries[-12:]
        self.updated_at = utc_now()

    def set_resolved_test_code(self, code: str) -> bool:
        cleaned = code.strip()
        if cleaned == self.resolved_test_code:
            return False
        self.resolved_test_code = cleaned
        self.updated_at = utc_now()
        return True

    def remove_context_kinds(self, *kinds: str) -> None:
        if not kinds:
            return
        blocked = set(kinds)
        remaining = [entry for entry in self.context_entries if entry.get("kind") not in blocked]
        if len(remaining) == len(self.context_entries):
            return
        self.context_entries = remaining
        self.updated_at = utc_now()

    def replace_latest_context(
        self,
        *,
        kind: str,
        role: str,
        title: str,
        content: str,
    ) -> bool:
        cleaned = content.strip()
        if not cleaned:
            return False

        for entry in reversed(self.context_entries):
            if entry.get("kind") != kind:
                continue
            entry["role"] = role
            entry["kind"] = kind
            entry["title"] = title
            entry["content"] = cleaned
            self.updated_at = utc_now()
            return True
        return False

    def replace_latest_plan_event(self, *, plan: str) -> bool:
        cleaned = plan.strip()
        if not cleaned:
            return False

        for event in reversed(self.events):
            if event.get("stage") != "plan":
                continue
            data = dict(event.get("data") or {})
            data["plan"] = cleaned
            data["plan_length"] = len(cleaned)
            data["edited"] = True
            event["status"] = "ready"
            event["title"] = "Plan Edited"
            event["message"] = "Plan was updated in place from the frontend editor."
            event["data"] = data
            self.updated_at = utc_now()
            self.status = "ready"
            self.current_stage = "plan"
            return True
        return False

    def reset_progress(self, *, reset_context: bool, preserve_resolved_tests: bool = True) -> None:
        self.current_code = ""
        self.current_plan = ""
        self.latest_evaluation = None
        self.passed = False
        self.attempt_count = 0
        self.regeneration_count = 0
        if not preserve_resolved_tests:
            self.resolved_test_code = ""
        if reset_context:
            self._seed_context_entries()
        self.add_event(
            stage="session",
            status="idle",
            title="Progress Reset",
            message="Current workflow progress was reset.",
        )

    def update_options(
        self,
        *,
        problem_statement: str | None = None,
        test_text: str | None = None,
        test_mode: TestMode | None = None,
        context_enabled: bool | None = None,
        max_rounds: int | None = None,
        plan: str | None = None,
        resolved_test_code: str | None = None,
        announce_resolved_tests: bool = False,
    ) -> None:
        if context_enabled is not None and context_enabled != self.context_enabled:
            self.context_enabled = context_enabled
            self.add_event(
                stage="session",
                status="ready",
                title="Context Enabled" if self.context_enabled else "Context Disabled",
                message=(
                    "Context memory is now enabled. Future model calls will reuse the saved history."
                    if self.context_enabled
                    else "Context memory is now disabled. Saved history remains visible, but future model calls will start fresh."
                ),
            )

        if problem_statement is not None:
            cleaned_problem = problem_statement.strip()
            if cleaned_problem and cleaned_problem != self.problem_statement:
                self.problem_statement = cleaned_problem
                self.add_context(
                    role="user",
                    kind="problem",
                    title="Updated Problem",
                    content=self.problem_statement,
                )

        tests_changed = False
        if test_text is not None:
            cleaned_test_text = test_text.strip()
            if cleaned_test_text != self.test_text:
                self.test_text = cleaned_test_text
                tests_changed = True

        if test_mode is not None and test_mode != self.test_mode:
            self.test_mode = test_mode
            tests_changed = True

        if tests_changed:
            self.resolved_test_code = ""
            if self.test_mode == "generate":
                self.remove_context_kinds("tests", "test_prompt")
            elif self.test_text:
                self.add_context(
                    role="user",
                    kind="tests",
                    title="Updated Test Input",
                    content=self.test_text,
                )

        if resolved_test_code is not None:
            tests_changed = self.set_resolved_test_code(resolved_test_code)
            if self.resolved_test_code and (tests_changed or announce_resolved_tests):
                self.add_event(
                    stage="tests",
                    status="ready",
                    title="Use Edited Tests",
                    message="The editable test suite is now selected for future evaluations.",
                    data={
                        "mode": self.test_mode,
                        "test_length": len(self.resolved_test_code),
                        "test_code": self.resolved_test_code,
                        "edited": True,
                    },
                )

        if max_rounds is not None and max_rounds > 0:
            self.max_rounds = max_rounds
        if plan is not None:
            self.current_plan = plan.strip()
            replaced_event = self.replace_latest_plan_event(plan=self.current_plan)
            replaced_context = self.replace_latest_context(
                role="assistant",
                kind="plan",
                title="Edited Plan",
                content=self.current_plan,
            )
            if not replaced_event:
                self.add_event(
                    stage="plan",
                    status="ready",
                    title="Plan Updated",
                    message="Plan was updated from the frontend editor.",
                    data={
                        "plan_length": len(self.current_plan),
                        "plan": self.current_plan,
                    },
                )
            if not replaced_context:
                self.add_context(
                    role="assistant",
                    kind="plan",
                    title="Edited Plan",
                    content=self.current_plan,
                )

    def _context_for_llm(self) -> list[dict[str, Any]] | None:
        if not self.context_enabled:
            return None
        return list(self.context_entries)

    def resolve_generated_tests(self, *, force_regenerate: bool = False) -> str:
        if self.resolved_test_code.strip() and not force_regenerate:
            return self.resolved_test_code

        result = self.engine.generate_tests(
            self.problem_statement,
            test_description="",
            context_entries=None,
        )
        if not result.get("ok"):
            raise RuntimeError(str(result.get("error", result.get("message", "Test generation failed."))))

        self.set_resolved_test_code(str(result.get("test_code", "")))
        return self.resolved_test_code

    def prepare_tests(self, *, force_regenerate: bool = False) -> str:
        if self.test_mode == "manual":
            cleaned_test_text = self.test_text.strip()
            if not cleaned_test_text:
                raise ValueError("Test text is empty. Paste Python tests or switch to model-generated tests.")
            if self.resolved_test_code != cleaned_test_text:
                self.resolved_test_code = cleaned_test_text
                self.add_event(
                    stage="tests",
                    status="completed",
                    title="Use Provided Tests",
                    message="Using the test code provided in the text area.",
                    data={
                        "mode": "manual",
                        "test_length": len(self.resolved_test_code),
                        "test_code": self.resolved_test_code,
                    },
                )
            return self.resolved_test_code

        return self.resolve_generated_tests(force_regenerate=force_regenerate)

    def run_generate_tests(self) -> dict[str, Any]:
        test_code = self.prepare_tests(force_regenerate=self.test_mode == "generate")
        message = (
            "Generated tests are ready in the isolated test workspace."
            if self.test_mode == "generate"
            else "Manual tests copied into the test workspace."
        )
        if self.test_mode == "generate":
            self.add_event(
                stage="tests",
                status="completed",
                title="Generate Tests",
                message=message,
                data={
                    "mode": self.test_mode,
                    "test_length": len(test_code),
                    "test_code": test_code,
                },
            )
        return {
            "ok": True,
            "stage": "tests",
            "message": message,
            "test_mode": self.test_mode,
            "test_code": test_code,
        }

    def run_generate(self, *, use_plan: bool, from_prompt: bool = False) -> dict[str, Any]:
        if from_prompt:
            self.reset_progress(reset_context=True)

        if use_plan and not self.current_plan.strip():
            raise ValueError("No plan is available. Generate or edit a plan first.")

        stage = "regenerate" if use_plan else "generate"
        stage_title = "Regenerate Code" if use_plan else "Generate Code"
        self.add_event(
            stage=stage,
            status="running",
            title=stage_title,
            message="Calling the model to generate code.",
        )

        result = self.engine.generate_code(
            self.problem_statement,
            plan=self.current_plan if use_plan else "",
            context_entries=self._context_for_llm(),
            stage=stage,
        )
        self.attempt_count += 1
        if use_plan:
            self.regeneration_count += 1

        if not result.get("ok"):
            self.add_event(
                stage=stage,
                status="failed",
                title=stage_title,
                message=result.get("message", "Code generation failed."),
                data={"attempts": result.get("attempts", 0)},
            )
            raise RuntimeError(str(result.get("error", result.get("message", "Generation failed."))))

        self.current_code = str(result.get("code", ""))
        self.passed = False
        self.add_event(
            stage=stage,
            status="completed",
            title=stage_title,
            message=result.get("message", "Code generation completed."),
            data={
                "attempts": result.get("attempts", 0),
                "code_length": len(self.current_code),
                "code": self.current_code,
            },
        )
        self.add_context(
            role="assistant",
            kind="code",
            title="Generated Code",
            content=self.current_code,
        )
        return result

    def run_evaluate(self) -> dict[str, Any]:
        if not self.current_code.strip():
            raise ValueError("No generated code is available to evaluate.")

        test_code = self.prepare_tests()

        self.add_event(
            stage="evaluate",
            status="running",
            title="Evaluate Code",
            message="Running the generated code against the current test text.",
            data={"test_mode": self.test_mode},
        )
        result = self.engine.evaluate_code(self.current_code, test_code)
        evaluation = result.get("evaluation", {})
        self.latest_evaluation = evaluation
        self.passed = bool(evaluation.get("passed", False))

        self.add_event(
            stage="evaluate",
            status="completed" if self.passed else "failed",
            title="Evaluate Code",
            message=result.get("message", "Code evaluation finished."),
            data={"evaluation": evaluation},
        )
        self.add_context(
            role="system",
            kind="evaluation",
            title="Latest Evaluation",
            content=summarize_evaluation(evaluation),
        )
        return result

    def run_plan(self, *, use_error_feedback: bool) -> dict[str, Any]:
        self.add_event(
            stage="plan",
            status="running",
            title="Create Plan",
            message="Generating a repair plan from the current task state.",
            data={"use_error_feedback": use_error_feedback},
        )
        result = self.engine.create_plan(
            self.problem_statement,
            evaluation=self.latest_evaluation,
            context_entries=self._context_for_llm(),
            use_error_feedback=use_error_feedback,
        )
        if not result.get("ok"):
            self.add_event(
                stage="plan",
                status="failed",
                title="Create Plan",
                message=result.get("message", "Plan generation failed."),
                data={"attempts": result.get("attempts", 0)},
            )
            raise RuntimeError(str(result.get("error", result.get("message", "Plan generation failed."))))

        self.current_plan = str(result.get("plan", "")).strip()
        self.add_event(
            stage="plan",
            status="completed",
            title="Create Plan",
            message=result.get("message", "Plan generated."),
            data={
                "attempts": result.get("attempts", 0),
                "used_error_feedback": result.get("used_error_feedback", use_error_feedback),
                "plan": self.current_plan,
            },
        )
        self.add_context(
            role="assistant",
            kind="plan",
            title="Generated Plan",
            content=self.current_plan,
        )
        return result

    def run_debug_fix(self) -> dict[str, Any] | None:
        if not self.latest_evaluation:
            return None
        if not self.engine.debugger.could_be_fixed(
            self.latest_evaluation.get("stage", ""),
            self.latest_evaluation.get("error_type", ""),
        ):
            return None

        self.add_event(
            stage="debug_fix",
            status="running",
            title="Apply Local Fix",
            message="Trying lightweight local fixes before replanning.",
        )
        result = self.engine.apply_debug_fix(self.current_code, self.latest_evaluation)
        if not result.get("changed"):
            self.add_event(
                stage="debug_fix",
                status="failed",
                title="Apply Local Fix",
                message=result.get("message", "No local fix was available."),
            )
            return result

        self.current_code = str(result.get("code", self.current_code))
        self.add_event(
            stage="debug_fix",
            status="completed",
            title="Apply Local Fix",
            message=result.get("message", "Local fix applied."),
            data={
                "fixes": result.get("fixes", []),
                "code": self.current_code,
            },
        )
        self.add_context(
            role="assistant",
            kind="code",
            title="Locally Fixed Code",
            content=self.current_code,
        )
        return result

    def _auto_result(self, *, message: str, passed: bool, interrupted: bool) -> dict[str, Any]:
        return {
            "ok": True,
            "stage": "auto",
            "message": message,
            "passed": passed,
            "interrupted": interrupted,
        }

    def _interrupt_auto(self, *, message: str) -> dict[str, Any]:
        self.add_event(
            stage="auto",
            status="ready",
            title="Auto Workflow Paused",
            message=message,
        )
        self.clear_interrupt()
        return self._auto_result(message=message, passed=self.passed, interrupted=True)

    def _complete_auto(self, *, message: str) -> dict[str, Any]:
        self.add_event(
            stage="auto",
            status="completed",
            title="Run Auto Workflow",
            message=message,
        )
        self.clear_interrupt()
        return self._auto_result(message=message, passed=True, interrupted=False)

    def _fail_auto(self, *, message: str) -> dict[str, Any]:
        self.add_event(
            stage="auto",
            status="failed",
            title="Run Auto Workflow",
            message=message,
        )
        self.clear_interrupt()
        return self._auto_result(message=message, passed=False, interrupted=False)

    def run_auto(self, *, max_rounds: int | None = None, resume: bool = False) -> dict[str, Any]:
        rounds = max_rounds if max_rounds is not None else self.max_rounds
        self.clear_interrupt()

        if not resume:
            self.reset_progress(reset_context=True)
            self.add_event(
                stage="auto",
                status="running",
                title="Run Auto Workflow",
                message="Starting the full workflow.",
                data={"max_rounds": rounds},
            )
        else:
            self.add_event(
                stage="auto",
                status="running",
                title="Resume Auto Workflow",
                message="Resuming the full workflow from the current progress.",
                data={"max_rounds": rounds, "resume": True},
            )

        if self.passed:
            return self._complete_auto(message="The workflow is already complete.")

        if not self.current_code.strip():
            self.run_generate(use_plan=False)
            if self.interrupt_requested:
                return self._interrupt_auto(message="Auto workflow paused after code generation. Resume to continue with evaluation.")
        elif self.current_stage == "plan" and self.current_plan.strip():
            self.run_generate(use_plan=True)
            if self.interrupt_requested:
                return self._interrupt_auto(message="Auto workflow paused after regenerating code from the current plan.")

        if self.current_stage in {"generate", "restart", "regenerate", "debug_fix"} or not self.latest_evaluation:
            evaluation_result = self.run_evaluate()
            if evaluation_result.get("evaluation", {}).get("passed"):
                return self._complete_auto(message="The workflow completed successfully.")
            if self.interrupt_requested:
                return self._interrupt_auto(message="Auto workflow paused after evaluation. Resume to continue the next iteration.")
        else:
            evaluation_result = {"evaluation": self.latest_evaluation}
            if evaluation_result.get("evaluation", {}).get("passed"):
                return self._complete_auto(message="The workflow completed successfully.")

        while self.regeneration_count < rounds:
            if not (self.current_stage == "plan" and self.current_plan.strip()):
                debug_fix = self.run_debug_fix()
                if debug_fix and debug_fix.get("changed"):
                    if self.interrupt_requested:
                        return self._interrupt_auto(message="Auto workflow paused after applying a local fix. Resume to continue with evaluation.")
                    evaluation_result = self.run_evaluate()
                    if evaluation_result.get("evaluation", {}).get("passed"):
                        return self._complete_auto(message="The workflow completed successfully after a local fix.")
                    if self.interrupt_requested:
                        return self._interrupt_auto(message="Auto workflow paused after evaluation. Resume to continue the next iteration.")

                self.run_plan(use_error_feedback=True)
                if self.interrupt_requested:
                    return self._interrupt_auto(message="Auto workflow paused after generating a repair plan.")

            self.run_generate(use_plan=True)
            if self.interrupt_requested:
                return self._interrupt_auto(message="Auto workflow paused after regenerating code from the current plan.")
            evaluation_result = self.run_evaluate()
            if evaluation_result.get("evaluation", {}).get("passed"):
                return self._complete_auto(message="The workflow completed successfully after replanning.")
            if self.interrupt_requested:
                return self._interrupt_auto(message="Auto workflow paused after evaluation. Resume to continue the next iteration.")

        return self._fail_auto(message="The workflow reached the configured retry limit without passing.")

    def to_dict(self) -> dict[str, Any]:
        return {
            "session_id": self.session_id,
            "problem_statement": self.problem_statement,
            "test_text": self.test_text,
            "test_mode": self.test_mode,
            "context_enabled": self.context_enabled,
            "max_rounds": self.max_rounds,
            "status": self.status,
            "current_stage": self.current_stage,
            "current_code": self.current_code,
            "current_plan": self.current_plan,
            "resolved_test_code": self.resolved_test_code,
            "latest_evaluation": self.latest_evaluation,
            "passed": self.passed,
            "attempt_count": self.attempt_count,
            "regeneration_count": self.regeneration_count,
            "events": self.events,
            "context_entries": self.context_entries,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "available_actions": self.available_actions(),
        }

    def available_actions(self) -> list[str]:
        actions = ["generate", "restart", "auto", "auto_resume"]
        if self.test_mode == "generate":
            actions.append("generate_tests")
        if self.current_code.strip():
            actions.append("evaluate")
        if self.latest_evaluation and not self.latest_evaluation.get("passed", False):
            actions.append("plan")
        if self.current_plan.strip():
            actions.append("regenerate")
        return actions


class SessionStore:
    def __init__(self) -> None:
        self._sessions: dict[str, WorkflowSession] = {}
        self._lock = RLock()

    def create_session(
        self,
        *,
        problem_statement: str,
        test_text: str,
        llm_config: LLMConfig,
        test_mode: TestMode,
        context_enabled: bool,
        max_rounds: int,
    ) -> WorkflowSession:
        session = WorkflowSession(
            problem_statement=problem_statement,
            test_text=test_text,
            llm_config=llm_config,
            test_mode=test_mode,
            context_enabled=context_enabled,
            max_rounds=max_rounds,
        )
        with self._lock:
            self._sessions[session.session_id] = session
        return session

    def get_session(self, session_id: str) -> WorkflowSession:
        with self._lock:
            session = self._sessions.get(session_id)
        if session is None:
            raise KeyError(f"Session not found: {session_id}")
        return session

    def delete_session(self, session_id: str) -> None:
        with self._lock:
            if session_id in self._sessions:
                del self._sessions[session_id]

    def list_sessions(self) -> list[dict[str, Any]]:
        with self._lock:
            return [session.to_dict() for session in self._sessions.values()]
