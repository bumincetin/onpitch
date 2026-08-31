/**
 * scripts/check-schema-drift.mjs
 *
 *   node scripts/check-schema-drift.mjs <live-schema.json>
 *
 * Compares the hand-written `packages/shared/src/database.ts` against the schema the migrations
 * actually produce, and exits non-zero on any disagreement.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * `database.ts` is not generated. `npm run db:types` exists, but the checked-in file has been
 * maintained by hand because the generated output drops every doc comment — and those comments
 * are carrying real information ("GENERATED: won * 3 + drawn", "citext", "IANA zone used to
 * render slot grids"). Regenerating would throw all of that away.
 *
 * The cost of hand-maintaining it is that nothing enforces the correspondence. A migration adds
 * a column, `database.ts` does not, and `tsc` is perfectly happy — the type is simply wrong, and
 * the first symptom is a runtime `undefined` in a Server Component months later. Worse in the
 * other direction: a column typed `string` here that is actually nullable makes every consumer
 * skip a null check the compiler has told them they do not need.
 *
 * That exact class of bug is why this file was written: a test caught `notifications.title`
 * being handled as nullable in one place and typed non-nullable in another. The type was right
 * and the test was wrong that time, but nothing would have said so if it had been the reverse.
 *
 * The comparison is deliberately limited to what is worth pinning:
 *
 *   • the SET of tables in `public`
 *   • the SET of columns per table
 *   • the NULLABILITY of each column
 *
 * Not the SQL types. Mapping `int8` to `number`, `timestamptz` to `string`, a domain to its base
 * type and an array to `T[]` requires re-implementing a large part of what supabase-gen does,
 * and a wrong mapping there would produce false failures that people learn to ignore — which is
 * worse than not checking. Names and nullability are unambiguous, and they are where the real
 * mistakes happen.
 *
 * The live side comes from `information_schema` in CI, after the migrations job has replayed all
 * of them into a stock Postgres. See `.github/workflows/ci.yml`.
 */

import { readFileSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const TYPES_FILE = resolve(HERE, "..", "packages", "shared", "src", "database.ts")

/* ========================================================================== */
/*  Declared side — parse the Row blocks out of database.ts                   */
/* ========================================================================== */

/**
 * A hand-rolled line scanner rather than the TypeScript compiler API: the file has one exact,
 * stable shape (six spaces, table name, `: {`, then eight spaces and `Row: {`), and adding
 * `typescript` as a dependency of a CI check to read six indentation levels is not a trade worth
 * making. If the file's formatting ever changes, this fails loudly with "no tables found"
 * rather than silently passing.
 */
function parseDeclaredTables(source) {
  const lines = source.split(/\r?\n/)

  const tablesStart = lines.findIndex((line) => line === "    Tables: {")
  const viewsStart = lines.findIndex((line) => line === "    Views: {")
  if (tablesStart === -1 || viewsStart === -1 || viewsStart < tablesStart) {
    throw new Error("could not locate the Tables block in database.ts")
  }

  const tables = new Map()
  let table = null
  let inRow = false

  for (let i = tablesStart + 1; i < viewsStart; i += 1) {
    const line = lines[i]

    const tableMatch = /^ {6}([a-z_][a-z0-9_]*): \{$/.exec(line)
    if (tableMatch) {
      table = tableMatch[1]
      tables.set(table, new Map())
      inRow = false
      continue
    }

    if (line === "        Row: {") {
      inRow = true
      continue
    }
    // The Row block ends at its closing brace; Insert and Update follow and are ignored, since
    // they are derived from the same columns and would triple every diff.
    if (inRow && line === "        }") {
      inRow = false
      continue
    }
    if (!inRow || table === null) continue

    // Skip the doc comments that are the whole reason this file is hand-written.
    const trimmed = line.trim()
    if (trimmed === "" || trimmed.startsWith("/*") || trimmed.startsWith("*") || trimmed.startsWith("//")) {
      continue
    }

    const columnMatch = /^ {10}([a-z_][a-z0-9_]*): (.+)$/.exec(line)
    if (!columnMatch) continue

    const [, name, type] = columnMatch
    tables.get(table).set(name, { nullable: / \| null$/.test(type.trim()), type: type.trim() })
  }

  if (tables.size === 0) throw new Error("no tables found in database.ts — has its shape changed?")
  return tables
}

/* ========================================================================== */
/*  Live side                                                                 */
/* ========================================================================== */

/**
 * Expects the JSON produced by the query in the CI step:
 *   [{ "table": "venues", "columns": [{ "name": "id", "nullable": false }, ...] }, ...]
 */
function parseLiveTables(json) {
  const tables = new Map()
  // A UTF-8 BOM, which any redirect through PowerShell adds, is not valid JSON to `JSON.parse`.
  for (const entry of JSON.parse(json.replace(/^﻿/, ""))) {
    tables.set(entry.table, new Map(entry.columns.map((c) => [c.name, { nullable: c.nullable }])))
  }
  if (tables.size === 0) throw new Error("the live schema dump is empty")
  return tables
}

/* ========================================================================== */
/*  Compare                                                                   */
/* ========================================================================== */

function compare(declared, live) {
  const problems = []

  for (const table of live.keys()) {
    if (!declared.has(table)) {
      problems.push(`table \`${table}\` exists in the database but is missing from database.ts`)
    }
  }
  for (const table of declared.keys()) {
    if (!live.has(table)) {
      problems.push(`table \`${table}\` is declared in database.ts but does not exist`)
    }
  }

  for (const [table, liveColumns] of live) {
    const declaredColumns = declared.get(table)
    if (!declaredColumns) continue

    for (const [column, { nullable }] of liveColumns) {
      const declaredColumn = declaredColumns.get(column)
      if (!declaredColumn) {
        problems.push(`${table}.${column} exists in the database but is missing from database.ts`)
        continue
      }
      if (declaredColumn.nullable !== nullable) {
        problems.push(
          `${table}.${column} is ${nullable ? "NULLABLE" : "NOT NULL"} in the database but ` +
            `declared as \`${declaredColumn.type}\` in database.ts`,
        )
      }
    }

    for (const column of declaredColumns.keys()) {
      if (!liveColumns.has(column)) {
        problems.push(`${table}.${column} is declared in database.ts but does not exist`)
      }
    }
  }

  return problems
}

/* ========================================================================== */
/*  Entry point                                                               */
/* ========================================================================== */

const dumpPath = process.argv[2]
if (!dumpPath) {
  console.error("usage: node scripts/check-schema-drift.mjs <live-schema.json>")
  process.exit(2)
}

const declared = parseDeclaredTables(readFileSync(TYPES_FILE, "utf8"))
const live = parseLiveTables(readFileSync(dumpPath, "utf8"))
const problems = compare(declared, live)

console.log(
  `database.ts declares ${declared.size} tables; the database has ${live.size}.`,
)

if (problems.length === 0) {
  console.log("No drift.")
  process.exit(0)
}

console.error(`\n${problems.length} schema drift problem${problems.length === 1 ? "" : "s"}:\n`)
for (const problem of problems.sort()) console.error(`  • ${problem}`)
console.error(
  "\nFix database.ts by hand — it is maintained by hand on purpose, because `npm run db:types`\n" +
    "discards every doc comment in it. Add the column with its comment, or correct the\n" +
    "nullability, rather than regenerating the file.",
)
process.exit(1)
