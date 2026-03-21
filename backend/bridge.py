import sys
import json
import traceback

from src import Adacoder, LLMConfig

def build_adacoder(args: dict):
    llmcon = LLMConfig(
        provider=args.get("provider", "other"),
        base_url=args.get("base_url", ""),
        api_key=args.get("api_key", ""),
        model=args.get("model", "")
    )
    return Adacoder(llmcon)

def handle(req: dict):
    method = req.get("method")
    args = req.get("args", {})

    if method == "workflow":
        problem = args.get("problem", "")
        test_file_path = args.get("test_file_path", "")
        if not problem:
            return {
                "id": req.get("id"),
                "ok": False,
                "error": "Missing required arg: problem"
            }
        if not test_file_path:
            return {
                "id": req.get("id"),
                "ok": False,
                "error": "Missing required arg: test_file_path"
            }

        adacoder = build_adacoder(args)
        result = adacoder.workflow(
            problem_statement=problem,
            test_file_path=test_file_path
        )
        return {
            "id": req.get("id"),
            "ok": True,
            "result": result
        }

    return {
        "id": req.get("id"),
        "ok": False,
        "error": f"Unknown method: {method}"
    }

def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            req = json.loads(line)
            resp = handle(req)
        except Exception as e:
            resp = {
                "id": None,
                "ok": False,
                "error": str(e),
                "traceback": traceback.format_exc()
            }

        print(json.dumps(resp, ensure_ascii=False), flush=True)

if __name__ == "__main__":
    main()