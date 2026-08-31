/**
 * The night-pitch palette.
 *
 * The page's editorial theme is warm paper over navy ink. This scene is that theme after dark:
 * the same navy becomes the ground, the same paper becomes the light, and the accents keep
 * their meanings — gold is the floodlight and the caution, vermilion is the away kit and the
 * red card.
 *
 * Values are 0xRRGGBB so they can go straight into `THREE.Color`, with CSS twins for the DOM
 * scrim that has to blend into the canvas seamlessly.
 */

export const NIGHT = {
  /** Deep end of the sky, directly overhead. */
  skyHigh: 0x05070c,
  /** Horizon glow — the city's light pollution, not the sun. */
  skyLow: 0x131c2b,
  /** Asphalt and packed earth between the pitches. */
  ground: 0x0a0e15,
  /** Turf in shadow. */
  turfDark: 0x17573a,
  /** Turf under a floodlight. */
  turfLit: 0x2f7d46,
  /** Painted lines. Never pure white — worn paint under sodium light goes bone. */
  paint: 0xdfe7dc,
  /** Floodlight lamp colour: metal-halide, faintly green-white with a warm core. */
  lamp: 0xffe6b8,
  /** The warm halo the lamps throw into the haze. */
  halo: 0xffc978,
  /** Moon: cold, pale, low. */
  moon: 0xd8e2f0,
  /** Cage mesh and mast steel. */
  steel: 0x2a3442,
  /** Goal frame — painted aluminium, catches the light. */
  frame: 0xc8cfd8,
  /** Distant apartment blocks. */
  block: 0x0c111a,
  /** Lit windows in those blocks. */
  window: 0xffcf8a,

  /* Kit colours, drawn from the site accents so the 3D and the type agree. */
  kitBone: 0xf6f1e7,
  kitVermilion: 0xcf2734,
  kitGold: 0xb8902e,
  kitAzure: 0x2f5f9e,
  kitTeal: 0x178f9a,
  kitInk: 0x1b2230,
  /** Skin/limb tone, kept desaturated so nobody reads as a specific person. */
  limb: 0x8d7864,
} as const

/** CSS twins, for the DOM layers that must sit flush against the canvas. */
export const NIGHT_CSS = {
  ground: "#05070c",
  scrim: "rgba(5, 7, 12, 0.72)",
  paper: "#f6f1e7",
} as const
