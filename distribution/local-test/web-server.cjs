const http = require("node:http");
const { readFile, stat } = require("node:fs/promises");
const path = require("node:path");
const root = path.join(__dirname, "web");
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
};
http
  .createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Cache-Control", "no-store");
    if (req.url?.startsWith("/api/")) {
      const headers = { ...req.headers, host: "auth:8080" };
      for (const name of [
        "connection",
        "proxy-connection",
        "transfer-encoding",
        "x-forwarded-for",
        "x-forwarded-host",
        "x-forwarded-proto",
      ])
        delete headers[name];
      const upstream = http.request(
        {
          hostname: "auth",
          port: 8080,
          path: req.url,
          method: req.method,
          headers,
        },
        (response) => {
          res.writeHead(response.statusCode || 502, response.headers);
          response.pipe(res);
        },
      );
      upstream.on("error", () => {
        if (!res.headersSent)
          res.writeHead(502, { "Content-Type": "text/plain" });
        res.end(
          "The local test API is not ready. Check startup in the launcher.",
        );
      });
      req.on("aborted", () => upstream.destroy());
      res.on("close", () => upstream.destroy());
      req.pipe(upstream);
      return;
    }
    if (!["GET", "HEAD"].includes(req.method)) {
      res.writeHead(405);
      res.end();
      return;
    }
    try {
      const url = new URL(req.url, "http://127.0.0.1:8088");
      if (url.pathname === "/test-kit-info") {
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            mode: "local-test",
            project_id: "demo-corewaste",
            version: "0.2.0",
          }),
        );
        return;
      }
      const pathname = decodeURIComponent(url.pathname),
        file = ["/", "/office", "/portal"].includes(pathname)
          ? path.join(root, "index.html")
          : path.resolve(root, "." + pathname);
      if (!file.startsWith(root + path.sep) || !(await stat(file)).isFile()) {
        res.writeHead(404);
        res.end();
        return;
      }
      const data = await readFile(file);
      res.setHeader(
        "Content-Type",
        types[path.extname(file)] || "application/octet-stream",
      );
      res.setHeader("Content-Length", data.length);
      res.end(req.method === "HEAD" ? undefined : data);
    } catch {
      res.writeHead(404);
      res.end();
    }
  })
  .listen(8088, "0.0.0.0");
