import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..', '..');
const collectionPath = resolve(
  root,
  'sabre',
  'Booking Management API v2026.04.postman_collection.json',
);
const environmentPath = resolve(root, 'sabre', 'BM API TEST CERT - EPR.postman_environment.json');

const collectionRaw = await readFile(collectionPath, 'utf8');
const collection = JSON.parse(collectionRaw);
const environment = JSON.parse(await readFile(environmentPath, 'utf8'));

const requests = [];

function walk(items, parent = '') {
  for (const item of items ?? []) {
    const path = parent ? `${parent} / ${item.name}` : item.name;
    if (item.request) {
      requests.push({
        path,
        url: String(item.request.url?.raw ?? ''),
        body: String(item.request.body?.raw ?? ''),
        responseCount: Array.isArray(item.response) ? item.response.length : 0,
      });
    }
    walk(item.item, path);
  }
}

walk(collection.item);

const matching = (pattern) => requests.filter((request) => pattern.test(request.url));
const containing = (items, pattern) => items.filter((request) => pattern.test(request.body));
const soap = matching(/\{\{(?:soap|lls)_endpoint\}\}/i);
const createBooking = matching(/createBooking/i);
const fulfill = matching(/fulfillFlightTickets/i);
const shop = matching(/\/offers\/shop/i);
const envValues = Array.isArray(environment.values) ? environment.values : [];
const isTemplate = (value) => /^\{\{[^{}]+\}\}$/.test(String(value ?? '').trim());
const sensitiveEnvironmentKey = /^(?:epr|username|password|secret|auth_secret|token|encrypted_token|pcc)$/i;
const embeddedEnvironmentCredentials = envValues.filter(
  (entry) =>
    sensitiveEnvironmentKey.test(String(entry.key ?? '')) &&
    String(entry.value ?? '').trim() &&
    !isTemplate(entry.value),
);
const hardcodedSoapSecrets = [...collectionRaw.matchAll(/<ClientSecret[^>]*>([^<]+)<\/ClientSecret>/gi)]
  .map((match) => match[1].trim())
  .filter((value) => value && !isTemplate(value));

const result = {
  collectionSha256: createHash('sha256').update(collectionRaw).digest('hex'),
  requests: {
    total: requests.length,
    soap: soap.length,
    rest: requests.length - soap.length,
    savedResponses: requests.reduce((sum, request) => sum + request.responseCount, 0),
  },
  createBooking: {
    total: createBooking.length,
    withCardNumber: containing(createBooking, /cardNumber/i).length,
    withCardSecurityCode: containing(createBooking, /cardSecurityCode/i).length,
  },
  fulfillFlightTickets: {
    total: fulfill.length,
    withCardNumber: containing(fulfill, /cardNumber/i).length,
    withCardSecurityCode: containing(fulfill, /cardSecurityCode/i).length,
  },
  shop: {
    total: shop.length,
    withMultipleSourcePerItinerary: containing(shop, /MultipleSourcePerItinerary/i).length,
    withCurrencyCode: containing(shop, /"CurrencyCode"/i).length,
  },
  environment: {
    variables: envValues.length,
    nonEmptyVariables: envValues.filter((entry) => String(entry.value ?? '').trim()).length,
    eprDefined: envValues.some((entry) => entry.key === 'epr'),
    operationalCredentialsEmbedded: embeddedEnvironmentCredentials.length > 0,
  },
  secretHygiene: {
    hardcodedSoapClientSecrets: hardcodedSoapSecrets.length,
    safeToVersion: embeddedEnvironmentCredentials.length === 0 && hardcodedSoapSecrets.length === 0,
  },
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
