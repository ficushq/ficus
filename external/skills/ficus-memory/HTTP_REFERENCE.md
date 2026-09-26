# Tau Memory HTTP Reference

Use HTTP only when the Tau CLI is unavailable. Replace `<base-url>` and `<squad-id>` explicitly. URL-encode query parameters such as paths.

All examples assume:

```bash
-H "Authorization: Bearer $FICUS_PASSWORD"
```

Never print, commit, or write `FICUS_PASSWORD` into memory.

## Read

```bash
curl -sS "$FICUS_API_URL/api/memory/<squad-id>/file?path=%2Fmemory%2Fcontext.md" \
  -H "Authorization: Bearer $FICUS_PASSWORD"
```

## Search

```bash
curl -sS "$FICUS_API_URL/api/memory/<squad-id>/search?query=authentication%20flow&limit=5&mode=hybrid" \
  -H "Authorization: Bearer $FICUS_PASSWORD"
```

Optional comma-separated filters: `sourceTypes`, `kinds`, `tags`, and `paths`.

## Write or Delete

```bash
curl -sS -X POST "$FICUS_API_URL/api/memory/<squad-id>/write" \
  -H "Authorization: Bearer $FICUS_PASSWORD" \
  -H "Content-Type: application/json" \
  -d '{"path":"/memory/patterns/api-errors.md","content":"# API Errors\n\nDurable guidance."}'
```

Delete by sending `content: null`:

```bash
curl -sS -X POST "$FICUS_API_URL/api/memory/<squad-id>/write" \
  -H "Authorization: Bearer $FICUS_PASSWORD" \
  -H "Content-Type: application/json" \
  -d '{"path":"/memory/obsolete.md","content":null}'
```

## Patch

```bash
curl -sS -X POST "$FICUS_API_URL/api/memory/<squad-id>/patch" \
  -H "Authorization: Bearer $FICUS_PASSWORD" \
  -H "Content-Type: application/json" \
  -d '{"path":"/memory/patterns/api-errors.md","match":"old exact text","replacement":"new text"}'
```

## Append

```bash
curl -sS -X POST "$FICUS_API_URL/api/memory/<squad-id>/append" \
  -H "Authorization: Bearer $FICUS_PASSWORD" \
  -H "Content-Type: application/json" \
  -d '{"path":"/memory/runbooks/deploy.md","content":"\n## Rollback\nDurable guidance.","ensureNewline":true}'
```

## Backlinks

```bash
curl -sS "$FICUS_API_URL/api/memory/<squad-id>/backlinks?path=%2Fmemory%2Fpatterns%2Fapi-errors.md" \
  -H "Authorization: Bearer $FICUS_PASSWORD"
```
