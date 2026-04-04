.PHONY: install dev deploy secrets secrets-certs csr test typecheck help

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  make %-14s %s\n", $$1, $$2}'

install: ## Install dependencies
	npm install

dev: ## Run local dev server
	npx wrangler dev

test: ## Run tests
	npx vitest run

typecheck: ## Run TypeScript type checking
	npx tsc --noEmit

deploy: typecheck test ## Deploy to Cloudflare Workers (runs typecheck + tests first)
	npx wrangler deploy

csr: ## Generate ARCA certificate request (usage: make csr CUIT=20123456789)
	node scripts/generate-csr.mjs $(CUIT)

secrets: ## Set all Wrangler secrets interactively (paste value + Ctrl+D for each)
	@echo "=== Telegram ==="
	npx wrangler secret put TELEGRAM_BOT_TOKEN
	npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
	npx wrangler secret put SETUP_SECRET
	npx wrangler secret put ALLOWED_CHAT_IDS
	@echo ""
	@echo "=== ARCA ==="
	@echo "For AFIP_CERT and AFIP_KEY, use: make secrets-certs"
	npx wrangler secret put AFIP_CUIT
	npx wrangler secret put AFIP_PTO_VTA

secrets-certs: ## Set AFIP cert and key from PEM files in project root
	@test -f afip_cert.pem || (echo "Error: afip_cert.pem not found" && exit 1)
	@test -f afip_key.pem || (echo "Error: afip_key.pem not found" && exit 1)
	npx wrangler secret put AFIP_CERT < afip_cert.pem
	npx wrangler secret put AFIP_KEY < afip_key.pem
	@echo "Done! AFIP_CERT and AFIP_KEY set from PEM files."
