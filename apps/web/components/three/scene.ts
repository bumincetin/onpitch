import * as THREE from "three"
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js"
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js"
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js"
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js"
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js"

import { NIGHT } from "./palette"
import { clamp, damp, lerp } from "./math"
import { grainTexture } from "./textures"
import { BANNER_PITCHES, buildWorld } from "./world"
import { buildCrowd } from "./players"

/**
 * The scroll-driven camera and the render loop.
 *
 * One continuous path threads every chapter: the waypoints below are control points on a
 * Catmull-Rom spline, and scroll position picks a fractional index into it. Nothing cuts. The
 * reason to spend a spline on this rather than snapping between shots is that a cut needs a
 * reason — a match has no cuts, you walk around it — and a spline lets a section's shot be
 * composed while the transitions into and out of it stay continuous.
 */

interface Waypoint {
  /** Camera position. */
  p: readonly [number, number, number]
  /** Look-at target. */
  t: readonly [number, number, number]
  fov: number
}

/**
 * Seven shots, in scroll order:
 *   0  outside the complex, high and wide — all four pitches, the city behind
 *   1  at the touchline of the centre pitch, looking in through the cage
 *   2  behind the north goal, down the length of the pitch
 *   3  on the pitch at boot height, inside the game
 *   4  lifted above the centre circle, looking back down
 *   5  away and high, the complex reduced to three pools of light
 *   6  gone — the lights receding as the page hands over to type
 */
const SHOTS: readonly Waypoint[] = [
  { p: [0, 25, 80], t: [0, 2, -12], fov: 35 },
  { p: [-16.2, 2.3, 6], t: [4, 1.5, -9], fov: 56 },
  { p: [0.5, 2.0, 31], t: [0.2, 2.3, 3], fov: 46 },
  { p: [9.5, 1.35, 2], t: [-3, 1.25, -4], fov: 62 },
  { p: [4, 16, -14], t: [0, 1.5, 2], fov: 44 },
  { p: [-26, 34, -64], t: [-4, 3, -6], fov: 46 },
  { p: [-8, 62, -108], t: [0, 0, -20], fov: 40 },
]

/**
 * The banner presets.
 *
 * A banner is a fixed strip at the top of a signed-in page, not a scroll experience, so it gets
 * ONE composed shot and a slow drift rather than a spline. Each page picks the shot that matches
 * what it is about — the ranking looks down from the stand, a match page stands in the goalmouth,
 * team creation waits in the tunnel — which is what stops twenty pages sharing one wallpaper.
 *
 * Coordinates are for the single banner pitch at the origin (24 x 44), not the full complex.
 */
export const BANNER_SHOTS = {
  /** Above the corner flag, the whole pitch in frame. The default. */
  stands: { p: [20, 8.5, 30], t: [0, 1.5, -2], fov: 42 },
  /** Boot height at the centre circle, players running past. */
  centre: { p: [9.5, 1.35, 2], t: [-3, 1.25, -4], fov: 62 },
  /** Behind the goal, down the length of the pitch. */
  goalmouth: { p: [0.5, 2, 30], t: [0.2, 2.3, 2], fov: 46 },
  /** Outside the cage, looking in through the chain link. */
  touchline: { p: [-16.5, 2.3, 6], t: [4, 1.5, -9], fov: 56 },
  /** High and square on, the markings legible. */
  aerial: { p: [4, 22, 20], t: [0, 0, -4], fov: 38 },
  /** Walking in, low and central. */
  tunnel: { p: [0, 1.6, 34], t: [0, 2.2, 0], fov: 52 },
} as const

export type BannerShot = keyof typeof BANNER_SHOTS

