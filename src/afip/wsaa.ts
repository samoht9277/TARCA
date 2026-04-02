/**
 * ARCA/AFIP WSAA (Web Service de Autenticación y Autorización)
 * Handles login ticket generation and authentication.
 */
import { signCMS } from "./cms";

const WSAA_URLS = {
  testing: "https://wsaahomo.afip.gov.ar/ws/services/LoginCms",
  production: "https://wsaa.afip.gov.ar/ws/services/LoginCms",
} as const;

export interface AuthCredentials {
  token: string;
  sign: string;
}

function buildLoginTicketRequest(service: string): string {
  const now = new Date();
  const genTime = new Date(now.getTime() - 10 * 60 * 1000); // -10 min
  const expTime = new Date(now.getTime() + 10 * 60 * 1000); // +10 min
  const uniqueId = Math.floor(now.getTime() / 1000);

  return `<?xml version="1.0" encoding="UTF-8"?>
<loginTicketRequest version="1.0">
  <header>
    <uniqueId>${uniqueId}</uniqueId>
    <generationTime>${genTime.toISOString()}</generationTime>
    <expirationTime>${expTime.toISOString()}</expirationTime>
  </header>
  <service>${service}</service>
</loginTicketRequest>`;
}

function buildSoapEnvelope(cmsBase64: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:wsaa="http://wsaa.view.sua.dvadac.desein.afip.gov">
  <soapenv:Body>
    <wsaa:loginCms>
      <wsaa:in0>${cmsBase64}</wsaa:in0>
    </wsaa:loginCms>
  </soapenv:Body>
</soapenv:Envelope>`;
}

/**
 * Authenticate with AFIP WSAA and get Token + Sign for the given service.
 */
export async function authenticate(
  certPem: string,
  keyPem: string,
  env: "testing" | "production" = "testing",
  service: string = "wsfe"
): Promise<AuthCredentials> {
  // 1. Build login ticket request XML
  const loginTicket = buildLoginTicketRequest(service);

  // 2. Sign it as CMS
  const cmsBase64 = await signCMS(loginTicket, certPem, keyPem);

  // 3. Send SOAP request to WSAA
  const soapBody = buildSoapEnvelope(cmsBase64);
  const response = await fetch(WSAA_URLS[env], {
    method: "POST",
    headers: {
      "Content-Type": "text/xml; charset=utf-8",
      SOAPAction: "",
    },
    body: soapBody,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`WSAA HTTP ${response.status}: ${text}`);
  }

  const responseText = await response.text();

  // 4. Parse response - extract token and sign from the XML
  const credentialsXml = extractXmlContent(responseText, "loginCmsReturn");
  if (!credentialsXml) {
    throw new Error(`WSAA: no loginCmsReturn in response: ${responseText}`);
  }

  // The loginCmsReturn contains HTML-encoded XML, decode it
  const decoded = credentialsXml
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"');

  const token = extractXmlContent(decoded, "token");
  const sign = extractXmlContent(decoded, "sign");

  if (!token || !sign) {
    throw new Error(`WSAA: could not extract token/sign from: ${decoded}`);
  }

  return { token, sign };
}

function extractXmlContent(xml: string, tag: string): string | null {
  const regex = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`);
  const match = xml.match(regex);
  return match ? match[1].trim() : null;
}
