import * as THREE from "three"

import { NIGHT } from "./palette"
import { clamp, mulberry32, rand, TAU } from "./math"
import { glowTexture } from "./textures"
import { PITCHES, type PitchLayout } from "./world"

/**
 * The people on the pitches.
 *
 * Thirty-six figures across three matches, each one four instanced primitives — torso, head and
 * two legs — plus a soft blob for contact shadow. Instancing is what makes the count affordable:
 * five draw calls in total, regardless of how many are playing.
 *
 * The simulation is deliberately crude. Nobody is running a tactical model; each side has a
 * shape that slides with the ball, the two nearest players chase it, the keeper tracks it along
 * his line, and whoever reaches it kicks it somewhere plausible. From the camera distances this
 * scene ever uses, that is indistinguishable from football, and it costs nothing.
 */

const OUTFIELD = 5
const PER_TEAM = OUTFIELD + 1 // plus a keeper
const SHADOW_Y = 0.03

interface Player {
  pitch: number
  team: 0 | 1
  keeper: boolean
  /** Formation slot in pitch-local space, before the ball pulls the shape around. */
  slotX: number
  slotZ: number
  x: number
  z: number
  vx: number
  vz: number
  /** Run-cycle phase, advanced by distance covered so the legs never skate. */
  gait: number
  heading: number
  /** Small per-player speed variation — a pick-up side is not a squad of clones. */
  pace: number
}

interface Ball {
  x: number
  z: number
  vx: number
  vz: number
  y: number
  vy: number
  /** Frames of grace after a kick, so one player cannot pinball it. */
  cooldown: number
}

export interface Crowd {
  group: THREE.Group
  update(dt: number): void
  dispose(): void
}

/** 3-2 in front of a keeper, mirrored for the away side. Metres, pitch-local. */
const SHAPE: readonly (readonly [number, number])[] = [
  [-0.30, -0.06],
  [0.0, -0.14],
  [0.30, -0.06],
  [-0.17, 0.18],
  [0.17, 0.18],
]

export interface CrowdOptions {
  /** Which pitches to populate. Defaults to the full complex. */
  pitches?: readonly PitchLayout[]
}

