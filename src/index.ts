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
import { createInvoice, createCreditNote, queryInvoice, getLastInvoiceNumber, getPuntosDeVenta, type Concepto, type ReceiverDoc } from "./afip/wsfev1";
import { CATEGORIES, CATEGORIES_EFFECTIVE_DATE, findCategory, nextCategory } from "./monotributo";

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
  CALLBACK_SECRET: string;
  // Optional offset for invoices invisible to WSFEv1 (e.g. web-UI / "Comprobantes en linea").
  // Format: comma-separated "YYYYMMDD:amount" pairs. Entries outside the rolling 12-month
  // window are ignored, so the offset auto-decays as invoices age out.
  AFIP_OFFSET_INVOICES?: string;
}

const MAX_AMOUNT = 10_000_000;
const AR_TZ_OFFSET = -3 * 60 * 60 * 1000;
const MAX_RESUMEN_INVOICES = 100;

const AMOUNT_EXAMPLES = `<pre>15000\n15000 28/03\n1.500,50</pre>`;

const COMMANDS_HELP =
  `<b>Comandos</b>\n` +
  `  /check - ultima factura\n` +
  `  /check 3 - consultar factura #3\n` +
  `  /anular 3 - anular factura #3\n` +
  `  /resumen - resumen del mes\n` +
  `  /resumen 03/2026 - resumen de marzo\n` +
  `  /recat - categoria monotributo\n` +
  `  /status - estado del bot`;

/** HMAC-sign a callback_data payload so it can't be tampered with. */
async function signCallback(data: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  const hex = [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 12);
  return `${data}|${hex}`;
}

/** Verify an HMAC-signed callback_data. Returns the data without signature, or null if invalid. */
async function verifyCallback(signed: string, secret: string): Promise<string | null> {
  const idx = signed.lastIndexOf("|");
  if (idx === -1) return null;
  const data = signed.slice(0, idx);
  const expected = await signCallback(data, secret);
  // Use the full signed string for comparison (includes the signature)
  const encoder = new TextEncoder();
  const a = encoder.encode(expected);
  const b = encoder.encode(signed);
  if (a.length !== b.length) return null;
  try {
    if (crypto.subtle.timingSafeEqual(a, b)) return data;
  } catch { /* length mismatch throws */ }
  return null;
}

/** Timing-safe string comparison using native Web Crypto. */
function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);
  try {
    return crypto.subtle.timingSafeEqual(bufA, bufB);
  } catch {
    return false; // length mismatch
  }
}

/** Track in-flight invoice creations to prevent double-tap. */
const inflightInvoices = new Set<number>(); // chatId

type InlineButton = { text: string; callback_data: string };
type InlineKeyboard = InlineButton[][];

/** Sign all callback_data values in an inline keyboard. */
async function signKeyboard(keyboard: InlineKeyboard, secret: string): Promise<InlineKeyboard> {
  const signed: InlineKeyboard = [];
  for (const row of keyboard) {
    const signedRow: InlineButton[] = [];
    for (const btn of row) {
      if (btn.callback_data === "cancel") {
        signedRow.push(btn);
      } else {
        signedRow.push({ ...btn, callback_data: await signCallback(btn.callback_data, secret) });
      }
    }
    signed.push(signedRow);
  }
  return signed;
}

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
interface PendingInput {
  amount: number;
  date: Date;
  messageId: number;
  timestamp: number;
  concepto?: Concepto;
  description?: string;
  waitingFor?: "description" | "receptor";
}
const pendingInputs = new Map<number, PendingInput>();

function getAfipEnv(env: Env): "testing" | "production" {
  return env.AFIP_ENV?.trim() === "production" ? "production" : "testing";
}

/** Primary PtoVta (used for creating invoices). */
function primaryPtoVta(env: Env): number {
  return parseInt(env.AFIP_PTO_VTA.split(",")[0].trim(), 10);
}

/** All PtoVta numbers (used for scanning in /recat). Supports comma-separated. */
function allPtoVtas(env: Env): number[] {
  return env.AFIP_PTO_VTA.split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => !isNaN(n) && n > 0);
}

