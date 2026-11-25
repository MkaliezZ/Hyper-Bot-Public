"""Launch the pinned text-only Hermes ACP server behind a local model gateway."""
import asyncio
from ipaddress import ip_address
import logging
import os
import socket
import sys

_ADDRESS_EVENTS = {
    "socket.bind": 1,
    "socket.connect": 1,
    "socket.sendto": 1,
    "socket.sendmsg": 1,
    "socket.getaddrinfo": 0,
    "socket.gethostbyname": 0,
    "socket.gethostbyaddr": 0,
    "socket.getnameinfo": 0,
}


def restrict_network(event, args):
    index = _ADDRESS_EVENTS.get(event)
    if index is None:
        return
    if index == 1 and args[0].family not in (socket.AF_INET, socket.AF_INET6):
        return
    address = args[index]
    if address is None and event in ("socket.getaddrinfo", "socket.sendmsg"):
        return
    host = address[0] if isinstance(address, tuple) else address
    if host == "localhost":
        return
    try:
        if ip_address(host).is_loopback:
            return
    except ValueError:
        pass
    raise PermissionError("Hyper Bot Hermes ACP only uses loopback networking")


os.environ["AWS_EC2_METADATA_DISABLED"] = "true"
# Limit the interpreter's socket operations before loading any Hermes module.
sys.addaudithook(restrict_network)
sys.path.insert(0, sys.argv[1])

import acp
from acp.schema import ModelInfo, SessionModelState
from acp_adapter.server import HermesACPAgent
from acp_adapter.session import SessionManager
from run_agent import AIAgent


class TextSessions(SessionManager):
    def _make_agent(self, *, session_id, **kwargs):
        agent = AIAgent(
            session_id=session_id,
            provider="custom",
            base_url=os.environ["HYPER_BOT_ACP_MODEL_URL"],
            api_key="hyper-bot-local-provider",
            api_mode="chat_completions",
            model=os.environ["HYPER_BOT_ACP_MODEL"],
            enabled_toolsets=["hyper-bot-text-only"],
            max_iterations=2,
            max_tokens=4096,
            platform="acp",
            skip_context_files=True,
            skip_memory=True,
            quiet_mode=True,
        )
        if agent.tools:
            raise RuntimeError("Unexpected tools in the Hyper Bot text session")
        return agent


class TextACPAgent(HermesACPAgent):
    def _build_model_state(self, state):
        model = state.agent.model
        return SessionModelState(
            available_models=[ModelInfo(model_id=model, name=model)],
            current_model_id=model,
        )


if __name__ == "__main__":
    logging.basicConfig(stream=sys.stderr, level=logging.ERROR)
    asyncio.run(acp.run_agent(TextACPAgent(session_manager=TextSessions()), use_unstable_protocol=True))

