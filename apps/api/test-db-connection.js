import pg from 'pg';

async function test(connStr) {
  console.log(`Testing ${connStr}...`);
  const client = new pg.Client({ connectionString: connStr });
  try {
    await client.connect();
    console.log(`SUCCESS connected to ${connStr}!`);
    const res = await client.query('SELECT current_database(), current_user');
    console.log('Result:', res.rows[0]);
    await client.end();
    return true;
  } catch (err) {
    console.error(`FAILED:`, err);
    return false;
  }
}

async function main() {
  const connectionStrings = [
    'postgresql://postgres:postgres@localhost:5432/sales_travel',
    'postgresql://postgres:postgres@127.0.0.1:5432/sales_travel',
    'postgresql://postgres:postgres@localhost:5432/postgres',
    'postgresql://postgres:postgres@127.0.0.1:5432/postgres',
    'postgresql://app_user:pass@localhost:5432/sales_travel',
    'postgresql://app_user:pass@127.0.0.1:5432/sales_travel',
    // Let's also check if it's running on port 5433 (sometimes PostgreSQL uses 5433 on Windows if 5432 was occupied)
    'postgresql://postgres:postgres@localhost:5433/sales_travel',
    'postgresql://postgres:postgres@127.0.0.1:5433/sales_travel',
    'postgresql://postgres:postgres@localhost:5433/postgres',
    'postgresql://postgres:postgres@127.0.0.1:5433/postgres',
  ];

  for (const conn of connectionStrings) {
    const ok = await test(conn);
    if (ok) {
      console.log('Found working connection string:', conn);
      break;
    }
  }
}

main().catch(console.error);
