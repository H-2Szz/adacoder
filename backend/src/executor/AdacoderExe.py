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
from ..utils import preprocess
import traceback

class AdacoderExecutor():
    def __init__(self,system_prompt:str="",LLM_Config:LLMConfig=LLMConfig()):
        self.llmconfig=LLM_Config
        self.llmrouter=self._init_roter(system_prompt,LLM_Config)

    def _init_roter(self,system_prompt:str,LLM_Config:LLMConfig):
        return LLMRouter(system_prompt,LLM_Config)
    
    def execute_coder(self,problem_statement:str="",plan:str=""):
        if problem_statement=="":
            raise(RuntimeError("输入不能是空"))
        if not plan:#没有计划（第一次输入）
            user_prompt = f"""
## Task Description
{problem_statement}"""
        else:
            user_prompt=f"""Solve the following problem according to the given plan.

{plan}

## Task Description
{problem_statement}"""
        trytime=10
        while trytime>0:
            trytime-=1
            try:
                res=self.llmrouter.generate(user_prompt=user_prompt)
                # 这边拿到code就行了，然后执行code看看成没成功
                code=preprocess(res)
            except Exception as e:
                code=""
            if code:
                break
        
        return code
    

    def evaluate_code(self,code: str, test_path: str)->dict:
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

        try:
            # 读取测试文件
            with open(test_path, "r", encoding="utf-8") as f:
                test_code = f.read()
        except Exception as e:
            return {
                "passed": False,
                "stage": "read_test_file",
                "error_type":type(e).__name__,
                "error": str(e),
                "traceback": traceback.format_exc(),
            }

        try:
            # 执行测试代码；测试代码里如果有 assert / check(...) 顶层调用，就会真正跑起来
            exec(test_code, namespace, namespace)
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
    
    def execute_planner(self,problem_statement:str="",relat_err_dict:dict={})->str:
        if not problem_statement:
            raise(RuntimeError("输入不能是空"))
        user_prompt=f"""Develop a new plan based on the feedback from the last error.

## Task Description
{problem_statement}

## Error Feedback
Error Type: {relat_err_dict.get("error_type","")}
Error Message: {relat_err_dict.get("error","")}

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
        while trytime>0:
            trytime-=1
            try:
                plan=self.llmrouter.generate(user_prompt=user_prompt)
            except Exception as e:
                plan=""
            if plan:
                break
        
        return plan
        
