import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { DatabaseService } from '../database/database.service.js';

export interface AirportView {
  code: string;
  name: string;
  city: string;
  countryCode: string | null;
  countryName: string;
}

@Injectable()
export class AirportsService {
  constructor(private readonly db: DatabaseService) {}

  async search(query: string, limit: number): Promise<AirportView[]> {
    const q = query.trim();
    const cap = Math.min(Math.max(limit, 1), 25);

    if (q.length === 0) {
      // Sin query: lista de "destacados" — orden alfabético por código por
      // ahora. Más adelante: ranking por uso real.
      const rows = await this.db.db
        .selectFrom('airports')
        .select(['code', 'name', 'city', 'country_code', 'country_name'])
        .where('country_code', 'in', [
          'CO',
          'BR',
          'PE',
          'CL',
          'AR',
          'MX',
          'EC',
          'UY',
          'PA',
          'CR',
          'DO',
          'US',
        ])
        .orderBy('city')
        .limit(cap)
        .execute();
      return rows.map(rowToView);
    }

    const upper = q.toUpperCase();

    // 1. Match exacto por código IATA (caso típico: "BOG", "GRU").
    if (/^[A-Z]{3}$/.test(upper)) {
      const exact = await this.db.db
        .selectFrom('airports')
        .select(['code', 'name', 'city', 'country_code', 'country_name'])
        .where('code', '=', upper)
        .executeTakeFirst();
      if (exact) return [rowToView(exact)];
    }

    // 2. Match por prefijo de código (ej. "BO" → BOG, BOM, BOS).
    const codePrefix = await this.db.db
      .selectFrom('airports')
      .select(['code', 'name', 'city', 'country_code', 'country_name'])
      .where('code', 'like', `${upper}%`)
      .orderBy('code')
      .limit(cap)
      .execute();

    if (codePrefix.length >= cap) {
      return codePrefix.map(rowToView);
    }

    // 3. Búsqueda fuzzy por city/name usando trigram + unaccent (case-insensitive,
    // tolerante a acentos). Ordenamos por similitud descendente.
    const remaining = cap - codePrefix.length;
    const fuzzyResult = await sql<{
      code: string;
      name: string;
      city: string;
      country_code: string | null;
      country_name: string;
    }>`
      SELECT code, name, city, country_code, country_name
      FROM airports
      WHERE
        unaccent(lower(city)) LIKE '%' || unaccent(lower(${q})) || '%'
        OR unaccent(lower(name)) LIKE '%' || unaccent(lower(${q})) || '%'
        OR unaccent(lower(country_name)) LIKE '%' || unaccent(lower(${q})) || '%'
      ORDER BY
        CASE
          WHEN unaccent(lower(city)) = unaccent(lower(${q})) THEN 0
          WHEN unaccent(lower(city)) LIKE unaccent(lower(${q})) || '%' THEN 1
          WHEN unaccent(lower(name)) LIKE unaccent(lower(${q})) || '%' THEN 2
          ELSE 3
        END,
        city
      LIMIT ${remaining}
    `.execute(this.db.db);

    const seen = new Set(codePrefix.map((r) => r.code));
    const merged = [...codePrefix, ...fuzzyResult.rows.filter((r) => !seen.has(r.code))];

    return merged.slice(0, cap).map(rowToView);
  }
}

function rowToView(row: {
  code: string;
  name: string;
  city: string;
  country_code: string | null;
  country_name: string;
}): AirportView {
  return {
    code: row.code,
    name: row.name,
    city: row.city,
    countryCode: row.country_code,
    countryName: row.country_name,
  };
}
