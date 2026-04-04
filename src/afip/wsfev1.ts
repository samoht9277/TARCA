/**
 * ARCA/AFIP WSFEv1 (Web Service de Facturacion Electronica v1)
 * Handles electronic invoice creation for Monotributistas.
 */
import type { AuthCredentials } from "./wsaa";

const WSFEV1_URLS = {
  testing: "https://wswhomo.afip.gov.ar/wsfev1/service.asmx",
  production: "https://servicios1.afip.gov.ar/wsfev1/service.asmx",
} as const;

export interface InvoiceResult {
  cae: string;
  caeFchVto: string;
  cbteNro: number;
  ptoVta: number;
}

function formatDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

function buildSoap(action: string, body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ar="http://ar.gov.afip.dif.FEV1/">
  <soapenv:Body>
    <ar:${action}>
      ${body}
    </ar:${action}>
  </soapenv:Body>
</soapenv:Envelope>`;
}

function authXml(auth: AuthCredentials, cuit: string): string {
  return `<ar:Auth>
        <ar:Token>${auth.token}</ar:Token>
        <ar:Sign>${auth.sign}</ar:Sign>
        <ar:Cuit>${cuit}</ar:Cuit>
      </ar:Auth>`;
}

async function soapCall(
  url: string,
  action: string,
  body: string
): Promise<string> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "text/xml; charset=utf-8",
      SOAPAction: `http://ar.gov.afip.dif.FEV1/${action}`,
    },
    body: buildSoap(action, body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`WSFEv1 ${action} HTTP ${response.status}: ${text}`);
  }

  return response.text();
}

function extractXml(xml: string, tag: string): string | null {
  const regex = new RegExp(`<(?:[a-zA-Z0-9]+:)?${tag}[^>]*>([\\s\\S]*?)</(?:[a-zA-Z0-9]+:)?${tag}>`);
  const match = xml.match(regex);
  return match ? match[1].trim() : null;
}

export async function getLastInvoiceNumber(
  auth: AuthCredentials,
  cuit: string,
  ptoVta: number,
  cbteTipo: number,
  env: "testing" | "production"
): Promise<number> {
  const body = `${authXml(auth, cuit)}
      <ar:PtoVta>${ptoVta}</ar:PtoVta>
      <ar:CbteTipo>${cbteTipo}</ar:CbteTipo>`;

  const response = await soapCall(
    WSFEV1_URLS[env],
    "FECompUltimoAutorizado",
    body
  );

  const cbteNro = extractXml(response, "CbteNro");
  if (cbteNro === null) {
    const errMsg = extractXml(response, "Msg");
    throw new Error(
      `FECompUltimoAutorizado failed: ${errMsg || "unknown error"}`
    );
  }

  return parseInt(cbteNro, 10);
}

/**
 * Create a Factura C for Consumidor Final (Monotributista).
 * Retries once on invoice number collision (concurrent request race).
 */
