from src import Adacoder
from src import LLMConfig

# 用法，直接初始化Adacoder后调用方法
llmcon=LLMConfig(base_url="",provider="",model="gpt-5.4",api_key="sk-")
adacoder=Adacoder(llmcon)
res=adacoder.workflow(problem_statement="from typing import List\n\n\ndef has_close_elements(numbers: List[float], threshold: float) -> bool:\n    \"\"\" Check if in given list of numbers, are any two numbers closer to each other than\n    given threshold.\n    >>> has_close_elements([1.0, 2.0, 3.0], 0.5)\n    False\n    >>> has_close_elements([1.0, 2.8, 3.0, 4.0, 5.0, 2.0], 0.3)\n    True\n    \"\"\"\n",test_file_path="testfile.py")
print(res)
