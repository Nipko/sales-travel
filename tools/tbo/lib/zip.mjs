import { deflateRawSync, inflateRawSync } from 'node:zlib';

/**
 * Zip mínimo (PKWARE APPNOTE 6.3, sin zip64 ni cifrado) para que el arnés siga sin dependencias,
 * como `tools/sabre/cert-probe.mjs`. Deflate de `node:zlib`, nombres en UTF-8 (bit 11) y la fecha
 * en UTC: dos zips de la misma corrida y el mismo instante salen idénticos.
 *
 * `readZip` existe para comprobar lo escrito: `zip` vuelve a leer el archivo, verifica cada CRC y
 * pasa la guarda de credenciales sobre lo descomprimido antes de dar el zip por bueno.
 */

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;
const UTF8 = 0x0800;
const DEFLATE = 8;
const STORE = 0;
const VERSION = 20;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(epochMs) {
  const d = new Date(epochMs);
  const year = Math.max(1980, d.getUTCFullYear());
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

function checkName(name) {
  if (
    typeof name !== 'string' ||
    name === '' ||
    name.startsWith('/') ||
    name.includes('\\') ||
    name.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new Error(`nombre de entrada de zip inválido: ${JSON.stringify(name)}`);
  }
}

/**
 * @param {{ name: string, bytes: Buffer }[]} entries En el orden en que se listan.
 * @param {{ modifiedAt: number }} options
 * @returns {Buffer}
 */
export function createZip(entries, { modifiedAt }) {
  const { time, date } = dosDateTime(modifiedAt);
  const locals = [];
  const centrals = [];
  const seen = new Set();
  let offset = 0;
  for (const entry of entries) {
    checkName(entry.name);
    if (seen.has(entry.name)) throw new Error(`entrada de zip repetida: ${entry.name}`);
    seen.add(entry.name);
    const name = Buffer.from(entry.name, 'utf8');
    const raw = Buffer.from(entry.bytes);
    const deflated = deflateRawSync(raw);
    const method = deflated.length < raw.length ? DEFLATE : STORE;
    const data = method === DEFLATE ? deflated : raw;
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL, 0);
    local.writeUInt16LE(VERSION, 4);
    local.writeUInt16LE(UTF8, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL, 0);
    central.writeUInt16LE(VERSION, 4);
    central.writeUInt16LE(VERSION, 6);
    central.writeUInt16LE(UTF8, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + data.length;
    if (offset > 0xffffffff) throw new Error('el zip pasa de 4 GB: haría falta zip64');
  }
  const centralSize = centrals.reduce((sum, b) => sum + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

/**
 * Lee un zip de este módulo (o cualquiera sin zip64 ni cifrado).
 * @returns {{ name: string, bytes: Buffer, crcOk: boolean }[]}
 */
export function readZip(buffer) {
  let end = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 0xffff); i--) {
    if (buffer.readUInt32LE(i) === END) {
      end = i;
      break;
    }
  }
  if (end === -1) throw new Error('no es un zip: falta el fin del directorio central');
  const count = buffer.readUInt16LE(end + 10);
  let at = buffer.readUInt32LE(end + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(at) !== CENTRAL) throw new Error('directorio central roto');
    const method = buffer.readUInt16LE(at + 10);
    const crc = buffer.readUInt32LE(at + 16);
    const size = buffer.readUInt32LE(at + 20);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const localOffset = buffer.readUInt32LE(at + 42);
    const name = buffer.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    at += 46 + nameLength + extraLength + commentLength;

    if (buffer.readUInt32LE(localOffset) !== LOCAL) throw new Error(`cabecera local rota: ${name}`);
    const start =
      localOffset +
      30 +
      buffer.readUInt16LE(localOffset + 26) +
      buffer.readUInt16LE(localOffset + 28);
    const data = buffer.subarray(start, start + size);
    let bytes;
    if (method === STORE) bytes = Buffer.from(data);
    else if (method === DEFLATE) bytes = inflateRawSync(data);
    else throw new Error(`método de compresión ${method} no soportado: ${name}`);
    out.push({ name, bytes, crcOk: crc32(bytes) === crc });
  }
  return out;
}
