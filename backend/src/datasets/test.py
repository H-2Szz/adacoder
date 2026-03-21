import json
from pathlib import Path


def print_jsonl_keys() -> None:
    jsonl_path = Path(__file__).resolve().with_name("HumanEval.jsonl")

    first_keys = None
    all_keys: set[str] = set()

    with jsonl_path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            obj = json.loads(line)
            if first_keys is None:
                first_keys = list(obj.keys())
            all_keys.update(obj.keys())

    if first_keys is None:
        print("文件为空，没有可读取的 JSON 记录。")
        return

    print("第一条记录 keys:", first_keys)
    print("全文件去重后的 keys:", sorted(all_keys))


if __name__ == "__main__":
    print_jsonl_keys()
