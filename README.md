# TARCA

Telegram bot that creates ARCA (ex-AFIP) invoices, running on a free Cloudflare Worker.

Send an amount to the bot, confirm, and get a Factura C issued instantly.

## How it works

1. You text the bot an amount (e.g. `15000`)
2. Bot asks for confirmation with inline buttons
3. You tap **Confirmar** → bot creates the invoice on ARCA
4. Bot replies with the invoice number, CAE, and expiry

**Invoice defaults:** Factura C · Servicios Informáticos · Consumidor Final · Monotributista

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

This creates `afip_key.pem` (private key) and `afip_csr.pem` (CSR). Then:

1. Log in to [ARCA](https://auth.afip.gob.ar/contribuyente_/login.xhtml) with your CUIT
2. Go to **Administración de certificados digitales**
3. Upload the CSR and download the signed certificate as `afip_cert.pem`

### 3. Set secrets

```bash
make secrets
```

This prompts you for:
- `TELEGRAM_BOT_TOKEN` — from @BotFather
- `AFIP_CERT` — contents of `afip_cert.pem`
- `AFIP_KEY` — contents of `afip_key.pem`
- `AFIP_CUIT` — your CUIT number (no dashes)
- `AFIP_PTO_VTA` — your punto de venta number

### 4. Deploy

```bash
make deploy
```

### 5. Register the webhook

Visit `https://tarca.<your-subdomain>.workers.dev/setup` in your browser.

### 6. Switch to production

By default the bot runs against ARCA's testing environment. To issue real invoices, edit `wrangler.toml`:

```toml
AFIP_ENV = "production"
```

Then redeploy with `make deploy`.

## Development

```bash
make dev      # local dev server with wrangler
make help     # show all available commands
```

## Project structure

```
src/
├── index.ts           # Worker entry point and webhook routing
├── telegram.ts        # Telegram Bot API helpers
└── afip/
    ├── cms.ts         # CMS/PKCS#7 signing (pkijs + Web Crypto)
    ├── wsaa.ts        # ARCA authentication (WSAA)
    └── wsfev1.ts      # Invoice creation (WSFEv1)
scripts/
└── generate-csr.mjs   # ARCA certificate request generator
```
