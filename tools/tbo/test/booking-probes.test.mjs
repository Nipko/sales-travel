import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { createFakeTbo } from './fake-tbo.mjs';
import { assertNoSecrets, cleanup, jsonl, readJson, runHarness } from './support.mjs';

/**
 * `probe --bookings` (docs/tbo/07 §6.8): PR-09, PR-10 y PR-11 reservan en test, contestan Q-43,
 * Q-33 y Q-35 y cancelan siempre lo que reservaron. Contra el TBO falso, con sus dos respuestas
 * posibles, para ver que la lectura cambia con lo que TBO haga.
 */

after(cleanup);

const ARGS = ['probe', '--bookings', '--only', 'PR-09,PR-10,PR-11'];

async function summaryOf(result) {
  const summary = await readJson(join(result.dir, 'probes', 'summary.json'));
  return Object.fromEntries(summary.probes.map((p) => [p.id, p]));
}

describe('probe --bookings', () => {
  it('PR-09 a PR-11 contestan Q-43, Q-33 y Q-35 y cancelan todo lo que reservaron', async () => {
    const result = await runHarness(ARGS);
    assert.equal(result.code, 0, result.stderr);
    const byId = await summaryOf(result);
    assert.deepEqual(
      Object.values(byId).map((p) => [p.id, p.question]),
      [
        ['PR-09', 'Q-43'],
        ['PR-10', 'Q-33'],
        ['PR-11', 'Q-35'],
      ],
    );
    assert.match(byId['PR-09'].reading, /TBO acepta tildes y ñ .* "José Muñoz": intactos/);
    assert.match(
      byId['PR-10'].reading,
      /TBO rechaza un TotalFare distinto del PreBook: .*Status\.Code 400/,
    );
    assert.match(byId['PR-11'].reading, /TBO crea OTRA reserva \(FK0002 y FK0003\).*\(c\)/);
    assert.ok([...result.fake.bookings.values()].every((b) => b.status === 'Cancelled'));
    await assertNoSecrets(result);
  });

  it('PR-09 declara la reescritura: el ACL manda ASCII y la sonda devuelve las tildes', async () => {
    const result = await runHarness(ARGS);
    const calls = await jsonl(join(result.dir, 'probes', 'PR-09', 'calls.jsonl'));
    const book = calls.find((c) => c.operation === 'Book');
    assert.equal(book.mutation, 'CustomerNames[0]: Jose Munoz (ASCII del ACL) → José Muñoz');
    const wire = JSON.parse(await readFile(join(result.dir, book.requestFile), 'utf8'));
    const acl = JSON.parse(await readFile(join(result.dir, book.aclRequestFile), 'utf8'));
    assert.deepEqual(wire.CustomerDetails[0].CustomerNames[0], {
      ...acl.CustomerDetails[0].CustomerNames[0],
      FirstName: 'José',
      LastName: 'Muñoz',
    });
    assert.equal(acl.CustomerDetails[0].CustomerNames[0].FirstName, 'Jose');
    // Todo lo demás es lo que armó el ACL: PaymentMode Limit incluido.
    assert.deepEqual({ ...wire, CustomerDetails: acl.CustomerDetails }, acl);
    const received = result.fake.requests.filter((r) => r.url.endsWith('/Book'))[0];
    assert.match(received.body, /"FirstName":"José","LastName":"Muñoz"/);
  });

  it('PR-11 manda dos Book con la misma referencia y BookingCode distintos', async () => {
    const result = await runHarness(['probe', '--bookings', '--only', 'PR-11']);
    const books = result.fake.requests
      .filter((r) => r.url.endsWith('/Book'))
      .map((r) => JSON.parse(r.body));
    assert.equal(books.length, 2);
    assert.equal(books[0].BookingReferenceId, books[1].BookingReferenceId);
    assert.notEqual(books[0].BookingCode, books[1].BookingCode);
  });

  it('con otro TBO la lectura cambia: idempotente, acepta el centavo y altera las tildes', async () => {
    const fake = createFakeTbo({
      sameReference: 'existing',
      fareMismatch: 'accept',
      mangleNames: true,
    });
    const result = await runHarness(ARGS, { fake });
    assert.equal(result.code, 0, result.stderr);
    const byId = await summaryOf(result);
    assert.match(
      byId['PR-09'].reading,
      /"Jos\? Mu\?oz": alterados o ausentes\. Se mantiene la transliteración/,
    );
    assert.match(byId['PR-10'].reading, /TBO acepta un TotalFare 0\.01 por encima del PreBook/);
    // PR-10 también reservó (FK0002): la de PR-11 es la siguiente.
    assert.match(byId['PR-11'].reading, /devuelve la reserva existente \(FK0003\).*\(a\)/);
    assert.ok([...fake.bookings.values()].every((b) => b.status === 'Cancelled'));
  });

  it('si no se puede cancelar, la lectura lo advierte con el localizador', async () => {
    const fake = createFakeTbo({ cancelCode: 479 });
    const result = await runHarness(['probe', '--bookings', '--only', 'PR-09'], { fake });
    const byId = await summaryOf(result);
    assert.match(byId['PR-09'].reading, /OJO: no se pudo confirmar la cancelación de FK0001/);
  });

  it('PR-11 no manda el segundo Book si el primero no confirmó', async () => {
    const fake = createFakeTbo({ bookSequence: [-1] });
    const result = await runHarness(['probe', '--bookings', '--only', 'PR-11'], { fake });
    assert.equal(fake.requests.filter((r) => r.url.endsWith('/Book')).length, 1);
    const byId = await summaryOf(result);
    assert.match(byId['PR-11'].reading, /no se manda el segundo y no contesta Q-35/);
    assert.equal(fake.bookings.size, 0);
  });

  it('sin --bookings, ninguna sonda reserva ni cancela', async () => {
    const result = await runHarness(['probe', '--skip-hotelcodelist'], { withBooking: false });
    assert.equal(result.code, 0, result.stderr);
    const paths = result.fake.requests.map((r) => new URL(r.url).pathname.toLowerCase());
    assert.ok(paths.length > 0);
    assert.ok(!paths.some((p) => p.endsWith('/book') || p.endsWith('/cancel')), paths.join());
    assert.equal(result.fake.bookings.size, 0);
  });
});
