import { AmbientLight, BackSide, BufferAttribute, BufferGeometry, Color, CubeCamera, FogExp2, HalfFloatType, HemisphereLight, LineSegments, Mesh, PerspectiveCamera, PMREMGenerator, PointLight, Scene, ShaderMaterial, SphereGeometry, Vector3, Vector4, WebGLCubeRenderTarget } from 'three'
import type { Camera, WebGLRenderer, WebGLRenderTarget } from 'three'
import type { TimeOfDayMode, WeatherMode } from '#shared/types/game'
import { createCascadedShadows } from './shadows'
import type { CascadedShadows } from './shadows'

/**
 * Plaza lamp heads, in world space, for the eight lanterns nearest the fountain
 * at (72, 72). Lanterns render inside an `InstancedMesh` batch, so the sky has
 * nothing to look up: these are the `Courtyard_Lantern` placements from
 * `shared/data/courtyard-props.json` (x, y -> world x, z) plus the template's
 * own +0.72 lamp-arm offset, mirrored by the placement's rotation. Two
 * symmetric rows of four keep the plaza lit evenly. Keep in sync with the JSON.
 */
const PLAZA_LANTERNS: [number, number][] = [
  [69.22, 59], [74.78, 59], [69.22, 85], [74.78, 85],
  [69.22, 48], [74.78, 48], [69.22, 96], [74.78, 96],
]
const LANTERN_HEIGHT = 2.55

const DAY_MS = 15 * 60 * 1000
const clamp01 = (value: number) => Math.min(1, Math.max(0, value))

/** The same absolute server clock drives weather, cloud advection and daylight. */
export function courtyardWeather(now: number, mode: WeatherMode = 'auto', timeOfDay: TimeOfDayMode = 'auto') {
  let sunAngle = (now / DAY_MS % 1) * Math.PI * 2 - Math.PI / 2
  if (timeOfDay !== 'auto') {
    // `day` sits short of the zenith on purpose: a sun straight overhead casts
    // shadows nobody can see, and the town reads flat without them.
    const angles = { dawn: 0.08, day: 1.12, sunset: Math.PI - 0.08, night: -Math.PI / 2 }
    sunAngle = angles[timeOfDay]
  }
  const seconds = now / 1000
  let overcast = clamp01(0.22 + 0.42 * Math.sin(seconds / 197) + 0.22 * Math.sin(seconds / 71 + 2.1))
  let rain = clamp01((overcast - 0.68) / 0.32)
  if (mode !== 'auto') {
    overcast = mode === 'clear' ? 0 : mode === 'overcast' ? 0.85 : 1
    rain = mode === 'rain' ? 1 : 0
  }
  if (import.meta.dev) {
    const override = (window as Window & { __envOverride?: { dayness?: number, sunAngle?: number, overcast?: number, rain?: number } }).__envOverride
    if (override) {
      // A preview must move the actual sun too, otherwise sky and shadows disagree.
      sunAngle = override.sunAngle ?? (override.dayness !== undefined ? Math.asin(clamp01(override.dayness) * 2 - 1) : sunAngle)
      overcast = override.overcast ?? overcast
      rain = override.rain ?? rain
    }
  }
  const sunHeight = Math.sin(sunAngle)
  return { sunAngle, sunHeight, dayness: clamp01(sunHeight * 2 + 0.15), overcast, rain }
}

const LIGHTNING_WINDOW = 9
const fract = (value: number) => value - Math.floor(value)

/** Lightning off the same server clock, so every client sees the same strike.
 * Time is cut into windows, and a hashed share of them, growing with the rain,
 * hold one cluster of two or three flashes: strikes come in bursts and then go
 * quiet. Flashes sit at least 0.24 s apart, under three a second. Returns the
 * glow (0..1) and where in the cloud layer it sits, relative to the viewer. */
