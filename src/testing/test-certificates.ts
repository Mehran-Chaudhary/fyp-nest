import 'reflect-metadata';
import * as x509 from '@peculiar/x509';
import { webcrypto } from 'node:crypto';

x509.cryptoProvider.set(webcrypto as unknown as Parameters<typeof x509.cryptoProvider.set>[0]);

const ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' };

export interface TestPair {
  cert: string;
  key: string;
}

export interface TestPki {
  ca: TestPair;
  server: TestPair;
  client: TestPair;
}

async function pem(key: webcrypto.CryptoKey): Promise<string> {
  const der = await webcrypto.subtle.exportKey('pkcs8', key);
  return x509.PemConverter.encode(der, 'PRIVATE KEY');
}

/**
 * A throwaway private PKI for tests: a CA, a server certificate for
 * `localhost`/127.0.0.1, and a client certificate — the same shape
 * `npm run generate:mtls` produces.
 */
export async function createTestPki(options: { expired?: boolean } = {}): Promise<TestPki> {
  const now = Date.now();
  const notAfter = options.expired ? new Date(now - 86_400_000) : new Date(now + 86_400_000);
  const notBefore = new Date(now - 2 * 86_400_000);

  const caKeys = await webcrypto.subtle.generateKey(ALGORITHM, true, ['sign', 'verify']);
  const caCertificate = await x509.X509CertificateGenerator.createSelfSigned({
    name: 'CN=Test CA',
    notBefore,
    notAfter: new Date(now + 86_400_000),
    keys: caKeys,
    signingAlgorithm: ALGORITHM,
    extensions: [
      new x509.BasicConstraintsExtension(true, 0, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign, true),
    ],
  });

  const leaf = async (commonName: string, usage: string, hosts: string[]): Promise<TestPair> => {
    const keys = await webcrypto.subtle.generateKey(ALGORITHM, true, ['sign', 'verify']);
    const certificate = await x509.X509CertificateGenerator.create({
      subject: `CN=${commonName}`,
      issuer: caCertificate.subject,
      notBefore,
      notAfter,
      signingAlgorithm: ALGORITHM,
      publicKey: keys.publicKey,
      signingKey: caKeys.privateKey,
      extensions: [
        new x509.BasicConstraintsExtension(false),
        new x509.ExtendedKeyUsageExtension([usage]),
        ...(hosts.length > 0
          ? [
              new x509.SubjectAlternativeNameExtension(
                hosts.map((host) =>
                  /^\d/.test(host) ? { type: 'ip', value: host } : { type: 'dns', value: host },
                ),
              ),
            ]
          : []),
      ],
    });
    return { cert: certificate.toString('pem'), key: await pem(keys.privateKey) };
  };

  return {
    ca: { cert: caCertificate.toString('pem'), key: await pem(caKeys.privateKey) },
    server: await leaf('localhost', x509.ExtendedKeyUsage.serverAuth, ['localhost', '127.0.0.1']),
    client: await leaf('daiap-backend', x509.ExtendedKeyUsage.clientAuth, []),
  };
}
