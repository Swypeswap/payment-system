import { fileURLToPath } from "node:url";
import path from "node:path";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { env } from "./env.js";
import { registerRoutes } from "./routes.js";
import { isFrontendLockdownActive } from "./security.js";

const app = Fastify({ logger: true, trustProxy: 1 });
const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../public");

await app.register(cookie);
await app.register(rateLimit, { global: false });
app.addHook("onRequest", async (request, reply) => {
  const path = request.url.split("?", 1)[0];
  const backgroundPath =
    path === "/health" ||
    path === "/webhooks/helius" ||
    path === "/webhooks/supabase/logs";
  if (!backgroundPath && await isFrontendLockdownActive()) {
    return reply
      .code(503)
      .type("text/plain; charset=utf-8")
      .send("Service unavailable");
  }
});
app.addHook("onSend", async (_request, reply) => {
  reply
    .header("content-security-policy", "default-src 'self'; img-src 'self' https://files.catbox.moe data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'")
    .header("cross-origin-opener-policy", "same-origin")
    .header("cross-origin-resource-policy", "same-origin")
    .header("permissions-policy", "camera=(), microphone=(), geolocation=()")
    .header("referrer-policy", "no-referrer")
    .header("x-content-type-options", "nosniff")
    .header("x-frame-options", "DENY");
  if (env.NODE_ENV === "production") {
    reply.header("strict-transport-security", "max-age=31536000; includeSubDomains");
  }
});
await app.register(fastifyStatic, {
  root: publicDir,
  prefix: "/"
});
await registerRoutes(app);

app.get("/health", async () => ({ ok: true }));
app.setErrorHandler((error, _request, reply) => {
  app.log.error(error);
  reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
});

await app.listen({ host: env.HOST, port: env.PORT });
