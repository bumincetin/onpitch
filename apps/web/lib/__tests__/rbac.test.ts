import { describe, expect, it } from "vitest"

import {
  ACTIONS,
  APP_ROLES,
  PERMISSION_MATRIX,
  RESOURCES,
  canAccess,
  capabilitiesFor,
  type Action,
  type AppRole,
  type Resource,
} from "../rbac"

/**
 * `canAccess()` is a CAPABILITY gate, not an ownership check — "may a venue owner update pitches
 * at all", never "may they update pitch #42". The second question is `private.owns_pitch()` in
 * Postgres and nothing here can weaken it.
 *
 * These tests exist because the matrix is the one place the whole authorisation surface is
 * readable, and every entry in it mirrors a decision already made in SQL. A change here that
 * nobody noticed would put a button in front of somebody the database is going to refuse — or,
 * worse, would quietly widen what the UI is willing to attempt.
 */

describe("the permission matrix", () => {
  it("covers every role and every resource, with no stray entries", () => {
    for (const role of APP_ROLES) {
      const forRole = PERMISSION_MATRIX[role]
      expect(Object.keys(forRole).sort()).toEqual([...RESOURCES].sort())

      for (const resource of RESOURCES) {
        for (const action of forRole[resource]) {
          expect(ACTIONS).toContain(action)
        }
        // No duplicates: a repeated action is a merge artefact, not a permission.
        const actions = forRole[resource]
        expect(new Set(actions).size).toBe(actions.length)
      }
    }
  })

  it("gives delete to nobody but an admin", () => {
    // Profiles are erased by soft-delete, bookings are cancelled and refunded rather than
    // removed, and matches keep their financial and rating history. 0002_rls.sql grants no
    // DELETE on profiles to anyone at all.
    for (const role of APP_ROLES) {
      for (const resource of RESOURCES) {
        const allowed = canAccess(role, resource, "delete")
        expect(allowed, `${role} delete ${resource}`).toBe(role === "admin")
      }
    }
  })

  it("does not let a venue owner create a booking", () => {
    // Facility owners block time via pitch_availability_blocks. A booking is always a customer
    // transaction, and letting an owner mint one would put a charge on a card nobody presented.
    expect(canAccess("venue_owner", "bookings", "create")).toBe(false)
    expect(canAccess("venue_owner", "bookings", "read")).toBe(true)
    expect(canAccess("venue_owner", "bookings", "update")).toBe(true)
  })

  it("lets a player file a score report but never edit one", () => {
    // A filed report is evidence; the anomaly and consensus layers police it from there.
    expect(canAccess("player", "stats", "create")).toBe(true)
    expect(canAccess("player", "stats", "update")).toBe(false)
  })

  it("does not let a player create or update a venue or a pitch", () => {
    for (const resource of ["venues", "pitches"] as const) {
      expect(canAccess("player", resource, "read")).toBe(true)
      expect(canAccess("player", resource, "create")).toBe(false)
      expect(canAccess("player", resource, "update")).toBe(false)
    }
  })

  it("gives an admin everything", () => {
    for (const resource of RESOURCES) {
      for (const action of ACTIONS) {
        expect(canAccess("admin", resource, action)).toBe(true)
      }
    }
  })

  it("never grants an action a role's own matrix entry does not list", () => {
    for (const role of APP_ROLES) {
      for (const resource of RESOURCES) {
        for (const action of ACTIONS) {
          expect(canAccess(role, resource, action)).toBe(
            PERMISSION_MATRIX[role][resource].includes(action),
          )
        }
      }
    }
  })
})

describe("canAccess", () => {
  it("refuses when there is no role at all", () => {
    for (const value of [null, undefined] as const) {
      for (const resource of RESOURCES) {
        for (const action of ACTIONS) {
          expect(canAccess(value, resource, action)).toBe(false)
        }
      }
    }
  })

  it("refuses an unknown role or resource rather than throwing", () => {
    expect(canAccess("superuser" as AppRole, "bookings", "read")).toBe(false)
    expect(canAccess("player", "secrets" as Resource, "read")).toBe(false)
    expect(canAccess("player", "bookings", "purge" as Action)).toBe(false)
  })
})

describe("capabilitiesFor", () => {
  it("lists exactly the pairs the matrix holds", () => {
    for (const role of APP_ROLES) {
      const capabilities = capabilitiesFor(role)
      const expected = RESOURCES.flatMap((resource) =>
        PERMISSION_MATRIX[role][resource].map((action) => `${resource}:${action}`),
      )
      expect([...capabilities].sort()).toEqual(expected.sort())
    }
  })

  it("gives an admin strictly more than a venue owner, and a venue owner more than a player", () => {
    const size = (role: AppRole) => capabilitiesFor(role).length
    expect(size("admin")).toBeGreaterThan(size("venue_owner"))
    expect(size("admin")).toBeGreaterThan(size("player"))
  })
})
