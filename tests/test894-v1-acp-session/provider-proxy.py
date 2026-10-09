"""TEST ONLY: closed loopback CONNECT/TLS Responses fixture, never forwards."""
import json
import ssl
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

cert, key, log_path = sys.argv[1:4]
context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain(cert, key)


class Model(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        # Deliberately tiny OFFLINE catalog fixture, not a vendor availability
        # claim. Fresh launch caches otherwise require a models catalog fetch.
        if self.headers.get('host') != 'models.opencode.ai' or self.path != '/api.json':
            self.send_error(404)
            return
        model = {'id': 'gpt-4.1', 'name': 'Fixture GPT-4.1', 'attachment': False,
                 'reasoning': False, 'tool_call': True, 'temperature': True,
                 'release_date': '2025-04-14', 'last_updated': '2025-04-14',
                 'modalities': {'input': ['text'], 'output': ['text']},
                 'open_weights': False, 'cost': {'input': 0, 'output': 0},
                 'limit': {'context': 128000, 'output': 1000}}
        raw = json.dumps({'openai': {'id': 'openai', 'name': 'Fixture OpenAI',
                                    'env': ['OPENAI_API_KEY'], 'npm': '@ai-sdk/openai',
                                    'api': 'https://api.openai.com/v1',
                                    'models': {'gpt-4.1': model}}}).encode()
        self.send_response(200)
        self.send_header('content-type', 'application/json')
        self.send_header('content-length', str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get('content-length', '0'))) or b'{}')
        authorized = self.headers.get('authorization') == 'Bearer test-only-v1-acp'
        with open(log_path, 'a') as out:
            out.write(json.dumps({'path': self.path, 'host': self.headers.get('host'), 'authorized': authorized,
                                  'model': body.get('model'), 'input': body.get('input')}) + '\n')
        if not authorized or self.path != '/v1/responses' or self.headers.get('host') != 'api.openai.com':
            raw = json.dumps({'error': {'message': 'fixture authorization rejected', 'type': 'authentication_error'}}).encode()
            self.send_response(401 if not authorized else 404)
            self.send_header('content-type', 'application/json')
            self.send_header('content-length', str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)
            return
        self.send_response(200)
        self.send_header('content-type', 'text/event-stream')
        self.send_header('connection', 'close')
        self.end_headers()
        text = 'FIXTURE_ONLY_V1_ACP_RESPONSE'
        item = {'id': 'msg_fixture', 'type': 'message', 'role': 'assistant',
                'status': 'completed', 'content': [{'type': 'output_text', 'text': text, 'annotations': []}]}
        response = {'id': 'resp_fixture', 'object': 'response', 'created_at': 1,
                    'model': body.get('model'), 'status': 'completed', 'output': [item],
                    'usage': {'input_tokens': 1, 'output_tokens': 1, 'total_tokens': 2}}
        events = [
            {'type': 'response.created', 'response': {**response, 'status': 'in_progress', 'output': []}},
            {'type': 'response.output_item.added', 'output_index': 0,
             'item': {**item, 'status': 'in_progress', 'content': []}},
            {'type': 'response.content_part.added', 'item_id': item['id'], 'output_index': 0,
             'content_index': 0, 'part': {'type': 'output_text', 'text': '', 'annotations': []}},
            {'type': 'response.output_text.delta', 'item_id': item['id'], 'output_index': 0,
             'content_index': 0, 'delta': text},
            {'type': 'response.output_item.done', 'output_index': 0, 'item': item},
            {'type': 'response.completed', 'response': response},
        ]
        for sequence, event in enumerate(events):
            event['sequence_number'] = sequence
            self.wfile.write(('event: ' + event['type'] + '\ndata: ' + json.dumps(event) + '\n\n').encode())
        self.wfile.flush()


class Proxy(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_CONNECT(self):
        # No external forwarding, DNS, arbitrary domains or broad trust bypass.
        if self.path not in ('api.openai.com:443', 'models.opencode.ai:443'):
            self.send_error(403)
            return
        self.send_response(200, 'Connection Established')
        self.end_headers()
        self.wfile.flush()
        try:
            with context.wrap_socket(self.connection, server_side=True) as secure:
                Model(secure, self.client_address, self.server)
        except (ssl.SSLError, ConnectionError):
            pass
        self.close_connection = True


ThreadingHTTPServer(('127.0.0.1', 18896), Proxy).serve_forever()
