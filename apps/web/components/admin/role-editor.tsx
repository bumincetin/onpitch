"use client"

/**
 * components/admin/role-editor.tsx
 *
 * Role management. One dialog, one reason, one POST to `/api/admin/users/[id]/role`.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS COMPONENT DOES NOT DO
 * ---------------------------------------------------------------------------
 * It does not write to `profiles`. It cannot: `0002_rls.sql` §4.1 leaves `role` out of the
 * column-level UPDATE grant, so a browser client PATCHing the column gets 42501 no matter who
 * is signed in. The route handler holds the service-role key and re-states every guard.
 *
 * The client-side checks below — no self-demotion when you are the only admin, a reason of at
 * least ten characters — exist so the operator gets an answer before a round trip. They are
 * duplicated server-side, and the server's copy is the one that counts.
 *
 * ---------------------------------------------------------------------------
 * THE RE-AUTHENTICATION NOTICE
 * ---------------------------------------------------------------------------
 * `user_role` is stamped into the JWT by `custom_access_token_hook` when a token is issued, and
 * RLS reads that claim before it reads the table. A live session therefore keeps its old role
 * until the token refreshes. The dialog says so before the change is made, not after, because
 * "I promoted them and it did not work" is the support ticket this sentence prevents.
 */

import { useCallback, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { z } from "zod"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import { toast } from "@/lib/use-toast"
import { Constants, type Enums } from "@onpitch/shared/database"

/**
 * The role union comes from the generated schema constants, not from `@/lib/rbac`. That module
 * pulls in `next/headers` and the server Supabase client, and importing it from a Client
 * Component is a build error rather than a runtime surprise. `Constants` is a plain frozen
 * array, safe on either side of the boundary, and it is generated from the `app_role` enum so
 * the two cannot drift.
 */
export type AdminRole = Enums<"app_role">

const APP_ROLES: readonly AdminRole[] = Constants.public.Enums.app_role

export interface AdminUserRow {
  id: string
  role: AdminRole
  displayName: string | null
  fullName: string | null
  city: string | null
  createdAt: string
}

export interface RoleEditorProps {
  users: readonly AdminUserRow[]
  /** The signed-in operator, so the table can mark their own row and guard self-demotion. */
  currentUserId: string
  /** Live admins on the platform. Drives the last-admin warning before the round trip. */
  adminCount: number
}

const MIN_REASON_LENGTH = 10

/** The route's success payload, re-declared here because a fetch response is untrusted input. */
const roleChangeResultSchema = z.object({
  ok: z.literal(true),
  data: z.object({
    userId: z.string(),
    previousRole: z.string(),
    role: z.string(),
    auditRecorded: z.boolean(),
    reauthRequired: z.boolean(),
    message: z.string(),
  }),
})

const apiErrorSchema = z.object({
  ok: z.literal(false),
  error: z.object({ code: z.string(), message: z.string() }),
})

export function RoleEditor({ users, currentUserId, adminCount }: RoleEditorProps) {
  const router = useRouter()
  const [editing, setEditing] = useState<AdminUserRow | null>(null)
  const [nextRole, setNextRole] = useState<AdminRole>("player")
  const [reason, setReason] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const openEditor = useCallback((user: AdminUserRow) => {
    setEditing(user)
    setNextRole(user.role)
    setReason("")
    setFormError(null)
  }, [])

  const closeEditor = useCallback(() => {
    if (submitting) return
    setEditing(null)
    setFormError(null)
  }, [submitting])

  const blockedReason = useMemo(() => {
    if (!editing) return null
    if (nextRole === editing.role) return "Pick a different role."
    if (editing.role === "admin" && nextRole !== "admin" && adminCount <= 1) {
      return editing.id === currentUserId
        ? "You are the only administrator. Promote a replacement before stepping down."
        : "That is the last administrator. Promote a replacement first."
    }
    return null
  }, [editing, nextRole, adminCount, currentUserId])

  const submit = useCallback(async () => {
    if (!editing || blockedReason) return

    const trimmed = reason.trim()
    if (trimmed.length < MIN_REASON_LENGTH) {
      setFormError(`The reason needs at least ${MIN_REASON_LENGTH} characters. It is kept forever.`)
      return
    }

    setSubmitting(true)
    setFormError(null)

    try {
      const response = await fetch(`/api/admin/users/${editing.id}/role`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: nextRole, reason: trimmed }),
      })

      const payload: unknown = await response.json().catch(() => null)

      const success = roleChangeResultSchema.safeParse(payload)
      if (success.success) {
        toast({
          variant: success.data.data.auditRecorded ? "success" : "warning",
          title: `Role changed to ${success.data.data.role.replace("_", " ")}`,
          description: success.data.data.auditRecorded
            ? success.data.data.message
            : `${success.data.data.message} The operator audit entry could not be written — tell an engineer.`,
        })
        setEditing(null)
        router.refresh()
        return
      }

      const failure = apiErrorSchema.safeParse(payload)
      setFormError(
        failure.success
          ? failure.data.error.message
          : "Sunucu bu sayfanın okuyamadığı bir yanıt gönderdi. Hiçbir şey değişmedi.",
      )
    } catch {
      setFormError("The request did not reach the server. Check your connection and try again.")
    } finally {
      setSubmitting(false)
    }
  }, [editing, blockedReason, reason, nextRole, router])

  if (users.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Eşleşen hesap yok</CardTitle>
          <CardDescription>Filtreleri temizle ya da başka bir adla ara.</CardDescription>
        </CardHeader>
      </Card>
    )
  }

  return (
    <>
      <div className="rounded-lg border border-border">
        <Table>
          <caption className="sr-only">Hesaplar ve platform rolleri</caption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Hesap</TableHead>
              <TableHead scope="col">Rol</TableHead>
              <TableHead scope="col">Katıldı</TableHead>
              <TableHead scope="col">
                <span className="sr-only">Rolü değiştir</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.map((user) => {
              const label = user.displayName ?? user.fullName ?? "Unnamed account"
              const isSelf = user.id === currentUserId
              return (
                <TableRow key={user.id}>
                  <TableCell>
                    <div className="font-medium">
                      {label}
                      {isSelf ? (
                        <Badge variant="outline" className="ml-2">
                          sen
                        </Badge>
                      ) : null}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {user.city ?? "no city"} · {user.id.slice(0, 8)}
                    </div>
                  </TableCell>
                  <TableCell>
                    <RoleBadge role={user.role} />
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {/*
                      The ISO date, not a locale format. This subtree is rendered on the server
                      and hydrated in the browser, and `Intl.DateTimeFormat` resolves the zone
                      from the host — a server in UTC and a client in Europe/Istanbul disagree
                      about which day a late-evening signup landed on, which is a hydration
                      mismatch. The first ten characters of a timestamptz are the same string
                      everywhere.
                    */}
                    <time dateTime={user.createdAt}>{user.createdAt.slice(0, 10)}</time>
                  </TableCell>
                  <TableCell className="text-right">
                    <Button variant="outline" size="sm" onClick={() => openEditor(user)}>
                      Rolü değiştir
                      <span className="sr-only"> for {label}</span>
                    </Button>
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>

      <Dialog open={editing !== null} onOpenChange={(open) => (open ? undefined : closeEditor())}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Change role for {editing?.displayName ?? editing?.fullName ?? "this account"}
            </DialogTitle>
            <DialogDescription>
              Yeni rol, kişi bir sonraki girişinde ya da jetonu yenilendiğinde JWT&apos;sine ulaşır. O zamana kadar hem ara katman hem RLS eskisini görür; bu yüzden düşürme tek başına açık bir oturumu sonlandırmaz.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="role-select">Yeni rol</Label>
              <Select value={nextRole} onValueChange={(value) => setNextRole(asAdminRole(value))}>
                <SelectTrigger id="role-select">
                  <SelectValue placeholder="Bir rol seç" />
                </SelectTrigger>
                <SelectContent>
                  {APP_ROLES.map((role) => (
                    <SelectItem key={role} value={role}>
                      {role.replace("_", " ")}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="role-reason">Gerekçe</Label>
              <Textarea
                id="role-reason"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                rows={3}
                placeholder="Bu hesabın rolü neden değişiyor. Denetim kaydında saklanır."
                aria-describedby="role-reason-help"
              />
              <p id="role-reason-help" className="text-xs text-muted-foreground">
                At least {MIN_REASON_LENGTH} characters. Recorded against your account in the
                audit log and never deleted.
              </p>
            </div>

            {nextRole === "admin" && editing?.role !== "admin" ? (
              <Alert variant="destructive">
                <AlertTitle>Bu, platformun tamamına erişim verir</AlertTitle>
                <AlertDescription>
                  Bir yönetici, RLS üzerinden her tablodaki her satırı okur ve yazar, itirazları karara bağlar ve seninki dâhil rolleri değiştirebilir.
                </AlertDescription>
              </Alert>
            ) : null}

            {blockedReason ? (
              <Alert>
                <AlertTitle>Bu değişiklik uygulanamıyor</AlertTitle>
                <AlertDescription>{blockedReason}</AlertDescription>
              </Alert>
            ) : null}

            {formError ? (
              <Alert variant="destructive" role="alert">
                <AlertTitle>İşlem tamamlanmadı</AlertTitle>
                <AlertDescription>{formError}</AlertDescription>
              </Alert>
            ) : null}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={closeEditor} disabled={submitting}>
              Vazgeç
            </Button>
            <Button onClick={() => void submit()} disabled={submitting || blockedReason !== null}>
              {submitting ? "Applying…" : "Change role"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

/** Radix hands back a bare string; narrow it against the enum rather than asserting. */
function asAdminRole(value: string): AdminRole {
  return APP_ROLES.find((role) => role === value) ?? "player"
}

export function RoleBadge({ role }: { role: AdminRole }) {
  switch (role) {
    case "admin":
      return <Badge variant="destructive">yönetici</Badge>
    case "venue_owner":
      return <Badge variant="secondary">işletme sahibi</Badge>
    default:
      return <Badge variant="outline">oyuncu</Badge>
  }
}