const GRAIN_SHADER = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    tGrain: { value: null as THREE.Texture | null },
    uScale: { value: new THREE.Vector2(1, 1) },
    uOffset: { value: new THREE.Vector2(0, 0) },
    uGrain: { value: 0.055 },
    uVignette: { value: 0.85 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform sampler2D tGrain;
    uniform vec2 uScale;
    uniform vec2 uOffset;
    uniform float uGrain;
    uniform float uVignette;
    varying vec2 vUv;

    void main() {
      vec4 c = texture2D(tDiffuse, vUv);

      // Vignette. Floodlights are the only light source here, so the frame has to fall off
      // hard at the edges or the whole image reads as evenly, unbelievably lit.
      float r = length(vUv - 0.5);
      float v = smoothstep(0.86, 0.24, r);
      c.rgb *= mix(1.0, v, uVignette);

      // Film grain, sampled at 1:1 device pixels and scrolled each frame.
      float g = texture2D(tGrain, vUv * uScale + uOffset).r - 0.5;
      c.rgb += g * uGrain;

      gl_FragColor = c;
    }
  `,
}

export interface NightPitchOptions {
  /**
   * `scroll` threads the whole complex on a spline driven by page scroll — the landing page.
   * `banner` builds one pitch, holds one composed shot and drifts slowly — every other page.
   */
  mode?: "scroll" | "banner"
  /** Banner mode only: which composed shot to hold. Defaults to `stands`. */
  shot?: BannerShot
  /** Scroll mode only: elements in scroll order, one per waypoint. */
  sections?: HTMLElement[]
  /**
   * Scroll mode only. Below this document offset the canvas is fully covered by opaque content,
   * so there is nothing to draw. Null keeps the loop running for the whole page.
   */
  coverAt?: () => number | null
  /** Honour `prefers-reduced-motion`: paint one composed frame and stop. */
  reducedMotion: boolean
  /** Called once the first frame has actually been presented, to fade the canvas in. */
  onReady?: () => void
  /**
   * Pauses the loop when the canvas is off screen. A banner scrolls out of view within one
   * screen height and there is no reason to keep rendering it after that.
   */
  isVisible?: () => boolean
}

export interface NightPitchHandle {
  dispose(): void
}

/**
 * `WebGLRenderer` throws rather than returning null when there is no context, and a landing
 * page must never be a blank screen because a driver is blocklisted.
 */
export function createNightPitch(
  canvas: HTMLCanvasElement,
  options: NightPitchOptions,
): NightPitchHandle | null {
  let renderer: THREE.WebGLRenderer
  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false, // the bloom and grain passes hide the edges; MSAA here is wasted fill
      powerPreference: "high-performance",
      alpha: false,
      stencil: false,
      depth: true,
    })
  } catch {
    return null
  }

  const maxDpr = 1.85
  let dprScale = 1
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, maxDpr))
  renderer.setSize(window.innerWidth, window.innerHeight, false)
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.05
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.setClearColor(NIGHT.skyHigh, 1)

  const scene = new THREE.Scene()
  scene.fog = new THREE.FogExp2(0x080d16, 0.0042)

  const camera = new THREE.PerspectiveCamera(
    SHOTS[0]?.fov ?? 35,
    window.innerWidth / window.innerHeight,
    0.3,
    460,
  )

  /* ------------------------------------------------------------------ lights */

  // Two ambient sources only. Everything else in the frame is emissive geometry, which is what
  // makes the floodlights feel like the source rather than a decoration on top of daylight.
  const hemi = new THREE.HemisphereLight(0x1b2740, 0x05070c, 0.55)
  scene.add(hemi)

  const moonLight = new THREE.DirectionalLight(0x9fb4d4, 0.35)
  moonLight.position.set(-120, 90, -140)
  scene.add(moonLight)

  /* ------------------------------------------------------------------- world */

  const banner = options.mode === "banner"
  const pitches = banner ? BANNER_PITCHES : undefined

  const world = buildWorld({ pitches, lite: banner })
  scene.add(world.group)

  const crowd = buildCrowd({ pitches })
  scene.add(crowd.group)

  /* -------------------------------------------------------------------- post */

  const composer = new EffectComposer(renderer)
  composer.addPass(new RenderPass(scene, camera))

  const bloom = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    0.58, // strength
    0.42, // radius
    0.82, // threshold — the lamps and nothing else; at 0.58 the turf itself bloomed
  )
  composer.addPass(bloom)
  composer.addPass(new OutputPass())

  const grain = grainTexture()
  const grainPass = new ShaderPass(GRAIN_SHADER)
  /* ShaderPass types its uniforms as an open string map, so every access is `possibly
     undefined` under `noUncheckedIndexedAccess`. The pass clones the literal above verbatim,
     so naming that shape once here is accurate rather than a way around the checker. */
  const grainUniforms = grainPass.uniforms as typeof GRAIN_SHADER.uniforms
  grainUniforms.tGrain.value = grain
  grainPass.renderToScreen = true
  composer.addPass(grainPass)

  /* --------------------------------------------------------------------- rig */

  const curveP = new THREE.CatmullRomCurve3(
    SHOTS.map((s) => new THREE.Vector3(s.p[0], s.p[1], s.p[2])),
    false,
    "catmullrom",
    0.4,
  )
  const curveT = new THREE.CatmullRomCurve3(
    SHOTS.map((s) => new THREE.Vector3(s.t[0], s.t[1], s.t[2])),
    false,
    "catmullrom",
    0.4,
  )

  const rig = { target: 0, smooth: 0, mx: 0, my: 0, tmx: 0, tmy: 0, intro: 0 }

  /** Banner mode holds one shot; the spline above is only wired up for scroll mode. */
  const shot = BANNER_SHOTS[options.shot ?? "stands"]
  const _p = new THREE.Vector3()
  const _t = new THREE.Vector3()
  const _dir = new THREE.Vector3()

  /**
   * Every shot is framed for a wide viewport. On a phone the same numbers crop the goal out of
   * frame, so the rig retreats along its own view axis and opens the lens rather than letting
   * the sides fall away.
   */
  function portraitFit(p: THREE.Vector3, t: THREE.Vector3, fov: number): number {
    const aspect = window.innerWidth / window.innerHeight
    const amount = clamp((1.6 - aspect) / 1.05, 0, 1)
    if (amount <= 0) return fov
    _dir.subVectors(p, t).normalize()
    p.addScaledVector(_dir, amount * 11)
    p.y += amount * 1.4
    return fov * (1 + amount * 0.34)
  }

  /**
   * Banner framing: the preset, plus a slow lateral drift and a gentle rise.
   *
   * The drift is deliberately long-period (about forty seconds) and small. A banner is
   * peripheral — it sits above the thing the reader came for — so it has to read as alive
   * without ever pulling the eye off the content. Anything faster becomes a distraction that
   * people learn to scroll past.
   */
  function applyBannerCamera(elapsed: number): void {
    _p.set(shot.p[0], shot.p[1], shot.p[2])
    _t.set(shot.t[0], shot.t[1], shot.t[2])

    const swing = Math.sin(elapsed * 0.16)
    const lift = Math.sin(elapsed * 0.11 + 1.2)
    _p.x += swing * 1.9
    _p.y += lift * 0.42
    _p.z += Math.cos(elapsed * 0.13) * 1.1
    _t.x -= swing * 0.5

    let fov = portraitFit(_p, _t, shot.fov)

    // The same opening dolly the landing page uses, shortened: the banner arrives on a shot.
    const io = 1 - rig.intro
    _p.z += io * 6
    _p.y += io * 1.6
    fov += io * 4

    _p.x += rig.mx * 0.7
    _p.y += rig.my * 0.35

    camera.position.copy(_p)
    camera.lookAt(_t)
    if (Math.abs(camera.fov - fov) > 1e-4) {
      camera.fov = fov
      camera.updateProjectionMatrix()
    }
  }

  function applyCamera(): void {
    const last = SHOTS.length - 1
    const u = clamp(rig.smooth / last, 0, 1)
    curveP.getPoint(u, _p)
    curveT.getPoint(u, _t)

    const i = clamp(Math.floor(rig.smooth), 0, last - 1)
    const f = clamp(rig.smooth - i, 0, 1)
    let fov = lerp(SHOTS[i]?.fov ?? 40, SHOTS[i + 1]?.fov ?? 40, f)
    fov = portraitFit(_p, _t, fov)

    // The opening move: the first two and a half seconds ease in from further back and wider,
    // so the page arrives on a shot rather than cutting to one.
    const io = 1 - rig.intro
    _p.z += io * 16
    _p.y += io * 4
    fov += io * 7

    // Pointer parallax — a hand-held drift, damped out as the camera enters the cage so it
    // never nudges the frame at the closest shots.
    const near = 1 - clamp((rig.smooth - 1.4) / 1.8, 0, 1) * 0.62
    _p.x += rig.mx * 1.5 * near
    _p.y += rig.my * 0.75 * near
    _t.x -= rig.mx * 0.4 * near
    _t.y -= rig.my * 0.2 * near

    camera.position.copy(_p)
    camera.lookAt(_t)
    if (Math.abs(camera.fov - fov) > 1e-4) {
      camera.fov = fov
      camera.updateProjectionMatrix()
    }
  }

  /* ------------------------------------------------------- scroll ↔ chapters */

  let anchors: number[] = []
  let coverOffset: number | null = null

  function measure(): void {
    if (banner) return
    const sections = options.sections ?? []
    const vh = window.innerHeight
    const maxScroll = Math.max(1, document.documentElement.scrollHeight - vh)
    anchors = sections.map((el, i) => {
      if (i === 0) return 0
      const centre = el.offsetTop + el.offsetHeight * 0.5 - vh * 0.5
      return clamp(centre, 0, maxScroll)
    })
    // Monotonic, so a short section can never make the camera run backwards.
    for (let i = 1; i < anchors.length; i++) {
      const prev = anchors[i - 1] ?? 0
      const cur = anchors[i] ?? 0
      anchors[i] = Math.max(cur, prev + 1)
    }
    coverOffset = options.coverAt?.() ?? null
  }

  function progressFor(y: number): number {
    const first = anchors[0] ?? 0
    if (y <= first) return 0
    for (let i = 0; i < anchors.length - 1; i++) {
      const a = anchors[i] ?? 0
      const b = anchors[i + 1] ?? a + 1
      if (y <= b) return i + (y - a) / (b - a)
    }
    return anchors.length - 1
  }

  /* ------------------------------------------------------------------ events */

  let width = 0
  let height = 0

  function resize(): void {
    // A banner is sized by its own element, not by the window: it is a strip in the layout, and
    // sizing it to the viewport would stretch the picture and waste most of the pixels.
    const box = banner ? canvas.getBoundingClientRect() : null
    width = box && box.width > 0 ? Math.round(box.width) : window.innerWidth
    height = box && box.height > 0 ? Math.round(box.height) : window.innerHeight
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, maxDpr) * dprScale)
    renderer.setSize(width, height, false)
    composer.setSize(width, height)
    bloom.setSize(width, height)
    camera.aspect = width / height
    camera.updateProjectionMatrix()

    // Grain is sampled at device pixels, not CSS pixels, so it stays the same physical size
    // on a retina screen instead of doubling and turning into mush.
    const dp = renderer.getPixelRatio()
    grainUniforms.uScale.value.set((width * dp) / 256, (height * dp) / 256)
    measure()
  }

  const onPointerMove = (e: PointerEvent): void => {
    rig.tmx = (e.clientX / window.innerWidth) * 2 - 1
    rig.tmy = -((e.clientY / window.innerHeight) * 2 - 1)
  }

  const onResize = (): void => resize()
  const onScrollMeasure = (): void => measure()

  window.addEventListener("resize", onResize)
  window.addEventListener("orientationchange", onResize)
  window.addEventListener("pointermove", onPointerMove, { passive: true })

  // In banner mode the canvas's own box is what drives the render size, so that is what is
  // observed. In scroll mode the document height is what moves the waypoints.
  const ro = new ResizeObserver(banner ? onResize : onScrollMeasure)
  ro.observe(banner ? canvas : document.documentElement)

  resize()

  /* -------------------------------------------------------------------- loop */

  let raf = 0
  let disposed = false
  let last = performance.now()
  let started = 0
  let announced = false
  const perf = { acc: 0, n: 0, locked: false }

  function renderFrame(now: number): void {
    if (disposed) return
    const raw = (now - last) / 1000
    last = now
    const dt = clamp(raw, 0, 0.05)

    if (!started) started = now
    rig.intro = clamp((now - started) / 2500, 0, 1)

    const y = window.scrollY || window.pageYOffset || 0

    // Nothing to draw once opaque content has covered the canvas. Battery matters on a page
    // people scroll to the bottom of and then read.
    const covered = coverOffset !== null && y > coverOffset
    // A banner scrolls out of view within a screen height; there is no reason to keep drawing it.
    const offScreen = options.isVisible ? !options.isVisible() : false
    if (!covered && !offScreen && !document.hidden) {
      rig.mx = damp(rig.mx, rig.tmx, 2.4, dt)
      rig.my = damp(rig.my, rig.tmy, 2.4, dt)

      // Scroll the grain each frame; a fixed noise field reads as a dirty screen, not as film.
      grainUniforms.uOffset.value.set((now * 0.0011) % 1, (now * 0.0007) % 1)

      if (banner) {
        applyBannerCamera(now / 1000)
      } else {
        rig.target = progressFor(y)
        rig.smooth = damp(rig.smooth, rig.target, 4.6, dt)
        applyCamera()
      }
      world.update(now / 1000, dt)
      crowd.update(dt)
      composer.render()

      if (!announced) {
        announced = true
        options.onReady?.()
      }

      /* Resolution governor. Measured frame time, not a device sniff: an old phone and a
         throttled laptop look identical from here, and both want fewer pixels. */
      if (!perf.locked && now - started > 2200) {
        perf.acc += raw
        perf.n++
        if (perf.n >= 45) {
          const avg = perf.acc / perf.n
          perf.acc = 0
          perf.n = 0
          if (avg > 0.024 && dprScale > 0.6) {
            dprScale = Math.max(0.6, dprScale * (avg > 0.05 ? 0.7 : 0.86))
            resize()
          } else if (avg < 0.0135 && dprScale < 1) {
            dprScale = Math.min(1, dprScale + 0.08)
            resize()
          }
        }
      }
    }

    raf = requestAnimationFrame(renderFrame)
  }

  if (options.reducedMotion) {
    // One composed frame at the opening shot, then nothing moves again.
    rig.intro = 1
    rig.smooth = 0
    if (banner) applyBannerCamera(0)
    else applyCamera()
    world.update(0, 0)
    crowd.update(0)
    composer.render()
    options.onReady?.()
  } else {
    raf = requestAnimationFrame(renderFrame)
  }

  /* ----------------------------------------------------------------- teardown */

  function dispose(): void {
    if (disposed) return
    disposed = true
    cancelAnimationFrame(raf)
    ro.disconnect()
    window.removeEventListener("resize", onResize)
    window.removeEventListener("orientationchange", onResize)
    window.removeEventListener("pointermove", onPointerMove)

    world.dispose()
    crowd.dispose()
    grain.dispose()
    bloom.dispose()
    composer.dispose()
    renderer.dispose()
    renderer.forceContextLoss()
  }

  return { dispose }
}
