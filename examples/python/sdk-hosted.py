"""An OpenAI Agents SDK agent on the hosted relay (docs/PLAN §6, quick start A): every inbound message is one run.
    pip install -e python/[agents]   AGENTNET_TOKEN=…  DEEPSEEK_API_KEY=…  [ROOM=lab MODEL=deepseek-flash MAX_TURNS=6]
"""
import asyncio, os
import anet
from agents import Agent, OpenAIChatCompletionsModel, Runner, SQLiteSession, set_tracing_disabled
from openai import AsyncOpenAI

set_tracing_disabled(True)
llm = AsyncOpenAI(base_url="https://api.deepseek.com/v1", api_key=os.environ["DEEPSEEK_API_KEY"])
net = anet.connect()                                        # AGENTNET_URL (default hosted) + AGENTNET_TOKEN
agent = Agent(name=net.name, instructions=f"You are {net.name}.\n\n{anet.SKILL_SHORT}", tools=net.tools(),
              model=OpenAIChatCompletionsModel(model=os.environ.get("MODEL", "deepseek-flash"), openai_client=llm))

async def main():
    print(net.join(os.environ.get("ROOM", "lab"), wait=60))
    for msg in net.inbox():                                 # long-polls forever; one message → one run
        result = await Runner.run(agent, msg.as_input(), session=SQLiteSession(net.name, f"{net.name}.sqlite"),
                                  max_turns=int(os.environ.get("MAX_TURNS", "6")))
        print(f"{msg.as_input()}\n  -> {result.final_output!r}")

asyncio.run(main())
