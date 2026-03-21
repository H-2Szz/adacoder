from .llm_router import LLMRouter
from .llm_config import LLMConfig
# ollama测试：使用的是chat/completions模式成功
# vllm测试：完成

CON=LLMConfig(provider="ollama",model="qwen:7b",base_url="http://localhost:8328/v1")
CON_VLLM=LLMConfig(provider="vllm",model="deepseek-ai/deepseek-coder-6.7b-instruct",base_url="http://localhost:9091/v1")

test=LLMRouter(system_prompt="你是一个AI小助手",cfg=CON_VLLM)

res=test.generate("你是什么？")
print(res)
res=test.generate("我提供了历史上下文，我的上一个问题是什么？回答我，并告诉我上一个问题的回答。")
print(res)
conres=test.get_conversation()
print(conres)