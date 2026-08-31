import * as THREE from "three"

import { NIGHT } from "./palette"
import { mulberry32, rand, TAU } from "./math"
import {
  beamFadeTexture,
  chainLinkTexture,
  glowTexture,
  groundTexture,
  netTexture,
  skyTexture,
  turfTexture,
  windowTexture,
  type PitchDims,
} from "./textures"

/**
 * The complex: four caged pitches on a concourse, floodlit, with the neighbourhood behind them.
 *
 * Everything is built from primitives at runtime — no models, no downloads. The scene is
 * assembled once and then only the atmosphere moves, which keeps the per-frame cost in the
 * player simulation where it belongs.
 *
 * Three pitches are in play. The fourth, set back and half-dark, is finished for the night; it
 * exists to give the hero shot depth and to say that this is a place with a schedule rather
 * than a single stage.
 */

export interface PitchLayout extends PitchDims {
  x: number
  z: number
  /** False for the pitch at the back: masts up, lamps off, nobody on it. */
  lit: boolean
  /** Kit colours for the two sides, when the pitch is in play. */
  kits: readonly [number, number]
}

/**
 * The full complex: three pitches in play and one finished for the night.
 *
 * Pitch long axis runs along Z, so the camera can travel down a touchline.
 */
export const PITCHES: readonly PitchLayout[] = [
  { x: -31, z: 0, width: 22, length: 40, lit: true, kits: [NIGHT.kitGold, NIGHT.kitAzure] },
  { x: 0, z: 0, width: 24, length: 44, lit: true, kits: [NIGHT.kitBone, NIGHT.kitVermilion] },
  { x: 31, z: 0, width: 22, length: 40, lit: true, kits: [NIGHT.kitTeal, NIGHT.kitInk] },
  { x: -16, z: -62, width: 22, length: 40, lit: false, kits: [NIGHT.kitBone, NIGHT.kitInk] },
]

/**
 * One pitch, for the banner that sits at the top of every signed-in page.
 *
 * The full complex is four pitches, twelve floodlight masts and thirty-six figures. That is the
 * right budget for a landing page somebody visits once and scrolls through; it is the wrong
 * budget for a strip 240px tall on a screen people open every day. One pitch costs roughly a
 * quarter of the draw calls and a third of the simulation, and at banner framing there was never
 * anything else in shot.
 */
export const BANNER_PITCHES: readonly PitchLayout[] = [
  { x: 0, z: 0, width: 24, length: 44, lit: true, kits: [NIGHT.kitBone, NIGHT.kitVermilion] },
]

export interface WorldOptions {
  /** Which pitches to build. Defaults to the full complex. */
  pitches?: readonly PitchLayout[]
  /**
   * Drops the skyline, the trees and the moths. The banner keeps the sky and the floodlights —
   * they are the picture — and loses the scenery nobody sees behind 240px of type.
   */
  lite?: boolean
}

const FENCE_H = 4.6
const MAST_H = 11.5

export interface World {
  group: THREE.Group
  /** Lamp-head positions, so the moth swarm and the flares know where the light is. */
  lampPoints: readonly THREE.Vector3[]
  update(elapsed: number, dt: number): void
  dispose(): void
}

/** Everything the world allocates, tracked so a route change can hand it all back. */
interface Disposables {
  geometries: THREE.BufferGeometry[]
  materials: THREE.Material[]
  textures: THREE.Texture[]
}

