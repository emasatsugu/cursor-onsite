import http from "node:http";

export type MainServerOptions = {
  port: number;
  externalId: string;
};

/** Minimal main HTTP listener — health only. */
export function startMainServer(options: MainServerOptions): http.Server {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${options.port}`);
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          externalId: options.externalId,
          port: options.port,
        })
      );
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found", paths: ["/", "/health"] }));
  });

  server.listen(options.port, () => {
    console.log(
      `[vm] main HTTP on :${options.port}  /health  (id=${options.externalId})`
    );
  });

  return server;
}
