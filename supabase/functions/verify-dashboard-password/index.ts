import bcrypt from "npm:bcryptjs@3.0.3";

function bearerRole(request: Request): string | null {
  const authorization = request.headers.get("authorization") ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = parts[1].replaceAll("-", "+").replaceAll("_", "/");
    const padded = payload.padEnd(Math.ceil(payload.length / 4) * 4, "=");
    const claims = JSON.parse(atob(padded)) as { role?: unknown };
    return typeof claims.role === "string" ? claims.role : null;
  } catch {
    return null;
  }
}

Deno.serve(async (request) => {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const dashboardPasswordHash = Deno.env.get("DASHBOARD_PASSWORD_HASH");
  // Supabase's gateway verifies the JWT before this function runs.
  if (bearerRole(request) !== "service_role") {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!dashboardPasswordHash) {
    return Response.json({ error: "Password verifier is not configured" }, { status: 503 });
  }

  let password = "";
  try {
    const body = await request.json() as { password?: unknown };
    password = typeof body.password === "string" ? body.password : "";
  } catch {
    return Response.json({ valid: false }, { status: 400 });
  }

  if (!password || password.length > 1024) {
    return Response.json({ valid: false });
  }
  return Response.json(
    { valid: await bcrypt.compare(password, dashboardPasswordHash) },
    { headers: { "cache-control": "no-store" } }
  );
});
