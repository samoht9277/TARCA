/**
 * TARCA - Telegram ARCA Invoice Bot
 * Cloudflare Worker entry point.
 *
 * Flow:
 * 1. User sends an amount (e.g., "15000" or "15000.50")
 * 2. Bot asks for confirmation with inline buttons
 * 3. User taps "Confirmar" -> invoice is created on ARCA
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
import { createInvoice, createCreditNote, queryInvoice, getLastInvoiceNumber } from "./afip/wsfev1";

export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  ALLOWED_CHAT_IDS: string;
  AFIP_CERT: string;
  AFIP_KEY: string;
  AFIP_CUIT: string;
  AFIP_PTO_VTA: string;
  AFIP_ENV: string;
  SETUP_SECRET: string;
}

const MAX_AMOUNT = 10_000_000;
const AR_TZ_OFFSET = -3 * 60 * 60 * 1000;

function getAfipEnv(env: Env): "testing" | "production" {
  return env.AFIP_ENV === "production" ? "production" : "testing";
}

function nowAR(): Date {
  const utc = Date.now();
  return new Date(utc + AR_TZ_OFFSET);
}

function isAllowedChat(env: Env, chatId: number): boolean {
  if (!env.ALLOWED_CHAT_IDS) return false;
  const allowed = env.ALLOWED_CHAT_IDS.split(",").map((id) => id.trim());
  return allowed.includes(String(chatId));
}

export function formatCurrency(amount: number): string {
  return new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
  }).format(amount);
}

export function formatCbteNro(ptoVta: number, cbteNro: number): string {
  return `${String(ptoVta).padStart(5, "0")}-${String(cbteNro).padStart(8, "0")}`;
}

/**
 * Parse an amount string supporting both AR and international number formats.
 *
 * Handles:
 *   "15000"       -> 15000
 *   "15000.50"    -> 15000.50
 *   "15000,50"    -> 15000.50
 *   "1.500,50"    -> 1500.50  (AR: dots=thousands, comma=decimal)
 *   "1,500.50"    -> 1500.50  (US: commas=thousands, dot=decimal)
 *   "1.500"       -> 1500     (AR thousands)
 *   "1.500.000"   -> 1500000  (AR thousands)
 */
export function parseAmountStr(str: string): number | null {
  let s = str.replace(/[\s$]/g, "");
  if (!s || !/^[\d.,]+$/.test(s)) return null;

  const hasComma = s.includes(",");
  const hasDot = s.includes(".");

  if (hasComma && hasDot) {
    if (s.lastIndexOf(",") > s.lastIndexOf(".")) {
      // 1.500,50 -> AR format
      s = s.replace(/\./g, "").replace(",", ".");
    } else {
      // 1,500.50 -> US format
      s = s.replace(/,/g, "");
    }
  } else if (hasComma) {
    const afterComma = s.split(",").pop()!;
    if (afterComma.length <= 2) {
      s = s.replace(",", ".");
    } else {
      s = s.replace(/,/g, "");
    }
  } else if (hasDot) {
    const parts = s.split(".");
    const afterDot = parts[parts.length - 1];
    if (parts.length > 2 || (afterDot.length === 3 && parts[0].length <= 3)) {
      // 1.500.000 or 1.500 -> thousands dots
      s = s.replace(/\./g, "");
    }
    // else: 15000.50 -> decimal dot, leave as-is
  }

  const amount = parseFloat(s);
  if (isNaN(amount) || amount <= 0) return null;
  if (amount > MAX_AMOUNT) return null;
  return Math.round(amount * 100) / 100;
}

/**
 * Parse user input: "<amount>" or "<amount> <dd/mm>" or "<amount> <dd/mm/yyyy>"
 */
