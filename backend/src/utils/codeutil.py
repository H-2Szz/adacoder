import re

def find_all_occurrences(text: str, sub: str):
    positions = []
    start = 0
    while True:
        idx = text.find(sub, start)
        if idx == -1:
            break
        positions.append(idx)
        start = idx + len(sub)
    return positions

def remove_last_row(code: str) -> str:
    lines = code.split("\n")
    if not lines:
        return code
    return "\n".join(lines[:-1])

def _normalize_indentation(code_block: str) -> str:
    return (
        code_block
        .replace("    ", "\t")
        .replace("   ", "\t")
        .replace("  ", "\t")
        .replace("\t", "    ")
    )

def _trim_to_compilable(code_block: str) -> str:
    candidate = code_block.strip()
    while candidate:
        try:
            compile(candidate, "", "exec")
            return candidate
        except Exception:
            candidate = remove_last_row(candidate)
    return ""

def _extract_fenced_blocks(text: str) -> list[str]:
    if "```" not in text:
        return []

    blocks: list[str] = []
    split_list = find_all_occurrences(text, "```")
    for index in range(len(split_list) // 2):
        left = split_list[2 * index]
        right = split_list[2 * index + 1]
        code_block = text[left:right].strip()
        body = "\n".join(code_block.split("\n")[1:])
        if body.strip():
            blocks.append(body)

    if len(split_list) % 2 != 0:
        dangling = text[split_list[-1]:].strip()
        body = "\n".join(dangling.split("\n")[1:])
        if body.strip():
            blocks.append(body)

    return blocks

def ffilter(code_block: str) -> str:
    code_block = _normalize_indentation(code_block)

    code_block = code_block.split('if __name__ == "__main__":')[0]
    code_block = code_block.split("if __name__ == '__main__':")[0]

    lines = code_block.split("\n")
    new_lines = []
    for line in lines:
        s = line.strip()
        if not (
            s.startswith("print")
            or s.startswith("input")
            or s.startswith("assert")
            or s.startswith("unittest")
        ):
            new_lines.append(line)

    return "\n".join(new_lines).strip()

def preprocess(code: str) -> str:
    code_blocks = []

    if "```" in code:
        split_list = find_all_occurrences(code, "```")

        # 处理第一个代码块前面就出现 def 的情况
        first_fence = split_list[0]
        def_pos = code.find("def ")
        if def_pos != -1 and def_pos < first_fence:
            code_block = code[def_pos:first_fence].strip()
            code_block = ffilter(code_block)

            while code_block:
                try:
                    compile(code_block, "", "exec")
                    break
                except Exception:
                    code_block = remove_last_row(code_block)

            if code_block:
                code_blocks.append(code_block)

            rest_code = code[first_fence:].split("\n")
            if not (len(rest_code) >= 2 and rest_code[1].startswith("def")):
                split_list.pop(0)

        # 成对处理 ```...```
        for i in range(len(split_list) // 2):
            left = split_list[2 * i]
            right = split_list[2 * i + 1]
            code_block = code[left:right].strip()
            code_block = "\n".join(code_block.split("\n")[1:])  # 去掉 ```python
            code_block = ffilter(code_block)
            if code_block:
                code_blocks.append(code_block)

        # 处理不完整结尾
        if len(split_list) % 2 != 0:
            code_block = code[split_list[-1]:].strip()
            code_block = "\n".join(code_block.split("\n")[1:])
            code_block = ffilter(code_block)
            if code_block:
                code_blocks.append(code_block)

        return "\n\n".join(code_blocks).strip()

    return ffilter(code).strip()

def _looks_like_assert_test_suite(code_block: str, target_symbols: list[str] | None = None) -> bool:
    cleaned = code_block.strip()
    if not cleaned:
        return False
    if not re.search(r"(^|\n)\s*assert\b", cleaned):
        return False
    lowered = cleaned.lower()
    if "import unittest" in lowered or "from unittest" in lowered:
        return False
    if "import pytest" in lowered or "pytest." in lowered:
        return False
    for symbol in target_symbols or []:
        if not symbol:
            continue
        if f"def {symbol}(" in cleaned or f"class {symbol}(" in cleaned or f"class {symbol}:" in cleaned:
            return False
    return True

def _clean_test_block(code_block: str) -> str:
    code_block = _normalize_indentation(code_block)
    code_block = code_block.split('if __name__ == "__main__":')[0]
    code_block = code_block.split("if __name__ == '__main__':")[0]

    lines = code_block.split("\n")
    new_lines = []
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("```"):
            continue
        if stripped.startswith("print("):
            continue
        if stripped.startswith("input("):
            continue
        new_lines.append(line)

    return "\n".join(new_lines).strip()

def preprocess_tests(code: str, *, target_symbols: list[str] | None = None) -> str:
    candidates = _extract_fenced_blocks(code)
    if not candidates:
        candidates = [code]

    for candidate in candidates:
        cleaned = _clean_test_block(candidate)
        if _looks_like_assert_test_suite(cleaned, target_symbols=target_symbols):
            return cleaned

    cleaned_full = _clean_test_block(code)
    if _looks_like_assert_test_suite(cleaned_full, target_symbols=target_symbols):
        return cleaned_full

    return ""
