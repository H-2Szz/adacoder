# 先调用模型进行生成直接生成，第一步是没有计划的，直接根据描述进行生成

# 计划：
# 1.调用模型直接生成，模型router保留，第一步是没有plan输入的
# 2.上一个可以服用，如果有plan（就是失败之后会有一个模型生成plan继续生成）

# 工具计划：分成4个输入
# 1.用户需求（必须）
# 2.需要导入的模块（不是必须）
# 3.测试例子（不是必须）
# 4.测试代码存放的文件（必须）
from ..llm_clients import LLMRouter,LLMConfig
import re

from ..utils import preprocess, preprocess_tests
import traceback
from typing import Any

class AdacoderExecutor():
    def __init__(self,system_prompt:str="",LLM_Config:LLMConfig=LLMConfig()):
        self.llmconfig=LLM_Config
        self.llmrouter=self._init_roter(system_prompt,LLM_Config)

    def _init_roter(self,system_prompt:str,LLM_Config:LLMConfig):
        return LLMRouter(system_prompt,LLM_Config)

    def _extract_target_symbols(self, problem_statement: str) -> list[str]:
        patterns = [
            r"\bdef\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(",
            r"\bclass\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(|:)",
            r"\bfunction\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(",
            r"(?:实现|编写|定义|实现函数|函数)\s*`?([A-Za-z_][A-Za-z0-9_]*)`?\s*\(",
            r"(?:implement|write|define)\s+(?:the\s+)?(?:function|class)\s+`?([A-Za-z_][A-Za-z0-9_]*)`?",
        ]
        names: list[str] = []
        for pattern in patterns:
            for match in re.findall(pattern, problem_statement, flags=re.IGNORECASE):
                if match and match not in names:
                    names.append(match)
        return names[:6]

    def _build_context_block(self, context_entries: list[dict[str, Any]] | None) -> str:
        if not context_entries:
            return ""

        sections: list[str] = []
        for index, entry in enumerate(context_entries[-8:], start=1):
            if not isinstance(entry, dict):
                continue

            role = str(entry.get("role", "system")).strip() or "system"
            kind = str(entry.get("kind", "context")).strip() or "context"
            content = str(entry.get("content", "")).strip()
            if not content:
                continue

            title = str(entry.get("title", kind)).strip() or kind
            sections.append(
                f"### {index}. {title} ({role})\n{content}"
            )

        if not sections:
            return ""

        return (
            "## Context\n"
            "Reuse the following context when it is helpful, but prioritize the current task.\n\n"
            + "\n\n".join(sections)
            + "\n\n"
        )
    
    def execute_coder(
        self,
        problem_statement:str="",
        plan:str="",
        context_entries: list[dict[str, Any]] | None = None,
    )->dict[str, Any]:
        if problem_statement=="":
            raise(RuntimeError("输入不能是空"))
        context_block = self._build_context_block(context_entries)
        if not plan:#没有计划（第一次输入）
            user_prompt = f"""
{context_block}## Task Description
{problem_statement}"""
        else:
            user_prompt=f"""{context_block}Solve the following problem according to the given plan.

## Plan
{plan}

## Task Description
{problem_statement}"""
        trytime=10
        attempts=0
        code=""
        while trytime>0:
            trytime-=1
            attempts+=1
            try:
                res=self.llmrouter.generate(user_prompt=user_prompt)
                # 这边拿到code就行了，然后执行code看看成没成功
                code=preprocess(res)
            except Exception as e:
                code=""
            if code:
                break

        return {
            "code": code,
            "attempts": attempts,
            "prompt": user_prompt,
            "ok": bool(code),
        }

    def generate_test_code(
        self,
        problem_statement: str = "",
        test_description: str = "",
        context_entries: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        if not problem_statement:
            raise RuntimeError("输入不能是空")

        context_block = self._build_context_block(context_entries)
        cleaned_description = test_description.strip()
        if not cleaned_description:
            cleaned_description = (
                "Create a compact Python test suite that validates the expected behavior, "
                "important edge cases, and obvious failure paths when applicable."
            )
        target_symbols = self._extract_target_symbols(problem_statement)
        target_block = ""
        if target_symbols:
            joined = "\n".join(f"- {symbol}" for symbol in target_symbols)
            target_block = f"""
## Required Symbols
The candidate solution is expected to define and expose these symbols already.
You must call them in the tests and must NOT redefine them.
{joined}
"""

        user_prompt = f"""{context_block}Write runnable Python test code for the task below.

## Task Description
{problem_statement}
{target_block}

## Test Guidance
{cleaned_description}

## Output Rules
- Output ONLY Python test code.
- Do not wrap the answer in markdown fences.
- The candidate solution has already been executed into the same namespace.
- Do NOT implement or redefine the candidate solution.
- Do NOT define the required functions or classes again.
- Use plain top-level `assert` statements only.
- Do NOT use `unittest`, `pytest`, or custom test frameworks.
- If helper functions are needed, keep them small and still end with direct top-level `assert` checks.
- Every valid answer must contain at least one `assert`.
- The test code should fail loudly when the implementation is wrong.
"""

        trytime = 10
        attempts = 0
        test_code = ""
        while trytime > 0:
            trytime -= 1
            attempts += 1
            try:
                res = self.llmrouter.generate(user_prompt=user_prompt)
                test_code = preprocess_tests(res, target_symbols=target_symbols)
            except Exception:
                test_code = ""
            if test_code:
                break

        return {
            "test_code": test_code,
            "attempts": attempts,
            "prompt": user_prompt,
            "ok": bool(test_code),
        }

    def evaluate_code(self,code: str, test_code: str)->dict:
        namespace = {}

        try:
            # 先检查用户代码能不能编译
            compile(code, "<coder>", "exec")
        except Exception as e:
            return {
                "passed": False,
                "stage": "compile",
                "error_type":type(e).__name__,
                "error": str(e),
                "traceback": traceback.format_exc(),
            }

        try:
            # 执行用户代码，把函数/变量放进同一个命名空间
            exec(code, namespace, namespace)
        except Exception as e:
            return {
                "passed": False,
                "stage": "exec_code",
                "error_type":type(e).__name__,
                "error": str(e),
                "traceback": traceback.format_exc(),
            }

        cleaned_test_code = test_code.strip()
        if not cleaned_test_code:
            return {
                "passed": False,
                "stage": "prepare_tests",
                "error_type": "ValueError",
                "error": "No test code was provided.",
                "traceback": None,
            }

        try:
            compile(cleaned_test_code, "<tests>", "exec")
        except Exception as e:
            return {
                "passed": False,
                "stage": "compile_tests",
                "error_type":type(e).__name__,
                "error": str(e),
                "traceback": traceback.format_exc(),
            }

        try:
            # 执行测试代码；测试代码里如果有 assert / check(...) 顶层调用，就会真正跑起来
            exec(cleaned_test_code, namespace, namespace)
        except Exception as e:
            return {
                "passed": False,
                "stage": "exec_tests",
                "error_type":type(e).__name__,
                "error": str(e),
                "traceback": traceback.format_exc(),
            }

        return {
            "passed": True,
            "stage": "pass",
            "error_type":None,
            "error": None,
            "traceback": None,
        }
    
    def execute_planner(
        self,
        problem_statement:str="",
        relat_err_dict:dict | None = None,
        context_entries: list[dict[str, Any]] | None = None,
        use_error_feedback: bool = True,
    )->dict[str, Any]:
        if not problem_statement:
            raise(RuntimeError("输入不能是空"))
        relat_err_dict = relat_err_dict or {}
        context_block = self._build_context_block(context_entries)
        if use_error_feedback:
            feedback_block = f"""## Error Feedback
Error Type: {relat_err_dict.get("error_type","")}
Error Message: {relat_err_dict.get("error","")}
Error Stage: {relat_err_dict.get("stage","")}"""
        else:
            feedback_block = """## Error Feedback
Ignore previous runtime/test feedback and build the plan only from the task description."""

        user_prompt=f"""{context_block}Develop a new plan for the problem.

## Task Description
{problem_statement}

{feedback_block}

## Let's explore various approaches and perspectives to solve this problem.

You must output ONLY in the following markdown format.
Do not add any extra explanation.
Do not output code.

## Plan
- Firstly,...
- <step 2>
- ...
"""
        trytime=10
        attempts=0
        plan=""
        while trytime>0:
            trytime-=1
            attempts+=1
            try:
                plan=self.llmrouter.generate(user_prompt=user_prompt)
            except Exception as e:
                plan=""
            if plan:
                break

        return {
            "plan": plan.strip(),
            "attempts": attempts,
            "prompt": user_prompt,
            "ok": bool(plan.strip()),
            "used_error_feedback": use_error_feedback,
        }
        