export function courtyardLightning(now: number, rain: number) {
  const seconds = now / 1000
  const slot = Math.floor(seconds / LIGHTNING_WINDOW)
  const chance = fract(Math.sin(slot * 127.1) * 43758.5453)
  if (rain < 0.3 || chance > (rain - 0.3) * 0.6) return { glow: 0, x: 0, z: 0 }
  const seed = fract(Math.sin(slot * 311.7) * 23421.631)
  const since = seconds - slot * LIGHTNING_WINDOW - seed * 6
  const flashes = 2 + Math.floor(seed * 1.99)
  let glow = 0
  for (let i = 0; i < flashes; i++) {
    const age = since - i * (0.24 + fract(seed * 17.3 + i * 0.37) * 0.2)
    if (age >= 0) glow += Math.exp(-age * 9) * (i === 0 ? 1 : 0.6)
  }
  return { glow: Math.min(glow, 1), x: (fract(seed * 91.7) - 0.5) * 520, z: (fract(seed * 47.3) - 0.5) * 520 }
}

/** Atmospheric perspective and a bounded cloud-volume march, in linear light.
 * No camera position enters cloud density: all players see the same weather. */
const fragmentShader = /* glsl */ `
  varying vec3 vDirection;
  uniform vec3 sunDirection;
  uniform float dayness;
  uniform float overcast;
  uniform vec2 wind;
  uniform float evolution;
  uniform float skyTime;
  uniform float sunAngle;
  uniform float moonPhase;
  uniform vec4 flash;

  // The sun's orbit: east, up and the axis it turns about. Stars and the
  // Milky Way live in this frame, turned back by the sun angle, so the night
  // sky wheels overhead instead of hanging still.
  const vec3 ORBIT_EAST = vec3(0.9348, 0.0, 0.3552);
  const vec3 ORBIT_AXIS = vec3(-0.3552, 0.0, 0.9348);
  // Orbit-frame axes, perpendicular to each other. At midnight the zenith is
  // (-1, 0, 0) here, which puts the core about 35 degrees up.
  const vec3 GALAXY_POLE = vec3(0.4657, 0.8849, 0.0);
  const vec3 GALAXY_CORE = vec3(-0.572, 0.301, 0.763);

  vec3 hash32(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yxz + 33.33);
    return fract((p3.xxy + p3.yzz) * p3.zyx);
  }
  float hash(vec3 p) {
    p = fract(p * 0.3183099 + vec3(0.11, 0.27, 0.43));
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }
  float noise3(vec3 p) {
    vec3 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x),
                   mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
               mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x),
                   mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
  }
  // The light march passes fine = false and skips the second detail octave:
  // a shadow does not need the edge churn the silhouette does.
  float density(vec3 p, bool fine) {
    vec3 q = vec3(p.x + wind.x, p.y, p.z + wind.y) * 0.019;
    float broad = noise3(q);
    // Detail drifts half again as fast as the mass it rides on, so edges churn.
    vec3 r = q * 3.1 + vec3(wind.x, 0.0, wind.y) * 0.0285 + evolution;
    float detail = noise3(r) * 0.62 + (fine ? noise3(r * 2.4 - evolution) * 0.38 : 0.19);
    // The noise sum averages 0.67. A clear sky starts well above that, so only
    // the peaks condense into scattered puffs; full overcast starts far below.
    float shape = smoothstep(0.84 - overcast * 0.46, 0.97 - overcast * 0.37, broad + detail * 0.34);
    float height = (p.y - 80.0) / 58.0;
    // Flat bases, and heads that tower where the mass is thickest. An overcast
    // deck fills the layer instead: thin sunlit tops would show through it as
    // white wisps.
    float top = mix(0.5 + overcast * 0.4, 1.0, shape);
    return shape * smoothstep(0.0, 0.14, height) * (1.0 - smoothstep(top * 0.5, top, height));
  }
  vec3 cubeDirection(vec2 uv, float face) {
    if (face < 2.0) return vec3(face < 1.0 ? 1.0 : -1.0, uv);
    if (face < 4.0) return vec3(uv.x, face < 3.0 ? 1.0 : -1.0, uv.y);
    return vec3(uv, face < 5.0 ? 1.0 : -1.0);
  }
  // At most one star per cube-face cell, kept clear of the cell border so its
  // disc is never clipped. Distance is angular, so stars stay round at the
  // cube corners where the cells themselves are stretched.
  vec3 starField(vec3 sd, float scale, float amount, float size, float flicker) {
    vec3 a = abs(sd);
    vec2 uv;
    float face;
    if (a.x >= a.y && a.x >= a.z) { uv = sd.yz / a.x; face = sd.x > 0.0 ? 0.0 : 1.0; }
    else if (a.y >= a.z) { uv = sd.xz / a.y; face = sd.y > 0.0 ? 2.0 : 3.0; }
    else { uv = sd.xy / a.z; face = sd.z > 0.0 ? 4.0 : 5.0; }
    vec2 cell = floor(uv * scale);
    vec3 h = hash32(cell + face * 97.0 + scale);
    vec3 star = normalize(cubeDirection((cell + 0.3 + h.xy * 0.4) / scale, face));
    // The galactic plane is crowded.
    float latitude = dot(star, GALAXY_POLE);
    if (h.z > amount * (1.0 + exp(-latitude * latitude / 0.09) * 1.6)) return vec3(0.0);
    vec3 k = hash32(cell * 1.7 + face * 31.0 + 5.0);
    // Few bright stars, many faint ones.
    float magnitude = 0.12 + pow(k.x, 7.0) * 0.88;
    float d = length(sd - star) / (size * (0.7 + magnitude * 0.6));
    vec3 tint = k.y < 0.5
      ? mix(vec3(1.0, 0.76, 0.56), vec3(1.0), k.y * 2.0)
      : mix(vec3(1.0), vec3(0.72, 0.83, 1.0), k.y * 2.0 - 1.0);
    // Scintillation: two detuned sines per star, and bright stars hold steadier.
    float phase = k.z * 6.2832;
    float twinkle = 1.0 + flicker * (1.0 - magnitude * 0.6)
      * (sin(skyTime * (2.1 + k.z * 3.0) + phase) * 0.6 + sin(skyTime * (5.3 + k.x * 4.0) + phase * 1.7) * 0.4);
    return tint * exp(-d * d * 2.5) * magnitude * twinkle;
  }
  void main() {
    vec3 rd = normalize(vDirection);
    float elevation = max(rd.y, 0.0);
    float sunDot = dot(rd, sunDirection);
    float horizon = exp(-elevation * 5.0);
    // Longer optical paths at the horizon desaturate blue Rayleigh scattering.
    vec3 rayleigh = vec3(0.055, 0.25, 0.65);
    vec3 sky = mix(rayleigh, vec3(0.42, 0.66, 0.85), horizon);
    float sunset = exp(-abs(sunDirection.y) * 7.0);
    sky = mix(sky, vec3(1.0, 0.43, 0.18), sunset * horizon * pow(max(sunDot, 0.0), 2.0) * 0.7);
    // Forward scattering around the sun, separate from the sharp solar disc.
    sky += vec3(1.0, 0.81, 0.5) * pow(max(sunDot, 0.0), 16.0) * 0.16 * dayness;
    sky = mix(vec3(0.008, 0.018, 0.05) + horizon * vec3(0.024, 0.041, 0.065), sky, dayness);
    sky = mix(sky, mix(vec3(0.023,0.033,0.053), vec3(0.33,0.4,0.47), dayness), overcast * 0.63);
    float sunDisc = smoothstep(cos(0.009), cos(0.007), sunDot);
    sky += sunDisc * vec3(5.0, 3.8, 2.2) * smoothstep(-0.02, 0.04, sunDirection.y);
    float moonDot = dot(rd, -sunDirection);
    float moonlit = 0.5 + 0.5 * cos(moonPhase);
    // Stars are gone long before the sky is bright.
    float night = (1.0 - smoothstep(0.0, 0.45, dayness)) * (1.0 - overcast);
    vec3 celestial = vec3(0.0);
    if (night > 0.004 && rd.y > 0.0) {
      // Into the orbit frame, turned back by the sun angle: the sun sits still
      // in it, so everything drawn here rises and sets with the night.
      float east = dot(rd, ORBIT_EAST);
      float ca = cos(sunAngle), sa = sin(sunAngle);
      vec3 sd = vec3(east * ca + rd.y * sa, rd.y * ca - east * sa, dot(rd, ORBIT_AXIS));
      // Thicker air near the horizon dims the stars and makes them flicker.
      float flicker = mix(0.22, 0.6, exp(-rd.y * 4.0));
      vec3 stars = starField(sd, 26.0, 0.05, 0.0024, flicker) * 2.4
        + starField(sd, 74.0, 0.085, 0.0012, flicker) * 0.9;
      // The Milky Way: a band about the galactic plane, mottled by star clouds,
      // split by dust lanes and warmer and brighter toward the core.
      float latitude = dot(sd, GALAXY_POLE);
      float band = exp(-latitude * latitude / 0.05);
      float core = exp(-(1.0 - dot(sd, GALAXY_CORE)) * 2.2);
      float mottle = noise3(sd * 3.2 + 4.0) * 0.6 + noise3(sd * 7.5) * 0.4;
      float dust = smoothstep(0.42, 0.78, noise3(sd * 5.0 + 9.0) * 0.65 + noise3(sd * 13.0 + 2.0) * 0.35)
        * exp(-latitude * latitude / 0.012);
      vec3 galaxy = mix(vec3(0.34, 0.42, 0.62), vec3(0.7, 0.65, 0.6), core)
        * band * (0.35 + core * 0.6) * (0.35 + mottle * 0.9) * (1.0 - dust * 0.75);
      celestial = (stars + galaxy * 0.09) * night * smoothstep(0.02, 0.3, rd.y);
    }
    // The moon stays opposite the sun, because the night's key light and its
    // shadows come from there. Its phase is a terminator swept across the disc.
    const float MOON_RADIUS = 0.021;
    if (moonDot > cos(MOON_RADIUS * 1.05)) {
      vec3 moonUp = cross(-sunDirection, ORBIT_AXIS);
      vec2 q = vec2(dot(rd, ORBIT_AXIS), dot(rd, moonUp)) / sin(MOON_RADIUS);
      float rim = length(q);
      vec3 n = vec3(q, sqrt(max(1.0 - rim * rim, 0.0)));
      float lit = smoothstep(-0.05, 0.25, dot(n, vec3(sin(moonPhase), 0.0, cos(moonPhase))));
      float maria = smoothstep(0.35, 0.7, noise3(n * 2.3 + 17.0) * 0.7 + noise3(n * 5.5 + 3.0) * 0.3);
      vec3 surface = vec3(0.82, 0.88, 1.0) * (1.0 - maria * 0.42) * (0.85 + noise3(n * 14.0) * 0.25);
      // Limb darkening, and a trace of earthshine so the dark side hides stars.
      vec3 moon = surface * (lit * mix(0.6, 1.0, pow(n.z, 0.45)) * 0.85 + 0.03);
      sky = mix(sky, moon, (1.0 - smoothstep(0.93, 1.0, rim)) * (1.0 - dayness));
    }
    float moonGlow = pow(max(moonDot, 0.0), 110.0) + pow(max(moonDot, 0.0), 900.0) * 0.8;
    sky += moonGlow * vec3(0.035, 0.055, 0.1) * (1.0 - dayness) * (0.3 + 0.7 * moonlit);
    // Lightning lifts the whole sky for a moment, clouds most of all.
    sky += flash.w * vec3(0.05, 0.06, 0.09);

    if (rd.y > 0.025) {
      float transmittance = 1.0;
      vec3 cloud = vec3(0.0);
      // A march through a finite cloud layer: grey flat bases, lit heads,
      // self-shadowing toward the actual sun and bright forward-scattered rims.
      // Samples sit on planes of constant altitude. Toward the horizon a ray
      // runs far between two planes, each one turns opaque on its own and they
      // read as stacked sheets, so the count grows as the ray flattens. Per-pixel
      // jitter hides the sheets too, but shows as grain at high pixel ratios.
      float steps = floor(clamp(12.0 / rd.y, 12.0, 40.0));
      float stepLength = 58.0 / (rd.y * steps);
      vec3 lightDir = sunDirection.y > 0.0 ? sunDirection : -sunDirection;
      vec3 cloudShade = mix(vec3(0.035,0.055,0.09), vec3(0.29,0.39,0.56), dayness);
      vec3 cloudLight = mix(vec3(0.15,0.2,0.3), vec3(0.95,0.97,1.0), dayness);
      cloudLight = mix(cloudLight, vec3(1.0,0.59,0.31), sunset * dayness * 0.62);
      for (int i = 0; i < 40; i++) {
        if (float(i) >= steps) break;
        float height = (float(i) + 0.5) / steps;
        vec3 p = rd * ((80.0 + height * 58.0) / rd.y);
        float d = density(p, true);
        if (d < 0.004) continue;
        float shade = exp(-density(p + lightDir * 22.0, false) * 2.8);
        vec3 light = mix(cloudShade, cloudLight, shade * 0.8 + 0.2);
        light *= mix(0.72, 1.06, smoothstep(0.0, 0.75, height));
        // Silver lining: thin edges between the eye and the light glow hardest.
        float thin = 1.0 + exp(-d * 2.5) * 1.4;
        light += pow(max(sunDot, 0.0), 12.0) * dayness * shade * thin * vec3(0.28,0.23,0.17);
        light += pow(max(moonDot, 0.0), 14.0) * (1.0 - dayness) * shade * thin * moonlit * vec3(0.05,0.07,0.11);
        light *= 1.0 - overcast * 0.36;
        light += flash.w * vec3(0.62, 0.72, 1.0) * (0.25 + 2.2 * exp(-length(p.xz - flash.xy) * 0.006));
        float alpha = 1.0 - exp(-d * stepLength * 0.075);
        cloud += transmittance * alpha * light;
        transmittance *= 1.0 - alpha;
        if (transmittance < 0.02) break;
      }
      float haze = smoothstep(0.025, 0.13, rd.y);
      sky = mix(sky, cloud + sky * transmittance, haze);
      // Points of light die behind far less cloud than the sky's own glow does.
      float veil = mix(1.0, transmittance, haze);
      celestial *= veil * veil * veil;
    }
    sky += celestial;
    if (rd.y < 0.0) sky = mix(sky, vec3(0.08, 0.115, 0.075) * (0.1 + dayness * 0.9), smoothstep(0.0, 0.5, -rd.y));
    gl_FragColor = vec4(sky, 1.0);
  }
`

