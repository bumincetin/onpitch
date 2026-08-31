/**
 * components/match/error-notice.tsx
 *
 * Turning a failure into something a player can act on.
 *
 * The interesting cases here are not network errors — they are the database's own refusals.
 * `public.validate_score_report()` and the consensus functions in `0005_integrity_consensus.sql`
 * raise PostgREST-style SQLSTATEs (`PT403`, `PT404`, `PT409`, `PT422`, `PT429`) whose messages are
 * written to be read by a player: "A single side cannot score more than 30 goals.", "You have
 * already reported a score for this match." The route handlers map the SQLSTATE to an
 * `ApiResponse` error code and FORWARD THE MESSAGE VERBATIM, which is the entire point of that
 * convention.
 *
 * So this module adds a title and passes the body through. It does not rewrite the server's
 * sentence — a curated message replaced by a generic one here would waste the work the migration
 * did, and would hide the specific number the player needs ("at most 12 goals in total").
 *
 * The one thing it will not do is surface a raw Postgres string. An unmapped code gets a generic
 * message and a console entry, because constraint and column names help nobody holding a phone.
 *
 * That last paragraph is enforced here rather than trusted. Only two error types carry a message
 * written for a player: `ApiError`, whose text came through a route handler that forwarded a
 * curated SQLSTATE message, and `DataError` (lib/data-error.ts), which a direct Supabase read
 * builds explicitly. EVERY OTHER `Error` is logged and rendered as the caller's fallback — a
 * `PostgrestError` rethrown as a plain `Error` would otherwise put "new row violates row-level
 * security policy" on screen, which is both unreadable and more than a stranger should learn.
 */

import * as React from 'react'

import { API_ERROR_CODES } from '@halisaha/shared/domain'

import { Notice, type NoticeTone } from '@/components/ui'
import { ApiError } from '@/lib/api'
import { DataError } from '@/lib/data-error'

export interface PlainError {
  title: string
  body: string
  tone: NoticeTone
}

const GENERIC: PlainError = {
  title: 'İşlem tamamlanamadı',
  body: 'Sunucuya giderken bir şeyler ters gitti. Birazdan tekrar dene.',
  tone: 'destructive',
}

/**
 * A failure as a title and a sentence.
 *
 * @param caught anything a `catch` produced.
 * @param fallback replaces the generic body when the error carries nothing readable.
 */
export function describeError(caught: unknown, fallback?: string): PlainError {
  if (caught instanceof ApiError) {
    return { title: titleForCode(caught.code), body: caught.message, tone: toneForCode(caught.code) }
  }

  if (caught instanceof DataError && caught.message) {
    return { ...GENERIC, body: caught.message }
  }

  if (caught !== null && caught !== undefined) {
    // Kept out of the UI, kept in the device log: this is where a stack trace or a constraint name
    // is actually useful.
    console.warn('[error-notice] unmapped failure', caught)
  }

  return fallback ? { ...GENERIC, body: fallback } : GENERIC
}

/** Just the sentence, for a place with no room for a title. */
export function describeErrorText(caught: unknown, fallback?: string): string {
  return describeError(caught, fallback).body
}

function titleForCode(code: string): string {
  switch (code) {
    case API_ERROR_CODES.REPORT_REJECTED:
      // PT409 and PT422 from the report and consensus triggers both land here: already settled,
      // window closed, implausible scoreline, wrong side.
      return 'That report was refused'
    case API_ERROR_CODES.DIGEST_MISMATCH:
      return 'The result on the table changed'
    case API_ERROR_CODES.RATE_LIMITED:
      return 'Slow down'
    case API_ERROR_CODES.FORBIDDEN:
      return 'Not your match to do that in'
    case API_ERROR_CODES.NOT_FOUND:
      return 'Not there any more'
    case API_ERROR_CODES.CONSENT_REQUIRED:
      return 'Your guardian has to agree first'
    case API_ERROR_CODES.UNAUTHENTICATED:
      return 'Sign in again'
    case API_ERROR_CODES.VALIDATION_FAILED:
      return 'That is not a valid entry'
    default:
      return 'That did not work'
  }
}

function toneForCode(code: string): NoticeTone {
  switch (code) {
    case API_ERROR_CODES.RATE_LIMITED:
    case API_ERROR_CODES.DIGEST_MISMATCH:
    case API_ERROR_CODES.CONSENT_REQUIRED:
      return 'warning'
    default:
      return 'destructive'
  }
}

export interface ErrorNoticeProps {
  /** Null renders nothing, so a caller can drop this straight into a layout. */
  error: unknown
  fallback?: string
}

/** The standard inline failure block. Announces itself when it appears. */
export function ErrorNotice({ error, fallback }: ErrorNoticeProps): React.ReactElement | null {
  if (error === null || error === undefined) return null
  const plain = describeError(error, fallback)
  return <Notice tone={plain.tone} title={plain.title} description={plain.body} live />
}
