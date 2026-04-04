/**
 * Telegram Bot API helpers.
 */

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: CallbackQuery;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  text?: string;
  date: number;
}

export interface CallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

interface TelegramUser {
  id: number;
  first_name: string;
}

interface TelegramChat {
  id: number;
  type: string;
}

const API_BASE = "https://api.telegram.org/bot";

async function callApi(
  token: string,
  method: string,
  body: Record<string, unknown>
): Promise<unknown> {
  const response = await fetch(`${API_BASE}${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await response.json()) as { ok: boolean; description?: string };
  if (!data.ok) {
    throw new Error(`Telegram ${method}: ${data.description}`);
  }
  return data;
}

export async function sendMessage(
  token: string,
  chatId: number,
  text: string,
  replyMarkup?: unknown
): Promise<void> {
  await callApi(token, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
}

export async function answerCallbackQuery(
  token: string,
  callbackQueryId: string,
  text?: string
): Promise<void> {
  await callApi(token, "answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    ...(text ? { text } : {}),
  });
}

export async function editMessageText(
  token: string,
  chatId: number,
  messageId: number,
  text: string,
  replyMarkup?: unknown
): Promise<void> {
  await callApi(token, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: "HTML",
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
}

/**
 * Register the webhook URL with Telegram, with a secret for verification.
 */
export async function setWebhook(
  token: string,
  url: string,
  secretToken?: string
): Promise<void> {
  await callApi(token, "setWebhook", {
    url,
    ...(secretToken ? { secret_token: secretToken } : {}),
  });
}
