#!/usr/bin/env node
/* eslint-disable no-console */

/**
 * Generates the certificates for mutual TLS between this backend and the
 * Python AI service (phase 5):
 *
 *   npm run generate:mtls -- --server-host ai.example.com
 *   npm run generate:mtls -- --server-host ai.example.com --server-host 10.0.0.7 --out certs/mtls
 *
 * Produces, in the output directory (default `certs/mtls`, git-ignored):
 *
 *   ca.crt / ca.key          a private certificate authority — keep ca.key OFFLINE
 *   server.crt / server.key  for the AI service (serverAuth, SAN = --server-host)
 *   client.crt / client.key  for this backend (clientAuth, CN = daiap-backend)
 *
 * and prints the three environment variables to set on the API and worker
 * (base64-encoded PEM, which every hosting platform's variable editor accepts),
 * plus how to make the AI service require the client certificate.
 *
 * ECDSA P-256 keys, SHA-256 signatures: supported by Python's ssl module
 * (uvicorn, gunicorn), Caddy, nginx, Envoy and every current TLS stack.
 * Each certificate is verified against the CA before anything is printed.
 */

require('reflect-metadata');
const x509 = require('@peculiar/x509');
const {
  webcrypto,
  randomBytes,
  X509Certificate,
  createPrivateKey,
} = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');

x509.cryptoProvider.set(webcrypto);

const ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' };
const DAY_MS = 86_400_000;

function parseArguments(argv) {
  const options = {
    serverHosts: [],
    out: path.resolve(process.cwd(), 'certs', 'mtls'),
    days: 397,
    caDays: 3650,
    clientName: 'daiap-backend',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--server-host') {
      options.serverHosts.push(value);
      index += 1;
    } else if (flag === '--out') {
      options.out = path.resolve(process.cwd(), value);
      index += 1;
    } else if (flag === '--days') {
      options.days = Number(value);
      index += 1;
    } else if (flag === '--ca-days') {
      options.caDays = Number(value);
      index += 1;
    } else if (flag === '--client-name') {
      options.clientName = value;
      index += 1;
    } else if (flag === '--help' || flag === '-h') {
      options.help = true;
    }
  }
  return options;
}

const serial = () => randomBytes(16).toString('hex').replace(/^[89a-f]/, '1');

async function keyPair() {
  return webcrypto.subtle.generateKey(ALGORITHM, true, ['sign', 'verify']);
}

async function privateKeyPem(key) {
  const der = await webcrypto.subtle.exportKey('pkcs8', key);
  return x509.PemConverter.encode(der, 'PRIVATE KEY');
}

function generalName(host) {
  return net.isIP(host) ? { type: 'ip', value: host } : { type: 'dns', value: host };
}

async function issue(ca, { commonName, usage, hosts, days }) {
  const keys = await keyPair();
  const now = Date.now();
  const extensions = [
    new x509.BasicConstraintsExtension(false, undefined, true),
    new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
    new x509.ExtendedKeyUsageExtension([usage], false),
    await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
    await x509.AuthorityKeyIdentifierExtension.create(ca.keys.publicKey),
  ];
  if (hosts && hosts.length > 0) {
    extensions.push(new x509.SubjectAlternativeNameExtension(hosts.map(generalName), false));
  }
  const certificate = await x509.X509CertificateGenerator.create({
    serialNumber: serial(),
    subject: `CN=${commonName}, O=DAIAP`,
    issuer: ca.certificate.subject,
    notBefore: new Date(now - 60_000),
    notAfter: new Date(now + days * DAY_MS),
    signingAlgorithm: ALGORITHM,
    publicKey: keys.publicKey,
    signingKey: ca.keys.privateKey,
    extensions,
  });
  return {
    cert: certificate.toString('pem'),
    key: await privateKeyPem(keys.privateKey),
  };
}