export function parseInput(text: string): { amount: number; date: Date } | null {
  const cleaned = text.replace(/\$/g, "").trim();
  // Split into amount part and optional date part
  const match = cleaned.match(
    /^([\d.,]+)(?:\s+(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?)?$/
  );
  if (!match) return null;

  const amount = parseAmountStr(match[1]);
  if (amount === null) return null;

  let date = nowAR();
  if (match[2] && match[3]) {
    const day = parseInt(match[2], 10);
    const month = parseInt(match[3], 10) - 1;
    let year = match[4] ? parseInt(match[4], 10) : date.getFullYear();
    if (year < 100) year += 2000;

    if (month < 0 || month > 11 || day < 1 || day > 31) return null;

    date = new Date(year, month, day);
    if (isNaN(date.getTime())) return null;

    // Catch JS Date rollover (e.g. Feb 31 -> Mar 3)
    if (date.getDate() !== day || date.getMonth() !== month) return null;
  }

  return { amount, date };
}

export function formatDateYMD(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

export function parseDateYMD(str: string): Date {
  const y = parseInt(str.substring(0, 4), 10);
  const m = parseInt(str.substring(4, 6), 10) - 1;
  const d = parseInt(str.substring(6, 8), 10);
  return new Date(y, m, d);
}

export function formatDateAR(date: Date): string {
  return date.toLocaleDateString("es-AR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
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

  // Only allow private chats
  if (message.chat.type !== "private") return;

  // Authorization check
  if (!isAllowedChat(env, chatId)) {
    await sendMessage(token, chatId, "No autorizado.");
    return;
  }

  // Handle /start command
  if (text.startsWith("/start")) {
    const afipEnv = getAfipEnv(env);
    const envTag = afipEnv === "testing" ? " [TESTING]" : "";
    await sendMessage(
      token,
      chatId,
      `<b>TARCA</b>${envTag}\n` +
        `Facturacion electronica por Telegram\n\n` +
        `Enviame un monto para crear una Factura C:\n\n` +
        `  <code>15000</code>  -  fecha de hoy\n` +
        `  <code>15000 28/03</code>  -  con fecha\n` +
        `  <code>1.500,50</code>  -  con decimales\n\n` +
        `<b>Comandos</b>\n` +
        `  /check  -  ultima factura emitida\n` +
        `  /check 3  -  consultar factura #3\n` +
        `  /anular 3  -  anular factura #3\n` +
        `  /resumen  -  resumen del mes`
    );
    return;
  }

  // Handle /check command - query existing invoice
  if (text.startsWith("/check")) {
    try {
      const afipEnv = getAfipEnv(env);
      const ptoVta = parseInt(env.AFIP_PTO_VTA, 10);
      const auth = await authenticate(env.AFIP_CERT, env.AFIP_KEY, afipEnv);

      const parts = text.split(/\s+/);
      const cbteNro = parts[1] ? parseInt(parts[1], 10) : 0;

      if (parts[1] && (isNaN(cbteNro) || cbteNro <= 0)) {
        await sendMessage(token, chatId, "Uso: /check o /check 3");
        return;
      }

      // If no number given, get the last one
      const targetNro = cbteNro > 0
        ? cbteNro
        : await getLastInvoiceNumber(auth, env.AFIP_CUIT, ptoVta, 11, afipEnv);

      if (targetNro === 0) {
        await sendMessage(token, chatId, "No hay facturas emitidas en este punto de venta.");
        return;
      }

      const info = await queryInvoice(auth, env.AFIP_CUIT, ptoVta, targetNro, afipEnv);

      const estado = info.resultado === "A" ? "Aprobada" : "Rechazada";
      const fchEmision = info.cbteFch ? formatDateAR(parseDateYMD(info.cbteFch)) : "-";
      const fchVto = info.caeFchVto ? formatDateAR(parseDateYMD(info.caeFchVto)) : "-";
      const importe = info.impTotal ? formatCurrency(parseFloat(info.impTotal)) : "-";

      await sendMessage(
        token,
        chatId,
        `<b>Factura C  ${formatCbteNro(ptoVta, targetNro)}</b>\n` +
          `${estado === "Aprobada" ? "Aprobada por ARCA" : "RECHAZADA"}\n\n` +
          `Importe  <b>${importe}</b>\n` +
          `Fecha  ${fchEmision}\n\n` +
          `CAE  <code>${info.cae}</code>\n` +
          `Vencimiento  ${fchVto}`
      );
    } catch (error) {
      console.error("Check failed:", error);
      await sendMessage(token, chatId, "Error al consultar factura.");
    }
    return;
  }

  // Handle /anular command - create credit note to reverse an invoice
  if (text.startsWith("/anular")) {
    const parts = text.split(/\s+/);
    const cbteNro = parts[1] ? parseInt(parts[1], 10) : 0;

    if (!cbteNro || isNaN(cbteNro) || cbteNro <= 0) {
      await sendMessage(token, chatId, "Uso: <code>/anular 3</code> (numero de factura)");
      return;
    }

    try {
      const afipEnv = getAfipEnv(env);
      const ptoVta = parseInt(env.AFIP_PTO_VTA, 10);
      const auth = await authenticate(env.AFIP_CERT, env.AFIP_KEY, afipEnv);

      const info = await queryInvoice(auth, env.AFIP_CUIT, ptoVta, cbteNro, afipEnv);

      if (!info.cae || info.resultado !== "A") {
        await sendMessage(token, chatId, `Factura #${cbteNro} no encontrada o no esta aprobada.`);
        return;
      }

      const importe = formatCurrency(parseFloat(info.impTotal));
      const fchEmision = info.cbteFch ? formatDateAR(parseDateYMD(info.cbteFch)) : "-";

      const keyboard = {
        inline_keyboard: [
          [
            { text: "Anular", callback_data: `anular:${cbteNro}` },
            { text: "Cancelar", callback_data: "cancel" },
          ],
        ],
      };

      await sendMessage(
        token,
        chatId,
        `<b>Anular Factura C  ${formatCbteNro(ptoVta, cbteNro)}</b>\n\n` +
          `Monto  <b>${importe}</b>\n` +
          `Fecha  ${fchEmision}\n\n` +
          `Se emitira una <b>Nota de Credito C</b> por el mismo monto.`,
        keyboard
      );
    } catch (error) {
      console.error("Anular lookup failed:", error);
      await sendMessage(token, chatId, "Error al consultar factura.");
    }
    return;
  }

  // Handle /resumen command - monthly summary
  if (text.startsWith("/resumen")) {
    try {
      const afipEnv = getAfipEnv(env);
      const ptoVta = parseInt(env.AFIP_PTO_VTA, 10);
      const auth = await authenticate(env.AFIP_CERT, env.AFIP_KEY, afipEnv);

      const today = nowAR();
      const currentMonth = today.getMonth();
      const currentYear = today.getFullYear();
      const monthName = today.toLocaleDateString("es-AR", { month: "long", year: "numeric" });

      // Get last invoice number for Factura C
      const lastFactura = await getLastInvoiceNumber(auth, env.AFIP_CUIT, ptoVta, 11, afipEnv);

      if (lastFactura === 0) {
        await sendMessage(token, chatId, "No hay facturas emitidas.");
        return;
      }

      // Iterate backwards through invoices, collecting current month ones
      let totalFacturas = 0;
      let sumFacturas = 0;
      const invoices: { nro: number; amount: number; date: string }[] = [];

      for (let i = lastFactura; i >= 1; i--) {
        const info = await queryInvoice(auth, env.AFIP_CUIT, ptoVta, i, afipEnv);
        if (!info.cbteFch) continue;

        const invDate = parseDateYMD(info.cbteFch);
        if (invDate.getFullYear() !== currentYear || invDate.getMonth() !== currentMonth) {
          break; // Past invoices are in order, so we can stop
        }

        if (info.resultado === "A") {
          const amount = parseFloat(info.impTotal);
          totalFacturas++;
          sumFacturas += amount;
          invoices.push({ nro: i, amount, date: formatDateAR(invDate) });
        }
      }

      // Check credit notes (Nota de Credito C = 13)
      const lastNC = await getLastInvoiceNumber(auth, env.AFIP_CUIT, ptoVta, 13, afipEnv);
      let totalNC = 0;
      let sumNC = 0;

      for (let i = lastNC; i >= 1; i--) {
        const info = await queryInvoice(auth, env.AFIP_CUIT, ptoVta, i, afipEnv, 13);
        if (!info.cbteFch) continue;

        const invDate = parseDateYMD(info.cbteFch);
        if (invDate.getFullYear() !== currentYear || invDate.getMonth() !== currentMonth) {
          break;
        }

        if (info.resultado === "A") {
          totalNC++;
          sumNC += parseFloat(info.impTotal);
        }
      }

      const neto = sumFacturas - sumNC;

      // Build summary message
      let msg = `<b>Resumen  ${monthName}</b>\n\n`;

      if (invoices.length === 0 && totalNC === 0) {
        msg += "No hay comprobantes emitidos este mes.";
      } else {
        if (invoices.length > 0) {
          msg += `<b>Facturas</b>\n`;
          for (const inv of invoices.reverse()) {
            msg += `  #${inv.nro}  ${formatCurrency(inv.amount)}  ${inv.date}\n`;
          }
          msg += `\n`;
        }

        if (totalNC > 0) {
          msg += `Notas de credito: ${totalNC} por ${formatCurrency(sumNC)}\n\n`;
        }

        msg += `Facturado  <b>${formatCurrency(sumFacturas)}</b>`;
        if (totalNC > 0) {
          msg += `\nAnulado  ${formatCurrency(sumNC)}`;
          msg += `\n<b>Neto  ${formatCurrency(neto)}</b>`;
        }
        msg += `\n${totalFacturas} factura${totalFacturas !== 1 ? "s" : ""}`;
      }

      await sendMessage(token, chatId, msg);
    } catch (error) {
      console.error("Resumen failed:", error);
      await sendMessage(token, chatId, "Error al generar resumen.");
    }
    return;
  }

  // Parse amount and optional date
  const parsed = parseInput(text);

  if (!parsed) {
    await sendMessage(
      token,
      chatId,
      "No entendi. Enviame un monto, opcionalmente con fecha.\n\n" +
        "Ej: <code>15000</code> o <code>15000 28/03</code>"
    );
    return;
  }

  const { amount, date } = parsed;
  const dateStr = formatDateAR(date);

  // callback_data format: "confirm:<amount>:<YYYYMMDD>"
  const datePayload = formatDateYMD(date);
  const confirmKeyboard = {
    inline_keyboard: [
      [
        { text: "Confirmar", callback_data: `confirm:${amount}:${datePayload}` },
        { text: "Cancelar", callback_data: "cancel" },
      ],
    ],
  };

  const afipEnv = getAfipEnv(env);
  const envLabel = afipEnv === "testing" ? "\n<i>[TESTING]</i>" : "";
  const todayAR = nowAR();
  const isToday = formatDateYMD(date) === formatDateYMD(todayAR);

  await sendMessage(
    token,
    chatId,
    `<b>Nueva Factura C</b>${envLabel}\n\n` +
      `Monto  <b>${formatCurrency(amount)}</b>\n` +
      `Fecha  ${dateStr}${isToday ? " (hoy)" : ""}\n` +
      `Concepto  Servicios Informaticos\n` +
      `Receptor  Consumidor Final`,
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

  // Authorization check
  if (!isAllowedChat(env, query.from.id)) {
    await answerCallbackQuery(token, query.id, "No autorizado.");
    return;
  }

  // Always answer the callback to remove loading state
  await answerCallbackQuery(token, query.id);

  if (query.data === "cancel") {
    await editMessageText(token, chatId, messageId, "Cancelado.");
    return;
  }

  if (query.data.startsWith("anular:")) {
    const cbteNro = parseInt(query.data.split(":")[1], 10);
    if (isNaN(cbteNro) || cbteNro <= 0) {
      await editMessageText(token, chatId, messageId, "Error: datos invalidos.");
      return;
    }

    await editMessageText(token, chatId, messageId, "Procesando nota de credito...");

    try {
      const afipEnv = getAfipEnv(env);
      const ptoVta = parseInt(env.AFIP_PTO_VTA, 10);
      const auth = await authenticate(env.AFIP_CERT, env.AFIP_KEY, afipEnv);

      const original = await queryInvoice(auth, env.AFIP_CUIT, ptoVta, cbteNro, afipEnv);
      if (!original.cae || original.resultado !== "A") {
        await editMessageText(token, chatId, messageId, "Factura no encontrada o no aprobada.");
        return;
      }

      const result = await createCreditNote(
        auth,
        env.AFIP_CUIT,
        ptoVta,
        original,
        afipEnv,
        nowAR()
      );

      const importe = formatCurrency(parseFloat(original.impTotal));
      const fchVto = result.caeFchVto
        ? formatDateAR(parseDateYMD(result.caeFchVto))
        : result.caeFchVto;

      await editMessageText(
        token,
        chatId,
        messageId,
        `<b>Nota de Credito C  ${formatCbteNro(result.ptoVta, result.cbteNro)}</b>\n` +
          `Aprobada por ARCA\n\n` +
          `Anula Factura C #${cbteNro}\n` +
          `Monto  <b>${importe}</b>\n\n` +
          `CAE  <code>${result.cae}</code>\n` +
          `Vencimiento  ${fchVto}`
      );
    } catch (error) {
      console.error("Credit note failed:", error);
      await editMessageText(
        token,
        chatId,
        messageId,
        "Error al crear nota de credito. Revisa los logs."
      );
    }
    return;
  }

  if (query.data.startsWith("confirm:")) {
    const parts = query.data.split(":");
    const amount = parseFloat(parts[1]);
    const dateStr = parts[2]; // YYYYMMDD
    if (isNaN(amount) || !dateStr || amount <= 0 || amount > MAX_AMOUNT) {
      await editMessageText(token, chatId, messageId, "Error: datos invalidos.");
      return;
    }

    const date = parseDateYMD(dateStr);

    // Remove keyboard and show progress (prevents double-tap)
    await editMessageText(
      token,
      chatId,
      messageId,
      `Procesando factura por ${formatCurrency(amount)}...`
    );

    try {
      const afipEnv = getAfipEnv(env);

      const auth = await authenticate(
        env.AFIP_CERT,
        env.AFIP_KEY,
        afipEnv
      );

      const result = await createInvoice(
        auth,
        env.AFIP_CUIT,
        parseInt(env.AFIP_PTO_VTA, 10),
        amount,
        afipEnv,
        date
      );

      const envLabel = afipEnv === "testing" ? "\n\n<i>[TESTING]</i>" : "";
      const fchVto = result.caeFchVto
        ? formatDateAR(parseDateYMD(result.caeFchVto))
        : result.caeFchVto;

      await editMessageText(
        token,
        chatId,
        messageId,
        `<b>Factura C  ${formatCbteNro(result.ptoVta, result.cbteNro)}</b>\n` +
          `Aprobada por ARCA\n\n` +
          `Monto  <b>${formatCurrency(amount)}</b>\n` +
          `Fecha  ${formatDateAR(date)}\n` +
          `Concepto  Servicios Informaticos\n\n` +
          `CAE  <code>${result.cae}</code>\n` +
          `Vencimiento  ${fchVto}` +
          envLabel
      );
    } catch (error) {
      console.error("Invoice creation failed:", error);
      await editMessageText(
        token,
        chatId,
        messageId,
        "Error al crear factura. Intenta de nuevo o revisa los logs."
      );
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // GET /setup?secret=<SETUP_SECRET> - Register webhook with Telegram
    if (url.pathname === "/setup" && request.method === "GET") {
      if (!env.SETUP_SECRET || url.searchParams.get("secret") !== env.SETUP_SECRET) {
        return new Response("Unauthorized", { status: 401 });
      }

      const webhookUrl = `${url.origin}/webhook`;
      try {
        await setWebhook(env.TELEGRAM_BOT_TOKEN, webhookUrl, env.TELEGRAM_WEBHOOK_SECRET);
        return new Response(`Webhook set to: ${webhookUrl}`, { status: 200 });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return new Response(`Failed to set webhook: ${msg}`, { status: 500 });
      }
    }

    // POST /webhook - Telegram webhook handler
    if (url.pathname === "/webhook" && request.method === "POST") {
      // Verify webhook secret
      const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
      if (secret !== env.TELEGRAM_WEBHOOK_SECRET) {
        return new Response("Unauthorized", { status: 401 });
      }

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
