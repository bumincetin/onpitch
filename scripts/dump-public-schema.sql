-- Every base table in `public` with its columns and nullability, as one JSON document.
-- Views are excluded: `database.ts` declares them in a separate `Views` block whose Row types
-- are hand-narrowed, and a view column's nullability in information_schema is unreliable.
select jsonb_pretty(
  coalesce(
    jsonb_agg(
      jsonb_build_object('table', t.table_name, 'columns', t.columns)
      order by t.table_name
    ),
    '[]'::jsonb
  )
)
from (
  select
    c.relname as table_name,
    jsonb_agg(
      jsonb_build_object('name', a.attname, 'nullable', not a.attnotnull)
      order by a.attnum
    ) as columns
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  join pg_attribute a on a.attrelid = c.oid
  where n.nspname = 'public'
    and c.relkind = 'r'
    and a.attnum > 0
    and not a.attisdropped
  group by c.relname
) t;
