from dataclasses import dataclass
from .llm_provider import Provider

@dataclass
class LLMConfig:
    provider: Provider = "other"
    model: str = ""
    api_key: str = ""
    base_url: str | None = None
    timeout: int = 300
    temperature: float = 0.2
    max_tokens: int = 1024