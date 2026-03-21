import json
import re
from pathlib import Path
modules_path=str(Path(__file__).resolve().parent.parent / "modules" / "modules.json")

def invert_dict(d1):
    d2 = {}
    for key, value_list in d1.items():
        for value in value_list:
            d2[value] = key
    return d2


class DebugSpecialist:
    """
    只修三类：
    1. IndentationError -> 规范缩进
    2. SyntaxError      -> 尾部截断修复
    3. NameError        -> 缺失 import 注入
    """

    def __init__(self,modules_json_path: str = modules_path):
        with open(modules_json_path, "r", encoding="utf-8") as f:
            raw = json.load(f)

        # 函数/类名 -> 模块名
        self.fcs = invert_dict(raw)

        # 原仓库里的模块白名单思路
        self.modules = {
            "math", "typing", "functools", "string", "hashlib", "random",
            "heapq", "re", "numpy", "cmath", "itertools", "pandas",
            "pytest", "scipy", "matplotlib", "sklearn", "pyglet",
            "OpenGL", "decimal", "datetime", "collections", "fractions"
        }

    def could_be_fixed(self, stage: str, err_type: str) -> bool:
        if stage not in {"compile", "exec_code"}:
            return False
        return err_type in {"NameError", "SyntaxError", "IndentationError"}

    def fix(self, code: str, eval_result: dict) -> dict:
        err_type = eval_result.get("error_type", "")
        err_msg = eval_result.get("error", "")
        stage = eval_result.get("stage", "")

        if not self.could_be_fixed(stage, err_type):
            return {
                "fixed_code": code,
                "changed": False,
                "fixes": [],
            }

        fixed_code = code
        fixes = []

        if err_type == "IndentationError":
            new_code = self.fix_indentation(fixed_code)
            if new_code != fixed_code:
                fixed_code = new_code
                fixes.append("fix_indentation")

        elif err_type == "SyntaxError":
            new_code = self.fix_syntax_by_truncation(fixed_code)
            if new_code != fixed_code:
                fixed_code = new_code
                fixes.append("fix_truncation")

        elif err_type == "NameError":
            new_code = self.fix_name_error(fixed_code, err_msg)
            if new_code != fixed_code:
                fixed_code = new_code
                fixes.append("inject_import")

        return {
            "fixed_code": fixed_code,
            "changed": len(fixes) > 0,
            "fixes": fixes,
        }

    # ---------- 1) Inconsistent Indentation ----------
    def fix_indentation(self, code: str) -> str:
        """
        论文里的 Code Filtering：规范缩进。
        这里做保守处理：
        - tab -> 4 spaces
        - 去掉行尾空白
        """
        lines = code.splitlines()
        new_lines = []
        for line in lines:
            line = line.replace("\t", "    ").rstrip()
            new_lines.append(line)
        return "\n".join(new_lines)

    # ---------- 2) Function Overflow ----------
    def fix_syntax_by_truncation(self, code: str, max_rounds: int = 200) -> str:
        """
        论文里的 Code Truncation：
        从代码末尾一行一行删除，直到 compile 成功。
        """
        current = code
        for _ in range(max_rounds):
            try:
                compile(current, "", "exec")
                return current
            except Exception:
                if not current.strip():
                    return current
                current = self.remove_last_line(current)
        return current

    @staticmethod
    def remove_last_line(code: str) -> str:
        lines = code.splitlines()
        if not lines:
            return code
        return "\n".join(lines[:-1])

    # ---------- 3) Missing Import ----------
    def fix_name_error(self, code: str, err_msg: str) -> str:
        """
        论文里的 Missing Modules Injection：
        从 NameError 中提取名字，匹配模块库，补 import。
        """
        missing_name = self.extract_name_from_name_error(err_msg)
        if not missing_name:
            return code

        import_stmt = None

        # 情况1：缺的是模块本身，比如 math
        if missing_name in self.modules:
            import_stmt = f"import {missing_name}"

        # 情况2：缺的是模块中的函数/类，比如 List / Counter / lru_cache
        elif missing_name in self.fcs:
            module_name = self.fcs[missing_name]
            import_stmt = f"from {module_name} import {missing_name}"

        if not import_stmt:
            return code

        return self.prepend_import_if_needed(code, import_stmt)

    @staticmethod
    def extract_name_from_name_error(err_msg: str) -> str:
        m = re.search(r"name ['\"](.+?)['\"] is not defined", err_msg or "")
        return m.group(1) if m else ""

    @staticmethod
    def prepend_import_if_needed(code: str, import_stmt: str) -> str:
        if import_stmt in code:
            return code

        lines = code.splitlines()
        insert_pos = 0

        while insert_pos < len(lines):
            line = lines[insert_pos].strip()
            if line.startswith("#!") or "coding" in line:
                insert_pos += 1
            else:
                break

        new_lines = lines[:insert_pos] + [import_stmt] + lines[insert_pos:]
        return "\n".join(new_lines)