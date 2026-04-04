/**
 * CMS (PKCS#7) signing for ARCA/AFIP WSAA authentication.
 * Uses pkijs with Web Crypto API (compatible with Cloudflare Workers).
 */
import * as asn1js from "asn1js";
import * as pkijs from "pkijs";

// Initialize pkijs crypto engine with the Worker's Web Crypto
const cryptoEngine = new pkijs.CryptoEngine({
  name: "webcrypto",
  crypto: crypto as unknown as Crypto,
});
pkijs.setEngine("webcrypto", cryptoEngine as unknown as pkijs.ICryptoEngine);

function pemToDer(pem: string): ArrayBuffer {
  const b64 = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Create a CMS SignedData containing the given content, signed with the
 * provided certificate and private key. Returns base64-encoded CMS.
 */
export async function signCMS(
  content: string,
  certPem: string,
  keyPem: string
): Promise<string> {
  // Parse X.509 certificate
  const certDer = pemToDer(certPem);
  const cert = pkijs.Certificate.fromBER(certDer);

  // Import private key
  const keyDer = pemToDer(keyPem);
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    keyDer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );

  // Encode content as OctetString
  const contentBytes = new TextEncoder().encode(content);

  // Build SignedData
  const cmsSigned = new pkijs.SignedData({
    version: 1,
    encapContentInfo: new pkijs.EncapsulatedContentInfo({
      eContentType: "1.2.840.113549.1.7.1", // id-data
      eContent: new asn1js.OctetString({ valueHex: contentBytes.buffer as ArrayBuffer }),
    }),
    signerInfos: [
      new pkijs.SignerInfo({
        version: 1,
        sid: new pkijs.IssuerAndSerialNumber({
          issuer: cert.issuer,
          serialNumber: cert.serialNumber,
        }),
      }),
    ],
    certificates: [cert],
  });

  // Sign
  await cmsSigned.sign(privateKey, 0, "SHA-256");

  // Wrap in ContentInfo
  const contentInfo = new pkijs.ContentInfo({
    contentType: "1.2.840.113549.1.7.2", // id-signedData
    content: cmsSigned.toSchema(true),
  });

  const ber = contentInfo.toSchema().toBER(false);
  return arrayBufferToBase64(ber);
}