export function buildWorld(options: WorldOptions = {}): World {
  const layout = options.pitches ?? PITCHES
  const lite = options.lite === true
  const group = new THREE.Group()
  const rng = mulberry32(0x104f)
  const bin: Disposables = { geometries: [], materials: [], textures: [] }

  const keepG = <T extends THREE.BufferGeometry>(g: T): T => (bin.geometries.push(g), g)
  const keepM = <T extends THREE.Material>(m: T): T => (bin.materials.push(m), m)
  const keepT = <T extends THREE.Texture>(t: T): T => (bin.textures.push(t), t)

  /* ------------------------------------------------------------------ sky */

  const sky = new THREE.Mesh(
    keepG(new THREE.SphereGeometry(340, 32, 20)),
    keepM(
      new THREE.MeshBasicMaterial({
        map: keepT(skyTexture()),
        side: THREE.BackSide,
        fog: false,
        depthWrite: false,
      }),
    ),
  )
  sky.renderOrder = -10
  group.add(sky)

  const glow = keepT(glowTexture(0.5))

  const moon = new THREE.Sprite(
    keepM(
      new THREE.SpriteMaterial({
        map: glow,
        color: NIGHT.moon,
        transparent: true,
        opacity: 1,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
      }),
    ),
  )
  moon.position.set(84, 104, -178)
  moon.scale.setScalar(46)
  moon.renderOrder = -9
  group.add(moon)

  /* --------------------------------------------------------------- ground */

  const ground = new THREE.Mesh(
    keepG(new THREE.PlaneGeometry(700, 700)),
    keepM(new THREE.MeshLambertMaterial({ map: keepT(groundTexture()), color: 0xffffff })),
  )
  ground.rotation.x = -Math.PI / 2
  group.add(ground)

  /* ------------------------------------------------------------ skyline */

  const blockGeo = keepG(new THREE.BoxGeometry(1, 1, 1))
  const blockCount = lite ? 8 : 22
  const blockMats = [0x71c3, 0x2f81, 0xa14e].map((seed) =>
    keepM(new THREE.MeshBasicMaterial({ map: keepT(windowTexture(seed)), color: 0xffffff })),
  )
  for (const mat of blockMats) {
    const count = blockCount
    const blocks = new THREE.InstancedMesh(blockGeo, mat, count)
    blocks.instanceMatrix.setUsage(THREE.StaticDrawUsage)
    const dummy = new THREE.Object3D()
    for (let i = 0; i < count; i++) {
      // A broken arc behind and beside the complex, never in front of the camera's start.
      const angle = rand(rng, Math.PI * 0.06, Math.PI * 1.94)
      const radius = rand(rng, 235, 400)
      const height = rand(rng, 11, 31)
      dummy.position.set(Math.sin(angle) * radius, height / 2, Math.cos(angle) * radius - 40)
      dummy.rotation.y = angle + rand(rng, -0.3, 0.3)
      dummy.scale.set(rand(rng, 16, 34), height, rand(rng, 16, 28))
      dummy.updateMatrix()
      blocks.setMatrixAt(i, dummy.matrix)
    }
    blocks.instanceMatrix.needsUpdate = true
    group.add(blocks)
  }

  // Poplars along the far edge of the concourse. Silhouettes only; they never catch a lamp.
  const treeGeo = keepG(new THREE.ConeGeometry(2.2, 13, 7))
  const treeMat = keepM(new THREE.MeshLambertMaterial({ color: 0x080c12 }))
  const treeCount = lite ? 0 : 26
  const trees = new THREE.InstancedMesh(treeGeo, treeMat, treeCount)
  {
    const dummy = new THREE.Object3D()
    for (let i = 0; i < treeCount; i++) {
      const side = i % 2 === 0 ? -1 : 1
      dummy.position.set(
        side * rand(rng, 58, 96) + rand(rng, -8, 8),
        rand(rng, 5.5, 8.5),
        rand(rng, -110, 60),
      )
      dummy.rotation.y = rng() * TAU
      dummy.scale.set(rand(rng, 0.7, 1.3), rand(rng, 0.8, 1.5), rand(rng, 0.7, 1.3))
      dummy.updateMatrix()
      trees.setMatrixAt(i, dummy.matrix)
    }
    trees.instanceMatrix.needsUpdate = true
  }
  group.add(trees)

  /* --------------------------------------------------------------- pitches */

  const chain = keepT(chainLinkTexture())
  const beamFade = keepT(beamFadeTexture())
  const net = keepT(netTexture())
  const steelMat = keepM(new THREE.MeshLambertMaterial({ color: NIGHT.steel }))
  const frameMat = keepM(new THREE.MeshLambertMaterial({ color: NIGHT.frame }))
  const lampPoints: THREE.Vector3[] = []

  for (const pitch of layout) {
    const pad = new THREE.Group()
    pad.position.set(pitch.x, 0, pitch.z)
    group.add(pad)

    /* turf */
    const turfTex = keepT(turfTexture(pitch))
    const turf = new THREE.Mesh(
      keepG(new THREE.PlaneGeometry(pitch.width, pitch.length)),
      keepM(new THREE.MeshLambertMaterial({ map: turfTex, color: pitch.lit ? 0xffffff : 0x4a5566 })),
    )
    turf.rotation.x = -Math.PI / 2
    turf.position.y = 0.02
    pad.add(turf)

    /* fence — four cutout panels plus a top rail */
    const halfW = pitch.width / 2 + 1.2
    const halfL = pitch.length / 2 + 1.2
    const fenceMatLong = keepM(
      new THREE.MeshLambertMaterial({
        map: chain.clone(),
        transparent: false,
        alphaTest: 0.42,
        side: THREE.DoubleSide,
        color: pitch.lit ? 0x9aa6b8 : 0x4a5262,
      }),
    )
    const fenceMatShort = keepM(fenceMatLong.clone())
    if (fenceMatLong.map) {
      bin.textures.push(fenceMatLong.map)
      fenceMatLong.map.repeat.set(pitch.length / 0.7, FENCE_H / 0.7)
    }
    if (fenceMatShort.map) {
      fenceMatShort.map = fenceMatShort.map.clone()
      bin.textures.push(fenceMatShort.map)
      fenceMatShort.map.repeat.set(pitch.width / 0.7, FENCE_H / 0.7)
      fenceMatShort.map.needsUpdate = true
    }

    const longGeo = keepG(new THREE.PlaneGeometry(pitch.length, FENCE_H))
    const shortGeo = keepG(new THREE.PlaneGeometry(pitch.width + 2.4, FENCE_H))

    for (const sx of [-1, 1] as const) {
      const panel = new THREE.Mesh(longGeo, fenceMatLong)
      panel.position.set(sx * halfW, FENCE_H / 2, 0)
      panel.rotation.y = Math.PI / 2
      pad.add(panel)
    }
    for (const sz of [-1, 1] as const) {
      const panel = new THREE.Mesh(shortGeo, fenceMatShort)
      panel.position.set(0, FENCE_H / 2, sz * halfL)
      pad.add(panel)
    }

    /* fence posts */
    const postGeo = keepG(new THREE.CylinderGeometry(0.075, 0.075, FENCE_H + 0.3, 6))
    const posts: THREE.Vector3[] = []
    for (let z = -halfL; z <= halfL + 0.01; z += pitch.length / 8) {
      posts.push(new THREE.Vector3(-halfW, 0, z), new THREE.Vector3(halfW, 0, z))
    }
    for (let x = -halfW; x <= halfW + 0.01; x += pitch.width / 5) {
      posts.push(new THREE.Vector3(x, 0, -halfL), new THREE.Vector3(x, 0, halfL))
    }
    const postMesh = new THREE.InstancedMesh(postGeo, steelMat, posts.length)
    {
      const dummy = new THREE.Object3D()
      posts.forEach((p, i) => {
        dummy.position.set(p.x, (FENCE_H + 0.3) / 2, p.z)
        dummy.rotation.set(0, 0, 0)
        dummy.scale.setScalar(1)
        dummy.updateMatrix()
        postMesh.setMatrixAt(i, dummy.matrix)
      })
      postMesh.instanceMatrix.needsUpdate = true
    }
    pad.add(postMesh)

    /* goals */
    const goalW = 5
    const goalH = 2
    const goalD = 1.4
    const barGeo = keepG(new THREE.CylinderGeometry(0.06, 0.06, goalH, 8))
    const crossGeo = keepG(new THREE.CylinderGeometry(0.06, 0.06, goalW, 8))
    const netMat = keepM(
      new THREE.MeshLambertMaterial({
        map: net,
        alphaTest: 0.35,
        side: THREE.DoubleSide,
        color: 0xb9c4cc,
      }),
    )
    const netBack = keepG(new THREE.PlaneGeometry(goalW, goalH))
    const netSide = keepG(new THREE.PlaneGeometry(goalD, goalH))

    for (const sz of [-1, 1] as const) {
      const goal = new THREE.Group()
      goal.position.set(0, 0, sz * (pitch.length / 2 - 0.6))
      goal.rotation.y = sz > 0 ? 0 : Math.PI
      for (const sx of [-1, 1] as const) {
        const post = new THREE.Mesh(barGeo, frameMat)
        post.position.set((sx * goalW) / 2, goalH / 2, 0)
        goal.add(post)
      }
      const cross = new THREE.Mesh(crossGeo, frameMat)
      cross.rotation.z = Math.PI / 2
      cross.position.y = goalH
      goal.add(cross)

      const back = new THREE.Mesh(netBack, netMat)
      back.position.set(0, goalH / 2, goalD)
      goal.add(back)
      for (const sx of [-1, 1] as const) {
        const side = new THREE.Mesh(netSide, netMat)
        side.position.set((sx * goalW) / 2, goalH / 2, goalD / 2)
        side.rotation.y = Math.PI / 2
        goal.add(side)
      }
      pad.add(goal)
    }

    /* floodlight masts at the four corners */
    const mastGeo = keepG(new THREE.CylinderGeometry(0.16, 0.26, MAST_H, 8))
    const headGeo = keepG(new THREE.BoxGeometry(2.6, 0.26, 0.9))
    const lampGeo = keepG(new THREE.PlaneGeometry(0.9, 0.62))
    const lampOnMat = keepM(new THREE.MeshBasicMaterial({ color: 0xfff3d8, fog: false }))
    const lampOffMat = keepM(new THREE.MeshBasicMaterial({ color: 0x30384a, fog: false }))
    const coneMat = keepM(
      new THREE.MeshBasicMaterial({
        color: NIGHT.lamp,
        transparent: true,
        opacity: 0.02,
        alphaMap: beamFade,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.BackSide,
        fog: false,
      }),
    )
    const coneGeo = keepG(new THREE.ConeGeometry(8.5, MAST_H + 1, 20, 1, true))
    const flareMat = keepM(
      new THREE.SpriteMaterial({
        map: glow,
        color: NIGHT.lamp,
        transparent: true,
        opacity: pitch.lit ? 0.6 : 0.04,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
      }),
    )
    const poolMat = keepM(
      new THREE.MeshBasicMaterial({
        map: glow,
        color: NIGHT.lamp,
        transparent: true,
        opacity: 0.085,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    )
    const poolGeo = keepG(new THREE.PlaneGeometry(26, 26))

    for (const sx of [-1, 1] as const) {
      for (const sz of [-1, 1] as const) {
        const mx = sx * (halfW + 1.6)
        const mz = sz * (halfL * 0.62)

        const mast = new THREE.Mesh(mastGeo, steelMat)
        mast.position.set(mx, MAST_H / 2, mz)
        pad.add(mast)

        const head = new THREE.Mesh(headGeo, steelMat)
        head.position.set(mx, MAST_H, mz)
        head.rotation.y = sx > 0 ? -0.5 : 0.5
        pad.add(head)

        // Lamp faces point inward and down at the pitch.
        for (let i = 0; i < 3; i++) {
          const lamp = new THREE.Mesh(lampGeo, pitch.lit ? lampOnMat : lampOffMat)
          lamp.position.set(mx - sx * (0.9 - i * 0.9), MAST_H - 0.24, mz + 0.1)
          lamp.rotation.set(-Math.PI / 3, sx > 0 ? 0.5 : -0.5, 0)
          pad.add(lamp)
        }

        const flare = new THREE.Sprite(flareMat)
        flare.position.set(mx, MAST_H - 0.2, mz)
        flare.scale.setScalar(pitch.lit ? 2.3 : 0.9)
        pad.add(flare)

        if (!pitch.lit) continue

        lampPoints.push(new THREE.Vector3(pitch.x + mx, MAST_H - 0.2, pitch.z + mz))

        const cone = new THREE.Mesh(coneGeo, coneMat)
        cone.position.set(mx * 0.72, (MAST_H + 1) / 2, mz * 0.72)
        pad.add(cone)

        const pool = new THREE.Mesh(poolGeo, poolMat)
        pool.rotation.x = -Math.PI / 2
        pool.position.set(mx * 0.55, 0.06, mz * 0.55)
        pad.add(pool)
      }
    }

    /* One real light per pitch. Four would be honest and four times the cost; the pools above
       carry the corner falloff, and this carries the shading on the players. */
    if (pitch.lit) {
      const key = new THREE.PointLight(NIGHT.lamp, 780, 120, 2)
      key.position.set(pitch.x, 12, pitch.z)
      group.add(key)
    }
  }

  /* ----------------------------------------------------------------- moths */

  const mothCount = lite ? 90 : 260
  const mothPos = new Float32Array(mothCount * 3)
  const mothSeed = new Float32Array(mothCount * 3)
  for (let i = 0; i < mothCount; i++) {
    const anchor = lampPoints[i % Math.max(1, lampPoints.length)]
    const ax = anchor?.x ?? 0
    const ay = anchor?.y ?? MAST_H
    const az = anchor?.z ?? 0
    mothPos[i * 3] = ax + rand(rng, -3.5, 3.5)
    mothPos[i * 3 + 1] = ay + rand(rng, -2.6, 1.4)
    mothPos[i * 3 + 2] = az + rand(rng, -3.5, 3.5)
    mothSeed[i * 3] = ax
    mothSeed[i * 3 + 1] = ay
    mothSeed[i * 3 + 2] = az
  }
  const mothGeo = keepG(new THREE.BufferGeometry())
  mothGeo.setAttribute("position", new THREE.BufferAttribute(mothPos, 3))
  const moths = new THREE.Points(
    mothGeo,
    keepM(
      new THREE.PointsMaterial({
        map: glow,
        color: NIGHT.lamp,
        size: 0.34,
        sizeAttenuation: true,
        transparent: true,
        opacity: 0.75,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
      }),
    ),
  )
  group.add(moths)

  const mothPhase = new Float32Array(mothCount)
  for (let i = 0; i < mothCount; i++) mothPhase[i] = rng() * TAU

  /* ------------------------------------------------------------------ api */

  function update(elapsed: number): void {
    const attr = mothGeo.getAttribute("position") as THREE.BufferAttribute
    const arr = attr.array as Float32Array
    for (let i = 0; i < mothCount; i++) {
      const p = mothPhase[i] ?? 0
      const r = 1.4 + (i % 5) * 0.5
      arr[i * 3] = (mothSeed[i * 3] ?? 0) + Math.sin(elapsed * (0.5 + (i % 7) * 0.12) + p) * r
      arr[i * 3 + 1] =
        (mothSeed[i * 3 + 1] ?? 0) - 1.1 + Math.sin(elapsed * (0.9 + (i % 4) * 0.2) + p * 2) * 1.3
      arr[i * 3 + 2] = (mothSeed[i * 3 + 2] ?? 0) + Math.cos(elapsed * (0.42 + (i % 6) * 0.1) + p) * r
    }
    attr.needsUpdate = true
  }

  function dispose(): void {
    for (const g of bin.geometries) g.dispose()
    for (const m of bin.materials) m.dispose()
    for (const t of bin.textures) t.dispose()
  }

  return { group, lampPoints, update, dispose }
}
