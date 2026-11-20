import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { classify } from "./mock-ai.mjs";
import { pathToFileURL } from "node:url";

const html = await readFile(new URL("./index.html", import.meta.url));
const client = await readFile(new URL("./client.mjs", import.meta.url));
const topics = new Set(["delivery", "pricing", "other"]);
const manualReview = { status: "manual_review", topic: null, draft: null };

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function handleTriage(request, response, model) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  let input;
  try {
    input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return json(response, 400, { status: "invalid_input" });
  }
  if (!input || typeof input.text !== "string" || !input.text.trim()) {
    return json(response, 400, { status: "invalid_input" });
  }

  const controller = new AbortController();
  let timer;
  try {
    // Race also bounds providers that ignore AbortSignal.
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error("Model timeout"));
        controller.abort();
      }, 300);
    });
    const raw = await Promise.race([
      Promise.resolve().then(() => model(input.text.trim(), { signal: controller.signal })),
      deadline,
    ]);
    const result = JSON.parse(raw);
    if (!result || Array.isArray(result) || !topics.has(result.topic) ||
        typeof result.draft !== "string" || !result.draft.trim()) {
      return json(response, 200, manualReview);
    }
    return json(response, 200, {
      status: "ready", topic: result.topic, draft: result.draft.trim(),
    });
  } catch {
    return json(response, 200, manualReview);
  } finally {
    clearTimeout(timer);
  }
}

export function createApp({ model = classify } = {}) {
  return createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(html);
      return;
    }
    if (request.method === "GET" && request.url === "/client.mjs") {
      response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
      response.end(client);
      return;
    }
    if (request.method !== "POST" || request.url !== "/api/triage") {
      return json(response, 404, { status: "not_found" });
    }
    try {
      await handleTriage(request, response, model);
    } catch {
      json(response, 500, { status: "server_error" });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createApp().listen(Number(process.env.PORT || 3000), "127.0.0.1");
}
