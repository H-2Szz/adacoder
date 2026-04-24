from __future__ import annotations

from typing import Any, Callable

from .executor import AdacoderExecutor
from .llm_clients import LLMConfig
from .utils import DebugSpecialist

StageCallback = Callable[[dict[str, Any]], None]


class Adacoder:
    def __init__(self, config: LLMConfig, planner_config: LLMConfig | None = None):
        self.coder_config = config
        self.planner_config = planner_config or config
        self.coder = self._init_coder()
        self.planner = self._init_planner()
        self.tester = self._init_tester()
        self.debugger = self._init_debugger()

    def _init_coder(self) -> AdacoderExecutor:
        return AdacoderExecutor(
            system_prompt="You are an expert programming assistant.",
            LLM_Config=self.coder_config,
        )

    def _init_planner(self) -> AdacoderExecutor:
        return AdacoderExecutor(
            system_prompt="You are a programming planning assistant.",
            LLM_Config=self.planner_config,
        )

    def _init_tester(self) -> AdacoderExecutor:
        return AdacoderExecutor(
            system_prompt="You are an expert Python test writer.",
            LLM_Config=self.coder_config,
        )

    def _init_debugger(self) -> DebugSpecialist:
        return DebugSpecialist()

    def generate_code(
        self,
        problem_statement: str,
        *,
        plan: str = "",
        context_entries: list[dict[str, Any]] | None = None,
        stage: str = "generate",
    ) -> dict[str, Any]:
        result = self.coder.execute_coder(
            problem_statement=problem_statement,
            plan=plan,
            context_entries=context_entries,
        )
        code = result.get("code", "")
        if not code:
            return {
                "ok": False,
                "stage": stage,
                "message": "Failed to generate code from the model.",
                "attempts": result.get("attempts", 0),
                "prompt": result.get("prompt", ""),
                "code": "",
                "error": "No code was returned by the model.",
            }

        return {
            "ok": True,
            "stage": stage,
            "message": "Code generation completed.",
            "attempts": result.get("attempts", 0),
            "prompt": result.get("prompt", ""),
            "code": code,
        }

    def generate_tests(
        self,
        problem_statement: str,
        *,
        test_description: str = "",
        context_entries: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        result = self.tester.generate_test_code(
            problem_statement=problem_statement,
            test_description=test_description,
            context_entries=context_entries,
        )
        test_code = result.get("test_code", "")
        if not test_code:
            return {
                "ok": False,
                "stage": "tests",
                "message": "Failed to generate tests from the model.",
                "attempts": result.get("attempts", 0),
                "prompt": result.get("prompt", ""),
                "test_code": "",
                "error": "No test code was returned by the model.",
            }

        return {
            "ok": True,
            "stage": "tests",
            "message": "Test generation completed.",
            "attempts": result.get("attempts", 0),
            "prompt": result.get("prompt", ""),
            "test_code": test_code,
        }

    def evaluate_code(self, code: str, test_code: str) -> dict[str, Any]:
        result = self.coder.evaluate_code(code=code, test_code=test_code)
        message = "Code passed all tests." if result.get("passed") else "Code evaluation failed."
        return {
            "ok": True,
            "stage": "evaluate",
            "message": message,
            "evaluation": result,
        }

    def create_plan(
        self,
        problem_statement: str,
        *,
        evaluation: dict[str, Any] | None = None,
        context_entries: list[dict[str, Any]] | None = None,
        use_error_feedback: bool = True,
    ) -> dict[str, Any]:
        result = self.planner.execute_planner(
            problem_statement=problem_statement,
            relat_err_dict=evaluation or {},
            context_entries=context_entries,
            use_error_feedback=use_error_feedback,
        )
        plan = result.get("plan", "")
        if not plan:
            return {
                "ok": False,
                "stage": "plan",
                "message": "Failed to generate a plan.",
                "attempts": result.get("attempts", 0),
                "prompt": result.get("prompt", ""),
                "plan": "",
                "error": "No plan was returned by the model.",
                "used_error_feedback": use_error_feedback,
            }

        return {
            "ok": True,
            "stage": "plan",
            "message": "Plan generated successfully.",
            "attempts": result.get("attempts", 0),
            "prompt": result.get("prompt", ""),
            "plan": plan,
            "used_error_feedback": use_error_feedback,
        }

    def apply_debug_fix(self, code: str, evaluation: dict[str, Any]) -> dict[str, Any]:
        fix_result = self.debugger.fix(code, evaluation)
        fixed_code = fix_result.get("fixed_code", code)
        changed = bool(fix_result.get("changed", False))
        return {
            "ok": changed,
            "stage": "debug_fix",
            "message": "Applied local debug fixes." if changed else "No local debug fix was applied.",
            "changed": changed,
            "fixes": fix_result.get("fixes", []),
            "code": fixed_code,
        }

    def workflow(
        self,
        problem_statement: str,
        test_code: str,
        *,
        context_entries: list[dict[str, Any]] | None = None,
        max_rounds: int = 3,
        emit: StageCallback | None = None,
    ) -> dict[str, Any]:
        events: list[dict[str, Any]] = []

        def record(event: dict[str, Any]) -> None:
            events.append(event)
            if emit is not None:
                emit(event)

        current_context = list(context_entries or [])

        generation = self.generate_code(
            problem_statement,
            context_entries=current_context,
            stage="generate",
        )
        record(generation)
        if not generation.get("ok"):
            return {
                "passed": False,
                "error": generation.get("error", generation.get("message", "")),
                "events": events,
            }

        code = generation.get("code", "")
        evaluation_result = self.evaluate_code(code, test_code)
        record(evaluation_result)
        evaluation = evaluation_result.get("evaluation", {})
        if evaluation.get("passed"):
            return {
                "passed": True,
                "code": code,
                "code_test_res_dict": evaluation,
                "events": events,
            }

        for _ in range(max_rounds):
            if self.debugger.could_be_fixed(
                evaluation.get("stage", ""),
                evaluation.get("error_type", ""),
            ):
                fix_result = self.apply_debug_fix(code, evaluation)
                record(fix_result)
                if fix_result.get("changed"):
                    code = fix_result.get("code", code)
                    evaluation_result = self.evaluate_code(code, test_code)
                    record(evaluation_result)
                    evaluation = evaluation_result.get("evaluation", {})
                    if evaluation.get("passed"):
                        return {
                            "passed": True,
                            "code": code,
                            "code_test_res_dict": evaluation,
                            "events": events,
                        }

            plan_result = self.create_plan(
                problem_statement,
                evaluation=evaluation,
                context_entries=current_context,
                use_error_feedback=True,
            )
            record(plan_result)
            if not plan_result.get("ok"):
                return {
                    "passed": False,
                    "code": code,
                    "code_test_res_dict": evaluation,
                    "error": plan_result.get("error", plan_result.get("message", "")),
                    "events": events,
                }

            generation = self.generate_code(
                problem_statement,
                plan=plan_result.get("plan", ""),
                context_entries=current_context,
                stage="regenerate",
            )
            record(generation)
            if not generation.get("ok"):
                return {
                    "passed": False,
                    "code": code,
                    "code_test_res_dict": evaluation,
                    "error": generation.get("error", generation.get("message", "")),
                    "events": events,
                }

            code = generation.get("code", "")
            evaluation_result = self.evaluate_code(code, test_code)
            record(evaluation_result)
            evaluation = evaluation_result.get("evaluation", {})
            if evaluation.get("passed"):
                return {
                    "passed": True,
                    "code": code,
                    "code_test_res_dict": evaluation,
                    "events": events,
                }

        return {
            "passed": False,
            "code": code,
            "code_test_res_dict": evaluation,
            "events": events,
        }
