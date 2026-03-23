from .executor import AdacoderExecutor
from .llm_clients import LLMConfig
from .utils import DebugSpecialist

class Adacoder:
    def __init__(self,config:LLMConfig,planner_config:LLMConfig=None):
        self.coder_config=config
        self.planner_config=planner_config
        self.coder=self._init_coder()
        self.planner=self._init_coder()
        self.debugger=self._init_debugger()

    def _init_coder(self):
        self.coder=AdacoderExecutor(system_prompt="You are an expert programming assistant.",LLM_Config=self.coder_config)
    def _init_planner(self):
        if not self.planner_config:
            self.planner_config=self.coder_config
        self.planner=AdacoderExecutor(system_prompt="You are a programming planning assistant.",LLM_Config=self.planner_config)
    def _init_debugger(self):
        self.debugger=DebugSpecialist()# 自动修复三种错误的
    def workflow(self,problem_statement:str,test_file_path:str)->dict:
        # 第一次生成，不需要计划
        code=self.coder.execute_coder(problem_statement=problem_statement)# 默认请求10次直到成功，没成功也没办法
        if not code:
            # 尝试没成功(默认10次)
            # raise(RuntimeError("尝试连接LLM失败"))
            return {
                "passed":False,
                "error":"Try to get the return code, but something happen and stop it. May be check your llm config or try again."
            }
        # 开始代码测试
        code_test_res=self.coder.evaluate_code(code=code,test_path=test_file_path)
        if code_test_res.get("passed",False):
            return {
                "passed":True,
                "code_test_res_dict":code_test_res,
                "code":code
            }
        else:
            # 上限是10次
            try_time=10
            while try_time>10:
                try_time-=1
                
                # 看看是不是能修
                iscanfix=self.debugger.could_be_fixed(code_test_res.get("stage",""),code_test_res.get("error_type",""))
                while iscanfix:
                    # 先修在测试,修好了成功结束，没有结束可以修继续修
                    fix_res=self.debugger.fix(code,code_test_res)
                    if fix_res.get("changed",False):# 有代码的修改
                        # 测试
                        code=fix_res.get("fixed_code",code)
                        code_test_res=self.coder.evaluate_code(code=code,test_path=test_file_path)
                        if code_test_res.get("passed",False):
                            return {
                                "passed":True,
                                "code_test_res_dict":code_test_res,
                                "code":code
                            }
                        else:
                            iscanfix=self.debugger.could_be_fixed(code_test_res.get("stage",""),code_test_res.get("error_type",""))
                
                # 这个时候先制定计划
                plan=self.planner.execute_planner(problem_statement=problem_statement,relat_err_dict=code_test_res)

                # 使用计划来生成代码
                code=self.coder.execute_coder(problem_statement=problem_statement,plan=plan)
                # 测试：
                code_test_res=self.coder.evaluate_code(code=code,test_path=test_file_path)
                # 成功就返回，失败就继续，直到10
                if code_test_res.get("passed",False):
                    return {
                        "passed":True,
                        "code_test_res_dict":code_test_res,
                        "code":code
                    }
                else:
                    continue

            # 尝试完了10次之后,就是失败
            return {
                "passed":False,
                "code_test_res_dict":code_test_res,
                "code":code
            }

