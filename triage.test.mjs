import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createApp } from "./server.mjs";
import { attachTriageForm } from "./client.mjs";

const manual = { status: "manual_review", topic: null, draft: null };

async function serve(t, options) {
  const server = createApp(options);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  return async (body) => {
    const reply = await fetch(`http://127.0.0.1:${server.address().port}/api/triage`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body,
    });
    return { status: reply.status, body: await reply.json() };
  };
}

test("invalid input returns 400 without calling AI", async (t) => {
  let calls = 0;
  const post = await serve(t, { model: () => { calls++; } });
  for (const body of ["", "{", "null", "[]", "42", '"text"', "{}",
    ...[null, false, 42, [], {}, "", " \n\t "].map((text) => JSON.stringify({ text }))]) {
    assert.deepEqual(await post(body), { status: 400, body: { status: "invalid_input" } }, body);
  }
  assert.equal(calls, 0);
});

test("ordinary requests return the expected topics and a draft", async (t) => {
  const post = await serve(t);
  for (const [text, topic] of [["Доставка", "delivery"], ["Стоимость", "pricing"], ["Привет", "other"]]) {
    const reply = await post(JSON.stringify({ text }));
    assert.equal(reply.status, 200);
    assert.deepEqual(reply.body, {
      status: "ready", topic, draft: "Спасибо за обращение. Уточним детали заявки.",
    });
  }
});

for (const marker of ["[timeout]", "[error]", "[bad-json]", "[bad-topic]", "[empty-draft]"]) {
  test(`${marker} returns manual review; server accepts the next request`, async (t) => {
    const post = await serve(t);
    const start = performance.now();
    assert.deepEqual(await post(JSON.stringify({ text: marker })), { status: 200, body: manual });
    if (marker === "[timeout]") assert.ok(performance.now() - start < 1_000);
    assert.equal((await post(JSON.stringify({ text: "Привет" }))).body.status, "ready");
  });
}

test("deadline also works if provider ignores cancellation", { timeout: 1_500 }, async (t) => {
  let signal;
  const post = await serve(t, { model: (_, options) => {
    signal = options.signal;
    return new Promise(() => {});
  } });
  const reply = await post(JSON.stringify({ text: "Привет" }));
  assert.deepEqual(reply, { status: 200, body: manual });
  assert.equal(signal.aborted, true);
});

test("schema validation rejects unexpected model output and filters extra fields", async (t) => {
  let raw;
  const post = await serve(t, { model: () => raw });
  for (raw of ["null", "[]", "42", "{}", '{"topic":"delivery"}',
    '{"topic":"pricing","draft":123}', '{"topic":"other","draft":"  "}']) {
    assert.deepEqual(await post('{"text":"Привет"}'), { status: 200, body: manual }, raw);
  }
  raw = JSON.stringify({ status: "manual_review", topic: "other", draft: " Ответ ", extra: true });
  assert.deepEqual(await post('{"text":"Привет"}'), {
    status: 200, body: { status: "ready", topic: "other", draft: "Ответ" },
  });
});

function formFixture(fetchRequest) {
  const elements = Object.fromEntries(["form", "#message", "button", "#result", "#topic", "#draft"]
    .map((selector) => [selector, { value: "Привет", textContent: "", disabled: false }]));
  let submit;
  elements.form.addEventListener = (event, handler) => {
    assert.equal(event, "submit");
    submit = () => handler({ preventDefault() {} });
  };
  attachTriageForm({ querySelector: (selector) => elements[selector] }, fetchRequest);
  return { elements, submit: () => submit() };
}

for (const failure of ["manual_review", "network", "bad-json", "http-error", "bad-ready"]) {
  test(`page clears previous draft on ${failure} and allows retry`, async () => {
    let fail = false;
    const { elements, submit } = formFixture(async () => {
      if (fail && failure === "network") throw new Error("Offline");
      return {
        ok: !(fail && failure === "http-error"), status: fail && failure === "http-error" ? 500 : 200,
        json: async () => {
          if (fail && failure === "bad-json") throw new SyntaxError("Bad JSON");
          if (fail && failure === "manual_review") return manual;
          return { status: "ready", topic: fail && failure === "bad-ready" ? "refund" : "delivery", draft: "Черновик" };
        },
      };
    });
    await submit();
    assert.equal(elements["#topic"].textContent, "Тема: Доставка");
    assert.equal(elements["#draft"].textContent, "Черновик");
    fail = true;
    const pending = submit();
    assert.equal(elements["#draft"].textContent, "");
    assert.equal(elements.button.disabled, true);
    await pending;
    assert.match(elements["#result"].textContent, /вручную/);
    assert.equal(elements["#topic"].textContent, "");
    assert.equal(elements["#draft"].textContent, "");
    assert.equal(elements.button.disabled, false);
    fail = false;
    await submit();
    assert.equal(elements["#draft"].textContent, "Черновик");
  });
}

test("empty form clears stale output without making a request", async () => {
  const { elements, submit } = formFixture(() => assert.fail("Must not call API"));
  elements["#message"].value = " \n ";
  elements["#draft"].textContent = "Предыдущий черновик";
  await submit();
  assert.equal(elements["#draft"].textContent, "");
  assert.equal(elements["#result"].textContent, "Введите текст заявки.");
});

test("duplicate submit cannot overwrite the current result", async () => {
  let resolve;
  let calls = 0;
  const { elements, submit } = formFixture(() => {
    calls++;
    return new Promise((done) => { resolve = done; });
  });
  const pending = submit();
  await submit();
  assert.equal(calls, 1);
  resolve({ ok: true, status: 200, json: async () => ({ status: "ready", topic: "other", draft: "Ответ" }) });
  await pending;
  assert.equal(elements["#draft"].textContent, "Ответ");
});

test("page handles a server-side invalid input response", async () => {
  const { elements, submit } = formFixture(async () => ({
    ok: false, status: 400, json: async () => ({ status: "invalid_input" }),
  }));
  await submit();
  assert.equal(elements["#result"].textContent, "Введите текст заявки.");
  assert.equal(elements["#draft"].textContent, "");
  assert.equal(elements.button.disabled, false);
});

test("page falls back when network request times out", { timeout: 7_000 }, async () => {
  const { elements, submit } = formFixture((_, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }));
  const pending = submit();
  await pending;
  assert.match(elements["#result"].textContent, /вручную/);
  assert.equal(elements["#draft"].textContent, "");
  assert.equal(elements.button.disabled, false);
});
