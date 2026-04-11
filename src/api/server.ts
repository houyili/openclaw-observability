import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { CONFIG } from "../config.ts";

// ─── Auth token ─────────────────────────────────────────────────
function loadAuthToken(): string | null {
  // 1. Environment variable
  if (process.env.OBS_AUTH_TOKEN) return process.env.OBS_AUTH_TOKEN;
  // 2. .env file in project root
  const envPath = join(import.meta.dirname, "..", "..", ".env");
  if (existsSync(envPath)) {
    const lines = readFileSync(envPath, "utf-8").split("\n");
    for (const line of lines) {
      const m = line.match(/^OBS_AUTH_TOKEN\s*=\s*(.+)/);
      if (m) return m[1].trim();
    }
  }
  return null;
}

const AUTH_TOKEN = loadAuthToken();
if (AUTH_TOKEN) console.log("[auth] Token protection enabled");

function checkAuth(req: IncomingMessage, query: Record<string, string>): boolean {
  if (!AUTH_TOKEN) return true; // no token configured = open access
  // Allow localhost access without token
  const host = req.headers.host || "";
  if (host.startsWith("127.0.0.1") || host.startsWith("localhost")) return true;
  const path = (req.url || "").split("?")[0];
  // Allow static assets without token (CSS/JS/HTML, healthz)
  // The frontend JS reads the token from the URL and attaches it to API calls
  if (path === "/" || path === "/index.html" || path.endsWith(".css") || path.endsWith(".js") || path.startsWith("/healthz")) return true;
  // API endpoints require token
  const authHeader = req.headers.authorization || "";
  if (authHeader === `Bearer ${AUTH_TOKEN}`) return true;
  if (query.token === AUTH_TOKEN) return true;
  return false;
}

function send401(res: ServerResponse): void {
  res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Access Denied</title>
<style>body{background:#0d1117;color:#c9d1d9;font-family:monospace;display:flex;justify-content:center;align-items:center;height:100vh;margin:0}
.box{text-align:center;padding:40px;border:1px solid #30363d;border-radius:12px;background:#161b22}
h1{color:#f85149;font-size:20px}p{color:#8b949e;font-size:13px;margin-top:8px}</style></head>
<body><div class="box"><h1>Access Denied</h1><p>Add <code>#token=YOUR_TOKEN</code> to the URL</p></div></body></html>`);
}
import { handleSessionsRoutes } from "./routes-sessions.ts";
import { handleSkillsRoute } from "./routes-skills.ts";
import { handleScriptsRoute } from "./routes-scripts.ts";
import { handleMcpsRoute } from "./routes-mcps.ts";
import { handleHealthRoute } from "./routes-health.ts";
import { getAllRegistry } from "../storage/registry-repo.ts";
import { getSummaryStats } from "../storage/steps-repo.ts";

const FRONTEND_DIR = join(import.meta.dirname, "..", "frontend");

function sendJson(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(data));
}

function sendHtml(res: ServerResponse, html: string): void {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

function sendCss(res: ServerResponse, css: string): void {
  res.writeHead(200, { "Content-Type": "text/css; charset=utf-8" });
  res.end(css);
}

function sendJs(res: ServerResponse, js: string): void {
  res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
  res.end(js);
}

function send404(res: ServerResponse): void {
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not Found");
}

function parseQuery(url: string): Record<string, string> {
  const idx = url.indexOf("?");
  if (idx < 0) return {};
  const params = new URLSearchParams(url.slice(idx));
  const result: Record<string, string> = {};
  for (const [k, v] of params) result[k] = v;
  return result;
}

export function startServer(): void {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url || "/";
    const path = url.split("?")[0];
    const query = parseQuery(url);

    try {
      // Auth check (skip for healthz)
      if (!checkAuth(req, query)) return send401(res);

      // Frontend static files
      if (path === "/" || path === "/index.html") {
        return sendHtml(res, readFileSync(join(FRONTEND_DIR, "index.html"), "utf-8"));
      }
      if (path.endsWith(".css")) {
        try { return sendCss(res, readFileSync(join(FRONTEND_DIR, path.slice(1)), "utf-8")); } catch { return send404(res); }
      }
      if (path.endsWith(".js")) {
        try { return sendJs(res, readFileSync(join(FRONTEND_DIR, path.slice(1)), "utf-8")); } catch { return send404(res); }
      }

      // API routes
      if (path === "/api/sessions") return handleSessionsRoutes.list(query, res, sendJson);
      if (path.startsWith("/api/sessions/") && path.endsWith("/trace")) {
        const key = decodeURIComponent(path.slice("/api/sessions/".length, -"/trace".length));
        return handleSessionsRoutes.trace(key, query, res, sendJson);
      }
      if (path.startsWith("/api/sessions/")) {
        const key = decodeURIComponent(path.slice("/api/sessions/".length));
        return handleSessionsRoutes.detail(key, res, sendJson);
      }
      if (path === "/api/skills") return handleSkillsRoute(query, res, sendJson);
      if (path === "/api/scripts") return handleScriptsRoute(query, res, sendJson);
      if (path === "/api/mcps") return handleMcpsRoute(query, res, sendJson);
      if (path === "/api/summary") return sendJson(res, getSummaryStats());
      if (path === "/api/registry") return sendJson(res, getAllRegistry());
      if (path === "/healthz") return handleHealthRoute(res, sendJson);

      send404(res);
    } catch (err) {
      console.error("[server] Error:", (err as Error).message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  });

  server.listen(CONFIG.PORT, CONFIG.HOST, () => {
    console.log(`[observability-v2] http://${CONFIG.HOST}:${CONFIG.PORT}`);
  });
}
