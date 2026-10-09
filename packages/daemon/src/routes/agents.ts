import { Hono } from "hono";
import { validateAgentSpecFromYaml } from "../domain/spec-validation-service.js";

export const agentsRoutes = new Hono();

// POST /api/agents/validate
agentsRoutes.post("/validate", async (c) => {
  const body = await c.req.text();
  if (!body.trim()) {
    return c.json({ valid: false, errors: ["空的 YAML 请求体"] }, 400);
  }
  const result = validateAgentSpecFromYaml(body);
  return c.json(result);
});
