import { expect, test } from 'bun:test'
import { eq, sql } from 'drizzle-orm'
import { alias, pgTable, text } from 'drizzle-orm/pg-core'
import { drizzle } from 'drizzle-orm/postgres-js'

const db = drizzle.mock()

test('PostgreSQL identifier delimiters are doubled, not executable SQL', () => {
  const name = 'name"; DROP TABLE users; --'
  const query = db
    .select({ value: sql`${sql.identifier(name)}` })
    .from(pgTable('source', { value: text('value') }))
    .toSQL()
  expect(query.sql).toBe('select "name""; DROP TABLE users; --" from "source"')
  expect(query.params).toEqual([])
})

test('table and projection aliases escape delimiters while ordinary values stay bound', () => {
  const table = alias(pgTable('source', { value: text('value') }), 'alias"; --')
  const value = "ordinary' ; DROP TABLE users; --"
  const query = db
    .select({ value: sql`${table.value}`.as('projection"; --') })
    .from(table)
    .where(eq(table.value, value))
    .toSQL()
  expect(query.sql).toBe(
    'select "value" as "projection""; --" from "source" "alias""; --" where "alias""; --"."value" = $1'
  )
  expect(query.params).toEqual([value])
  expect(query.sql).not.toContain(value)
})
