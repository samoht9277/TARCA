.PHONY: install dev deploy setup secrets csr test typecheck help

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  make %-12s %s\n", $$1, $$2}'

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

secrets: ## Set all Wrangler secrets interactively
	@echo "Setting secrets (paste each value, then Ctrl+D)..."
	npx wrangler secret put TELEGRAM_BOT_TOKEN
	npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
	npx wrangler secret put SETUP_SECRET
	npx wrangler secret put ALLOWED_CHAT_IDS
	npx wrangler secret put AFIP_CERT
	npx wrangler secret put AFIP_KEY
	npx wrangler secret put AFIP_CUIT
	npx wrangler secret put AFIP_PTO_VTA
