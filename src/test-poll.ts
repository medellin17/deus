import { createOpencodeClient } from "@opencode-ai/sdk";

async function main() {
  const client = createOpencodeClient({ baseUrl: "http://localhost:4096" });

  console.log("1. Creating session...");
  const sessionRes = await client.session.create({ body: { title: "test-poll" } });
  const sessionId = sessionRes.data?.id;
  console.log("   Session ID:", sessionId);

  // 2. Запускаем prompt_async — задача, которая будет выполняться долго
  console.log("2. Sending async prompt...");
  const promptPromise = client.session.prompt({
    path: { id: sessionId },
    body: {
      model: { providerID: "opencode-go", modelID: "deepseek-v4-flash" },
      parts: [{ type: "text", text: "Напиши очень длинный текст на 5 параграфов про историю программирования. Пиши медленно, не торопись." }]
    }
  });

  // 3. НЕМЕДЛЕННО (до завершения) запрашиваем сообщения
  console.log("3. Polling messages immediately (before finish)...");
  await sleep(2000); // даём 2 секунды на генерацию первого токена

  const messagesRes = await client.session.messages({ path: { id: sessionId } });
  const messages = messagesRes.data;

  if (messages && messages.length > 0) {
    console.log(`   ✅ Получено ${messages.length} сообщений ДО завершения!`);
    for (const msg of messages) {
      const parts = msg.parts || [];
      const text = parts.map((p: any) => p.text || "").join(" ").slice(0, 200);
      console.log(`   - [${msg.info?.role}] ${text}...`);
    }
  } else {
    console.log("   ❌ Сообщений нет — messages() пуст до finish=stop");
  }

  // 4. Ждём завершения и финальный poll
  console.log("4. Waiting for completion...");
  // дожидаемся ответа от prompt
  await promptPromise;
  console.log("   prompt resolved");

  const finalRes = await client.session.messages({ path: { id: sessionId } });
  const finalMessages = finalRes.data;
  if (finalMessages) {
    console.log(`   Финальных сообщений: ${finalMessages.length}`);
    const lastMsg = finalMessages[finalMessages.length - 1];
    if (lastMsg.info?.finish === "stop") {
      console.log("   ✅ Сессия завершилась корректно (finish=stop)");
    } else {
      console.log("   ⚠️ Последнее сообщение finish:", lastMsg.info?.finish);
    }
  }

  console.log("\n=== ВЕРДИКТ ===");
  if (messages && messages.length > 0) {
    console.log("✅ ПОТОКОВЫЙ МОНИТОРИНГ РАБОТАЕТ — можно проверять [CHECKPOINT] в реальном времени");
  } else {
    console.log("❌ СТРИМИНГ НЕ РАБОТАЕТ — нужно полагаться только на force-trigger");
  }
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

main().catch(e => { console.error("ERROR:", e.message || e); process.exit(1); });
