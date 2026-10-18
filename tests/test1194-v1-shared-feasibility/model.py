#!/usr/bin/env python3
import json, re, sys, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
LOG = sys.argv[1]
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        self.reply({"object":"list","data":[{"id":"alpha","object":"model"},{"id":"beta","object":"model"}]})
    def reply(self, value):
        data=json.dumps(value).encode();self.send_response(200);self.send_header("content-type","application/json");self.send_header("content-length",str(len(data)));self.end_headers();self.wfile.write(data)
    def do_POST(self):
        body=json.loads(self.rfile.read(int(self.headers.get("content-length",0))))
        messages=body.get("messages",[]); tools=[t.get("function",{}).get("name") for t in body.get("tools",[]) or []]
        user_index=max((i for i,m in enumerate(messages) if m.get("role")=="user"),default=-1)
        user=messages[user_index].get("content","") if user_index>=0 else ""
        if isinstance(user,list):user=" ".join(p.get("text","") for p in user if isinstance(p,dict))
        results=[m for m in messages[user_index+1:] if m.get("role")=="tool"]
        with open(LOG,"a") as f:f.write(json.dumps({"model":body.get("model"),"tools":tools,"user":user,"toolResults":len(results)})+"\n")
        call="CALL_IDENTITY" in user and not results
        name=next((n for n in tools if n and n.endswith("read_identity")),None)
        if call and not name:raise RuntimeError("identity MCP tool was not offered")
        match=re.search(r"Reply with exactly (\S+)",user)
        text=("IDENTITY_RESULT:"+json.dumps(results[-1].get("content"))) if results else (match.group(1) if match else "STUB_OK")
        delta={"tool_calls":[{"index":0,"id":"call1194","type":"function","function":{"name":name,"arguments":"{}"}}]} if call else {"content":text}
        finish="tool_calls" if call else "stop"
        base={"id":"fixture1194","created":int(time.time()),"model":body.get("model")}
        if not body.get("stream"):
            message={"role":"assistant",**delta}
            if call:message["tool_calls"][0].pop("index",None)
            self.reply({**base,"object":"chat.completion","choices":[{"index":0,"message":message,"finish_reason":finish}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}});return
        self.send_response(200);self.send_header("content-type","text/event-stream");self.end_headers()
        for payload in [{"role":"assistant","content":""},delta]:
            self.wfile.write(("data: "+json.dumps({**base,"object":"chat.completion.chunk","choices":[{"index":0,"delta":payload,"finish_reason":None}]})+"\n\n").encode());self.wfile.flush()
        self.wfile.write(("data: "+json.dumps({**base,"object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":finish}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}})+"\n\ndata: [DONE]\n\n").encode());self.wfile.flush()
ThreadingHTTPServer(("127.0.0.1",18994),H).serve_forever()
