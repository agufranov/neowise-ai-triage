const topicLabels = { delivery: "Доставка", pricing: "Стоимость", other: "Другое" };
const manualMessage = "Не удалось подготовить ответ. Разберите заявку вручную: определите тему и составьте ответ клиенту.";

export function attachTriageForm(document, fetchRequest = globalThis.fetch) {
  const form = document.querySelector("form");
  const message = document.querySelector("#message");
  const button = document.querySelector("button");
  const result = document.querySelector("#result");
  const topic = document.querySelector("#topic");
  const draft = document.querySelector("#draft");
  let busy = false;

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy) return;
    topic.textContent = "";
    draft.textContent = "";
    const text = message.value.trim();
    if (!text) {
      result.textContent = "Введите текст заявки.";
      return;
    }

    busy = true;
    button.disabled = true;
    message.disabled = true;
    result.textContent = "Готовим черновик…";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
      const reply = await fetchRequest("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
        signal: controller.signal,
      });
      const data = await reply.json();
      if (reply.status === 400 && data?.status === "invalid_input") {
        result.textContent = "Введите текст заявки.";
      } else if (reply.ok && data?.status === "ready" &&
          Object.hasOwn(topicLabels, data.topic) &&
          typeof data.draft === "string" && data.draft.trim()) {
        topic.textContent = `Тема: ${topicLabels[data.topic]}`;
        draft.textContent = data.draft;
        result.textContent = "Черновик готов. Проверьте его перед отправкой клиенту.";
      } else {
        result.textContent = manualMessage;
      }
    } catch {
      result.textContent = manualMessage;
    } finally {
      clearTimeout(timer);
      busy = false;
      button.disabled = false;
      message.disabled = false;
    }
  });
}
