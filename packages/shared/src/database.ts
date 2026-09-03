/**
 * packages/shared/src/database.ts
 *
 * Hand-authored mirror of `supabase/migrations/0001_schema.sql`, shaped exactly like the
 * output of `npx supabase gen types typescript --local`. Once the Supabase CLI is available
 * this file should be REGENERATED rather than hand-edited:
 *
 *   npx supabase gen types typescript --local > packages/shared/src/database.ts
 *
 * Conventions mirrored from the schema contract:
 *   - money is an integer count of MINOR units (kurus/cents); columns end in `_minor`
 *   - every timestamp is `timestamptz`, surfaced as an ISO-8601 string
 *   - `tstzrange` is surfaced as its Postgres text form, e.g. ["2026-01-01 18:00+00","2026-01-01 19:00+00")
 *   - `bytea` is surfaced as its PostgREST hex text form
 *   - `citext` / `date` / `time` are plain strings
 *   - `numeric` and `double precision` are `number` (PostgREST delivers numeric as a JS number;
 *     every numeric column here is small and lossless in float64)
 *
 * GENERATED COLUMNS ARE DELIBERATELY OMITTED FROM `Insert` AND `Update`.
 * `profiles.is_minor`, `player_ratings.conservative_rating`, `player_stats.rating_delta`,
 * `player_progress.level`, `league_entries.points` and `league_entries.goal_difference` are
 * `GENERATED ALWAYS AS (...) STORED`, and `audit_log.id` is `GENERATED ALWAYS AS IDENTITY`.
 * Postgres rejects any statement that names them, so they appear on `Row` only — listing them
 * as optional would let TypeScript bless a write the database is guaranteed to refuse.
 *
 * AND THEY ARE ALL NULLABLE ON `Row`, including the ones whose expression cannot produce a null.
 * Postgres does not infer `NOT NULL` for a generated column: `points integer generated always as
 * (won * 3 + drawn) stored` over two `NOT NULL` columns is still reported as nullable, and
 * PostgREST reports what the catalogue says. Declaring it `number` here would be a type this
 * file asserts and the database does not — exactly the disagreement
 * `scripts/check-schema-drift.mjs` runs in CI to catch, and it caught these three.
 */

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  public: {
    Tables: {
      audit_log: {
        Row: {
          /** GENERATED ALWAYS AS IDENTITY — never writable. */
          id: number
          actor_id: string | null
          action: string
          entity_type: string | null
          entity_id: string | null
          metadata: Json
          ip_hash: string | null
          created_at: string
        }
        Insert: {
          // `id` omitted: GENERATED ALWAYS AS IDENTITY.
          actor_id?: string | null
          action: string
          entity_type?: string | null
          entity_id?: string | null
          metadata?: Json
          ip_hash?: string | null
          created_at?: string
        }
        Update: {
          // `id` omitted: GENERATED ALWAYS AS IDENTITY.
          actor_id?: string | null
          action?: string
          entity_type?: string | null
          entity_id?: string | null
          metadata?: Json
          ip_hash?: string | null
          created_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "audit_log_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      bookings: {
        Row: {
          id: string
          pitch_id: string
          booked_by: string
          team_id: string | null
          /** Half-open tstzrange [start,end). */
          time_range: string
          status: Database["public"]["Enums"]["booking_status"]
          payment_status: Database["public"]["Enums"]["payment_status"]
          subtotal_minor: number
          platform_fee_minor: number
          total_minor: number
          currency: string
          stripe_payment_intent_id: string | null
          stripe_checkout_session_id: string | null
          stripe_charge_id: string | null
          stripe_transfer_id: string | null
          connected_account_id: string | null
          application_fee_id: string | null
          notes: string | null
          cancelled_at: string | null
          cancellation_reason: string | null
          refunded_amount_minor: number
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          pitch_id: string
          booked_by: string
          team_id?: string | null
          time_range: string
          status?: Database["public"]["Enums"]["booking_status"]
          payment_status?: Database["public"]["Enums"]["payment_status"]
          subtotal_minor: number
          platform_fee_minor?: number
          total_minor: number
          currency?: string
          stripe_payment_intent_id?: string | null
          stripe_checkout_session_id?: string | null
          stripe_charge_id?: string | null
          stripe_transfer_id?: string | null
          connected_account_id?: string | null
          application_fee_id?: string | null
          notes?: string | null
          cancelled_at?: string | null
          cancellation_reason?: string | null
          refunded_amount_minor?: number
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          pitch_id?: string
          booked_by?: string
          team_id?: string | null
          time_range?: string
          status?: Database["public"]["Enums"]["booking_status"]
          payment_status?: Database["public"]["Enums"]["payment_status"]
          subtotal_minor?: number
          platform_fee_minor?: number
          total_minor?: number
          currency?: string
          stripe_payment_intent_id?: string | null
          stripe_checkout_session_id?: string | null
          stripe_charge_id?: string | null
          stripe_transfer_id?: string | null
          connected_account_id?: string | null
          application_fee_id?: string | null
          notes?: string | null
          cancelled_at?: string | null
          cancellation_reason?: string | null
          refunded_amount_minor?: number
          created_at?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "bookings_pitch_id_fkey"
            columns: ["pitch_id"]
            isOneToOne: false
            referencedRelation: "pitches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bookings_booked_by_fkey"
            columns: ["booked_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bookings_team_id_fkey"
            columns: ["team_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["id"]
          },
        ]
      }
      consensus_approvals: {
        Row: {
          id: string
          match_id: string
          approver_id: string
          /** CHECK constraint, not an enum type: approve | reject. */
          decision: string
          canonical_payload: Json
          /** bytea — SHA-256 of the canonical payload bytes. */
          payload_digest: string
          /** bytea — server-issued single-use nonce. */
          nonce: string
          signature: string | null
          signature_alg: string
          approved_at: string
        }
        Insert: {
          id?: string
          match_id: string
          approver_id: string
          decision: string
          canonical_payload: Json
          payload_digest: string
          nonce: string
          signature?: string | null
          signature_alg?: string
          approved_at?: string
        }
        Update: {
          id?: string
          match_id?: string
          approver_id?: string
          decision?: string
          canonical_payload?: Json
          payload_digest?: string
          nonce?: string
          signature?: string | null
          signature_alg?: string
          approved_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "consensus_approvals_match_id_fkey"
            columns: ["match_id"]
            isOneToOne: false
            referencedRelation: "matches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "consensus_approvals_approver_id_fkey"
            columns: ["approver_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      match_anomaly_flags: {
        Row: {
          id: string
          match_id: string
          /** CHECK constraint: rule_engine | isolation_forest | manual. */
          source: string
          anomaly_score: number | null
          is_anomalous: boolean
          /** JSON array of machine-readable reason codes. */
          reasons: Json
          model_version: string | null
          leaf_depth: number | null
          average_path_length: number | null
          created_at: string
        }
        Insert: {
          id?: string
          match_id: string
          source: string
          anomaly_score?: number | null
          is_anomalous?: boolean
          reasons?: Json
          model_version?: string | null
          leaf_depth?: number | null
          average_path_length?: number | null
          created_at?: string
        }
        Update: {
          id?: string
          match_id?: string
          source?: string
          anomaly_score?: number | null
          is_anomalous?: boolean
          reasons?: Json
          model_version?: string | null
          leaf_depth?: number | null
          average_path_length?: number | null
          created_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "match_anomaly_flags_match_id_fkey"
            columns: ["match_id"]
            isOneToOne: false
            referencedRelation: "matches"
            referencedColumns: ["id"]
          },
        ]
      }
      /** Created by `0005_integrity_consensus.sql`. One row per match, service/admin only. */
      match_collusion_signals: {
        Row: {
          match_id: string
          /**
           * Per-heuristic breakdown: repeat_pairing_7d, repeat_pairing_90d, rating_farming_7d,
           * shared_ip_reporter_pairs, lopsided_fast_report, reporter_pair_frequency.
           */
          signals: Json
          /** numeric(6,5) in [0,1]. >= 0.5 sets `is_suspicious`. */
          collusion_score: number
          is_suspicious: boolean
          computed_at: string
        }
        Insert: {
          match_id: string
          signals?: Json
          collusion_score?: number
          is_suspicious?: boolean
          computed_at?: string
        }
        Update: {
          match_id?: string
          signals?: Json
          collusion_score?: number
          is_suspicious?: boolean
          computed_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "match_collusion_signals_match_id_fkey"
            columns: ["match_id"]
            isOneToOne: true
            referencedRelation: "matches"
            referencedColumns: ["id"]
          },
        ]
      }
      match_participants: {
        Row: {
          id: string
          match_id: string
          player_id: string
          /** CHECK constraint: home | away. */
          team_side: string
          is_confirmed: boolean
          joined_at: string
        }
        Insert: {
          id?: string
          match_id: string
          player_id: string
          team_side: string
          is_confirmed?: boolean
          joined_at?: string
        }
        Update: {
          id?: string
          match_id?: string
          player_id?: string
          team_side?: string
          is_confirmed?: boolean
          joined_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "match_participants_match_id_fkey"
            columns: ["match_id"]
            isOneToOne: false
            referencedRelation: "matches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "match_participants_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      matches: {
        Row: {
          id: string
          booking_id: string | null
          pitch_id: string | null
          venue_id: string | null
          format: Database["public"]["Enums"]["match_format"]
          status: Database["public"]["Enums"]["match_status"]
          kickoff_at: string
          duration_minutes: number
          home_team_id: string | null
          away_team_id: string | null
          home_score: number | null
          away_score: number | null
          score_confirmed_at: string | null
          is_ranked: boolean
          predicted_draw_probability: number | null
          match_quality: number | null
          requires_consensus: boolean
          anomaly_score: number | null
          anomaly_checked_at: string | null
          consensus_deadline: string | null
          /** Added by 0005. 16 random bytes scoping the CURRENT round; PostgREST hex text. */
          consensus_nonce: string | null
          /** Added by 0005. When `consensus_nonce` was minted. */
          consensus_nonce_issued_at: string | null
          rating_applied_at: string | null
          created_by: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          booking_id?: string | null
          pitch_id?: string | null
          venue_id?: string | null
          format?: Database["public"]["Enums"]["match_format"]
          status?: Database["public"]["Enums"]["match_status"]
          kickoff_at: string
          duration_minutes?: number
          home_team_id?: string | null
          away_team_id?: string | null
          home_score?: number | null
          away_score?: number | null
          score_confirmed_at?: string | null
          is_ranked?: boolean
          predicted_draw_probability?: number | null
          match_quality?: number | null
          requires_consensus?: boolean
          anomaly_score?: number | null
          anomaly_checked_at?: string | null
          consensus_deadline?: string | null
          consensus_nonce?: string | null
          consensus_nonce_issued_at?: string | null
          rating_applied_at?: string | null
          created_by?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          booking_id?: string | null
          pitch_id?: string | null
          venue_id?: string | null
          format?: Database["public"]["Enums"]["match_format"]
          status?: Database["public"]["Enums"]["match_status"]
          kickoff_at?: string
          duration_minutes?: number
          home_team_id?: string | null
          away_team_id?: string | null
          home_score?: number | null
          away_score?: number | null
          score_confirmed_at?: string | null
          is_ranked?: boolean
          predicted_draw_probability?: number | null
          match_quality?: number | null
          requires_consensus?: boolean
          anomaly_score?: number | null
          anomaly_checked_at?: string | null
          consensus_deadline?: string | null
          consensus_nonce?: string | null
          consensus_nonce_issued_at?: string | null
          rating_applied_at?: string | null
          created_by?: string | null
          created_at?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "matches_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: true
            referencedRelation: "bookings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "matches_pitch_id_fkey"
            columns: ["pitch_id"]
            isOneToOne: false
            referencedRelation: "pitches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "matches_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "matches_home_team_id_fkey"
            columns: ["home_team_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "matches_away_team_id_fkey"
            columns: ["away_team_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "matches_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      notifications: {
        Row: {
          id: string
          user_id: string
          type: string
          title: string
          body: string | null
          data: Json
          read_at: string | null
          created_at: string
        }
        Insert: {
          id?: string
          user_id: string
          type: string
          title: string
          body?: string | null
          data?: Json
          read_at?: string | null
          created_at?: string
        }
        Update: {
          id?: string
          user_id?: string
          type?: string
          title?: string
          body?: string | null
          data?: Json
          read_at?: string | null
          created_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "notifications_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      parental_consent_requests: {
        Row: {
          id: string
          minor_id: string
          guardian_email: string
          /** bytea — SHA-256 of the emailed token. The plaintext is never persisted. */
          token_hash: string
          status: Database["public"]["Enums"]["consent_status"]
          requested_at: string
          expires_at: string
          verified_at: string | null
          guardian_ip_hash: string | null
          revoked_at: string | null
        }
        Insert: {
          id?: string
          minor_id: string
          guardian_email: string
          token_hash: string
          status?: Database["public"]["Enums"]["consent_status"]
          requested_at?: string
          expires_at: string
          verified_at?: string | null
          guardian_ip_hash?: string | null
          revoked_at?: string | null
        }
        Update: {
          id?: string
          minor_id?: string
          guardian_email?: string
          token_hash?: string
          status?: Database["public"]["Enums"]["consent_status"]
          requested_at?: string
          expires_at?: string
          verified_at?: string | null
          guardian_ip_hash?: string | null
          revoked_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "parental_consent_requests_minor_id_fkey"
            columns: ["minor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      pitch_availability_blocks: {
        Row: {
          id: string
          pitch_id: string
          /** Half-open tstzrange [start,end); never overlaps another block on the same pitch. */
          block_range: string
          reason: string | null
          created_by: string | null
          created_at: string
        }
        Insert: {
          id?: string
          pitch_id: string
          block_range: string
          reason?: string | null
          created_by?: string | null
          created_at?: string
        }
        Update: {
          id?: string
          pitch_id?: string
          block_range?: string
          reason?: string | null
          created_by?: string | null
          created_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "pitch_availability_blocks_pitch_id_fkey"
            columns: ["pitch_id"]
            isOneToOne: false
            referencedRelation: "pitches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pitch_availability_blocks_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      pitches: {
        Row: {
          id: string
          venue_id: string
          name: string
          format: Database["public"]["Enums"]["match_format"]
          surface: Database["public"]["Enums"]["pitch_surface"]
          is_indoor: boolean
          capacity: number | null
          hourly_rate_minor: number
          currency: string
          /** `time` — local wall clock in the parent venue timezone, e.g. "08:00:00". */
          opening_time: string
          closing_time: string
          slot_minutes: number
          is_active: boolean
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          venue_id: string
          name: string
          format?: Database["public"]["Enums"]["match_format"]
          surface?: Database["public"]["Enums"]["pitch_surface"]
          is_indoor?: boolean
          capacity?: number | null
          hourly_rate_minor: number
          currency?: string
          opening_time?: string
          closing_time?: string
          slot_minutes?: number
          is_active?: boolean
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          venue_id?: string
          name?: string
          format?: Database["public"]["Enums"]["match_format"]
          surface?: Database["public"]["Enums"]["pitch_surface"]
          is_indoor?: boolean
          capacity?: number | null
          hourly_rate_minor?: number
          currency?: string
          opening_time?: string
          closing_time?: string
          slot_minutes?: number
          is_active?: boolean
          created_at?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "pitches_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      player_ratings: {
        Row: {
          player_id: string
          mu: number
          sigma: number
          /** GENERATED ALWAYS AS (mu - 3 * sigma) STORED — never writable. */
          conservative_rating: number | null
          matches_played: number
          wins: number
          draws: number
          losses: number
          last_match_at: string | null
          last_decay_at: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          // `conservative_rating` omitted: GENERATED ALWAYS AS ... STORED.
          player_id: string
          mu?: number
          sigma?: number
          matches_played?: number
          wins?: number
          draws?: number
          losses?: number
          last_match_at?: string | null
          last_decay_at?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          // `conservative_rating` omitted: GENERATED ALWAYS AS ... STORED.
          player_id?: string
          mu?: number
          sigma?: number
          matches_played?: number
          wins?: number
          draws?: number
          losses?: number
          last_match_at?: string | null
          last_decay_at?: string | null
          created_at?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "player_ratings_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: true
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      player_stats: {
        Row: {
          id: string
          match_id: string
          player_id: string
          team_id: string | null
          /** CHECK constraint: home | away. */
          team_side: string | null
          goals: number
          assists: number
          saves: number
          yellow_cards: number
          red_cards: number
          minutes_played: number
          mu_before: number | null
          sigma_before: number | null
          mu_after: number | null
          sigma_after: number | null
          /** GENERATED ALWAYS AS (mu_after - mu_before) STORED — never writable. */
          rating_delta: number | null
          created_at: string
        }
        Insert: {
          // `rating_delta` omitted: GENERATED ALWAYS AS ... STORED.
          id?: string
          match_id: string
          player_id: string
          team_id?: string | null
          team_side?: string | null
          goals?: number
          assists?: number
          saves?: number
          yellow_cards?: number
          red_cards?: number
          minutes_played?: number
          mu_before?: number | null
          sigma_before?: number | null
          mu_after?: number | null
          sigma_after?: number | null
          created_at?: string
        }
        Update: {
          // `rating_delta` omitted: GENERATED ALWAYS AS ... STORED.
          id?: string
          match_id?: string
          player_id?: string
          team_id?: string | null
          team_side?: string | null
          goals?: number
          assists?: number
          saves?: number
          yellow_cards?: number
          red_cards?: number
          minutes_played?: number
          mu_before?: number | null
          sigma_before?: number | null
          mu_after?: number | null
          sigma_after?: number | null
          created_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "player_stats_match_id_fkey"
            columns: ["match_id"]
            isOneToOne: false
            referencedRelation: "matches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "player_stats_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "player_stats_team_id_fkey"
            columns: ["team_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          id: string
          /** citext */
          email: string | null
          full_name: string | null
          display_name: string | null
          avatar_url: string | null
          role: Database["public"]["Enums"]["app_role"]
          date_of_birth: string | null
          /**
           * GENERATED ALWAYS AS (private.is_minor_dob(date_of_birth)) STORED — never writable.
           * The column is nullable in DDL, so it is typed `boolean | null`; in practice the
           * backing function returns `false` (never null) for a null date_of_birth.
           */
          is_minor: boolean | null
          parental_consent_status: Database["public"]["Enums"]["consent_status"]
          parental_consent_at: string | null
          /** citext */
          guardian_email: string | null
          guardian_name: string | null
          location_sharing_enabled: boolean
          /** CHECK constraint: public | members | private. */
          profile_visibility: string
          marketing_opt_in: boolean
          phone: string | null
          city: string | null
          /** Free text by design — no CHECK constraint. */
          preferred_position: string | null
          bio: string | null
          stripe_account_id: string | null
          stripe_customer_id: string | null
          onboarding_completed_at: string | null
          last_seen_at: string | null
          deleted_at: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          // `is_minor` omitted: GENERATED ALWAYS AS ... STORED.
          id: string
          email?: string | null
          full_name?: string | null
          display_name?: string | null
          avatar_url?: string | null
          role?: Database["public"]["Enums"]["app_role"]
          date_of_birth?: string | null
          parental_consent_status?: Database["public"]["Enums"]["consent_status"]
          parental_consent_at?: string | null
          guardian_email?: string | null
          guardian_name?: string | null
          location_sharing_enabled?: boolean
          profile_visibility?: string
          marketing_opt_in?: boolean
          phone?: string | null
          city?: string | null
          preferred_position?: string | null
          bio?: string | null
          stripe_account_id?: string | null
          stripe_customer_id?: string | null
          onboarding_completed_at?: string | null
          last_seen_at?: string | null
          deleted_at?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          // `is_minor` omitted: GENERATED ALWAYS AS ... STORED.
          id?: string
          email?: string | null
          full_name?: string | null
          display_name?: string | null
          avatar_url?: string | null
          role?: Database["public"]["Enums"]["app_role"]
          date_of_birth?: string | null
          parental_consent_status?: Database["public"]["Enums"]["consent_status"]
          parental_consent_at?: string | null
          guardian_email?: string | null
          guardian_name?: string | null
          location_sharing_enabled?: boolean
          profile_visibility?: string
          marketing_opt_in?: boolean
          phone?: string | null
          city?: string | null
          preferred_position?: string | null
          bio?: string | null
          stripe_account_id?: string | null
          stripe_customer_id?: string | null
          onboarding_completed_at?: string | null
          last_seen_at?: string | null
          deleted_at?: string | null
          created_at?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "profiles_id_fkey"
            columns: ["id"]
            isOneToOne: true
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      /**
       * Created by `0004_trueskill.sql`. Single-row tunable constants for the TrueSkill 2
       * engine, read by `trueskill2_update` / `match_quality` on every call. The default row
       * is mirrored by the constants in `lib/matchmaking/trueskill.ts`.
       */
      rating_config: {
        Row: {
          /** `boolean primary key default true check (singleton)` — always `true`. */
          singleton: boolean
          mu0: number
          sigma0: number
          beta: number
          tau: number
          draw_probability: number
          margin_log_divisor: number
          margin_factor_max: number
          min_variance_ratio: number
          sigma_floor: number
          mu_floor: number
          mu_ceiling: number
          updated_at: string
        }
        Insert: {
          singleton?: boolean
          mu0?: number
          sigma0?: number
          beta?: number
          tau?: number
          draw_probability?: number
          margin_log_divisor?: number
          margin_factor_max?: number
          min_variance_ratio?: number
          sigma_floor?: number
          mu_floor?: number
          mu_ceiling?: number
          updated_at?: string
        }
        Update: {
          singleton?: boolean
          mu0?: number
          sigma0?: number
          beta?: number
          tau?: number
          draw_probability?: number
          margin_log_divisor?: number
          margin_factor_max?: number
          min_variance_ratio?: number
          sigma_floor?: number
          mu_floor?: number
          mu_ceiling?: number
          updated_at?: string
        }
        Relationships: []
      }
      score_reports: {
        Row: {
          id: string
          match_id: string
          reported_by: string
          /** CHECK constraint: home | away. */
          team_side: string | null
          home_score: number
          away_score: number
          reported_at: string
          client_reported_at: string | null
          /** bytea — SHA-256 of the canonical report body. */
          payload_hash: string | null
          /** bytea — salted SHA-256 of the reporter IP. Raw IPs are never stored. */
          ip_hash: string | null
        }
        Insert: {
          id?: string
          match_id: string
          reported_by: string
          team_side?: string | null
          home_score: number
          away_score: number
          reported_at?: string
          client_reported_at?: string | null
          payload_hash?: string | null
          ip_hash?: string | null
        }
        Update: {
          id?: string
          match_id?: string
          reported_by?: string
          team_side?: string | null
          home_score?: number
          away_score?: number
          reported_at?: string
          client_reported_at?: string | null
          payload_hash?: string | null
          ip_hash?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "score_reports_match_id_fkey"
            columns: ["match_id"]
            isOneToOne: false
            referencedRelation: "matches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "score_reports_reported_by_fkey"
            columns: ["reported_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      stripe_events: {
        Row: {
          /** Stripe evt_* identifier, used verbatim as the primary key. */
          id: string
          type: string
          api_version: string | null
          payload: Json
          received_at: string
          processed_at: string | null
          processing_error: string | null
          attempts: number
        }
        Insert: {
          id: string
          type: string
          api_version?: string | null
          payload: Json
          received_at?: string
          processed_at?: string | null
          processing_error?: string | null
          attempts?: number
        }
        Update: {
          id?: string
          type?: string
          api_version?: string | null
          payload?: Json
          received_at?: string
          processed_at?: string | null
          processing_error?: string | null
          attempts?: number
        }
        Relationships: []
      }
      team_members: {
        Row: {
          team_id: string
          player_id: string
          role: Database["public"]["Enums"]["team_member_role"]
          jersey_number: number | null
          joined_at: string
          left_at: string | null
          updated_at: string
        }
        Insert: {
          team_id: string
          player_id: string
          role?: Database["public"]["Enums"]["team_member_role"]
          jersey_number?: number | null
          joined_at?: string
          left_at?: string | null
          updated_at?: string
        }
        Update: {
          team_id?: string
          player_id?: string
          role?: Database["public"]["Enums"]["team_member_role"]
          jersey_number?: number | null
          joined_at?: string
          left_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "team_members_team_id_fkey"
            columns: ["team_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "team_members_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      teams: {
        Row: {
          id: string
          name: string
          /** Lowercase kebab-case, unique. */
          slug: string
          owner_id: string
          city: string | null
          crest_url: string | null
          description: string | null
          is_public: boolean
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          name: string
          slug: string
          owner_id: string
          city?: string | null
          crest_url?: string | null
          description?: string | null
          is_public?: boolean
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          name?: string
          slug?: string
          owner_id?: string
          city?: string | null
          crest_url?: string | null
          description?: string | null
          is_public?: boolean
          created_at?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "teams_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      venue_payouts: {
        Row: {
          id: string
          venue_id: string
          /** Stripe po_* identifier. Unique; doubles as this table's webhook idempotency key. */
          stripe_payout_id: string
          connected_account_id: string | null
          amount_minor: number
          currency: string
          status: Database["public"]["Enums"]["payout_status"]
          /** `date` — expected settlement date reported by Stripe. */
          arrival_date: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          venue_id: string
          stripe_payout_id: string
          connected_account_id?: string | null
          amount_minor: number
          currency?: string
          status?: Database["public"]["Enums"]["payout_status"]
          arrival_date?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          venue_id?: string
          stripe_payout_id?: string
          connected_account_id?: string | null
          amount_minor?: number
          currency?: string
          status?: Database["public"]["Enums"]["payout_status"]
          arrival_date?: string | null
          created_at?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "venue_payouts_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      venues: {
        Row: {
          id: string
          owner_id: string
          name: string
          /** Lowercase kebab-case, unique. */
          slug: string
          description: string | null
          address_line1: string | null
          address_line2: string | null
          city: string | null
          district: string | null
          postal_code: string | null
          /** ISO 3166-1 alpha-2, uppercase. */
          country: string
          latitude: number | null
          longitude: number | null
          amenities: string[]
          photos: string[]
          phone: string | null
          /** citext */
          contact_email: string | null
          /** IANA zone used to render slot grids; storage stays timestamptz (UTC). */
          timezone: string
          is_active: boolean
          stripe_account_id: string | null
          charges_enabled: boolean
          payouts_enabled: boolean
          onboarding_completed_at: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          owner_id: string
          name: string
          slug: string
          description?: string | null
          address_line1?: string | null
          address_line2?: string | null
          city?: string | null
          district?: string | null
          postal_code?: string | null
          country?: string
          latitude?: number | null
          longitude?: number | null
          amenities?: string[]
          photos?: string[]
          phone?: string | null
          contact_email?: string | null
          timezone?: string
          is_active?: boolean
          stripe_account_id?: string | null
          charges_enabled?: boolean
          payouts_enabled?: boolean
          onboarding_completed_at?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          owner_id?: string
          name?: string
          slug?: string
          description?: string | null
          address_line1?: string | null
          address_line2?: string | null
          city?: string | null
          district?: string | null
          postal_code?: string | null
          country?: string
          latitude?: number | null
          longitude?: number | null
          amenities?: string[]
          photos?: string[]
          phone?: string | null
          contact_email?: string | null
          timezone?: string
          is_active?: boolean
          stripe_account_id?: string | null
          charges_enabled?: boolean
          payouts_enabled?: boolean
          onboarding_completed_at?: string | null
          created_at?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "venues_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      /* ---------------------------------------------------------------------- */
      /*  Progression (0008_gamification.sql)                                    */
      /* ---------------------------------------------------------------------- */

      /**
       * One row per player: XP, derived level, weekly streak, and the counters the
       * achievement and challenge evaluators read.
       *
       * NO ROLE HOLDS INSERT OR UPDATE. Every write goes through a SECURITY DEFINER
       * function (`award_xp`, `apply_match_progression`, the triggers in 0008), which is
       * what stops a client minting its own XP. `Insert` and `Update` are declared anyway
       * because the generated shape has them; a statement built from either is refused by
       * the grant, not by the type.
       */
      player_progress: {
        Row: {
          player_id: string
          xp: number
          /**
           * GENERATED ALWAYS AS private.level_for_xp(xp) STORED - never writable.
           * Nullable for the reason given in the header: Postgres does not infer NOT NULL for a
           * generated column, even when its expression cannot produce one.
           */
          level: number | null
          current_streak_weeks: number
          longest_streak_weeks: number
          /** Monday of the most recent week that counted, as `YYYY-MM-DD`. */
          last_streak_week: string | null
          last_played_on: string | null
          matches_played: number
          matches_won: number
          matches_drawn: number
          matches_lost: number
          goals: number
          assists: number
          clean_sheets: number
          hat_tricks: number
          late_matches: number
          distinct_venues: number
          bookings_paid: number
          reports_filed: number
          consensus_votes: number
          teams_captained: number
          current_unbeaten_run: number
          best_unbeaten_run: number
          created_at: string
          updated_at: string
        }
        Insert: {
          player_id: string
          xp?: number
          // `level` omitted: GENERATED ALWAYS AS ... STORED.
          current_streak_weeks?: number
          longest_streak_weeks?: number
          last_streak_week?: string | null
          last_played_on?: string | null
          matches_played?: number
          matches_won?: number
          matches_drawn?: number
          matches_lost?: number
          goals?: number
          assists?: number
          clean_sheets?: number
          hat_tricks?: number
          late_matches?: number
          distinct_venues?: number
          bookings_paid?: number
          reports_filed?: number
          consensus_votes?: number
          teams_captained?: number
          current_unbeaten_run?: number
          best_unbeaten_run?: number
          created_at?: string
          updated_at?: string
        }
        Update: {
          player_id?: string
          xp?: number
          current_streak_weeks?: number
          longest_streak_weeks?: number
          last_streak_week?: string | null
          last_played_on?: string | null
          matches_played?: number
          matches_won?: number
          matches_drawn?: number
          matches_lost?: number
          goals?: number
          assists?: number
          clean_sheets?: number
          hat_tricks?: number
          late_matches?: number
          distinct_venues?: number
          bookings_paid?: number
          reports_filed?: number
          consensus_votes?: number
          teams_captained?: number
          current_unbeaten_run?: number
          best_unbeaten_run?: number
          created_at?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "player_progress_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: true
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }

      /**
       * The append-only XP ledger. `player_progress.xp` is the running total of this table.
       *
       * `dedupe_key` is the idempotency key - `match:<uuid>:won`, `ach:centurion` - under a
       * partial unique index on `(user_id, dedupe_key) where dedupe_key is not null`. A
       * second award of the same thing is dropped, which is what makes the triggers safe to
       * re-run.
       */
      xp_events: {
        Row: {
          id: string
          user_id: string
          kind: Database["public"]["Enums"]["xp_event_kind"]
          points: number
          dedupe_key: string | null
          match_id: string | null
          booking_id: string | null
          metadata: Json
          created_at: string
        }
        Insert: {
          id?: string
          user_id: string
          kind: Database["public"]["Enums"]["xp_event_kind"]
          points: number
          dedupe_key?: string | null
          match_id?: string | null
          booking_id?: string | null
          metadata?: Json
          created_at?: string
        }
        Update: {
          id?: string
          user_id?: string
          kind?: Database["public"]["Enums"]["xp_event_kind"]
          points?: number
          dedupe_key?: string | null
          match_id?: string | null
          booking_id?: string | null
          metadata?: Json
          created_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "xp_events_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "xp_events_match_id_fkey"
            columns: ["match_id"]
            isOneToOne: false
            referencedRelation: "matches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "xp_events_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "bookings"
            referencedColumns: ["id"]
          },
        ]
      }

      /** The badge catalogue. Readable by `anon` too: a signed-out visitor can see what there is to earn. */
      achievements: {
        Row: {
          code: string
          name: string
          description: string
          tier: Database["public"]["Enums"]["achievement_tier"]
          metric: Database["public"]["Enums"]["progress_metric"]
          target: number
          xp_reward: number
          sort_order: number
          is_active: boolean
          created_at: string
        }
        Insert: {
          code: string
          name: string
          description: string
          tier: Database["public"]["Enums"]["achievement_tier"]
          metric: Database["public"]["Enums"]["progress_metric"]
          target: number
          xp_reward?: number
          sort_order?: number
          is_active?: boolean
          created_at?: string
        }
        Update: {
          code?: string
          name?: string
          description?: string
          tier?: Database["public"]["Enums"]["achievement_tier"]
          metric?: Database["public"]["Enums"]["progress_metric"]
          target?: number
          xp_reward?: number
          sort_order?: number
          is_active?: boolean
          created_at?: string
        }
        Relationships: []
      }

      /** Unlock state. `rewarded` is what stops a re-evaluation paying the XP twice. */
      player_achievements: {
        Row: {
          user_id: string
          achievement_code: string
          progress: number
          unlocked_at: string | null
          rewarded: boolean
          updated_at: string
        }
        Insert: {
          user_id: string
          achievement_code: string
          progress?: number
          unlocked_at?: string | null
          rewarded?: boolean
          updated_at?: string
        }
        Update: {
          user_id?: string
          achievement_code?: string
          progress?: number
          unlocked_at?: string | null
          rewarded?: boolean
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "player_achievements_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "player_achievements_achievement_code_fkey"
            columns: ["achievement_code"]
            isOneToOne: false
            referencedRelation: "achievements"
            referencedColumns: ["code"]
          },
        ]
      }

      /**
       * Weekly objectives. `code` repeats week to week; `(code, starts_on)` is the identity
       * of one running of it, which is what `ensure_weekly_challenges()` conflicts on.
       */
      challenges: {
        Row: {
          id: string
          code: string
          title: string
          description: string
          metric: Database["public"]["Enums"]["progress_metric"]
          target: number
          xp_reward: number
          /** `YYYY-MM-DD`, always a Monday. */
          starts_on: string
          ends_on: string
          created_at: string
        }
        Insert: {
          id?: string
          code: string
          title: string
          description: string
          metric: Database["public"]["Enums"]["progress_metric"]
          target: number
          xp_reward?: number
          starts_on: string
          ends_on: string
          created_at?: string
        }
        Update: {
          id?: string
          code?: string
          title?: string
          description?: string
          metric?: Database["public"]["Enums"]["progress_metric"]
          target?: number
          xp_reward?: number
          starts_on?: string
          ends_on?: string
          created_at?: string
        }
        Relationships: []
      }

      /**
       * Per-player progress against one running of a challenge.
       *
       * `baseline` is what makes a weekly challenge weekly: progress is
       * `counter now - counter when the player first saw it`, so "play two matches" means
       * two this week rather than two ever.
       */
      challenge_progress: {
        Row: {
          challenge_id: string
          user_id: string
          baseline: number
          progress: number
          completed_at: string | null
          claimed_at: string | null
          updated_at: string
        }
        Insert: {
          challenge_id: string
          user_id: string
          baseline?: number
          progress?: number
          completed_at?: string | null
          claimed_at?: string | null
          updated_at?: string
        }
        Update: {
          challenge_id?: string
          user_id?: string
          baseline?: number
          progress?: number
          completed_at?: string | null
          claimed_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "challenge_progress_challenge_id_fkey"
            columns: ["challenge_id"]
            isOneToOne: false
            referencedRelation: "challenges"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "challenge_progress_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      /* ---------------------------------------------------------------------- */
      /*  City leagues (0009_leagues.sql)                                        */
      /* ---------------------------------------------------------------------- */

      /** One 13-week season per city, aligned to a fixed epoch so every city runs the same calendar. */
      league_seasons: {
        Row: {
          id: string
          city: string
          name: string
          /** `YYYY-MM-DD`, always a Monday. */
          starts_on: string
          ends_on: string
          status: Database["public"]["Enums"]["season_status"]
          closed_at: string | null
          created_at: string
        }
        Insert: {
          id?: string
          city: string
          name: string
          starts_on: string
          ends_on: string
          status?: Database["public"]["Enums"]["season_status"]
          closed_at?: string | null
          created_at?: string
        }
        Update: {
          id?: string
          city?: string
          name?: string
          starts_on?: string
          ends_on?: string
          status?: Database["public"]["Enums"]["season_status"]
          closed_at?: string | null
          created_at?: string
        }
        Relationships: []
      }

      /**
       * A team's place and record in one division of one season.
       *
       * `points` and `goal_difference` are GENERATED STORED, so they are absent from Insert and
       * Update: naming either in a statement is an error Postgres refuses.
       *
       * No role holds INSERT or UPDATE on this table. Standings are written only by
       * `record_match_in_league()` and `close_season()`, which is what stops a captain editing
       * their own points total.
       */
      league_entries: {
        Row: {
          season_id: string
          team_id: string
          division: Database["public"]["Enums"]["league_division"]
          played: number
          won: number
          drawn: number
          lost: number
          goals_for: number
          goals_against: number
          /** GENERATED: goals_for - goals_against. Nullable for the reason in the header. */
          goal_difference: number | null
          /** GENERATED: won * 3 + drawn. Nullable for the reason in the header. */
          points: number | null
          final_rank: number | null
          movement: Database["public"]["Enums"]["league_movement"] | null
          joined_at: string
          updated_at: string
        }
        Insert: {
          season_id: string
          team_id: string
          division?: Database["public"]["Enums"]["league_division"]
          played?: number
          won?: number
          drawn?: number
          lost?: number
          goals_for?: number
          goals_against?: number
          final_rank?: number | null
          movement?: Database["public"]["Enums"]["league_movement"] | null
          joined_at?: string
          updated_at?: string
        }
        Update: {
          season_id?: string
          team_id?: string
          division?: Database["public"]["Enums"]["league_division"]
          played?: number
          won?: number
          drawn?: number
          lost?: number
          goals_for?: number
          goals_against?: number
          final_rank?: number | null
          movement?: Database["public"]["Enums"]["league_movement"] | null
          joined_at?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "league_entries_season_id_fkey"
            columns: ["season_id"]
            isOneToOne: false
            referencedRelation: "league_seasons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "league_entries_team_id_fkey"
            columns: ["team_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["id"]
          },
        ]
      }

      /** Which matches have been counted. Keyed on the match, so double-counting is impossible. */
      league_results: {
        Row: {
          match_id: string
          season_id: string
          home_team_id: string
          away_team_id: string
          home_score: number
          away_score: number
          counted_at: string
        }
        Insert: {
          match_id: string
          season_id: string
          home_team_id: string
          away_team_id: string
          home_score: number
          away_score: number
          counted_at?: string
        }
        Update: {
          match_id?: string
          season_id?: string
          home_team_id?: string
          away_team_id?: string
          home_score?: number
          away_score?: number
          counted_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "league_results_match_id_fkey"
            columns: ["match_id"]
            isOneToOne: true
            referencedRelation: "matches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "league_results_season_id_fkey"
            columns: ["season_id"]
            isOneToOne: false
            referencedRelation: "league_seasons"
            referencedColumns: ["id"]
          },
        ]
      }
      /**
       * Fixed-window rate-limit counters, from `0010_hardening.sql`.
       *
       * NOT READABLE OR WRITABLE BY ANYONE. RLS is enabled on this table with **no policies at
       * all**, so every role — `anon`, `authenticated`, and any added later — is denied by
       * default. The only way in is `public.consume_rate_limit()`, which is SECURITY DEFINER.
       * These types exist so the table is accounted for, not so a client can query it: a
       * `.from("rate_limits")` anywhere in the app is a bug, and it will return nothing.
       */
      rate_limits: {
        Row: {
          /** What is being limited, e.g. 'checkout'. Matches `^[a-z][a-z0-9_]{1,39}$`. */
          bucket: string
          /** 'user:<uuid>' for a signed-in caller, or 'ip:<sha256>' — never a raw address. */
          subject: string
          /** Start of the fixed window this row counts. Part of the primary key. */
          window_start: string
          count: number
          updated_at: string
        }
        Insert: {
          bucket: string
          subject: string
          window_start: string
          count?: number
          updated_at?: string
        }
        Update: {
          bucket?: string
          subject?: string
          window_start?: string
          count?: number
          updated_at?: string
        }
        Relationships: []
      }
    }
    Views: {
      /**
       * Created by `0007_cron_decay.sql`: the most recent run of every pg_cron job.
       *
       * TWO CAVEATS. It is created CONDITIONALLY — 0007 skips the whole `do $health$` block
       * when the `cron` schema is absent, so on a database without pg_cron this view does not
       * exist at all. And it is granted to `service_role` ONLY, with explicit revokes from
       * `anon` and `authenticated`, because `cron.job` exposes the raw command text: it must
       * never be queried from a browser client.
       */
      cron_job_health: {
        Row: {
          jobid: number | null
          jobname: string | null
          schedule: string | null
          active: boolean | null
          last_runid: number | null
          last_status: string | null
          last_message: string | null
          last_start: string | null
          last_end: string | null
          /** `end_time - start_time`, a Postgres `interval` in its text form. */
          last_duration: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      /**
       * Builds the anomaly feature vector for a match. The returned JSON object is key-for-key
       * the `match_anomaly_feature_row` composite below — which is field-for-field the
       * `AnomalyFeatureVector` in `types/domain.ts` and the pydantic model in
       * `services/anomaly/` — PLUS a nested `collusion` object from `collusion_signals()`.
       * The eleven feature fields must be changed in all three places together.
       */
      anomaly_features: {
        Args: { p_match_id: string }
        Returns: Json
      }
      /**
       * The score at or above which a match is treated as anomalous (default 0.62). Higher
       * score = more anomalous; crossing this cut opens a peer-consensus round.
       */
      anomaly_score_threshold: {
        Args: Record<PropertyKey, never>
        Returns: number
      }
      /**
       * Transactional entry point for the TrueSkill 2 update. Row-locks the match, verifies
       * it is finalised / ranked / `rating_applied_at is null`, writes before+after values
       * into `player_stats` and stamps `rating_applied_at`. Idempotent: returns 0 without
       * touching anything when the rating had already been applied; otherwise the number of
       * players rated.
       */
      apply_match_rating: {
        Args: { p_match_id: string }
        Returns: number
      }
      /**
       * Anti-collusion signals for a match: roster-overlap ratio, repeat-pairing frequency,
       * reporter account ages. Advisory input to the anomaly layer.
       */
      collusion_signals: {
        Args: { p_match_id: string }
        Returns: Json
      }
      /**
       * The canonical payload approvers sign. Canonical bytes are the jsonb::text rendering:
       * keys ordered by (length, bytewise) => nonce, match_id, away_score, home_score,
       * reported_at, participant_ids; one space after every colon and comma; UTC
       * second-precision timestamp; participant uuids sorted ascending as text. Rebuild these
       * exact bytes client-side or your digest will not match.
       *
       * It is emphatically NOT "sorted keys, no whitespace" — that is JCS/RFC 8785, and it is
       * not what Postgres emits. Two reference implementations exist; copy one rather than
       * writing a third: `canonicalizeJsonb` in `components/match/consensus-panel.tsx`
       * (browser) and `canonicalJsonbText` imported by
       * `app/api/matches/[id]/consensus/route.ts` (server).
       */
      consensus_payload: {
        Args: { p_match_id: string }
        Returns: Json
      }
      /**
       * Nightly sigma inflation for inactive players. Never touches mu. Returns the number of
       * `player_ratings` rows touched.
       */
      decay_inactive_ratings: {
        Args: {
          p_inactive_days?: number
          p_daily_sigma_growth?: number
          p_sigma_cap?: number
          p_batch_size?: number
          p_max_batches?: number
          p_min_days?: number
        }
        Returns: number
      }
      /**
       * Compares the score reports filed for a match. Returns a 15-key snake_case object:
       * `decision`, `match_id`, `variance`, `reports_count`, `home_reports`, `away_reports`,
       * `neutral_reports`, `distinct_scorelines`, `agreed_home_score`, `agreed_away_score`,
       * `accept_after`, `consensus_deadline`, `consensus_nonce`, `rating_applied`,
       * `collusion` (null for unprivileged callers).
       *
       * `decision` is one of 'accepted' | 'contested' | 'accepted_by_default' |
       * 'awaiting_counterparty' | 'noop' | 'awaiting_reports' — see `ScoreConsensusDecision`
       * in `types/domain.ts`. It is NOT the `ScoreVerdict` union: that one is the HTTP
       * response vocabulary of `/api/matches/[id]/report-score`, derived by its `verdictFor()`
       * from `matches.status` / `matches.requires_consensus`.
       */
      evaluate_score_consensus: {
        Args: { p_match_id: string }
        Returns: Json
      }
      /**
       * Sweeps consensus rounds past the two 24h clocks (uncontested acceptance and the
       * consensus deadline). Meant to run every few minutes. Returns a summary object.
       */
      expire_consensus_rounds: {
        Args: { p_limit?: number }
        Returns: Json
      }
      /**
       * The `0007` cron variant: resolves or disputes rounds whose deadline has passed,
       * clearing `requires_consensus` either way. Returns the number of matches touched.
       */
      expire_stale_consensus: {
        Args: { p_batch_size?: number }
        Returns: number
      }
      /** GDPR Art. 15/20 portability export for the calling user, as one JSON document. */
      export_my_data: {
        Args: Record<PropertyKey, never>
        Returns: Json
      }
      /**
       * Requires a ceil(2/3) quorum of confirmed participants with approvals from both sides,
       * then finalises the match and calls `apply_match_rating`. Row-locked and idempotent.
       * A rejection quorum sends the match to 'disputed'.
       */
      finalize_consensus: {
        Args: { p_match_id: string }
        Returns: Json
      }
      /**
       * Standard TrueSkill draw-probability quality score in [0,1] for two proposed sides,
       * each an array of player ids. Consumed by matchmaking.
       */
      match_quality: {
        Args: { p_team_a: string[]; p_team_b: string[] }
        Returns: number
      }
      /**
       * Batch entry point for the Isolation Forest poller: matches still awaiting an anomaly
       * check, one feature row each. service_role only.
       */
      matches_pending_anomaly_check: {
        Args: { p_limit?: number }
        Returns: Database["public"]["CompositeTypes"]["match_anomaly_feature_row"][]
      }
      /** Mints a 16-byte nonce and opens a consensus round. Returns the round descriptor. */
      open_consensus_round: {
        Args: { p_match_id: string }
        Returns: Json
      }
      /**
       * Deletes consent requests still 'pending' past their expiry. Granted and revoked rows
       * are evidence of a lawful basis and are never touched. Returns the number of rows
       * deleted.
       */
      purge_expired_consent_requests: {
        Args: { p_retain_days?: number; p_batch_size?: number; p_max_batches?: number }
        Returns: number
      }
      /**
       * Persists an anomaly verdict into `match_anomaly_flags` and updates
       * `matches.anomaly_score` / `requires_consensus`.
       *
       * `p_is_anomalous` defaults to NULL on purpose: leave it out (or pass null) and the
       * function derives the verdict from `anomaly_score_threshold()`, which is the intended
       * call shape for the Isolation Forest sidecar. Pass a boolean only to override it.
       *
       * Returns an eight-key object; the flag id is one field of it, not the whole result.
       */
      record_anomaly_verdict: {
        Args: {
          p_match_id: string
          p_source?: string
          p_anomaly_score?: number | null
          p_is_anomalous?: boolean | null
          p_reasons?: Json
          p_model_version?: string | null
          p_leaf_depth?: number | null
          p_average_path_length?: number | null
        }
        Returns: {
          match_id: string
          flag_id: string
          source: string
          anomaly_score: number | null
          threshold: number
          is_anomalous: boolean
          opened_consensus: boolean
          collusion: Json
        }
      }
      /**
       * GDPR Art. 17. Pseudonymises PII and soft-deletes the calling user; financial rows are
       * retained under Art. 17(3)(b). Returns a receipt describing what was erased/retained.
       * Takes NO arguments — it acts on `auth.uid()`. Any confirmation string is validated in
       * the route, not passed here.
       */
      request_account_erasure: {
        Args: Record<PropertyKey, never>
        Returns: Json
      }
      /**
       * GDPR Art. 8. Stores only `digest(token,'sha256')` with a 7-day expiry and returns the
       * RAW token exactly once so the API can email it. Never log or return this to a browser.
       *
       * Declared `returns table (request_id uuid, raw_token text)`, so PostgREST answers with
       * an ARRAY of exactly one row — not a bare string.
       */
      /* ---------------------------------------------------------------------- */
      /*  Progression (0008_gamification.sql)                                    */
      /* ---------------------------------------------------------------------- */

      /**
       * The caller's entire progression state in one round trip: level, XP, streak, every
       * achievement with its progress, every live challenge with its claim state, and the
       * last twelve ledger entries.
       *
       * Reads `auth.uid()` itself and takes no arguments, so it cannot be pointed at
       * somebody else. It also opens this week's challenges and syncs the caller's baseline
       * before answering, which is why it is a `plpgsql` function and not a view.
       *
       * The `jsonb` it returns is parsed by `playerProgressSchema` in
       * `@onpitch/shared/gamification`; use that rather than casting.
       */
      my_progress: {
        Args: Record<PropertyKey, never>
        Returns: Json
      }
      /**
       * Claims one completed challenge's XP. The UPDATE that flips `claimed_at` is the lock,
       * so two taps award once. Answers `{ claimed, xp, code? }`; `claimed: false` means it
       * was already claimed or was never completed, and is not an error.
       */
      claim_challenge: {
        Args: { p_challenge_id: string }
        Returns: Json
      }
      /**
       * A page of the ranking. `p_scope` is 'xp' | 'rating' | 'streak'.
       *
       * Rows are limited to public, non-deleted, non-minor profiles that have played at
       * least once, so a private account never appears no matter who asks. Declared
       * `returns table (...)`, so this is an ARRAY.
       */
      leaderboard_page: {
        Args: {
          p_scope?: string
          p_city?: string | null
          p_limit?: number
          p_offset?: number
        }
        Returns: {
          rank: number
          player_id: string
          display_name: string
          avatar_url: string | null
          city: string | null
          level: number
          xp: number
          conservative_rating: number
          matches_played: number
          current_streak_weeks: number
        }[]
      }
      /**
       * The venue owner's standing: paid bookings, cancellations, disputes, net take and a
       * tier. Raises 42501 unless the caller owns the venue or is an admin — SECURITY
       * DEFINER bypasses RLS, so the function makes the check RLS would have made.
       *
       * Parsed by `venueScorecardSchema` in `@onpitch/shared/gamification`.
       */
      venue_scorecard: {
        Args: { p_venue_id: string; p_days?: number }
        Returns: Json
      }
      /* ---------------------------------------------------------------------- */
      /*  City leagues (0009_leagues.sql)                                        */
      /* ---------------------------------------------------------------------- */

      /**
       * One division's table, ordered by points, then goal difference, then goals scored.
       *
       * `p_season_id` null means the city's currently active season. Only PUBLIC teams appear:
       * the function is SECURITY DEFINER, so it re-applies the visibility rule
       * `teams_select_public_or_member` would have applied. Declared `returns table (...)`, so
       * this is an ARRAY.
       *
       * The first column is `place`, not `position` — the latter is a reserved word in Postgres.
       */
      league_table: {
        Args: {
          p_city: string
          p_division?: Database["public"]["Enums"]["league_division"]
          p_season_id?: string | null
        }
        Returns: {
          place: number
          team_id: string
          team_name: string
          team_slug: string
          crest_url: string | null
          played: number
          won: number
          drawn: number
          lost: number
          goals_for: number
          goals_against: number
          goal_difference: number
          points: number
        }[]
      }
      /**
       * Where the caller's own teams stand, in every city they play in. Reads `auth.uid()`
       * itself and ignores `teams.is_public`, because your own team's position is yours to see.
       *
       * Parsed by `myLeaguesSchema` in `@onpitch/shared/leagues`.
       */
      my_leagues: {
        Args: Record<PropertyKey, never>
        Returns: Json
      }
      /** Every city with an active season that has at least one team in it. */
      league_cities: {
        Args: Record<PropertyKey, never>
        Returns: {
          city: string
          season_id: string
          season_name: string
          ends_on: string
          teams: number
        }[]
      }
      /* ---------------------------------------------------------------------- */
      /*  Rate limiting (0010_hardening.sql)                                     */
      /* ---------------------------------------------------------------------- */

      /**
       * Spends one unit of the CALLER's budget for a bucket and reports what is left.
       *
       * Reads `auth.uid()` itself and takes no subject, so a client cannot spend somebody
       * else's budget. Answers `{ allowed, limit, remaining, resetAt, retryAfterSeconds }` and
       * does NOT raise on refusal — a 429 is a normal answer with a body.
       *
       * Fixed windows, so up to 2x the limit is possible across a boundary. See 0010 for why
       * that is the right trade here.
       */
      consume_rate_limit: {
        Args: { p_bucket: string; p_limit: number; p_window_seconds?: number }
        Returns: Json
      }
      /**
       * The same limiter keyed on a subject the SERVER computes — a hashed IP, a Stripe account
       * id. `service_role` only: a subject argument is exactly what a client must not choose.
       */
      consume_rate_limit_for: {
        Args: {
          p_subject: string
          p_bucket: string
          p_limit: number
          p_window_seconds?: number
        }
        Returns: Json
      }
      request_parental_consent: {
        Args: { p_guardian_email: string; p_guardian_name?: string | null }
        Returns: { request_id: string; raw_token: string }[]
      }
      /**
       * GDPR Art. 7(3). Withdraws a minor's consent. Callable by the minor, by an admin, or by
       * the backend on the guardian's behalf (service role, `auth.uid()` is null).
       */
      revoke_parental_consent: {
        Args: { p_minor_id: string }
        Returns: boolean
      }
      /**
       * Records one signed vote. The server recomputes sha256(canonical_payload) and rejects
       * on digest mismatch, binding the approval to one exact scoreline.
       */
      submit_consensus_approval: {
        Args: {
          p_match_id: string
          p_decision: string
          p_client_digest: string
          p_signature?: string | null
          /** `text not null default 'hmac-sha256'` on `consensus_approvals.signature_alg`. */
          p_signature_alg?: string
        }
        Returns: Json
      }
      /**
       * TrueSkill 2 two-team rating update. Takes both line-ups as arrays of player ids plus
       * the outcome ('a_wins' | 'b_wins' | 'draw'), the absolute goal margin, and optional
       * `{"<player uuid>": 0..1}` partial-play weights.
       *
       * WRITES `player_ratings` (mu, sigma, matches_played, wins/draws/losses, last_match_at)
       * in the same transaction, taking row locks in ascending player_id order.
       * `apply_match_rating` is the transactional wrapper that calls it, not the sole writer.
       * SECURITY DEFINER; service_role only.
       *
       * Declared `returns table (...)`, so PostgREST answers with an ARRAY of one row per
       * player — do not destructure it as a single object.
       */
      trueskill2_update: {
        Args: {
          p_team_a: string[]
          p_team_b: string[]
          p_outcome: string
          p_score_margin?: number
          p_weights?: Json
        }
        Returns: {
          player_id: string
          mu_before: number
          sigma_before: number
          mu_after: number
          sigma_after: number
        }[]
      }
      /**
       * Hashes the raw token, matches a pending unexpired row, flips
       * `profiles.parental_consent_status` to 'granted' and writes `audit_log`.
       * `p_guardian_ip` is the Art. 8(2) evidence that a verification happened; always pass it.
       */
      verify_parental_consent: {
        Args: { p_raw_token: string; p_guardian_ip?: string | null }
        Returns: boolean
      }
    }
    Enums: {
      app_role: "admin" | "venue_owner" | "player"
      booking_status:
        | "pending"
        | "awaiting_payment"
        | "confirmed"
        | "cancelled"
        | "refunded"
        | "disputed"
        | "completed"
      consent_status: "not_required" | "pending" | "granted" | "revoked"
      match_format:
        | "five_a_side"
        | "six_a_side"
        | "seven_a_side"
        | "eight_a_side"
        | "eleven_a_side"
      match_status:
        | "scheduled"
        | "live"
        | "awaiting_report"
        | "requires_consensus"
        | "disputed"
        | "finalized"
        | "cancelled"
      payment_status:
        | "requires_payment"
        | "processing"
        | "succeeded"
        | "failed"
        | "refunded"
        | "partially_refunded"
      payout_status: "pending" | "in_transit" | "paid" | "failed"
      league_division: "bronze" | "silver" | "gold" | "platinum" | "diamond"
      league_movement: "promoted" | "held" | "relegated"
      season_status: "upcoming" | "active" | "closed"
      progress_metric:
        | "matches_played"
        | "matches_won"
        | "goals"
        | "assists"
        | "clean_sheets"
        | "bookings_paid"
        | "distinct_venues"
        | "reports_filed"
        | "consensus_votes"
        | "late_matches"
        | "hat_tricks"
        | "best_unbeaten_run"
        | "current_streak_weeks"
        | "teams_captained"
      pitch_surface: "natural_grass" | "artificial_turf" | "hybrid" | "indoor_court"
      team_member_role: "captain" | "vice_captain" | "member"
      achievement_tier: "bronze" | "silver" | "gold" | "platinum"
      xp_event_kind:
        | "match_played"
        | "match_won"
        | "match_drawn"
        | "goal"
        | "assist"
        | "clean_sheet"
        | "score_reported"
        | "consensus_voted"
        | "booking_paid"
        | "streak_bonus"
        | "achievement"
        | "challenge"
        | "onboarding"
        | "admin_adjustment"
    }
    CompositeTypes: {
      /**
       * Created by `0005_integrity_consensus.sql`. The Isolation Forest feature vector, and
       * the return element of `matches_pending_anomaly_check()`. Column ORDER and TYPES are
       * the contract with the Python sidecar: adding a field is a breaking change. Mirrored
       * key-for-key by `anomaly_features()` (plus a nested `collusion` object) and
       * field-for-field by `AnomalyFeatureVector` in `types/domain.ts`.
       */
      match_anomaly_feature_row: {
        match_id: string
        score_variance: number
        reporting_delay_seconds: number
        reporter_count: number
        opposing_report_agreement: number
        participant_overlap_ratio: number
        historical_report_deviation: number
        goal_diff: number
        kickoff_hour: number
        venue_bookings_last_7d: number
        reporter_account_age_days: number
      }
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** The row shape of a public table, e.g. `Tables<'bookings'>`. */
export type Tables<T extends keyof Database["public"]["Tables"]> =
  Database["public"]["Tables"][T]["Row"]

/** The insertable shape of a public table. Generated columns are absent. */
export type TablesInsert<T extends keyof Database["public"]["Tables"]> =
  Database["public"]["Tables"][T]["Insert"]

/** The updatable shape of a public table. Generated columns are absent. */
export type TablesUpdate<T extends keyof Database["public"]["Tables"]> =
  Database["public"]["Tables"][T]["Update"]

/** A public enum's value union, e.g. `Enums<'booking_status'>`. */
export type Enums<T extends keyof Database["public"]["Enums"]> =
  Database["public"]["Enums"][T]

/**
 * The RETURN type of an RPC, e.g. `Functions<'evaluate_score_consensus'>`.
 * Mirrors `Tables<T>` resolving to `Row`. Use `FunctionArgs<T>` for the argument object.
 */
export type Functions<T extends keyof Database["public"]["Functions"]> =
  Database["public"]["Functions"][T]["Returns"]

/** The ARGUMENT object of an RPC, e.g. `FunctionArgs<'apply_match_rating'>`. */
export type FunctionArgs<T extends keyof Database["public"]["Functions"]> =
  Database["public"]["Functions"][T]["Args"]

export type CompositeTypes<T extends keyof Database["public"]["CompositeTypes"]> =
  Database["public"]["CompositeTypes"][T]

/** Every public table name, handy for generic helpers and audit-log `entity_type` values. */
export type TableName = keyof Database["public"]["Tables"]

/** Every RPC name. */
export type FunctionName = keyof Database["public"]["Functions"]

/* -------------------------------------------------------------------------- */
/*  Runtime enum values                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The same enum values as `Database['public']['Enums']`, but available at RUNTIME so code can
 * validate against them (zod schemas in `domain.ts` are built from these, which keeps the
 * validators and the database definitionally in sync).
 */
export const Constants = {
  public: {
    Enums: {
      app_role: ["admin", "venue_owner", "player"],
      booking_status: [
        "pending",
        "awaiting_payment",
        "confirmed",
        "cancelled",
        "refunded",
        "disputed",
        "completed",
      ],
      consent_status: ["not_required", "pending", "granted", "revoked"],
      match_format: [
        "five_a_side",
        "six_a_side",
        "seven_a_side",
        "eight_a_side",
        "eleven_a_side",
      ],
      match_status: [
        "scheduled",
        "live",
        "awaiting_report",
        "requires_consensus",
        "disputed",
        "finalized",
        "cancelled",
      ],
      payment_status: [
        "requires_payment",
        "processing",
        "succeeded",
        "failed",
        "refunded",
        "partially_refunded",
      ],
      payout_status: ["pending", "in_transit", "paid", "failed"],
      league_division: ["bronze", "silver", "gold", "platinum", "diamond"],
      league_movement: ["promoted", "held", "relegated"],
      season_status: ["upcoming", "active", "closed"],
      progress_metric: [
        "matches_played",
        "matches_won",
        "goals",
        "assists",
        "clean_sheets",
        "bookings_paid",
        "distinct_venues",
        "reports_filed",
        "consensus_votes",
        "late_matches",
        "hat_tricks",
        "best_unbeaten_run",
        "current_streak_weeks",
        "teams_captained",
      ],
      pitch_surface: ["natural_grass", "artificial_turf", "hybrid", "indoor_court"],
      team_member_role: ["captain", "vice_captain", "member"],
      achievement_tier: ["bronze", "silver", "gold", "platinum"],
      xp_event_kind: [
        "match_played",
        "match_won",
        "match_drawn",
        "goal",
        "assist",
        "clean_sheet",
        "score_reported",
        "consensus_voted",
        "booking_paid",
        "streak_bonus",
        "achievement",
        "challenge",
        "onboarding",
        "admin_adjustment",
      ],
    },
  },
} as const

/** Names any enum whose `Constants` list has drifted from its `Database['public']['Enums']` union. */
export type EnumDrift = {
  [K in keyof Database["public"]["Enums"]]: (typeof Constants)["public"]["Enums"][K][number] extends Database["public"]["Enums"][K]
    ? Database["public"]["Enums"][K] extends (typeof Constants)["public"]["Enums"][K][number]
      ? never
      : K
    : K
}[keyof Database["public"]["Enums"]]

/** Errors at compile time unless `T` is exactly `true`. */
export type Expect<T extends true> = T

/**
 * Compile-time proof that `Constants.public.Enums` never drifts from the `Enums` unions above.
 * If a migration adds an enum value and only one of the two lists is updated, this alias fails
 * to satisfy its constraint and `tsc` points at the offending enum via `EnumDrift`.
 */
export type AssertNoEnumDrift = Expect<[EnumDrift] extends [never] ? true : false>
