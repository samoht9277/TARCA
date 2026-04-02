/**
 * TARCA - Telegram ARCA Invoice Bot
 * Cloudflare Worker entry point.
 *
 * Flow:
 * 1. User sends an amount (e.g., "15000" or "15000.50")
 * 2. Bot asks for confirmation with inline buttons
 * 3. User taps "Confirmar" → invoice is created on ARCA
 * 4. Bot responds with invoice details (CAE, number, etc.)
 */
import {
  type TelegramUpdate,
  sendMessage,
  answerCallbackQuery,
  editMessageText,
  setWebhook,
} from "./telegram";
import { authenticate } from "./afip/wsaa";
import { createInvoice } from "./afip/wsfev1";

export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  AFIP_CERT: string;
  AFIP_KEY: string;
  AFIP_CUIT: string;
  AFIP_PTO_VTA: string;
  AFIP_ENV: string;
}

function getAfipEnv(env: Env): "testing" | "production" {
  return env.AFIP_ENV === "production" ? "production" : "testing";
}

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
  }).format(amount);
}

function formatCbteNro(ptoVta: number, cbteNro: number): string {
  return `${String(ptoVta).padStart(5, "0")}-${String(cbteNro).padStart(8, "0")}`;
}

async function handleMessage(
  update: TelegramUpdate,
  env: Env
): Promise<void> {
  const message = update.message;
  if (!message?.text) return;

  const chatId = message.chat.id;
  const text = message.text.trim();
  const token = env.TELEGRAM_BOT_TOKEN;

  // Handle /start command
  if (text === "/start") {
    await sendMessage(
      token,
      chatId,
      "Hola! Soy TARCA 🧾\n\n" +
        "Enviame un monto y te creo una Factura C en ARCA.\n\n" +
        "Ejemplo: <code>15000</code> o <code>15000.50</code>"
    );
    return;
  }

  // Parse amount
  const amount = parseFloat(text.replace(/,/g, ".").replace(/\$/g, "").trim());

  if (isNaN(amount) || amount <= 0) {
    await sendMessage(
      token,
      chatId,
      "No entendí el monto. Enviame un número, por ejemplo: <code>15000</code>"
    );
    return;
  }

  // Send confirmation message with inline keyboard
  const confirmKeyboard = {
    inline_keyboard: [
      [
        { text: "✅ Confirmar", callback_data: `confirm:${amount}` },
        { text: "❌ Cancelar", callback_data: "cancel" },
      ],
    ],
  };

  const afipEnv = getAfipEnv(env);
  const envLabel = afipEnv === "testing" ? " (TESTING)" : "";

  await sendMessage(
    token,
    chatId,
    `Crear Factura C por <b>${formatCurrency(amount)}</b>?${envLabel}\n\n` +
      `📋 Servicios Informáticos\n` +
      `👤 Consumidor Final`,
    confirmKeyboard
  );
}

async function handleCallbackQuery(
  update: TelegramUpdate,
  env: Env
): Promise<void> {
  const query = update.callback_query;
  if (!query?.data || !query.message) return;

  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;

  // Always answer the callback to remove loading state
  await answerCallbackQuery(token, query.id);

  if (query.data === "cancel") {
    await editMessageText(token, chatId, messageId, "❌ Cancelado.");
    return;
  }

  if (query.data.startsWith("confirm:")) {
    const amount = parseFloat(query.data.split(":")[1]);
    if (isNaN(amount)) {
      await editMessageText(token, chatId, messageId, "Error: monto inválido.");
      return;
    }

    // Update message to show progress
    await editMessageText(
      token,
      chatId,
      messageId,
      `⏳ Creando factura por ${formatCurrency(amount)}...`
    );

    try {
      const afipEnv = getAfipEnv(env);

      // Authenticate with AFIP
      const auth = await authenticate(
        env.AFIP_CERT,
        env.AFIP_KEY,
        afipEnv
      );

      // Create invoice
      const result = await createInvoice(
        auth,
        env.AFIP_CUIT,
        parseInt(env.AFIP_PTO_VTA, 10),
        amount,
        afipEnv
      );

      const envLabel = afipEnv === "testing" ? "\n⚠️ <i>Entorno de testing</i>" : "";

      await editMessageText(
        token,
        chatId,
        messageId,
        `✅ <b>Factura C creada</b>\n\n` +
          `📄 Nº ${formatCbteNro(result.ptoVta, result.cbteNro)}\n` +
          `💰 ${formatCurrency(amount)}\n` +
          `📋 Servicios Informáticos\n` +
          `🔑 CAE: <code>${result.cae}</code>\n` +
          `📅 Vto CAE: ${result.caeFchVto}` +
          envLabel
      );
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      await editMessageText(
        token,
        chatId,
        messageId,
        `❌ Error al crear factura:\n<code>${errMsg}</code>`
      );
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // GET /setup - Register webhook with Telegram
    if (url.pathname === "/setup" && request.method === "GET") {
      const webhookUrl = `${url.origin}/webhook`;
      try {
        await setWebhook(env.TELEGRAM_BOT_TOKEN, webhookUrl);
        return new Response(`Webhook set to: ${webhookUrl}`, { status: 200 });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return new Response(`Failed to set webhook: ${msg}`, { status: 500 });
      }
    }

    // POST /webhook - Telegram webhook handler
    if (url.pathname === "/webhook" && request.method === "POST") {
      try {
        const update = (await request.json()) as TelegramUpdate;

        if (update.callback_query) {
          await handleCallbackQuery(update, env);
        } else if (update.message) {
          await handleMessage(update, env);
        }
      } catch (error) {
        console.error("Webhook error:", error);
      }

      // Always return 200 to Telegram so it doesn't retry
      return new Response("OK", { status: 200 });
    }

    // Health check
    if (url.pathname === "/" && request.method === "GET") {
      return new Response("TARCA is running", { status: 200 });
    }

    return new Response("Not found", { status: 404 });
  },
};
