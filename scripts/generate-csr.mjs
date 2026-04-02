#!/usr/bin/env node
/**
 * Generate a private key and CSR for ARCA (ex-AFIP) web services.
 *
 * Usage: node scripts/generate-csr.mjs <CUIT> <alias>
 * Example: node scripts/generate-csr.mjs 20123456789 tarca
 *
 * This creates:
 *   - afip_key.pem   → your private key (keep this safe!)
 *   - afip_csr.pem   → upload this to ARCA to get your certificate
 *
 * After uploading the CSR to ARCA, download the certificate and save it
 * as afip_cert.pem, then set it as a Wrangler secret.
 */
import { execSync } from "child_process";
import { existsSync } from "fs";

const cuit = process.argv[2];
const alias = process.argv[3] || "tarca";

if (!cuit) {
  console.error("Usage: node scripts/generate-csr.mjs <CUIT> [alias]");
  console.error("Example: node scripts/generate-csr.mjs 20123456789 tarca");
  process.exit(1);
}

const keyFile = "afip_key.pem";
const csrFile = "afip_csr.pem";

if (existsSync(keyFile)) {
  console.error(`Error: ${keyFile} already exists. Remove it first if you want to regenerate.`);
  process.exit(1);
}

console.log(`Generating private key and CSR for CUIT ${cuit}...\n`);

// Generate RSA private key
execSync(`openssl genrsa -out ${keyFile} 2048`, { stdio: "inherit" });

// Generate CSR
const subject = `/C=AR/O=CUIT ${cuit}/CN=${alias}/serialNumber=CUIT ${cuit}`;
execSync(
  `openssl req -new -key ${keyFile} -out ${csrFile} -subj "${subject}"`,
  { stdio: "inherit" }
);

console.log(`
✅ Files generated:
   ${keyFile}  → Private key (keep this safe, never share it!)
   ${csrFile}  → Certificate Signing Request

📋 Next steps:
   1. Go to https://auth.afip.gob.ar/contribuyente_/login.xhtml
   2. Log in with your CUIT and clave fiscal
   3. Go to "Administrador de Relaciones de Clave Fiscal"
   4. Add the "ARCA - Web Services" service if not already added
   5. Go to "Administración de certificados digitales"
   6. Create a new certificate, upload ${csrFile}
   7. Download the signed certificate and save it as afip_cert.pem
   8. Set up Wrangler secrets:
      wrangler secret put AFIP_CERT    (paste the certificate PEM)
      wrangler secret put AFIP_KEY     (paste the private key PEM)
      wrangler secret put AFIP_CUIT    (your CUIT number, no dashes)
      wrangler secret put AFIP_PTO_VTA (your punto de venta number)
`);
