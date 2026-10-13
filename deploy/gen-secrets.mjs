#!/usr/bin/env node
// ThemeBot Cloud secrets helper. Plain Node (18+), no dependencies; runs on your PC or on the server.
//
//   node deploy/gen-secrets.mjs
//       Prints a fresh CLOUD_SIGNING_KEY, CLOUD_PEPPER and ADMIN_TOKEN as cloud.env lines, plus the
//       THEMEBOT_CLOUD_PUBKEY the desktop app build needs. Nothing is written anywhere.
//
//   node deploy/gen-secrets.mjs --fill /etc/themebot-cloud/cloud.env
//       Fills CLOUD_SIGNING_KEY, CLOUD_PEPPER and ADMIN_TOKEN in that file ONLY where they are still
//       empty (setup-server.sh does this). A value that is already set is never replaced.
//
//   node deploy/gen-secrets.mjs --rotate-admin-token /etc/themebot-cloud/cloud.env
//       Replaces ADMIN_TOKEN with a fresh one and prints it (then: systemctl restart themebot-cloud).
//
//   node deploy/gen-secrets.mjs --pubkey /etc/themebot-cloud/cloud.env
//       Prints the base64 public key that belongs to the CLOUD_SIGNING_KEY in that file — the value
//       for THEMEBOT_CLOUD_PUBKEY. Same as GET https://<cloud>/v1/public-key.
//
// There is deliberately no option to rotate CLOUD_SIGNING_KEY or CLOUD_PEPPER (see deploy/README.md):
// a new signing key locks out every installed app until it is rebuilt with the new public key, and a
// new pepper signs everyone out and breaks leak tracing for prompts already sent.
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

const fresh = {
  /** One line, "\n" escapes, single-quoted: survives systemd's EnvironmentFile parser and `source`. */
  CLOUD_SIGNING_KEY: () => {
    const pem = generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }).toString().trim();
    return `'${pem.replace(/\r?\n/g, '\\n')}'`;
  },
  CLOUD_PEPPER: () => randomBytes(32).toString('base64url'),
  ADMIN_TOKEN: () => `tba_${randomBytes(32).toString('base64url')}`,
};

/** Value as the Cloud sees it: quotes removed, "\n" escapes turned into newlines (cloud/src/config.ts). */
function unquote(raw) {
  let value = raw.trim();
  if (value.length >= 2 && (value[0] === "'" || value[0] === '"') && value.endsWith(value[0])) value = value.slice(1, -1);
  return value.replace(/\\n/g, '\n');
}

/** The raw 32-byte Ed25519 public key, base64 — exactly what /v1/public-key serves (cloud/src/passes.ts). */
function publicKeyOf(pem) {
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('CLOUD_SIGNING_KEY is not an Ed25519 private key.');
  const { x } = createPublicKey(key).export({ format: 'jwk' });
  return Buffer.from(x, 'base64url').toString('base64');
}

const ASSIGNMENT = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=(.*)$/;

function readEnv(file) {
  if (!existsSync(file)) throw new Error(`${file} does not exist.`);
  return readFileSync(file, 'utf8').replace(/\r\n/g, '\n').split('\n');
}

function valueIn(lines, name) {
  for (const line of lines) {
    const match = ASSIGNMENT.exec(line);
    if (match && match[1] === name) return unquote(match[2]);
  }
  return '';
}

/** Writes beside the file and renames over it. The file stays readable by its owner only (0600). */
function writeEnv(file, lines) {
  const temp = `${file}.tmp-${process.pid}`;
  writeFileSync(temp, lines.join('\n'), { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, file);
}

/** Sets NAME=value: replaces its line (or appends one). `onlyIfEmpty` leaves a set value alone. */
function setValue(lines, name, value, onlyIfEmpty) {
  const at = lines.findIndex((line) => ASSIGNMENT.exec(line)?.[1] === name);
  if (at >= 0) {
    if (onlyIfEmpty && unquote(ASSIGNMENT.exec(lines[at])[2])) return false;
    lines[at] = `${name}=${value}`;
  } else {
    if (lines.length && lines[lines.length - 1] === '') lines.splice(lines.length - 1, 0, `${name}=${value}`);
    else lines.push(`${name}=${value}`);
  }
  return true;
}

function main(argv) {
  const [command, file] = argv;
  if (!command) {
    const signing = fresh.CLOUD_SIGNING_KEY();
    console.log(`# ThemeBot Cloud secrets — generated ${new Date().toISOString()}`);
    console.log('# Paste these into /etc/themebot-cloud/cloud.env (each on ONE line, exactly as shown) and keep');
    console.log('# a copy in your password manager. Losing CLOUD_SIGNING_KEY means rebuilding every installer.');
    console.log(`CLOUD_SIGNING_KEY=${signing}`);
    console.log(`CLOUD_PEPPER=${fresh.CLOUD_PEPPER()}`);
    console.log(`ADMIN_TOKEN=${fresh.ADMIN_TOKEN()}`);
    console.log('');
    console.log('# For building the desktop installers (NOT a secret — it is the public half of the key above):');
    console.log(`THEMEBOT_CLOUD_PUBKEY=${publicKeyOf(unquote(signing))}`);
    return;
  }
  if (command === '--fill') {
    if (!file) throw new Error('Usage: gen-secrets.mjs --fill <cloud.env>');
    const lines = readEnv(file);
    const filled = Object.keys(fresh).filter((name) => setValue(lines, name, fresh[name](), true));
    if (filled.length) writeEnv(file, lines);
    console.log(filled.length ? `Filled in ${file}: ${filled.join(', ')}` : `Nothing to fill in ${file}: the secrets are already set.`);
    console.log(`THEMEBOT_CLOUD_PUBKEY=${publicKeyOf(valueIn(lines, 'CLOUD_SIGNING_KEY'))}`);
    return;
  }
  if (command === '--rotate-admin-token') {
    if (!file) throw new Error('Usage: gen-secrets.mjs --rotate-admin-token <cloud.env>');
    const lines = readEnv(file);
    const token = fresh.ADMIN_TOKEN();
    setValue(lines, 'ADMIN_TOKEN', token, false);
    writeEnv(file, lines);
    console.log(`New ADMIN_TOKEN written to ${file}:`);
    console.log(token);
    console.log('The old token keeps working until the Cloud restarts: sudo systemctl restart themebot-cloud');
    return;
  }
  if (command === '--pubkey') {
    if (!file) throw new Error('Usage: gen-secrets.mjs --pubkey <cloud.env>');
    const pem = valueIn(readEnv(file), 'CLOUD_SIGNING_KEY');
    if (!pem) throw new Error(`CLOUD_SIGNING_KEY is empty in ${file}.`);
    console.log(publicKeyOf(pem));
    return;
  }
  throw new Error(`Unknown option ${command}. Options: (none), --fill <file>, --rotate-admin-token <file>, --pubkey <file>`);
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(`gen-secrets: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