function verify(label, pair, caPem) {
  const certificate = new X509Certificate(pair.cert);
  const caCertificate = new X509Certificate(caPem);
  if (!certificate.checkPrivateKey(createPrivateKey(pair.key))) {
    throw new Error(`${label}: the key does not match the certificate`);
  }
  if (!certificate.verify(caCertificate.publicKey)) {
    throw new Error(`${label}: the certificate is not signed by the CA`);
  }
}

const b64 = (pem) => Buffer.from(pem, 'utf8').toString('base64');

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help || options.serverHosts.length === 0) {
    console.log(
      'Usage: npm run generate:mtls -- --server-host <AI service host> [--server-host …] ' +
        '[--out certs/mtls] [--days 397] [--ca-days 3650] [--client-name daiap-backend]',
    );
    process.exit(options.help ? 0 : 1);
  }

  const now = Date.now();
  const caKeys = await keyPair();
  const caCertificate = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: serial(),
    name: 'CN=DAIAP Internal CA, O=DAIAP',
    notBefore: new Date(now - 60_000),
    notAfter: new Date(now + options.caDays * DAY_MS),
    keys: caKeys,
    signingAlgorithm: ALGORITHM,
    extensions: [
      new x509.BasicConstraintsExtension(true, 0, true),
      new x509.KeyUsagesExtension(
        x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign,
        true,
      ),
      await x509.SubjectKeyIdentifierExtension.create(caKeys.publicKey),
    ],
  });
  const ca = { keys: caKeys, certificate: caCertificate };
  const caPem = caCertificate.toString('pem');

  const server = await issue(ca, {
    commonName: options.serverHosts[0],
    usage: x509.ExtendedKeyUsage.serverAuth,
    hosts: options.serverHosts,
    days: options.days,
  });
  const client = await issue(ca, {
    commonName: options.clientName,
    usage: x509.ExtendedKeyUsage.clientAuth,
    days: options.days,
  });
  verify('server', server, caPem);
  verify('client', client, caPem);

  fs.mkdirSync(options.out, { recursive: true });
  const files = {
    'ca.crt': caPem,
    'ca.key': await privateKeyPem(caKeys.privateKey),
    'server.crt': server.cert,
    'server.key': server.key,
    'client.crt': client.cert,
    'client.key': client.key,
  };
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(options.out, name), content, {
      mode: name.endsWith('.key') ? 0o600 : 0o644,
    });
  }

  const relative = path.relative(process.cwd(), options.out) || '.';
  console.log('');
  console.log(`Certificates written to ${relative}/ (valid ${options.days} days; CA ${options.caDays}).`);
  console.log('Keep ca.key OFFLINE — anyone holding it can mint certificates both sides trust.');
  console.log('');
  console.log('# ── On the API and the worker ─────────────────────────────────────────');
  console.log(`AI_SERVICE_TLS_CERT=${b64(client.cert)}`);
  console.log(`AI_SERVICE_TLS_KEY=${b64(client.key)}`);
  console.log(`AI_SERVICE_TLS_CA=${b64(caPem)}`);
  console.log('');
  console.log('# ── On the AI service (it terminates TLS itself and requires the client cert) ──');
  console.log(`#   ${relative}/server.crt, ${relative}/server.key and ${relative}/ca.crt, then:`);
  console.log(
    '#   uvicorn app:app --host 0.0.0.0 --port 8443 --ssl-certfile server.crt ' +
      '--ssl-keyfile server.key --ssl-ca-certs ca.crt --ssl-cert-reqs 2',
  );
  console.log('#   (--ssl-cert-reqs 2 = CERT_REQUIRED: no client certificate, no connection.)');
  console.log('#   Behind a proxy instead (Caddy): tls { client_auth { mode require_and_verify');
  console.log('#   trust_pool file ca.crt } }. See docs/ENVIRONMENT.md, "Mutual TLS".');
  console.log('');
}

main().catch((error) => {
  console.error('Certificate generation failed:', error);
  process.exit(1);
});
