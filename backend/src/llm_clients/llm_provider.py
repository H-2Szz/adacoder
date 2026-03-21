# claude使用他的sdk做做发送，baseurl不能带/v1等，直接到根目录
from typing import Literal


Provider = Literal[
    "openai",    # 默认官方；也可配第三方 OpenAI-compatible BASE_URL
    "gemini",
    "claude",
    "ollama",
    "vllm",
    "other",     # 其他模型 / 其他兼容端点
]

provider_set={
    "openai",    # 默认官方；也可配第三方 OpenAI-compatible BASE_URL
    "gemini",
    "claude",
    "ollama",
    "vllm",
    "other",     # 其他模型 / 其他兼容端点
}
