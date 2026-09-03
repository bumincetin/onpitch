/**
 * components/admin/audit-trail.tsx
 *
 * `public.audit_log`, rendered.
 *
 * ---------------------------------------------------------------------------
 * WHY `actor_id` IS OFTEN NULL AND WHERE THE OPERATOR REALLY IS
 * ---------------------------------------------------------------------------
 * `public.log_audit` takes the actor from `auth.uid()` and refuses to accept one as an
 * argument, so a caller can never pin an action on somebody else. It is granted to
 * `service_role` only, and the service role carries no JWT — so rows written from a backend
 * route land with `actor_id` NULL and the operator's id in `metadata.actor_id` instead.
 *
 * This component looks in both places and says which one it found, because an accountability
 * trail that renders "system" over a human decision is worse than one that renders nothing.
 *
 * Rows written by a database trigger under a user's own session (`profile.role_changed`,
 * `profile.consent_status_changed`) do have a real `actor_id`. Both kinds are shown together:
 * a role change normally produces one of each, and seeing them adjacent is the point.
 */

import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { formatDateTime } from "@/components/admin/dispute-queue"
import type { AuditEntry } from "@/lib/admin/metrics"
import type { Json } from "@onpitch/shared/database"

export interface AuditTrailProps {
  entries: readonly AuditEntry[]
  /** Heading for the panel. */
  title?: string
  /** Shown when there is nothing to render. */
  emptyMessage?: string
  className?: string
}

export function AuditTrail({ entries, title, emptyMessage, className }: AuditTrailProps) {
  if (entries.length === 0) {
    return (
      <Card className={className}>
        <CardHeader>
          <CardTitle className="text-base">{title ?? "Audit trail"}</CardTitle>
          <CardDescription>{emptyMessage ?? "Nothing recorded yet."}</CardDescription>
        </CardHeader>
      </Card>
    )
  }

  return (
    <section className={cn("space-y-3", className)} aria-label={title ?? "Audit trail"}>
      {title ? <h2 className="text-sm font-semibold text-muted-foreground">{title}</h2> : null}

      <ol className="space-y-2">
        {entries.map((entry) => {
          const metadata = asRecord(entry.metadata)
          const reason = stringField(metadata, "reason")
          const metadataActor = stringField(metadata, "actor_id")
          const actor = entry.actorId ?? metadataActor
          const attribution = entry.actorId
            ? "signed-in actor"
            : metadataActor
              ? "operator, from metadata"
              : "no actor recorded"

          return (
            <li
              key={entry.id}
              className="rounded-lg border border-border bg-card p-3 text-card-foreground"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-mono text-xs font-semibold">{entry.action}</span>
                <time dateTime={entry.createdAt} className="text-xs text-muted-foreground">
                  {formatDateTime(entry.createdAt)}
                </time>
              </div>

              <p className="mt-1 text-xs text-muted-foreground">
                {actor ? (
                  <>
                    <span className="font-mono">{actor.slice(0, 8)}</span> · {attribution}
                  </>
                ) : (
                  attribution
                )}
                {entry.entityType ? (
                  <>
                    {" · "}
                    {entry.entityType}
                    {entry.entityId ? ` ${entry.entityId.slice(0, 8)}` : ""}
                  </>
                ) : null}
              </p>

              {reason ? <p className="mt-2 text-sm">{reason}</p> : null}

              <MetadataPairs metadata={metadata} skip={["reason", "actor_id", "recorded_by"]} />
            </li>
          )
        })}
      </ol>
    </section>
  )
}

/** The metadata that is not the reason, as badges. Nested objects are summarised, not dumped. */
function MetadataPairs({
  metadata,
  skip,
}: {
  metadata: Record<string, Json> | null
  skip: readonly string[]
}) {
  if (!metadata) return null

  const pairs = Object.entries(metadata).filter(([key]) => !skip.includes(key))
  if (pairs.length === 0) return null

  return (
    <ul className="mt-2 flex flex-wrap gap-1">
      {pairs.map(([key, value]) => (
        <li key={key}>
          <Badge variant="outline" className="font-mono text-[11px]">
            {key}: {renderScalar(value)}
          </Badge>
        </li>
      ))}
    </ul>
  )
}

function renderScalar(value: Json): string {
  if (value === null) return "null"
  if (typeof value === "string") return value.length > 40 ? `${value.slice(0, 40)}…` : value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (Array.isArray(value)) return `[${value.length}]`
  return "{…}"
}

function asRecord(value: Json): Record<string, Json> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null
  const record: Record<string, Json> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) record[key] = entry
  }
  return record
}

function stringField(record: Record<string, Json> | null, key: string): string | null {
  if (!record) return null
  const value = record[key]
  return typeof value === "string" && value.length > 0 ? value : null
}