export async function createInvoice(
  auth: AuthCredentials,
  cuit: string,
  ptoVta: number,
  amount: number,
  env: "testing" | "production" = "testing",
  date: Date = new Date()
): Promise<InvoiceResult> {
  const cbteTipo = 11; // Factura C
  const fch = formatDate(date);

  // Retry once on number collision
  for (let attempt = 0; attempt < 2; attempt++) {
    const lastNro = await getLastInvoiceNumber(auth, cuit, ptoVta, cbteTipo, env);
    const nextNro = lastNro + 1;

    const body = `${authXml(auth, cuit)}
      <ar:FeCAEReq>
        <ar:FeCabReq>
          <ar:CantReg>1</ar:CantReg>
          <ar:PtoVta>${ptoVta}</ar:PtoVta>
          <ar:CbteTipo>${cbteTipo}</ar:CbteTipo>
        </ar:FeCabReq>
        <ar:FeDetReq>
          <ar:FECAEDetRequest>
            <ar:Concepto>2</ar:Concepto>
            <ar:DocTipo>99</ar:DocTipo>
            <ar:DocNro>0</ar:DocNro>
            <ar:CbteDesde>${nextNro}</ar:CbteDesde>
            <ar:CbteHasta>${nextNro}</ar:CbteHasta>
            <ar:CbteFch>${fch}</ar:CbteFch>
            <ar:ImpTotal>${amount.toFixed(2)}</ar:ImpTotal>
            <ar:ImpTotConc>0</ar:ImpTotConc>
            <ar:ImpNeto>${amount.toFixed(2)}</ar:ImpNeto>
            <ar:ImpOpEx>0</ar:ImpOpEx>
            <ar:ImpIVA>0</ar:ImpIVA>
            <ar:ImpTrib>0</ar:ImpTrib>
            <ar:FchServDesde>${fch}</ar:FchServDesde>
            <ar:FchServHasta>${fch}</ar:FchServHasta>
            <ar:FchVtoPago>${fch}</ar:FchVtoPago>
            <ar:MonId>PES</ar:MonId>
            <ar:MonCotiz>1</ar:MonCotiz>
          </ar:FECAEDetRequest>
        </ar:FeDetReq>
      </ar:FeCAEReq>`;

    const response = await soapCall(WSFEV1_URLS[env], "FECAESolicitar", body);

    const resultado = extractXml(response, "Resultado");
    if (resultado !== "A") {
      // Extract error from <Errors><Err><Msg> first, fall back to top-level <Msg>
      const errorsBlock = extractXml(response, "Errors");
      const errMsg = (errorsBlock ? extractXml(errorsBlock, "Msg") : null)
        || extractXml(response, "Msg")
        || "";

      // Retry on "not consecutive" error (race condition)
      if (attempt === 0 && errMsg.toLowerCase().includes("consecutiv")) {
        continue;
      }

      console.error("FECAESolicitar full response:", response);
      throw new Error(`FECAESolicitar rejected: ${errMsg || "unknown error"}`);
    }

    const cae = extractXml(response, "CAE");
    const caeFchVto = extractXml(response, "CAEFchVto");

    if (!cae || !caeFchVto) {
      throw new Error("FECAESolicitar: missing CAE in response");
    }

    return {
      cae,
      caeFchVto,
      cbteNro: nextNro,
      ptoVta,
    };
  }

  throw new Error("FECAESolicitar: failed after retry");
}

export interface InvoiceInfo {
  cae: string;
  caeFchVto: string;
  cbteNro: number;
  ptoVta: number;
  cbteFch: string;
  impTotal: string;
  resultado: string;
}

/**
 * Query an existing invoice by number.
 */
export async function queryInvoice(
  auth: AuthCredentials,
  cuit: string,
  ptoVta: number,
  cbteNro: number,
  env: "testing" | "production" = "testing"
): Promise<InvoiceInfo> {
  const cbteTipo = 11; // Factura C

  const body = `${authXml(auth, cuit)}
      <ar:FeCompConsReq>
        <ar:CbteTipo>${cbteTipo}</ar:CbteTipo>
        <ar:CbteNro>${cbteNro}</ar:CbteNro>
        <ar:PtoVta>${ptoVta}</ar:PtoVta>
      </ar:FeCompConsReq>`;

  const response = await soapCall(WSFEV1_URLS[env], "FECompConsultar", body);

  const errorsBlock = extractXml(response, "Errors");
  if (errorsBlock) {
    const errMsg = extractXml(errorsBlock, "Msg") || "unknown error";
    throw new Error(`FECompConsultar failed: ${errMsg}`);
  }

  const cae = extractXml(response, "CodAutorizacion") || "";
  const caeFchVto = extractXml(response, "FchVto") || "";
  const cbteFch = extractXml(response, "CbteFch") || "";
  const impTotal = extractXml(response, "ImpTotal") || "";
  const resultado = extractXml(response, "Resultado") || "";

  return { cae, caeFchVto, cbteNro, ptoVta, cbteFch, impTotal, resultado };
}