/** Owns the sky, outdoor light, weather and the environment used by water and
 * PBR materials. Dispose before the scene disappears. No gameplay physics. */
export function createCourtyardSky(scene: Scene) {
  const previous = { background: scene.background, fog: scene.fog, environment: scene.environment, environmentIntensity: scene.environmentIntensity }
  const fog = new FogExp2('#b7cfd6', 0.0042)
  scene.fog = fog
  scene.background = new Color('#85b9df')
  scene.environmentIntensity = 0.55
  const ambient = new AmbientLight('#b6c6ea', 0.08)
  // Cool sky against warm bounce: shading keeps colour contrast, not just value.
  const hemi = new HemisphereLight('#9ecdff', '#b08e55', 0.6)
  const sunColor = new Color('#fff2d7')
  // Cascaded shadow maps own the sun. CSM's shader patch assumes every
  // directional light in the scene is one of its cascades, so there is
  // deliberately no separate DirectionalLight here.
  //
  // It is built here rather than on the first update because CSM rewrites
  // three's global light ShaderChunk: every material compiled before that
  // rewrite has to be recompiled after it, which stalls for as long as the
  // whole town's material count. The sky is created before the floor is built,
  // so this gets in first. A stand-in camera carries the game camera's
  // projection until the real one arrives on the first update.
  const shadowCamera = new PerspectiveCamera(62, 16 / 9, 0.1, 260)
  const shadows: CascadedShadows = createCascadedShadows(scene, shadowCamera)
  // Warm pools on the plaza lamps, so night is lit rather than merely blue.
  const lanterns = PLAZA_LANTERNS.map(([x, z]) => {
    const light = new PointLight('#ffbe72', 0, 13, 1.9)
    light.position.set(x, LANTERN_HEIGHT, z)
    scene.add(light)
    return light
  })
  const uniforms = {
    sunDirection: { value: new Vector3(0, 1, 0) },
    dayness: { value: 1 },
    overcast: { value: 0 },
    wind: { value: { x: 0, y: 0 } },
    evolution: { value: 0 },
    skyTime: { value: 0 },
    sunAngle: { value: 0 },
    moonPhase: { value: 0 },
    flash: { value: new Vector4() },
  }
  const material = new ShaderMaterial({
    uniforms, fragmentShader,
    vertexShader: 'varying vec3 vDirection; void main() { vDirection = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    side: BackSide, depthWrite: false, depthTest: false, fog: false,
  })
  const geometry = new SphereGeometry(80, 32, 16)
  const dome = new Mesh(geometry, material)
  dome.name = 'courtyard-atmosphere'
  dome.renderOrder = -10
  dome.frustumCulled = false
  scene.add(dome, ambient, hemi)

  // Capture only the sky, never the world or the water that samples this map.
  const environmentScene = new Scene()
  environmentScene.add(new Mesh(geometry, material))
  const environmentTarget = new WebGLCubeRenderTarget(256, { type: HalfFloatType })
  const environmentCamera = new CubeCamera(1, 120, environmentTarget)
  // PMREM is explicit rather than left to three's automatic cube conversion:
  // that cache keys off `texture.version`, which a CubeCamera render never
  // bumps, so the filtered map would freeze on the first frame's sky.
  let pmrem: PMREMGenerator | null = null
  let environmentMap: WebGLRenderTarget | null = null
  // Regenerate only when the sky has actually moved: the sun crosses this much
  // arc in roughly four seconds, matching the old fixed cadence without
  // spending the filter pass on a sky that is standing still.
  const ENVIRONMENT_ANGLE = 0.03
  const ENVIRONMENT_INTERVAL = 2500
  let capturedAngle = Infinity
  let capturedOvercast = Infinity
  let capturedAt = -Infinity
  const sunDirection = uniforms.sunDirection.value
  const lightDirection = new Vector3()
  const nightFog = new Color('#23344d')
  const dayFog = new Color('#b7cfd6')
  const stormFog = new Color('#7d92a4')

  // Streaks, not dots: two vertices per drop, a bright head and a tail that
  // fades to nothing, all moved on the GPU. Drops are anchored to the world and
  // wrapped into a box that follows the camera, so walking does not drag the
  // rain along and hills never climb out of it.
  const rainCount = 5000
  const rainSeeds = new Float32Array(rainCount * 6)
  const rainTips = new Float32Array(rainCount * 2)
  for (let i = 0; i < rainCount; i++) {
    const seed = [fract(Math.sin(i * 127.1) * 43758.5453), fract(Math.sin(i * 269.5) * 18345.127), fract(Math.sin(i * 311.7) * 23421.631)]
    rainSeeds.set(seed, i * 6)
    rainSeeds.set(seed, i * 6 + 3)
    rainTips[i * 2 + 1] = 1
  }
  const rainGeometry = new BufferGeometry()
  rainGeometry.setAttribute('position', new BufferAttribute(rainSeeds, 3))
  rainGeometry.setAttribute('tip', new BufferAttribute(rainTips, 1))
  const rainUniforms = {
    origin: { value: new Vector3() },
    rainTime: { value: 0 },
    opacity: { value: 0 },
    tint: { value: new Color() },
  }
  const rainMaterial = new ShaderMaterial({
    uniforms: rainUniforms,
    vertexShader: /* glsl */ `
      attribute float tip;
      uniform vec3 origin;
      uniform float rainTime;
      varying float vAlpha;
      const vec3 BOX = vec3(28.0, 18.0, 28.0);
      // Slanted along the same wind that carries the clouds.
      const vec3 FALL = vec3(3.4, -21.0, 1.0);
      void main() {
        vec3 fall = FALL * (0.85 + fract(position.x * 91.7 + position.z * 37.3) * 0.3);
        vec3 p = origin + mod(position * BOX + fall * rainTime - origin + BOX * 0.5, BOX) - BOX * 0.5;
        p -= fall * 0.026 * tip;
        float range = length(p - cameraPosition);
        vAlpha = (1.0 - tip) * smoothstep(0.5, 1.6, range) * (1.0 - smoothstep(9.0, 14.0, range));
        gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float opacity;
      uniform vec3 tint;
      varying float vAlpha;
      void main() { gl_FragColor = vec4(tint, vAlpha * opacity); }
    `,
    transparent: true, depthWrite: false, fog: false,
  })
  const rain = new LineSegments(rainGeometry, rainMaterial)
  rain.frustumCulled = false
  rain.userData.gtaoExclude = true
  scene.add(rain)
  const nightRain = new Color('#5d728c')
  const dayRain = new Color('#c4d8eb')
  const flashColor = new Color('#cfdcff')
  // Lightning is a full-scene flash, so it stays out of reduced-motion sessions.
  const calm = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

  let previousWeather: WeatherMode = 'auto'
  let previousTimeOfDay: TimeOfDayMode = 'auto'
  return {
    /** Patch freshly built or freshly loaded materials for cascaded shadows.
     *  The per-frame update rescans on its own, so calling this after a floor
     *  rebuild is an optimisation, not a requirement. */
    setupShadows() {
      shadows.setupScene(scene)
    },
    /**
     * Apply the graphics settings this module owns: the sun's cascades, and how
     * much of the storm is drawn. The streaks' seeds are hashed in index order,
     * so the first share of the buffer is already a fair scatter over the whole
     * box and a draw range is enough to thin the rain without a rebuild.
     */
    setQuality(quality: { shadowMapSize: number, shadowDistance: number, rain: number }) {
      shadows.setQuality(quality.shadowMapSize, quality.shadowDistance)
      rainGeometry.setDrawRange(0, Math.max(1, Math.round(rainCount * quality.rain)) * 2)
    },
    update(now: number, delta: number, camera: Camera, renderer: WebGLRenderer, x: number, z: number, mode: WeatherMode = 'auto', timeOfDay: TimeOfDayMode = 'auto') {
      const state = courtyardWeather(now, mode, timeOfDay)
      if (mode !== previousWeather || timeOfDay !== previousTimeOfDay) capturedAngle = Infinity
      previousWeather = mode
      previousTimeOfDay = timeOfDay
      const seconds = now / 1000
      sunDirection.set(Math.cos(state.sunAngle), state.sunHeight, Math.cos(state.sunAngle) * 0.38).normalize()
      uniforms.dayness.value = state.dayness
      uniforms.overcast.value = state.overcast
      // Modulo before the GPU upload avoids precision loss for epoch seconds.
      uniforms.wind.value.x = seconds * 0.72 % 20000
      uniforms.wind.value.y = seconds * 0.21 % 20000
      uniforms.evolution.value = Math.sin(seconds / 240) * 0.35
      // Twinkle only needs to be continuous, not absolute.
      uniforms.skyTime.value = seconds % 1000
      uniforms.sunAngle.value = state.sunAngle
      // One phase a night, stepped at noon while the moon is down. It swings
      // between full and a crescent on alternating sides and never goes new:
      // the moon is the night's key light.
      uniforms.moonPhase.value = Math.sin(Math.floor(now / DAY_MS + 0.5) % 8 / 8 * Math.PI * 2) * 1.9
      const strike = calm ? null : courtyardLightning(now, state.rain)
      const glow = strike?.glow ?? 0
      uniforms.flash.value.set(strike?.x ?? 0, strike?.z ?? 0, 0, glow)
      dome.position.copy(camera.position)
      const daylight = Math.max(state.sunHeight, 0)
      lightDirection.copy(sunDirection).multiplyScalar(state.sunHeight >= 0 ? 1 : -1)
      lightDirection.y = Math.max(lightDirection.y, 0.08)
      const intensity = state.sunHeight >= 0
        ? (0.25 + daylight * 3.9) * (1 - state.overcast * 0.7)
        : 0.62
      sunColor.set(state.sunHeight < 0 ? '#93b0ff' : daylight < 0.3 ? '#ffb877' : '#fff0cb')
      if (camera instanceof PerspectiveCamera) shadows.update(camera, lightDirection, sunColor, intensity, delta)
      hemi.intensity = 0.2 + state.dayness * 0.4 + glow * 0.9
      ambient.intensity = 0.04 + state.dayness * 0.03 + glow * 0.5
      // Lantern pools fade in as the sun goes down, and stay out of daylight.
      const lamp = (1 - state.dayness) ** 1.5 * 2.6
      for (const light of lanterns) light.intensity = lamp
      fog.color.copy(nightFog).lerp(dayFog, state.dayness).lerp(stormFog, state.overcast * state.dayness * 0.55).lerp(flashColor, glow * 0.35)
      // Dry mornings open in mist that burns off as the sun climbs.
      const mist = Math.exp(-(((state.sunAngle - 0.12) / 0.3) ** 2)) * (1 - state.rain)
      fog.density = 0.0036 * (1 + state.rain * 1.3 + state.overcast * 0.25 + mist * 1.1)
      // The post pipeline reads this to bias bloom toward night highlights;
      // `courtyardRenderer` has no other view of the clock.
      scene.userData.dayness = state.dayness
      rain.visible = state.rain > 0.02
      rainUniforms.opacity.value = state.rain * 0.55
      rainUniforms.origin.value.copy(camera.position)
      // Wrapped so the fall distance stays precise as a float; the one skip
      // every ten minutes is lost in the rain.
      rainUniforms.rainTime.value = seconds % 600
      rainUniforms.tint.value.copy(nightRain).lerp(dayRain, state.dayness).lerp(flashColor, glow)
      // Capture the sky and prefilter it for roughness, so stone, water and the
      // alpha-cut leaves reflect the actual weather instead of a flat tint.
      const moved = Math.abs(state.sunAngle - capturedAngle) > ENVIRONMENT_ANGLE
        || Math.abs(state.overcast - capturedOvercast) > 0.03
      if (moved && Math.abs(now - capturedAt) >= ENVIRONMENT_INTERVAL) {
        environmentCamera.update(renderer, environmentScene)
        pmrem ??= new PMREMGenerator(renderer)
        // Passing the previous target back reuses it instead of allocating one
        // filtered cube per refresh.
        environmentMap = pmrem.fromCubemap(environmentTarget.texture, environmentMap)
        scene.environment = environmentMap.texture
        capturedAngle = state.sunAngle
        capturedOvercast = state.overcast
        capturedAt = now
      }
      return state
    },
    dispose() {
      scene.remove(dome, ambient, hemi, rain, ...lanterns)
      shadows.dispose()
      geometry.dispose()
      material.dispose()
      rainGeometry.dispose()
      rainMaterial.dispose()
      environmentTarget.dispose()
      environmentMap?.dispose()
      pmrem?.dispose()
      scene.background = previous.background
      scene.fog = previous.fog
      scene.environment = previous.environment
      scene.environmentIntensity = previous.environmentIntensity
    },
  }
}
