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
import { createInvoice, createCreditNote, queryInvoice, getLastInvoiceNumber, type Concepto } from "./afip/wsfev1";

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

function friendlyError(error: unknown): string {
  const msg = error instanceof Error ? error.message : String(error);
  if (msg.includes("numero o fecha") || msg.includes("proximo a autorizar")) {
    return "La fecha no puede ser anterior a la ultima factura emitida.";
  }
  if (msg.includes("PUNTO DE VENTA") || msg.includes("RECE")) {
    return "El punto de venta no esta habilitado para factura electronica.";
  }
  if (msg.includes("NO AUTORIZADO")) {
    return "No autorizado a emitir comprobantes. Verifica tu punto de venta.";
  }
  if (msg.includes("cert") || msg.includes("Certificado")) {
    return "Error de certificado. Verifica AFIP_CERT y AFIP_KEY.";
  }
  return "Error al crear factura. Intenta de nuevo o revisa los logs.";
}

// In-memory state for pending product invoices awaiting a description
interface PendingVenta {
  amount: number;
  date: Date;
  messageId: number;
  timestamp: number;
  concepto?: Concepto;
}
const pendingVentas = new Map<number, PendingVenta>();

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
        `Enviame un monto y te pregunto el resto:\n` +
        `<pre>` +
        `15000\n` +
        `15000 28/03\n` +
        `1.500,50` +
        `</pre>` +
        `<b>Comandos</b>\n` +
        `  /check - ultima factura\n` +
        `  /check 3 - consultar factura #3\n` +
        `  /anular 3 - anular factura #3\n` +
        `  /resumen - resumen del mes`
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
        `<b>Factura C ${formatCbteNro(ptoVta, targetNro)}</b>\n` +
          `${estado === "Aprobada" ? "Aprobada por ARCA" : "RECHAZADA"}\n` +
          `<pre>` +
          `Importe  ${importe}\n` +
          `Fecha    ${fchEmision}\n` +
          `CAE      ${info.cae}\n` +
          `Vto CAE  ${fchVto}` +
          `</pre>`
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
        `<b>Anular Factura C ${formatCbteNro(ptoVta, cbteNro)}</b>\n` +
          `<pre>` +
          `Monto  ${importe}\n` +
          `Fecha  ${fchEmision}` +
          `</pre>` +
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
      const monthLabel = today.toLocaleDateString("es-AR", { month: "long" }).toUpperCase();
      const yearLabel = today.getFullYear();

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
      let msg = `<b>Resumen | ${monthLabel} ${yearLabel}</b>\n\n`;

      if (invoices.length === 0 && totalNC === 0) {
        msg += "No hay comprobantes emitidos este mes.";
      } else {
        msg += `<pre>`;
        for (const inv of invoices.reverse()) {
          const amt = formatCurrency(inv.amount).padStart(12);
          msg += `#${String(inv.nro).padStart(3)}  ${amt}  ${inv.date}\n`;
        }

        if (totalNC > 0) {
          msg += `\nNotas de credito: ${totalNC}\n`;
        }

        msg += `\n`;
        msg += `Facturado ${formatCurrency(sumFacturas)}`;
        if (totalNC > 0) {
          msg += `\nAnulado   ${formatCurrency(sumNC)}`;
          msg += `\nNeto      ${formatCurrency(neto)}`;
        }
        msg += `</pre>`;
        msg += `${totalFacturas} factura${totalFacturas !== 1 ? "s" : ""}`;
      }

      await sendMessage(token, chatId, msg);
    } catch (error) {
      console.error("Resumen failed:", error);
      await sendMessage(token, chatId, "Error al generar resumen.");
    }
    return;
  }

  // Check if we're waiting for a custom name (product or service)
  const pending = pendingVentas.get(chatId);
  if (pending && !text.startsWith("/")) {
    pendingVentas.delete(chatId);

    // Expire after 5 minutes
    if (Date.now() - pending.timestamp > 5 * 60 * 1000) {
      await sendMessage(token, chatId, "Se vencio el tiempo. Enviame el monto de nuevo.");
      return;
    }

    const description = text.substring(0, 30);
    const datePayload = formatDateYMD(pending.date);
    const descShort = description.substring(0, 20);
    const isService = pending.concepto === 2;
    const tipoLabel = isService ? "Servicio" : "Producto";

    // Service with custom name uses confirm: callback, product uses venta:
    const callbackData = isService
      ? `confirm:${pending.amount}:${datePayload}`
      : `venta:${pending.amount}:${datePayload}:${descShort}`;

    const confirmKeyboard = {
      inline_keyboard: [
        [
          { text: "Confirmar", callback_data: callbackData },
          { text: "Cancelar", callback_data: "cancel" },
        ],
      ],
    };

    const afipEnv = getAfipEnv(env);
    const envLabel = afipEnv === "testing" ? "\n<i>[TESTING]</i>" : "";

    await sendMessage(
      token,
      chatId,
      `<b>Nueva Factura C - ${tipoLabel}</b>${envLabel}\n` +
        `<pre>` +
        `Monto    ${formatCurrency(pending.amount)}\n` +
        `Fecha    ${formatDateAR(pending.date)}\n` +
        `Concepto ${description}\n` +
        `Receptor Consumidor Final` +
        `</pre>`,
      confirmKeyboard
    );
    return;
  }

  // Parse amount and optional date
  const parsed = parseInput(text);

  if (!parsed) {
    await sendMessage(
      token,
      chatId,
      `No entendi. Enviame un monto para facturar:\n` +
        `<pre>` +
        `15000\n` +
        `15000 28/03\n` +
        `1.500,50` +
        `</pre>` +
        `<b>Comandos</b>\n` +
        `  /check - ultima factura\n` +
        `  /anular 3 - anular factura #3\n` +
        `  /resumen - resumen del mes`
    );
    return;
  }

  const { amount, date } = parsed;
  const dateStr = formatDateAR(date);
  const datePayload = formatDateYMD(date);
  const todayAR = nowAR();
  const isToday = formatDateYMD(date) === formatDateYMD(todayAR);

  const afipEnv = getAfipEnv(env);
  const envLabel = afipEnv === "testing" ? "\n<i>[TESTING]</i>" : "";

  // Step 1: Ask servicio or venta
  const typeKeyboard = {
    inline_keyboard: [
      [
        { text: "Servicio", callback_data: `tipo:s:${amount}:${datePayload}` },
        { text: "Venta", callback_data: `tipo:v:${amount}:${datePayload}` },
        { text: "Cancelar", callback_data: "cancel" },
      ],
    ],
  };

  await sendMessage(
    token,
    chatId,
    `<b>Nueva Factura C</b>${envLabel}\n` +
      `<pre>` +
      `Monto ${formatCurrency(amount)}\n` +
      `Fecha ${dateStr}${isToday ? " (hoy)" : ""}` +
      `</pre>` +
      `Servicio o venta?`,
    typeKeyboard
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

  if (query.data.startsWith("tipo:")) {
    const parts = query.data.split(":");
    const tipo = parts[1]; // "s" or "v"
    const amount = parseFloat(parts[2]);
    const dateStr = parts[3];

    if (isNaN(amount) || !dateStr) {
      await editMessageText(token, chatId, messageId, "Error: datos invalidos.");
      return;
    }

    const date = parseDateYMD(dateStr);
    const dateFormatted = formatDateAR(date);

    if (tipo === "s") {
      // Service: show default name, offer to change
      const serviceKeyboard = {
        inline_keyboard: [
          [
            { text: "Confirmar", callback_data: `confirm:${amount}:${dateStr}` },
            { text: "Cambiar nombre", callback_data: `tipo:sn:${amount}:${dateStr}` },
          ],
          [
            { text: "Cancelar", callback_data: "cancel" },
          ],
        ],
      };

      await editMessageText(
        token,
        chatId,
        messageId,
        `<b>Nueva Factura C - Servicio</b>\n` +
          `<pre>` +
          `Monto    ${formatCurrency(amount)}\n` +
          `Fecha    ${dateFormatted}\n` +
          `Concepto Servicios Informaticos\n` +
          `Receptor Consumidor Final` +
          `</pre>` +
          `Confirmar o cambiar nombre del concepto?`,
        serviceKeyboard
      );
    } else if (tipo === "sn") {
      // Service with custom name: ask for it
      pendingVentas.set(chatId, {
        amount,
        date,
        messageId,
        timestamp: Date.now(),
        concepto: 2,
      });

      await editMessageText(
        token,
        chatId,
        messageId,
        `<b>Nueva Factura C - Servicio</b>\n` +
          `<pre>` +
          `Monto ${formatCurrency(amount)}\n` +
          `Fecha ${dateFormatted}` +
          `</pre>` +
          `Enviame el nombre del servicio:`
      );
    } else {
      // Product: ask for description
      pendingVentas.set(chatId, {
        amount,
        date,
        messageId,
        timestamp: Date.now(),
        concepto: 1,
      });

      await editMessageText(
        token,
        chatId,
        messageId,
        `<b>Nueva Factura C - Producto</b>\n` +
          `<pre>` +
          `Monto ${formatCurrency(amount)}\n` +
          `Fecha ${dateFormatted}` +
          `</pre>` +
          `Enviame el nombre del producto:`
      );
    }
    return;
  }

  if (query.data.startsWith("venta:")) {
    const parts = query.data.split(":");
    const amount = parseFloat(parts[1]);
    const dateStr = parts[2];
    const description = parts.slice(3).join(":");
    if (isNaN(amount) || !dateStr || amount <= 0 || amount > MAX_AMOUNT) {
      await editMessageText(token, chatId, messageId, "Error: datos invalidos.");
      return;
    }

    const date = parseDateYMD(dateStr);

    await editMessageText(
      token,
      chatId,
      messageId,
      `Procesando factura por ${formatCurrency(amount)}...`
    );

    try {
      const afipEnv = getAfipEnv(env);
      const auth = await authenticate(env.AFIP_CERT, env.AFIP_KEY, afipEnv);

      const result = await createInvoice(
        auth,
        env.AFIP_CUIT,
        parseInt(env.AFIP_PTO_VTA, 10),
        amount,
        afipEnv,
        date,
        1 // Concepto = Productos
      );

      const envLabel = afipEnv === "testing" ? "\n\n<i>[TESTING]</i>" : "";
      const fchVto = result.caeFchVto
        ? formatDateAR(parseDateYMD(result.caeFchVto))
        : result.caeFchVto;

      await editMessageText(
        token,
        chatId,
        messageId,
        `<b>Factura C ${formatCbteNro(result.ptoVta, result.cbteNro)}</b>\n` +
          `Aprobada por ARCA\n` +
          `<pre>` +
          `Monto    ${formatCurrency(amount)}\n` +
          `Fecha    ${formatDateAR(date)}\n` +
          `Concepto ${description}\n` +
          `CAE      ${result.cae}\n` +
          `Vto CAE  ${fchVto}` +
          `</pre>` +
          envLabel
      );
    } catch (error) {
      console.error("Product invoice failed:", error);
      await editMessageText(token, chatId, messageId, friendlyError(error));
    }
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
        `<b>Nota de Credito C ${formatCbteNro(result.ptoVta, result.cbteNro)}</b>\n` +
          `Aprobada por ARCA\n` +
          `<pre>` +
          `Anula    Factura C #${cbteNro}\n` +
          `Monto    ${importe}\n` +
          `CAE      ${result.cae}\n` +
          `Vto CAE  ${fchVto}` +
          `</pre>`
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
        `<b>Factura C ${formatCbteNro(result.ptoVta, result.cbteNro)}</b>\n` +
          `Aprobada por ARCA\n` +
          `<pre>` +
          `Monto    ${formatCurrency(amount)}\n` +
          `Fecha    ${formatDateAR(date)}\n` +
          `Concepto Servicios Informaticos\n` +
          `CAE      ${result.cae}\n` +
          `Vto CAE  ${fchVto}` +
          `</pre>` +
          envLabel
      );
    } catch (error) {
      console.error("Invoice creation failed:", error);
      await editMessageText(token, chatId, messageId, friendlyError(error));
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
