const http = require("http");
const port = Number(process.env.PORT);
const server = http.createServer((req, res) => {
  res.writeHead(req.url === "/login" ? 200 : 404, { "content-type": "text/plain" });
  res.end(req.url === "/login" ? "dashboard-login" : "not-found");
});
server.listen(port, process.env.HOSTNAME || "127.0.0.1");
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => server.close(() => process.exit(0)));
