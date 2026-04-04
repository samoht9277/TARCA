/**
 * ARCA/AFIP WSAA (Web Service de Autenticacion y Autorizacion)
 * Handles login ticket generation and authentication with in-memory caching.
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

interface CachedAuth {
  credentials: AuthCredentials;
  expiresAt: number;
}

// In-memory cache. Persists across requests within the same CF Worker isolate.
// Not shared across isolates, but massively reduces WSAA calls in practice.
const authCache = new Map<string, CachedAuth>();

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
 * Uses in-memory caching to avoid hitting WSAA on every request.
 */
export async function authenticate(
  certPem: string,
  keyPem: string,
  env: "testing" | "production" = "testing",
  service: string = "wsfe"
): Promise<AuthCredentials> {
  const cacheKey = `${env}:${service}`;
  const cached = authCache.get(cacheKey);

  // Use cached token if still valid (with 60s safety margin)
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return cached.credentials;
  }

  const credentials = await authenticateFresh(certPem, keyPem, env, service);

  // Cache for 10 minutes (matching our ticket expiration window)
  authCache.set(cacheKey, {
    credentials,
    expiresAt: Date.now() + 10 * 60 * 1000,
  });

  return credentials;
}

async function authenticateFresh(
  certPem: string,
  keyPem: string,
  env: "testing" | "production",
  service: string
): Promise<AuthCredentials> {
  const loginTicket = buildLoginTicketRequest(service);
  const cmsBase64 = await signCMS(loginTicket, certPem, keyPem);

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

  // Check for SOAP faults first
  const faultString = extractXmlContent(responseText, "faultstring");
  if (faultString) {
    throw new Error(`WSAA SOAP Fault: ${faultString}`);
  }

  const credentialsXml = extractXmlContent(responseText, "loginCmsReturn");
  if (!credentialsXml) {
    throw new Error(`WSAA: no loginCmsReturn in response`);
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
    throw new Error(`WSAA: could not extract token/sign`);
  }

  return { token, sign };
}

function extractXmlContent(xml: string, tag: string): string | null {
  // Match both bare and namespaced tags (e.g. <token> or <ns:token>)
  const regex = new RegExp(`<(?:[a-zA-Z0-9]+:)?${tag}[^>]*>([\\s\\S]*?)</(?:[a-zA-Z0-9]+:)?${tag}>`);
  const match = xml.match(regex);
  return match ? match[1].trim() : null;
}
