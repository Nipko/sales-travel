import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { crc32, createZip, readZip } from '../lib/zip.mjs';

const AT = Date.parse('2026-10-15T14:03:22Z');

describe('zip', () => {
  it('crc32 da el valor de control estándar', () => {
    assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  });

  it('lo que se escribe se lee igual, byte a byte, con nombres UTF-8 y CRC válido', () => {
    const entries = [
      { name: 'README.txt', bytes: Buffer.from('línea 1\r\nlínea 2\r\n') },
      // BOM y un byte que no es UTF-8: el zip no re-serializa nada.
      {
        name: 'Case01_1Room_1A/01_Search_RS.json',
        bytes: Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0xff, 0x7d]),
      },
      { name: 'Case01_1Room_1A/vacío.json', bytes: Buffer.alloc(0) },
      { name: 'grande.json', bytes: Buffer.from('{"a":1}'.repeat(5000)) },
    ];
    const back = readZip(createZip(entries, { modifiedAt: AT }));
    assert.deepEqual(
      back.map((e) => e.name),
      entries.map((e) => e.name),
    );
    back.forEach((e, i) => {
      assert.ok(e.crcOk, e.name);
      assert.deepEqual(e.bytes, entries[i].bytes);
    });
  });

  it('comprime lo que se deja comprimir y es determinista', () => {
    const entries = [{ name: 'a.json', bytes: Buffer.from('x'.repeat(10_000)) }];
    const a = createZip(entries, { modifiedAt: AT });
    const b = createZip(entries, { modifiedAt: AT });
    assert.ok(a.length < 1_000);
    assert.deepEqual(a, b);
  });

  it('un CRC que no coincide se detecta al leer', () => {
    const zip = createZip([{ name: 'a.txt', bytes: Buffer.from('hola hola hola') }], {
      modifiedAt: AT,
    });
    // El CRC del directorio central está en el offset 16 de su cabecera.
    const central = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    zip.writeUInt32LE(0, central + 16);
    assert.equal(readZip(zip)[0].crcOk, false);
  });

  it('rechaza nombres que salen de la carpeta, absolutos, con \\ o repetidos', () => {
    for (const name of ['../x', '/x', 'a/../b', 'a\\b', '', 'a//b']) {
      assert.throws(
        () => createZip([{ name, bytes: Buffer.alloc(1) }], { modifiedAt: AT }),
        /inválido/,
      );
    }
    assert.throws(
      () =>
        createZip(
          [
            { name: 'a', bytes: Buffer.alloc(1) },
            { name: 'a', bytes: Buffer.alloc(1) },
          ],
          { modifiedAt: AT },
        ),
      /repetida/,
    );
  });

  it('un archivo que no es zip no se lee', () => {
    assert.throws(
      () => readZip(Buffer.from('no soy un zip, sólo texto suficientemente largo')),
      /no es un zip/,
    );
  });
});
