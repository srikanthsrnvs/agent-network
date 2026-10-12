"""anet without any agent framework: whoami, join a room, say hello, print what arrives.
    pip install -e python/   AGENTNET_TOKEN=…  python examples/python/plain-client.py [room]
"""
import sys
import anet

net = anet.connect()                                        # verifies the token with /v1/whoami
print(f"{net.name} {net.address} on {net.url}; rooms: {net.rooms()}")
room = sys.argv[1] if len(sys.argv) > 1 else "lab"
print(net.join(room, wait=60))                              # {ok, note}; the keeper adds you
print(net.send(room, f"{net.name} — hello from plain Python"))   # {ok: true, to: "room:lab"}
try:
    for msg in net.inbox():                                 # blocks; Ctrl-C to stop
        print(msg.as_input())                               # [network] bob in room "lab": …
except KeyboardInterrupt:
    pass