export function buildCrowd(options: CrowdOptions = {}): Crowd {
  const rng = mulberry32(0x7c31)
  const group = new THREE.Group()
  const liveSahalar = (options.pitches ?? PITCHES).filter((p) => p.lit)

  /* ------------------------------------------------------------- population */

  const players: Player[] = []
  const balls: Ball[] = []

  liveSahalar.forEach((pitch, pi) => {
    balls.push({ x: 0, z: 0, vx: rand(rng, -3, 3), vz: rand(rng, -3, 3), y: 0.11, vy: 0, cooldown: 0 })

    for (const team of [0, 1] as const) {
      const dir = team === 0 ? -1 : 1 // team 0 attacks -Z, team 1 attacks +Z
      for (let i = 0; i < PER_TEAM; i++) {
        const keeper = i === OUTFIELD
        const slot = SHAPE[i]
        const slotX = keeper ? 0 : (slot?.[0] ?? 0) * pitch.width
        const slotZ = keeper
          ? dir * (pitch.length / 2 - 2.2)
          : (0.14 + (slot?.[1] ?? 0)) * dir * pitch.length

        players.push({
          pitch: pi,
          team,
          keeper,
          slotX,
          slotZ,
          x: slotX + rand(rng, -1, 1),
          z: slotZ + rand(rng, -1, 1),
          vx: 0,
          vz: 0,
          gait: rng() * TAU,
          heading: 0,
          pace: rand(rng, 0.86, 1.16),
        })
      }
    }
  })

  const count = players.length

  /* -------------------------------------------------------------- geometry */

  const bin: (THREE.BufferGeometry | THREE.Material | THREE.Texture)[] = []
  const keep = <T extends THREE.BufferGeometry | THREE.Material | THREE.Texture>(x: T): T => (
    bin.push(x), x
  )

  const torsoGeo = keep(new THREE.CapsuleGeometry(0.2, 0.46, 3, 8))
  const headGeo = keep(new THREE.SphereGeometry(0.125, 8, 6))
  const legGeo = keep(new THREE.BoxGeometry(0.11, 0.66, 0.14))
  // Legs pivot at the hip, so the origin is moved to the top of the box.
  legGeo.translate(0, -0.33, 0)

  const kitMat = keep(new THREE.MeshLambertMaterial({ color: 0xffffff }))
  const skinMat = keep(new THREE.MeshLambertMaterial({ color: NIGHT.limb }))
  const legMat = keep(new THREE.MeshLambertMaterial({ color: 0x252c39 }))

  const torso = new THREE.InstancedMesh(torsoGeo, kitMat, count)
  const head = new THREE.InstancedMesh(headGeo, skinMat, count)
  const legs = new THREE.InstancedMesh(legGeo, legMat, count * 2)
  torso.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  head.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  legs.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  group.add(torso, head, legs)

  const shadowTex = keep(glowTexture(0.02))
  const shadow = new THREE.InstancedMesh(
    keep(new THREE.PlaneGeometry(1.15, 1.15)),
    keep(
      new THREE.MeshBasicMaterial({
        map: shadowTex,
        color: 0x000000,
        transparent: true,
        opacity: 0.5,
        depthWrite: false,
        blending: THREE.NormalBlending,
      }),
    ),
    count,
  )
  shadow.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  shadow.renderOrder = 1
  group.add(shadow)

  const ballMesh = new THREE.InstancedMesh(
    keep(new THREE.SphereGeometry(0.11, 10, 8)),
    keep(new THREE.MeshLambertMaterial({ color: 0xf2f4ee })),
    balls.length,
  )
  ballMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  group.add(ballMesh)

  // Kit colours are per-instance, so both sides of three different matches share one draw call.
  const tint = new THREE.Color()
  players.forEach((p, i) => {
    const layout = liveSahalar[p.pitch]
    const kit = layout?.kits[p.team] ?? NIGHT.kitBone
    // Keepers wear something neither side is wearing. Everyone has played that game.
    tint.setHex(p.keeper ? NIGHT.kitTeal : kit)
    if (p.keeper && kit === NIGHT.kitTeal) tint.setHex(NIGHT.kitGold)
    torso.setColorAt(i, tint)
  })
  if (torso.instanceColor) torso.instanceColor.needsUpdate = true

  /* ------------------------------------------------------------ simulation */

  const dummy = new THREE.Object3D()

  function pitchOf(index: number): PitchLayout | undefined {
    return liveSahalar[index]
  }

  function stepBall(ball: Ball, pitch: PitchLayout, dt: number): void {
    ball.cooldown = Math.max(0, ball.cooldown - dt)

    ball.x += ball.vx * dt
    ball.z += ball.vz * dt

    // Bounce off the boards. OnPitch is a cage; the ball never really goes out.
    const bx = pitch.width / 2 - 0.6
    const bz = pitch.length / 2 - 0.6
    if (ball.x < -bx || ball.x > bx) {
      ball.x = clamp(ball.x, -bx, bx)
      ball.vx *= -0.72
    }
    if (ball.z < -bz || ball.z > bz) {
      ball.z = clamp(ball.z, -bz, bz)
      ball.vz *= -0.72
    }

    // Rolling friction, plus a floor so play never stalls into a still life.
    const drag = Math.exp(-1.15 * dt)
    ball.vx *= drag
    ball.vz *= drag
    const speed = Math.hypot(ball.vx, ball.vz)
    if (speed < 0.8) {
      const a = rng() * TAU
      ball.vx += Math.cos(a) * 0.9
      ball.vz += Math.sin(a) * 0.9
    }

    // A low hop after a hard contact, so the ball is not glued to the surface.
    ball.vy -= 12 * dt
    ball.y += ball.vy * dt
    if (ball.y < 0.11) {
      ball.y = 0.11
      ball.vy = Math.abs(ball.vy) * 0.34
      if (ball.vy < 0.4) ball.vy = 0
    }
  }

  function update(dt: number): void {
    const step = clamp(dt, 0, 0.05)

    for (let b = 0; b < balls.length; b++) {
      const ball = balls[b]
      const pitch = pitchOf(b)
      if (!ball || !pitch) continue
      stepBall(ball, pitch, step)
      dummy.position.set(pitch.x + ball.x, ball.y, pitch.z + ball.z)
      dummy.rotation.set(ball.z * 2.2, 0, -ball.x * 2.2)
      dummy.scale.setScalar(1)
      dummy.updateMatrix()
      ballMesh.setMatrixAt(b, dummy.matrix)
    }
    ballMesh.instanceMatrix.needsUpdate = true

    // Rank each side by distance to the ball once per frame; the two closest press it.
    const rank = new Map<string, number[]>()
    players.forEach((p, i) => {
      const ball = balls[p.pitch]
      if (!ball || p.keeper) return
      const key = `${p.pitch}:${p.team}`
      const list = rank.get(key) ?? []
      list.push(i)
      rank.set(key, list)
    })
    const chasers = new Set<number>()
    for (const list of rank.values()) {
      list.sort((a, b) => {
        const pa = players[a]
        const pb = players[b]
        if (!pa || !pb) return 0
        const ba = balls[pa.pitch]
        if (!ba) return 0
        return (
          Math.hypot(pa.x - ba.x, pa.z - ba.z) - Math.hypot(pb.x - ba.x, pb.z - ba.z)
        )
      })
      const first = list[0]
      const second = list[1]
      if (first !== undefined) chasers.add(first)
      if (second !== undefined) chasers.add(second)
    }

    /* Personal space. Without it the two pressing players and whoever they are pressing all
       converge on the same coordinate and render as one thick figure. A metre of separation is
       what stops a chase looking like a merge. */
    for (let i = 0; i < count; i++) {
      const a = players[i]
      if (!a) continue
      for (let j = i + 1; j < count; j++) {
        const b = players[j]
        if (!b || b.pitch !== a.pitch) continue
        const dx = b.x - a.x
        const dz = b.z - a.z
        const d2 = dx * dx + dz * dz
        if (d2 > 1.21 || d2 < 1e-6) continue
        const d = Math.sqrt(d2)
        const push = ((1.1 - d) / d) * 0.5
        a.x -= dx * push
        a.z -= dz * push
        b.x += dx * push
        b.z += dz * push
      }
    }

    for (let i = 0; i < count; i++) {
      const p = players[i]
      if (!p) continue
      const pitch = pitchOf(p.pitch)
      const ball = balls[p.pitch]
      if (!pitch || !ball) continue

      /* ---- where this player wants to be */
      let tx: number
      let tz: number
      if (p.keeper) {
        tx = clamp(ball.x * 0.42, -2.2, 2.2)
        tz = p.slotZ
      } else if (chasers.has(i)) {
        tx = ball.x
        tz = ball.z
      } else {
        // The shape slides toward the ball rather than holding a rigid grid.
        tx = p.slotX + ball.x * 0.36
        tz = p.slotZ + ball.z * 0.30
      }

      const dx = tx - p.x
      const dz = tz - p.z
      const dist = Math.hypot(dx, dz) || 1e-4
      const top = (p.keeper ? 2.6 : chasers.has(i) ? 6.4 : 3.6) * p.pace
      const desiredX = (dx / dist) * Math.min(top, dist * 3.2)
      const desiredZ = (dz / dist) * Math.min(top, dist * 3.2)

      p.vx += (desiredX - p.vx) * Math.min(1, step * 6)
      p.vz += (desiredZ - p.vz) * Math.min(1, step * 6)
      p.x += p.vx * step
      p.z += p.vz * step

      const bx = pitch.width / 2 - 0.5
      const bz = pitch.length / 2 - 0.5
      p.x = clamp(p.x, -bx, bx)
      p.z = clamp(p.z, -bz, bz)

      /* ---- contact with the ball */
      if (ball.cooldown <= 0) {
        const reach = Math.hypot(p.x - ball.x, p.z - ball.z)
        if (reach < 0.62) {
          const goalZ = (p.team === 0 ? -1 : 1) * (pitch.length / 2 - 0.6)
          // Aim at the goal, but only loosely — most of these are clearances, not passes.
          const aimX = rand(rng, -pitch.width * 0.34, pitch.width * 0.34)
          const ax = aimX - ball.x
          const az = goalZ - ball.z
          const an = Math.hypot(ax, az) || 1
          const power = rand(rng, 6, 15)
          ball.vx = (ax / an) * power + rand(rng, -2.4, 2.4)
          ball.vz = (az / an) * power + rand(rng, -2.4, 2.4)
          ball.vy = rng() > 0.62 ? rand(rng, 1.4, 3.4) : 0
          ball.cooldown = rand(rng, 0.35, 0.75)
        }
      }

      /* ---- pose */
      const speed = Math.hypot(p.vx, p.vz)
      p.gait += speed * step * 3.1
      if (speed > 0.12) {
        const want = Math.atan2(p.vx, p.vz)
        let delta = want - p.heading
        while (delta > Math.PI) delta -= TAU
        while (delta < -Math.PI) delta += TAU
        p.heading += delta * Math.min(1, step * 9)
      }

      const swing = Math.sin(p.gait) * clamp(speed * 0.16, 0.06, 0.75)
      const bob = Math.abs(Math.cos(p.gait)) * clamp(speed * 0.014, 0, 0.07)
      const lean = clamp(speed * 0.035, 0, 0.26)

      const wx = pitch.x + p.x
      const wz = pitch.z + p.z

      dummy.position.set(wx, 1.06 + bob, wz)
      dummy.rotation.set(lean, p.heading, 0)
      dummy.scale.setScalar(1)
      dummy.updateMatrix()
      torso.setMatrixAt(i, dummy.matrix)

      dummy.position.set(wx, 1.44 + bob, wz)
      dummy.rotation.set(0, p.heading, 0)
      dummy.updateMatrix()
      head.setMatrixAt(i, dummy.matrix)

      for (const side of [0, 1] as const) {
        const sign = side === 0 ? 1 : -1
        dummy.position.set(wx, 0.78 + bob, wz)
        dummy.rotation.set(swing * sign, p.heading, 0)
        dummy.updateMatrix()
        legs.setMatrixAt(i * 2 + side, dummy.matrix)
      }

      dummy.position.set(wx, SHADOW_Y, wz)
      dummy.rotation.set(-Math.PI / 2, 0, 0)
      dummy.scale.setScalar(1 - bob * 2)
      dummy.updateMatrix()
      shadow.setMatrixAt(i, dummy.matrix)
    }

    torso.instanceMatrix.needsUpdate = true
    head.instanceMatrix.needsUpdate = true
    legs.instanceMatrix.needsUpdate = true
    shadow.instanceMatrix.needsUpdate = true
  }

  // One settling pass so the first painted frame is a match in progress, not a kick-off grid.
  for (let i = 0; i < 220; i++) update(1 / 60)

  function dispose(): void {
    for (const item of bin) item.dispose()
    torso.dispose()
    head.dispose()
    legs.dispose()
    shadow.dispose()
    ballMesh.dispose()
  }

  return { group, update, dispose }
}
