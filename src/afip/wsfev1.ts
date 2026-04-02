/**
 * ARCA/AFIP WSFEv1 (Web Service de Facturación Electrónica v1)
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
  const regex = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`);
  const match = xml.match(regex);
  return match ? match[1].trim() : null;
}

/**
 * Get the last authorized invoice number for the given punto de venta and type.
 */
async function getLastInvoiceNumber(
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
    // Check for errors
    const errMsg = extractXml(response, "Msg");
    throw new Error(
      `FECompUltimoAutorizado failed: ${errMsg || response}`
    );
  }

  return parseInt(cbteNro, 10);
}

/**
 * Create a Factura C for Consumidor Final (Monotributista).
 *
 * @param amount - Invoice total amount
 * @returns Invoice result with CAE, expiry, and number
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
  const today = formatDate(date);

  // Get next invoice number
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
            <ar:CbteFch>${today}</ar:CbteFch>
            <ar:ImpTotal>${amount.toFixed(2)}</ar:ImpTotal>
            <ar:ImpTotConc>0</ar:ImpTotConc>
            <ar:ImpNeto>${amount.toFixed(2)}</ar:ImpNeto>
            <ar:ImpOpEx>0</ar:ImpOpEx>
            <ar:ImpIVA>0</ar:ImpIVA>
            <ar:ImpTrib>0</ar:ImpTrib>
            <ar:FchServDesde>${today}</ar:FchServDesde>
            <ar:FchServHasta>${today}</ar:FchServHasta>
            <ar:FchVtoPago>${today}</ar:FchVtoPago>
            <ar:MonId>PES</ar:MonId>
            <ar:MonCotiz>1</ar:MonCotiz>
          </ar:FECAEDetRequest>
        </ar:FeDetReq>
      </ar:FeCAEReq>`;

  const response = await soapCall(WSFEV1_URLS[env], "FECAESolicitar", body);

  // Check result
  const resultado = extractXml(response, "Resultado");
  if (resultado !== "A") {
    const errMsg = extractXml(response, "Msg") || extractXml(response, "Err");
    throw new Error(
      `FECAESolicitar rejected: ${errMsg || response}`
    );
  }

  const cae = extractXml(response, "CAE");
  const caeFchVto = extractXml(response, "CAEFchVto");

  if (!cae || !caeFchVto) {
    throw new Error(`FECAESolicitar: missing CAE in response: ${response}`);
  }

  return {
    cae,
    caeFchVto,
    cbteNro: nextNro,
    ptoVta,
  };
}
