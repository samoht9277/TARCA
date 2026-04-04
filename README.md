# TARCA

Telegram bot that creates ARCA (ex-AFIP) invoices, running on a free Cloudflare Worker.

Send an amount to the bot, confirm, and get a Factura C issued instantly.

## How it works

1. You text the bot an amount (e.g. `15000` or `1.500,50`)
2. Bot asks: Servicio or Venta?
3. You pick the type, optionally change the concept name or identify the receiver (CUIT/DNI)
4. You tap **CONFIRMAR**, bot creates the invoice on ARCA
5. Bot replies with the invoice number, CAE, and expiry

**Invoice defaults:** Factura C, Consumidor Final, Monotributista

**Commands:**
- `/start` - show help
- `/check` - query the last invoice emitted
- `/check 3` - query invoice #3
- `/anular 3` - reverse invoice #3 with a Nota de Credito C
- `/resumen` - monthly summary with totals

## Setup

### Prerequisites

- [Node.js](https://nodejs.org/) 18+
- A [Cloudflare](https://dash.cloudflare.com/sign-up) account (free tier works)
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- ARCA web services certificate (see below)

### 1. Install dependencies

```bash
make install
```

### 2. Generate ARCA certificate

```bash
make csr CUIT=20123456789
```

This creates `afip_key.pem` (private key) and `afip_csr.pem` (CSR). Now you need to get it signed by ARCA:

1. Log in to [ARCA](https://auth.afip.gob.ar/contribuyente_/login.xhtml) with your CUIT and clave fiscal
2. Go to **Administrador de Relaciones** (aka "Administrador de Relaciones de Clave Fiscal")
3. Enable the **"Administracion de Certificados Digitales"** service if you haven't already:
   - Click **"Habilitar Servicio"**
   - Under **ARCA**, click **"Servicios Interactivos"**
   - Select **"Administracion de Certificados Digitales"** and confirm
4. Go back to the main menu, open **"Administracion de Certificados Digitales"**
5. Click **"Agregar nuevo certificado"**
6. Enter an alias (e.g. `tarca`), upload `afip_csr.pem`
7. Download the signed `.crt` file and save it as `afip_cert.pem` in the project root:
   ```bash
   mv ~/Downloads/YOUR_CERT_FILE.crt afip_cert.pem
   ```

### 3. Create a Punto de Venta

You need a punto de venta of type **"Factura Electronica - Monotributo - Web Services"**:

1. In ARCA, go to **"Administracion de puntos de venta y domicilios"**
2. Click **"Agregar"**
3. Select type **"Factura Electronica - Monotributo - Web Services"**
4. Note the number it assigns (e.g. `2`)

### 4. Authorize Facturacion Electronica

Under **Administrador de Relaciones** > **ARCA** > **WebServices**, make sure **"Facturacion Electronica"** is enabled for your CUIT.

### 5. Find your Telegram chat ID

Send a message to your bot, then run:

```bash
curl "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates" | jq '.result[0].message.from.id'
```

That number is your chat ID. You'll need it for the next step.

### 6. Set secrets

```bash
make secrets
```

This prompts you for each secret. You'll need:

| Secret | What it is |
|--------|-----------|
| `TELEGRAM_BOT_TOKEN` | From @BotFather |
| `TELEGRAM_WEBHOOK_SECRET` | Any random string (e.g. `openssl rand -hex 32`) |
| `SETUP_SECRET` | Any random string to protect the /setup endpoint |
| `ALLOWED_CHAT_IDS` | Your Telegram user ID (comma-separated for multiple) |
| `AFIP_CERT` | Pipe the file: `npx wrangler secret put AFIP_CERT < afip_cert.pem` |
| `AFIP_KEY` | Pipe the file: `npx wrangler secret put AFIP_KEY < afip_key.pem` |
| `AFIP_CUIT` | Your CUIT number, no dashes |
| `AFIP_PTO_VTA` | Your punto de venta number from step 3 |

### 7. Deploy

```bash
make deploy
```

This runs type checking and tests before deploying.

### 8. Register the webhook

```bash
curl "https://tarca.<your-subdomain>.workers.dev/setup?secret=<YOUR_SETUP_SECRET>"
```

### 9. Switch to production

By default the bot runs against ARCA's testing environment (homologacion). To issue real invoices, edit `wrangler.toml`:

```toml
AFIP_ENV = "production"
```

Then redeploy with `make deploy`.

**Note:** For testing (homo), you need a separate certificate from WSASS (ARCA's homologation cert service). Your production certificate won't work against the testing endpoints.

## Development

```bash
make dev        # local dev server with wrangler
make test       # run tests
make typecheck  # run TypeScript type checking
make help       # show all available commands
```

## Security

- Webhook requests are verified via Telegram's `secret_token` mechanism
- Only Telegram user IDs in `ALLOWED_CHAT_IDS` can interact with the bot
- The `/setup` endpoint requires a secret query parameter
- AFIP error details are logged server-side, not sent to the user
- The bot only responds to private chats (ignores groups)
- WSAA auth tokens are cached in-memory to avoid rate limiting
- Invoice number collision is retried automatically (concurrent request safety)
- Friendly error messages for common AFIP rejections (backdating, unauthorized PtoVta, etc.)

## Project structure

```
src/
  index.ts           # Worker entry point and webhook routing
  telegram.ts        # Telegram Bot API helpers
  afip/
    cms.ts           # CMS/PKCS#7 signing (pkijs + Web Crypto)
    wsaa.ts          # ARCA authentication (WSAA) with caching
    wsfev1.ts        # Invoice creation and querying (WSFEv1)
scripts/
  generate-csr.mjs   # ARCA certificate request generator
```
