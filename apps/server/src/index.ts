import { fileURLToPath } from "node:url";
import path from "node:path";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { env } from "./env.js";
import { registerRoutes } from "./routes.js";

const app = Fastify({ logger: true });
const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../public");

await app.register(cookie);
await app.register(rateLimit, { global: false });
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
