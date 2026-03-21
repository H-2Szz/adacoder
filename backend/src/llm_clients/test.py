from llm_router import LLMConfig,LLMRouter

CON=LLMConfig(provider="claude",model="claude-3-5-haiku-20241022",api_key="sk-",base_url="")

test=LLMRouter(system_prompt="你是一个AI小助手",cfg=CON)

res=test.generate("你是什么？")
print(res)
res=test.generate("我的上一个问题是什么？回答我，并告诉我上一个问题的回答。")
print(res)
conres=test.get_conversation()
print(conres)
