from __future__ import annotations
from .llm_config import LLMConfig
from .llm_provider import provider_set
from typing import Any
import requests

class LLMRouter:
    def __init__(self,system_prompt: str, cfg: LLMConfig,is_history:bool=False):
        self.cfg = cfg
        self.provider = cfg.provider.lower().strip()
        self.system_prompt = system_prompt
        self.is_history=is_history

        # 统一变量名；后面的 _gemini_native / _claude_native / _openai... 都用这个
        self.conversation = []

        if self.provider not in provider_set:
            self.provider="other"#其他第三方直接模型是这个

        # 先校验，再建 client
        if not cfg.model:
            raise ValueError("model 不能为空")

        if not cfg.api_key and self.provider not in ("ollama","vllm"):
            raise ValueError("api_key 不能为空")

        self.client = self._build_client()
        self.claude_client=self._build_claude_client()

    def _build_client(self):
        provider = self.provider
        base_url = self._effective_base_url()

        # 1) OpenAI 官方
        if provider == "openai":
            from openai import OpenAI

            kwargs: dict[str, Any] = {
                "api_key": self.cfg.api_key,
                "timeout": self.cfg.timeout,
            }
            if base_url:
                kwargs["base_url"] = base_url

            return OpenAI(**kwargs)

        # 2) OpenAI-compatible 后端
        # 这里是框架层约定：如果你把 deepseek / ollama / vllm / other
        # 当 OpenAI-compatible endpoint 用，就走这个分支。
        elif provider in ("ollama", "vllm", "claude","other"):
            from openai import OpenAI

            if not base_url:
                raise ValueError(
                    f"{provider} 需要提供 base_url（按 OpenAI-compatible endpoint 方式接入）"
                )

            kwargs: dict[str, Any] = {
                "api_key": self.cfg.api_key or "EMPTY",
                "timeout": self.cfg.timeout,
                "base_url": base_url,
            }
            return OpenAI(**kwargs)

        # 3) Gemini
        elif provider == "gemini":
            from google import genai
            from google.genai import types

            kwargs: dict[str, Any] = {
                "api_key": self.cfg.api_key,
            }

            # Gemini 自定义 base url 走 http_options
            if base_url:
                kwargs["http_options"] = types.HttpOptions(
                    base_url=base_url
                )

            return genai.Client(**kwargs)

        raise ValueError(f"Unsupported provider: {provider}")

    def _build_claude_client(self):
        provider=self.provider
        base_url = getattr(self.cfg, "base_url", None)
        if base_url:# 删除最后的/v1保证可以跑
            base_url = base_url.rstrip("/")
            if base_url.endswith("/v1"):
                base_url = base_url[:-3]
        # 4) Claude，单独给他一个多的client
        if provider == "claude":
            from anthropic import Anthropic
            kwargs: dict[str, Any] = {
                "api_key": self.cfg.api_key,
            }
            if base_url:
                kwargs["base_url"] = base_url

            return Anthropic(**kwargs)
        else:
            return None

    def close(self):
        for name in ("client", "claude_client"):
            obj = getattr(self, name, None)
            if obj is not None:
                try:
                    obj.close()
                except Exception:
                    pass
                
    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        self.close()

    # ---------------------------
    # Public API
    # ---------------------------
    def generate(
        self,
        user_prompt: str,
        *,
        extra_body: dict[str, Any] | None = None,
    ) -> str:
        """
        按 provider 的优先级自动回退。
        """
        errors: list[str] = []

        for step in self._strategy_order():
            try:
                if step == "gemini_native":
                    return self._gemini_native(user_prompt)

                if step == "claude_native":
                    return self._claude_native( user_prompt)

                if step == "sdk_responses":
                    return self._openai_sdk_responses( user_prompt, extra_body=extra_body)

                if step == "sdk_chat":
                    return self._openai_sdk_chat( user_prompt, extra_body=extra_body)

                if step == "http_responses":
                    return self._http_responses(user_prompt, extra_body=extra_body)

                if step == "http_chat":
                    return self._http_chat( user_prompt, extra_body=extra_body)

                errors.append(f"{step}: unknown strategy")
            except Exception as exc:
                errors.append(f"{step}: {type(exc).__name__}: {exc}")

        raise RuntimeError("所有调用方式都失败了：\n" + "\n".join(errors))

    # ---------------------------
    # Strategy order
    # ---------------------------
    def _strategy_order(self) -> list[str]:
        if self.provider == "gemini":
            return [
                "gemini_native",
                "sdk_chat",
                "http_chat",
            ]

        if self.provider == "claude":
            # claude在官方文档中只支持使用openaisdk的chat格式
            return [
                "claude_native",
                "sdk_chat",
            ]

        # 其余一律按你要求：
        # OpenAI SDK Responses -> OpenAI SDK Chat -> requests Responses -> requests Chat
        return [
            "sdk_responses",
            "sdk_chat",
            "http_responses",
            "http_chat",
        ]

    # ---------------------------
    # Defaults
    # ---------------------------
    def _default_base_url(self) -> str | None:
        if self.provider == "openai":
            return "https://api.openai.com/v1"
        if self.provider == "gemini":
            return "https://generativelanguage.googleapis.com/v1beta/openai"
        if self.provider=="claude":#这是给openaisdk用的
            return "https://api.anthropic.com/v1"
        return None

    def _effective_base_url(self) -> str | None:
        url = self.cfg.base_url or self._default_base_url()
        return url.rstrip("/") if url else None

    def _effective_api_key(self) -> str:
        if self.provider == "ollama" and not self.cfg.api_key:
            # Ollama 兼容接口常见做法是随便给个 key，占位即可
            return "ollama"
        return self.cfg.api_key

    # ---------------------------
    # Native Gemini
    # ---------------------------
    def _gemini_native(self, user_prompt: str) -> str:
        from google.genai import types

        client = self.client

        # 确保 conversation 存在
        if not hasattr(self, "conversation") or self.conversation is None:
            self.conversation = []

        # 1) 先追加本轮用户消息
        self.conversation.append(
            types.Content(
                role="user",
                parts=[types.Part.from_text(text=user_prompt)],
            )
        )

        try:
            # 2) 把完整历史传给 Gemini
            response = client.models.generate_content(
                model=self.cfg.model,
                contents=self.conversation,
                config=types.GenerateContentConfig(
                    system_instruction=self.system_prompt
                ),
            )

            text = getattr(response, "text", None)
            if not isinstance(text, str) or not text.strip():
                # 失败时把刚刚追加的 user 消息回滚，避免污染历史
                self.conversation.pop()
                raise RuntimeError(f"Gemini 原生返回中没有可用文本: {response}")

            answer = text.strip()

            # 3) 把模型回复也写回历史
            self.conversation.append(
                types.Content(
                    role="assistant",
                    parts=[types.Part.from_text(text=answer)],
                )
            )

            return answer
        except Exception:
            if self.conversation and self.conversation[-1]["role"] == "user" and self.conversation[-1]["content"] == user_prompt:
                self.conversation.pop()
            raise

    # ---------------------------
    # Native Claude
    # ---------------------------
    def _claude_native(self, user_prompt: str) -> str:
        # print("尝试走claude")
        # raise(RuntimeError("桀桀桀claude"))
        if self.claude_client is None:
            raise(RuntimeError("无法初始化claude client"))
        client = self.claude_client
        if not hasattr(self, "conversation") or self.conversation is None:
            self.conversation = []
        
        if not self.is_history:
            self.conversation = []
        
        history = list(self.conversation)
        history.append(
            {
                "role": "user",
                "content": user_prompt,
            }
        )

        message = client.messages.create(
            model=self.cfg.model,
            max_tokens=self.cfg.max_tokens,
            system=self.system_prompt,
            messages=history,
        )

        parts: list[str] = []
        for block in message.content:
            text = getattr(block, "text", None)
            if isinstance(text, str) and text.strip():
                parts.append(text.strip())

        answer = "\n".join(parts).strip()

        if not answer:
            raise RuntimeError(f"Claude 原生返回中没有可用文本: {message}")

        self.conversation = history + [
            {
                "role": "assistant",
                "content": answer,
            }
        ]
        return answer

    # ---------------------------
    # OpenAI SDK - Responses
    # ---------------------------
    def _openai_sdk_responses(
        self,
        user_prompt: str,
        *,
        extra_body: dict[str, Any] | None = None,
    ) -> str:
        # print("尝试走sdk_respon")
        #raise(RuntimeError("桀桀桀,先不走这个repon"))

        client = self.client
        if not hasattr(self, "conversation") or self.conversation is None:
            self.conversation = []

        if not self.is_history:
            self.conversation=[]

        history = list(self.conversation)
        history.append(
            {
                "role": "user",
                "content": user_prompt,
            }
        )

        req: dict[str, Any] = {
            "model": self.cfg.model,
            "instructions": self.system_prompt,
            "input": history,
            "temperature": self.cfg.temperature,
            "max_output_tokens": self.cfg.max_tokens,
        }

        if extra_body:
            req["extra_body"] = extra_body

        resp = client.responses.create(**req)

        output_text = getattr(resp, "output_text", None)
        if isinstance(output_text, str) and output_text.strip():
            answer = output_text.strip()
        elif hasattr(resp, "model_dump"):
            answer = self._extract_text_from_responses_json(resp.model_dump()).strip()
        else:
            raise RuntimeError(f"无法解析 SDK Responses 返回: {resp}")

        if not answer:
            raise RuntimeError(f"OpenAI Responses 返回为空: {resp}")

        self.conversation = history + [
            {
                "role": "assistant",
                "content": answer,
            }
        ]
        return answer

    # ---------------------------
    # OpenAI SDK - Chat
    # ---------------------------
    def _openai_sdk_chat(
        self,
        user_prompt: str,
        *,
        extra_body: dict[str, Any] | None = None,
    ) -> str:
        # print("尝试走sdk_chat")
        # raise(RuntimeError("桀桀桀"))
        client = self.client

        if not hasattr(self, "conversation") or self.conversation is None:
            self.conversation = []
        if not self.is_history:
            self.conversation=[]

        # 只维护 user/assistant 历史；system/developer 每次请求时单独拼进去
        history = list(self.conversation)
        history.append(
            {
                "role": "user",
                "content": user_prompt,
            }
        )


        messages = [
            {"role": "system", "content": self.system_prompt},
            *history,
        ]

        req: dict[str, Any] = {
            "model": self.cfg.model,
            "messages": messages,
            "temperature": self.cfg.temperature,
            "max_tokens": self.cfg.max_tokens,
        }
        if extra_body:
            req["extra_body"] = extra_body

        resp = client.chat.completions.create(**req)

        content = resp.choices[0].message.content

        if isinstance(content, str) and content.strip():
            answer = content.strip()
        elif hasattr(resp, "model_dump"):
            answer = self._extract_text_from_chat_json(resp.model_dump()).strip()
        else:
            raise RuntimeError(f"无法解析 SDK Chat 返回: {resp}")

        if not answer:
            raise RuntimeError(f"OpenAI Chat 返回为空: {resp}")

        self.conversation = history + [
            {
                "role": "assistant",
                "content": answer,
            }
        ]
        return answer

        

    # ---------------------------
    # HTTP - Responses
    # ---------------------------
    def _http_responses(
        self,
        user_prompt: str,
        *,
        extra_body: dict[str, Any] | None = None,
    ) -> str:
        # print("尝试走http_respon")
        # raise(RuntimeError("桀桀桀2"))
        base_url = self._effective_base_url()
        if not base_url:
            raise RuntimeError("没有可用的 BASE_URL，无法走 requests + /responses")

        if self.provider == "claude" and not self.cfg.base_url:
            raise RuntimeError("Claude 官方直连没有 /responses；如需此回退，请显式提供兼容 BASE_URL")

        url = f"{base_url}/responses"

        if not hasattr(self, "conversation") or self.conversation is None:
            self.conversation = []

        if not self.is_history:
            self.conversation=[]

        # 先追加本轮 user
        history = list(self.conversation)
        history.append(
            {
                "role": "user",
                "content": user_prompt,
            }
        )

        
        payload: dict[str, Any] = {
            "model": self.cfg.model,
            "instructions": self.system_prompt,   # system_prompt 单独传
            "input": history,           # 这里传完整历史
            "temperature": self.cfg.temperature,
            "max_output_tokens": self.cfg.max_tokens,
        }

        if extra_body:
            payload.update(extra_body)

        resp = requests.post(
            url,
            headers=self._headers(),
            json=payload,
            timeout=self.cfg.timeout,
        )
        resp.raise_for_status()

        data = resp.json()
        answer = self._extract_text_from_responses_json(data).strip()

        if not answer:
            raise RuntimeError(f"HTTP /responses 返回为空: {data}")

        # 成功后把 assistant 也写入上下文
        self.conversation = history + [
            {
                "role": "assistant",
                "content": answer,
            }
        ]

        return answer

    # ---------------------------
    # HTTP - Chat
    # ---------------------------
    def _http_chat(
        self,
        user_prompt: str,
        *,
        extra_body: dict[str, Any] | None = None,
    ) -> str:
        # print("尝试走http_chat")
        # raise(RuntimeError("桀桀桀3"))
        base_url = self._effective_base_url()
        if not base_url:
            raise RuntimeError("没有可用的 BASE_URL，无法走 requests + /chat/completions")

        if self.provider == "claude" and not self.cfg.base_url:
            raise RuntimeError("Claude 官方直连没有 OpenAI-style /chat/completions；如需此回退，请显式提供兼容 BASE_URL")

        url = f"{base_url}/chat/completions"

        if not hasattr(self, "conversation") or self.conversation is None:
            self.conversation = []

        if not self.is_history:
            self.conversation=[]

        # 先复制历史，避免失败时污染正式上下文
        history = list(self.conversation)
        # 只维护 user / assistant，不把 system 放进 self.conversation
        history.append(
            {
                "role": "user",
                "content": user_prompt,
            }
        )

        payload: dict[str, Any] = {
            "model": self.cfg.model,
            "messages": [
                {"role": "system", "content": self.system_prompt},
                *history,
            ],
            "temperature": self.cfg.temperature,
            "max_tokens": self.cfg.max_tokens,
        }

        if extra_body:
            payload.update(extra_body)

        resp = requests.post(
            url,
            headers=self._headers(),
            json=payload,
            timeout=self.cfg.timeout,
        )
        resp.raise_for_status()

        data = resp.json()
        answer = self._extract_text_from_chat_json(data).strip()

        if not answer:
            raise RuntimeError(f"HTTP /chat/completions 返回为空: {data}")

        # 请求成功后再正式提交上下文
        self.conversation = history + [
            {
                "role": "assistant",
                "content": answer,
            }
        ]

        return answer

    # ---------------------------
    # Helpers
    # ---------------------------
    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self._effective_api_key()}",
            "Content-Type": "application/json",
        }

    @staticmethod
    def _extract_text_from_chat_json(data: dict[str, Any]) -> str:
        try:
            content = data["choices"][0]["message"]["content"]
        except Exception as exc:
            raise RuntimeError(f"chat 返回结构异常: {data}") from exc

        if isinstance(content, str):
            return content.strip()

        if isinstance(content, list):
            parts: list[str] = []
            for item in content:
                if isinstance(item, dict):
                    if item.get("type") == "text" and isinstance(item.get("text"), str):
                        parts.append(item["text"])
                    elif isinstance(item.get("content"), str):
                        parts.append(item["content"])
            merged = "\n".join(x for x in parts if x.strip()).strip()
            if merged:
                return merged

        raise RuntimeError(f"无法从 chat 返回中提取文本: {data}")

    @staticmethod
    def _extract_text_from_responses_json(data: dict[str, Any]) -> str:
        if isinstance(data.get("output_text"), str) and data["output_text"].strip():
            return data["output_text"].strip()

        output = data.get("output", [])
        parts: list[str] = []

        if isinstance(output, list):
            for item in output:
                if not isinstance(item, dict):
                    continue
                content_list = item.get("content", [])
                if not isinstance(content_list, list):
                    continue
                for c in content_list:
                    if not isinstance(c, dict):
                        continue
                    if c.get("type") in ("output_text", "text") and isinstance(c.get("text"), str):
                        parts.append(c["text"])

        merged = "\n".join(x for x in parts if x.strip()).strip()
        if merged:
            return merged

        raise RuntimeError(f"无法从 responses 返回中提取文本: {data}")
    
    def get_conversation(self)->list[dict[str,str]]:
        if self.conversation is not None:
            return [{"system":self.system_prompt}]+self.conversation
        else:
            return [{"system":self.system_prompt}]