/**
 * Sum manual offset invoices (for comprobantes invisible to WSFEv1, e.g. web-UI / "Comprobantes
 * en linea") that fall inside the rolling 12-month window. Each entry has its own date, so the
 * total auto-decays as old invoices age out without any manual maintenance.
 *
 * Format: "YYYYMMDD:amount,YYYYMMDD:amount,..." (whitespace and malformed entries ignored).
 */
function getOffset(env: Env, today: Date): { amount: number; count: number } {
  const raw = env.AFIP_OFFSET_INVOICES?.trim();
  if (!raw) return { amount: 0, count: 0 };

  const twelveMonthsAgo = new Date(today.getFullYear() - 1, today.getMonth(), today.getDate());
  const cutoff = formatDateYMD(twelveMonthsAgo);

  let amount = 0;
  let count = 0;
  for (const entry of raw.split(",")) {
    const m = entry.trim().match(/^(\d{8}):(\d+(?:\.\d+)?)$/);
    if (!m) continue;
    if (m[1] < cutoff) continue;
    const v = parseFloat(m[2]);
    if (!isFinite(v) || v <= 0) continue;
    amount += v;
    count++;
  }
  return { amount, count };
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

interface AnnualTotal {
  total: number;
  count: number;
  puntosQueried: number;
  fromLabel: string;
  toLabel: string;
}

/**
 * Sum invoices across all PtoVtas in AFIP_PTO_VTA for the last 12 months.
 * PtoVtas not authorized for WSFEv1 (e.g., web-UI / "Comprobantes en linea")
 * are skipped silently — WSFEv1 has no visibility into invoices issued through
 * other ARCA subsystems.
 */
async function getLast12MonthsTotal(
  auth: import("./afip/wsaa").AuthCredentials,
  cuit: string,
  afipEnv: "testing" | "production",
  ptoVtas: number[]
): Promise<AnnualTotal> {
  const today = nowAR();
  const twelveMonthsAgo = new Date(today.getFullYear() - 1, today.getMonth(), today.getDate());
  const cutoff = formatDateYMD(twelveMonthsAgo);

  // Deduplicate
  const ptoVtaNros = [...new Set(ptoVtas)];

  let total = 0;
  let count = 0;
  let activePtos = 0;

  for (const ptoVta of ptoVtaNros) {
    let lastNro = 0;
    let lastNC = 0;
    try {
      lastNro = await getLastInvoiceNumber(auth, cuit, ptoVta, 11, afipEnv);
      lastNC = await getLastInvoiceNumber(auth, cuit, ptoVta, 13, afipEnv);
    } catch {
      // PtoVta not authorized for WSFEv1 (web-UI-only) — invisible to this API.
      continue;
    }
    if (lastNro === 0 && lastNC === 0) continue;
    activePtos++;

    // Facturas C (tipo 11)
    let queried = 0;
    for (let i = lastNro; i >= 1 && queried < MAX_RESUMEN_INVOICES; i--) {
      queried++;
      const info = await queryInvoice(auth, cuit, ptoVta, i, afipEnv);
      if (!info.cbteFch) continue;
      if (info.cbteFch < cutoff) break;
      if (info.resultado === "A") {
        total += parseFloat(info.impTotal);
        count++;
      }
    }

    // Notas de Credito C (tipo 13) — subtract
    let ncQueried = 0;
    for (let i = lastNC; i >= 1 && ncQueried < MAX_RESUMEN_INVOICES; i--) {
      ncQueried++;
      const info = await queryInvoice(auth, cuit, ptoVta, i, afipEnv, 13);
      if (!info.cbteFch) continue;
      if (info.cbteFch < cutoff) break;
      if (info.resultado === "A") {
        total -= parseFloat(info.impTotal);
      }
    }
  }

  const fromLabel = formatDateAR(twelveMonthsAgo);
  const toLabel = formatDateAR(today);

  return { total: Math.max(0, total), count, puntosQueried: activePtos, fromLabel, toLabel };
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
  if (text.startsWith("/start") || text.startsWith("/help")) {
    const afipEnv = getAfipEnv(env);
    const envTag = afipEnv === "testing" ? " [TESTING]" : "";
    await sendMessage(
      token,
      chatId,
      `<b>TARCA</b>${envTag}\n` +
        `Facturacion electronica por Telegram\n\n` +
        `Enviame un monto y te pregunto el resto:\n` +
        AMOUNT_EXAMPLES +
        COMMANDS_HELP
    );
    return;
  }

  // Handle /check command - query existing invoice
  if (text.startsWith("/check")) {
    try {
      const afipEnv = getAfipEnv(env);
      const ptoVta = primaryPtoVta(env);
      const auth = await authenticate(env.AFIP_CERT, env.AFIP_KEY, afipEnv);

      const parts = text.split(/\s+/);
      const cbteNro = parts[1] ? parseInt(parts[1], 10) : 0;

      if (parts[1] && (isNaN(cbteNro) || cbteNro <= 0)) {
        await sendMessage(token, chatId, "Uso: /check o /check 3");
        return;
      }

      const lastNro = await getLastInvoiceNumber(auth, env.AFIP_CUIT, ptoVta, 11, afipEnv);

      if (lastNro === 0) {
        await sendMessage(token, chatId, "No hay facturas emitidas en este punto de venta.");
        return;
      }

      const targetNro = cbteNro > 0 ? cbteNro : lastNro;

      if (targetNro > lastNro) {
        await sendMessage(token, chatId, `Factura #${targetNro} no existe. La ultima es la #${lastNro}.`);
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
          `${estado === "Aprobada" ? "✅ Aprobada por ARCA" : "RECHAZADA"}\n` +
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

  // Handle /status command
  if (text.startsWith("/status")) {
    try {
      const afipEnv = getAfipEnv(env);
      const ptoVta = primaryPtoVta(env);
      const auth = await authenticate(env.AFIP_CERT, env.AFIP_KEY, afipEnv);
      const lastFactura = await getLastInvoiceNumber(auth, env.AFIP_CUIT, ptoVta, 11, afipEnv);
      const lastNC = await getLastInvoiceNumber(auth, env.AFIP_CUIT, ptoVta, 13, afipEnv);

      await sendMessage(
        token,
        chatId,
        `<b>Status</b>\n` +
          `<pre>` +
          `Entorno     ${afipEnv}\n` +
          `CUIT        ${env.AFIP_CUIT}\n` +
          `Pto Venta   ${ptoVta}\n` +
          `Facturas    ${lastFactura}\n` +
          `Notas cred. ${lastNC}` +
          `</pre>`
      );
    } catch (error) {
      console.error("Status failed:", error);
      await sendMessage(token, chatId, "Error al consultar estado.");
    }
    return;
  }

  // Handle /recat command - check monotributo category based on last 12 months
  if (text.startsWith("/recat")) {
    try {
      const afipEnv = getAfipEnv(env);
      const auth = await authenticate(env.AFIP_CERT, env.AFIP_KEY, afipEnv);

      const annual = await getLast12MonthsTotal(auth, env.AFIP_CUIT, afipEnv, allPtoVtas(env));
      const offset = getOffset(env, nowAR());
      const grandTotal = annual.total + offset.amount;

      const current = findCategory(grandTotal);
      const next = current ? nextCategory(current) : null;

      const wsCount = String(annual.count).padStart(2, "0");
      let msg = `<b>Recategorizacion Monotributo</b>\n\n`;
      msg += `<pre>`;
      msg += `Facturado WS    ${formatCurrency(annual.total)} (${wsCount} inv)\n`;
      if (offset.amount > 0) {
        const uiCount = String(offset.count).padStart(2, "0");
        msg += `Facturado UI    ${formatCurrency(offset.amount)} (${uiCount} inv)\n`;
        msg += `Total 12mon     ${formatCurrency(grandTotal)}\n`;
      }
      msg += `Periodo         ${annual.fromLabel} - ${annual.toLabel}\n`;

      if (current) {
        const pct = Math.round((grandTotal / current.maxAnnualIncome) * 100);
        msg += `\nCategoria       ${current.name}\n`;
        msg += `Tope            ${formatCurrency(current.maxAnnualIncome)}\n`;
        msg += `Uso             ${pct}%`;

        if (next) {
          const remaining = current.maxAnnualIncome - grandTotal;
          msg += `\nRestante        ${formatCurrency(remaining)}`;
        }
      } else {
        const maxCat = CATEGORIES[CATEGORIES.length - 1];
        msg += `\nExcede cat. ${maxCat.name} (${formatCurrency(maxCat.maxAnnualIncome)})`;
      }

      // ARCA recat windows close around Jan 20 / Jul 20
      const today = nowAR();
      const year = today.getFullYear();
      const nextCandidates = [
        new Date(year, 0, 20),
        new Date(year, 6, 20),
        new Date(year + 1, 0, 20),
      ];
      const prevCandidates = [
        new Date(year, 6, 20),
        new Date(year, 0, 20),
        new Date(year - 1, 6, 20),
      ];
      const nextRecat = nextCandidates.find((d) => d > today) ?? nextCandidates[nextCandidates.length - 1];
      const prevRecat = prevCandidates.find((d) => d <= today) ?? prevCandidates[prevCandidates.length - 1];
      const daysUntil = Math.ceil((nextRecat.getTime() - today.getTime()) / (24 * 60 * 60 * 1000));
      const daysSince = Math.floor((today.getTime() - prevRecat.getTime()) / (24 * 60 * 60 * 1000));
      msg += `\n\nPrev. Recat.    ${formatDateAR(prevRecat)} (hace ${daysSince} dias)`;
      msg += `\nProx Recat.     ${formatDateAR(nextRecat)} (en ${daysUntil} dias)`;

      msg += `</pre>`;

      if (current) {
        const pct = (grandTotal / current.maxAnnualIncome) * 100;
        if (pct >= 90) {
          msg += `\n⚠️ Estas al ${Math.round(pct)}% del tope. Considera recategorizarte.`;
        }
      } else {
        msg += `\n🚨 Superaste el tope maximo de Monotributo.`;
      }

      msg += `\n\n<i>Categorias vigentes desde ${CATEGORIES_EFFECTIVE_DATE}</i>`;

      await sendMessage(token, chatId, msg);
    } catch (error) {
      console.error("Recat failed:", error);
      await sendMessage(token, chatId, "Error al calcular recategorizacion.");
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
      const ptoVta = primaryPtoVta(env);
      const auth = await authenticate(env.AFIP_CERT, env.AFIP_KEY, afipEnv);

      // Check invoice exists
      const lastNro = await getLastInvoiceNumber(auth, env.AFIP_CUIT, ptoVta, 11, afipEnv);
      if (cbteNro > lastNro) {
        await sendMessage(token, chatId, `Factura #${cbteNro} no existe. La ultima es la #${lastNro}.`);
        return;
      }

      const info = await queryInvoice(auth, env.AFIP_CUIT, ptoVta, cbteNro, afipEnv);

      if (!info.cae || info.resultado !== "A") {
        await sendMessage(token, chatId, `Factura #${cbteNro} no encontrada o no esta aprobada.`);
        return;
      }

      const importe = formatCurrency(parseFloat(info.impTotal));
      const fchEmision = info.cbteFch ? formatDateAR(parseDateYMD(info.cbteFch)) : "-";

      const keyboard = {
        inline_keyboard: await signKeyboard([
          [
            { text: "Anular", callback_data: `anular:${cbteNro}` },
            { text: "Cancelar", callback_data: "cancel" },
          ],
        ], env.CALLBACK_SECRET),
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

  // Handle /resumen command - monthly summary, optional month param
  if (text.startsWith("/resumen")) {
    try {
      const afipEnv = getAfipEnv(env);
      const ptoVta = primaryPtoVta(env);
      const auth = await authenticate(env.AFIP_CERT, env.AFIP_KEY, afipEnv);

      const today = nowAR();
      let targetMonth = today.getMonth();
      let targetYear = today.getFullYear();

      // Parse optional mm/yyyy or mm/yy param
      const paramMatch = text.match(/\/resumen\s+(\d{1,2})\/(\d{2,4})/);
      if (paramMatch) {
        targetMonth = parseInt(paramMatch[1], 10) - 1;
        targetYear = parseInt(paramMatch[2], 10);
        if (targetYear < 100) targetYear += 2000;
        if (targetMonth < 0 || targetMonth > 11) {
          await sendMessage(token, chatId, "Mes invalido. Uso: <code>/resumen 03/2026</code>");
          return;
        }
      }

      const targetDate = new Date(targetYear, targetMonth, 1);
      const monthLabel = targetDate.toLocaleDateString("es-AR", { month: "long" }).toUpperCase();
      const yearLabel = targetYear;

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

      let queriedFacturas = 0;
      for (let i = lastFactura; i >= 1 && queriedFacturas < MAX_RESUMEN_INVOICES; i--) {
        queriedFacturas++;
        const info = await queryInvoice(auth, env.AFIP_CUIT, ptoVta, i, afipEnv);
        if (!info.cbteFch) continue;

        const invDate = parseDateYMD(info.cbteFch);
        const invY = invDate.getFullYear();
        const invM = invDate.getMonth();

        // Skip invoices from later months
        if (invY > targetYear || (invY === targetYear && invM > targetMonth)) continue;
        // Stop at invoices before target month
        if (invY < targetYear || (invY === targetYear && invM < targetMonth)) break;

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

      let queriedNC = 0;
      for (let i = lastNC; i >= 1 && queriedNC < MAX_RESUMEN_INVOICES; i--) {
        queriedNC++;
        const info = await queryInvoice(auth, env.AFIP_CUIT, ptoVta, i, afipEnv, 13);
        if (!info.cbteFch) continue;

        const invDate = parseDateYMD(info.cbteFch);
        const invY = invDate.getFullYear();
        const invM = invDate.getMonth();

        if (invY > targetYear || (invY === targetYear && invM > targetMonth)) continue;
        if (invY < targetYear || (invY === targetYear && invM < targetMonth)) break;

        if (info.resultado === "A") {
          totalNC++;
          sumNC += parseFloat(info.impTotal);
        }
      }

      const neto = sumFacturas - sumNC;

      // Build summary message
      let msg = `<b>Resumen | ${monthLabel} ${yearLabel}</b>\n\n`;

      if (invoices.length === 0 && totalNC === 0) {
        msg += "No hay comprobantes emitidos.";
      } else {
        msg += `<pre>Facturas\n`;
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

  // Check if we're waiting for user input (description or receptor).
  // Atomically claim the pending state by checking delete()'s return value,
  // so two concurrent messages for the same chat can't both process the same state.
  const pending = pendingInputs.get(chatId);
  if (pending && !text.startsWith("/")) {
    if (!pendingInputs.delete(chatId)) {
      // Another concurrent request already claimed and processed this pending state.
      return;
    }

    if (Date.now() - pending.timestamp > 5 * 60 * 1000) {
      await sendMessage(token, chatId, "Se vencio el tiempo. Enviame el monto de nuevo.");
      return;
    }

    const datePayload = formatDateYMD(pending.date);
    const afipEnv = getAfipEnv(env);
    const envLabel = afipEnv === "testing" ? "\n<i>[TESTING]</i>" : "";
    const isProduct = pending.concepto === 1;
    const tipoLabel = isProduct ? "Producto" : "Servicio";

    if (pending.waitingFor === "receptor") {
      // Parse CUIT (11 digits) or DNI (7-8 digits)
      const cleaned = text.replace(/[-.\s]/g, "");
      if (!/^\d{7,11}$/.test(cleaned)) {
        // Not valid, re-set pending and ask again
        pendingInputs.set(chatId, pending);
        await sendMessage(token, chatId, "Ingresa un CUIT (11 digitos) o DNI (7-8 digitos).");
        return;
      }

      const docTipo = cleaned.length >= 11 ? 80 : 96;
      const docTipoLabel = docTipo === 80 ? "CUIT" : "DNI";
      const descShort = (pending.description || "Serv.Informaticos").substring(0, 15);

      const callbackData = isProduct
        ? `venta:${pending.amount}:${datePayload}:${descShort}:${docTipo}:${cleaned}`
        : `confirm:${pending.amount}:${datePayload}:${docTipo}:${cleaned}`;

      const conceptoLabel = pending.description || "Servicios Informaticos";

      // Show full confirmation view with all options
      const confirmKeyboard = {
        inline_keyboard: await signKeyboard([
          [
            { text: "CONFIRMAR", callback_data: callbackData },
          ],
          [
            { text: "Cambiar concepto", callback_data: isProduct ? `tipo:v:${pending.amount}:${datePayload}` : `tipo:sn:${pending.amount}:${datePayload}` },
            { text: "Quitar receptor", callback_data: `review:${pending.amount}:${datePayload}:${pending.concepto || 2}:${descShort}` },
          ],
          [
            { text: "Cancelar", callback_data: "cancel" },
          ],
        ], env.CALLBACK_SECRET),
      };

      await sendMessage(
        token,
        chatId,
        `<b>Nueva Factura C - ${tipoLabel}</b>${envLabel}\n` +
          `<pre>` +
          `Monto    ${formatCurrency(pending.amount)}\n` +
          `Fecha    ${formatDateAR(pending.date)}\n` +
          `Concepto ${conceptoLabel}\n` +
          `Receptor ${docTipoLabel} ${cleaned}` +
          `</pre>`,
        confirmKeyboard
      );
      return;
    }

    // Waiting for description (product name or custom service name)
    const description = text.substring(0, 30);
    const descShort = description.substring(0, 15);

    const callbackData = !isProduct
      ? `confirm:${pending.amount}:${datePayload}`
      : `venta:${pending.amount}:${datePayload}:${descShort}`;

    // Full confirmation view
    const confirmKeyboard = {
      inline_keyboard: await signKeyboard([
        [
          { text: "CONFIRMAR", callback_data: callbackData },
        ],
        [
          { text: "Cambiar concepto", callback_data: isProduct ? `tipo:v:${pending.amount}:${datePayload}` : `tipo:sn:${pending.amount}:${datePayload}` },
          { text: "Identificar receptor", callback_data: `recep:${pending.amount}:${datePayload}:${pending.concepto || 2}:${descShort}` },
        ],
        [
          { text: "Cancelar", callback_data: "cancel" },
        ],
      ], env.CALLBACK_SECRET),
    };

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
        AMOUNT_EXAMPLES +
        COMMANDS_HELP
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
    inline_keyboard: await signKeyboard([
      [
        { text: "Servicio", callback_data: `tipo:s:${amount}:${datePayload}` },
        { text: "Venta", callback_data: `tipo:v:${amount}:${datePayload}` },
        { text: "Cancelar", callback_data: "cancel" },
      ],
    ], env.CALLBACK_SECRET),
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

  // Verify HMAC signature on all non-cancel callbacks
  const data = await verifyCallback(query.data, env.CALLBACK_SECRET);
  if (data === null) {
    await editMessageText(token, chatId, messageId, "Error: datos invalidos o expirados.");
    return;
  }

  if (data.startsWith("tipo:")) {
    const parts = data.split(":");
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
      // Service: show default name, offer to change or identify receptor
      const serviceKeyboard = {
        inline_keyboard: await signKeyboard([
          [
            { text: "CONFIRMAR", callback_data: `confirm:${amount}:${dateStr}` },
          ],
          [
            { text: "Cambiar concepto", callback_data: `tipo:sn:${amount}:${dateStr}` },
            { text: "Identificar receptor", callback_data: `recep:${amount}:${dateStr}:2:Serv.Informaticos` },
          ],
          [
            { text: "Cancelar", callback_data: "cancel" },
          ],
        ], env.CALLBACK_SECRET),
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
          `</pre>`,
        serviceKeyboard
      );
    } else if (tipo === "sn") {
      // Service with custom name: ask for it
      pendingInputs.set(chatId, {
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
      pendingInputs.set(chatId, {
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

  // Review: show full confirmation view without creating (used by "Quitar receptor" etc)
  if (data.startsWith("review:")) {
    const parts = data.split(":");
    const amount = parseFloat(parts[1]);
    const dateStr = parts[2];
    const concepto = parseInt(parts[3], 10) as Concepto;
    const description = parts.slice(4).join(":");

    if (isNaN(amount) || !dateStr) {
      await editMessageText(token, chatId, messageId, "Error: datos invalidos.");
      return;
    }

    const date = parseDateYMD(dateStr);
    const isProduct = concepto === 1;
    const tipoLabel = isProduct ? "Producto" : "Servicio";
    const conceptoLabel = description || "Servicios Informaticos";
    const descShort = conceptoLabel.substring(0, 15);

    const callbackData = isProduct
      ? `venta:${amount}:${dateStr}:${descShort}`
      : `confirm:${amount}:${dateStr}`;

    const confirmKeyboard = {
      inline_keyboard: await signKeyboard([
        [
          { text: "CONFIRMAR", callback_data: callbackData },
        ],
        [
          { text: "Cambiar concepto", callback_data: isProduct ? `tipo:v:${amount}:${dateStr}` : `tipo:sn:${amount}:${dateStr}` },
          { text: "Identificar receptor", callback_data: `recep:${amount}:${dateStr}:${concepto}:${descShort}` },
        ],
        [
          { text: "Cancelar", callback_data: "cancel" },
        ],
      ], env.CALLBACK_SECRET),
    };

    const afipEnv = getAfipEnv(env);
    const envLabel = afipEnv === "testing" ? "\n<i>[TESTING]</i>" : "";

    await editMessageText(
      token,
      chatId,
      messageId,
      `<b>Nueva Factura C - ${tipoLabel}</b>${envLabel}\n` +
        `<pre>` +
        `Monto    ${formatCurrency(amount)}\n` +
        `Fecha    ${formatDateAR(date)}\n` +
        `Concepto ${conceptoLabel}\n` +
        `Receptor Consumidor Final` +
        `</pre>`,
      confirmKeyboard
    );
    return;
  }

  if (data.startsWith("recep:")) {
    const parts = data.split(":");
    const amount = parseFloat(parts[1]);
    const dateStr = parts[2];
    const concepto = parseInt(parts[3], 10) as Concepto;
    const description = parts.slice(4).join(":");

    if (isNaN(amount) || !dateStr) {
      await editMessageText(token, chatId, messageId, "Error: datos invalidos.");
      return;
    }

    await editMessageText(
      token,
      chatId,
      messageId,
      `<b>Identificar receptor</b>\n\n` +
        `Enviame el CUIT (11 digitos) o DNI (7-8 digitos):`
    );
    pendingInputs.set(chatId, {
      amount,
      date: parseDateYMD(dateStr),
      messageId,
      timestamp: Date.now(),
      concepto: concepto as Concepto,
      description: description || undefined,
      waitingFor: "receptor",
    });
    return;
  }

  if (data.startsWith("venta:")) {
    // Format: venta:amount:date:desc or venta:amount:date:desc:docTipo:docNro
    const parts = data.split(":");
    const amount = parseFloat(parts[1]);
    const dateStr = parts[2];
    const description = parts[3] || "Producto";
    const docTipo = parts[4] ? parseInt(parts[4], 10) : 99;
    const docNro = parts[5] ? parseInt(parts[5], 10) : 0;

    if (isNaN(amount) || !dateStr || amount <= 0 || amount > MAX_AMOUNT) {
      await editMessageText(token, chatId, messageId, "Error: datos invalidos.");
      return;
    }

    if (inflightInvoices.has(chatId)) {
      await editMessageText(token, chatId, messageId, "Ya hay una factura en proceso. Espera.");
      return;
    }
    inflightInvoices.add(chatId);

    const date = parseDateYMD(dateStr);
    const receiver: ReceiverDoc = { docTipo, docNro };

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
        primaryPtoVta(env),
        amount,
        afipEnv,
        date,
        1, // Concepto = Productos
        receiver
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
          `✅ Aprobada por ARCA\n` +
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
    } finally {
      inflightInvoices.delete(chatId);
    }
    return;
  }

  if (data.startsWith("anular:")) {
    const cbteNro = parseInt(data.split(":")[1], 10);
    if (isNaN(cbteNro) || cbteNro <= 0) {
      await editMessageText(token, chatId, messageId, "Error: datos invalidos.");
      return;
    }

    if (inflightInvoices.has(chatId)) {
      await editMessageText(token, chatId, messageId, "Ya hay una operacion en proceso. Espera.");
      return;
    }
    inflightInvoices.add(chatId);

    await editMessageText(token, chatId, messageId, "Procesando nota de credito...");

    try {
      const afipEnv = getAfipEnv(env);
      const ptoVta = primaryPtoVta(env);
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
          `✅ Aprobada por ARCA\n` +
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
    } finally {
      inflightInvoices.delete(chatId);
    }
    return;
  }

  if (data.startsWith("confirm:")) {
    const parts = data.split(":");
    const amount = parseFloat(parts[1]);
    const dateStr = parts[2]; // YYYYMMDD
    // Optional: parts[3]=docTipo, parts[4]=docNro
    const docTipo = parts[3] ? parseInt(parts[3], 10) : 99;
    const docNro = parts[4] ? parseInt(parts[4], 10) : 0;

    if (isNaN(amount) || !dateStr || amount <= 0 || amount > MAX_AMOUNT) {
      await editMessageText(token, chatId, messageId, "Error: datos invalidos.");
      return;
    }

    if (inflightInvoices.has(chatId)) {
      await editMessageText(token, chatId, messageId, "Ya hay una factura en proceso. Espera.");
      return;
    }
    inflightInvoices.add(chatId);

    const date = parseDateYMD(dateStr);
    const receiver: ReceiverDoc = { docTipo, docNro };

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
        primaryPtoVta(env),
        amount,
        afipEnv,
        date,
        2,
        receiver
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
          `✅ Aprobada por ARCA\n` +
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
    } finally {
      inflightInvoices.delete(chatId);
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // POST /setup - Register webhook with Telegram (auth via header)
    if (url.pathname === "/setup" && request.method === "POST") {
      const providedSecret = request.headers.get("X-Setup-Secret") || "";
      if (!env.SETUP_SECRET || !timingSafeEqual(providedSecret, env.SETUP_SECRET)) {
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
      // Verify webhook secret (timing-safe to prevent timing attacks)
      const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
      if (!timingSafeEqual(secret, env.TELEGRAM_WEBHOOK_SECRET)) {
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

  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    const token = env.TELEGRAM_BOT_TOKEN;
    const chatIds = env.ALLOWED_CHAT_IDS?.split(",").map((id) => id.trim()).filter(Boolean) || [];

    if (chatIds.length === 0) return;

    const today = nowAR();
    const month = today.getMonth(); // 0-indexed
    const monthName = today.toLocaleDateString("es-AR", { month: "long" });

    for (const chatId of chatIds) {
      const id = parseInt(chatId, 10);
      if (isNaN(id)) continue;

      // Always send IIBB reminder
      await sendMessage(
        token,
        id,
        `📋 <b>Recordatorio IIBB</b>\n\n` +
          `Es momento de verificar tu situacion de Ingresos Brutos para ${monthName}.\n` +
          `Revisa si tenes saldo pendiente en tu agencia provincial.`
      );

      // Jan (0) and Jul (6): recategorización alert
      if (month === 0 || month === 6) {
        try {
          const afipEnv = getAfipEnv(env);
          const auth = await authenticate(env.AFIP_CERT, env.AFIP_KEY, afipEnv);
          const annual = await getLast12MonthsTotal(auth, env.AFIP_CUIT, afipEnv, allPtoVtas(env));
          const offset = getOffset(env, today);
          const grandTotal = annual.total + offset.amount;
          const current = findCategory(grandTotal);

          let msg = `🔄 <b>Periodo de recategorizacion</b>\n\n`;
          msg += `Facturado ultimos 12 meses: ${formatCurrency(grandTotal)}\n`;
          if (offset.amount > 0) {
            msg += `<i>(incluye ${formatCurrency(offset.amount)} de offset manual)</i>\n`;
          }

          if (current) {
            const pct = Math.round((grandTotal / current.maxAnnualIncome) * 100);
            msg += `Categoria actual: <b>${current.name}</b> (${pct}% del tope)\n\n`;
            if (pct >= 90) {
              msg += `⚠️ Estas muy cerca del tope. Verifica si necesitas recategorizarte.`;
            } else {
              msg += `Verifica tu categoria en ARCA.`;
            }
          } else {
            msg += `\n🚨 Superaste el tope maximo de Monotributo. Consulta con tu contador.`;
          }

          await sendMessage(token, id, msg);
        } catch (error) {
          console.error("Scheduled recat check failed:", error);
        }
      }
    }
  },
};
