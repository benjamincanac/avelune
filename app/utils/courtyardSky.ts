import { AmbientLight, BackSide, BufferAttribute, BufferGeometry, Color, CubeCamera, FogExp2, HalfFloatType, HemisphereLight, Mesh, PerspectiveCamera, PMREMGenerator, PointLight, Points, PointsMaterial, Scene, ShaderMaterial, SphereGeometry, Vector3, WebGLCubeRenderTarget } from 'three'
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

/** Atmospheric perspective and a bounded cloud-volume march, in linear light.
 * No camera position enters cloud density: all players see the same weather. */
const fragmentShader = /* glsl */ `
  varying vec3 vDirection;
  uniform vec3 sunDirection;
  uniform float dayness;
  uniform float overcast;
  uniform vec2 wind;
  uniform float evolution;

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
  float density(vec3 p) {
    vec3 q = vec3(p.x + wind.x, p.y, p.z + wind.y) * 0.019;
    float broad = noise3(q);
    float detail = noise3(q * 3.1 + evolution) * 0.28;
    float shape = smoothstep(0.64 - overcast * 0.29, 0.82 - overcast * 0.25, broad + detail);
    float height = (p.y - 80.0) / 58.0;
    return shape * smoothstep(0.0, 0.2, height) * (1.0 - smoothstep(0.55, 1.0, height));
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
    float moon = smoothstep(cos(0.012), cos(0.01), moonDot);
    sky += moon * vec3(0.6, 0.73, 0.92) * (1.0 - dayness);
    sky += pow(max(moonDot, 0.0), 110.0) * vec3(0.035, 0.055, 0.1) * (1.0 - dayness);
    // Sparse stars remain fixed on the celestial sphere, independent of wind.
    vec3 starCell = floor(rd * 340.0);
    float star = step(0.998, hash(starCell));
    sky += star * pow(max(0.0, 1.0 - length(fract(rd * 340.0) - 0.5) * 2.0), 3.0)
      * (1.0 - dayness) * (1.0 - overcast) * smoothstep(0.03, 0.25, rd.y) * 1.5;

    if (rd.y > 0.025) {
      float transmittance = 1.0;
      vec3 cloud = vec3(0.0);
      // Six samples through a finite cloud layer: denser bases, lit tops,
      // self-shadowing toward the actual sun and bright forward-scattered rims.
      float stepLength = 58.0 / (rd.y * 6.0);
      vec3 lightDir = sunDirection.y > 0.0 ? sunDirection : -sunDirection;
      for (int i = 0; i < 6; i++) {
        vec3 p = rd * ((80.0 + (float(i) + 0.5) * (58.0 / 6.0)) / rd.y);
        float d = density(p);
        float shade = exp(-density(p + lightDir * 22.0) * 2.8);
        vec3 cloudShade = mix(vec3(0.035,0.055,0.09), vec3(0.29,0.39,0.56), dayness);
        vec3 cloudLight = mix(vec3(0.15,0.2,0.3), vec3(0.95,0.97,1.0), dayness);
        cloudLight = mix(cloudLight, vec3(1.0,0.59,0.31), sunset * dayness * 0.62);
        vec3 light = mix(cloudShade, cloudLight, shade * 0.8 + 0.2);
        light += pow(max(sunDot, 0.0), 12.0) * dayness * shade * vec3(0.28,0.23,0.17);
        light *= 1.0 - overcast * 0.36;
        float alpha = 1.0 - exp(-d * stepLength * 0.075);
        cloud += transmittance * alpha * light;
        transmittance *= 1.0 - alpha;
      }
      float haze = smoothstep(0.025, 0.13, rd.y);
      sky = mix(sky, cloud + sky * transmittance, haze);
    }
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

  const rainCount = 800
  const rainGeometry = new BufferGeometry()
  const positions = new Float32Array(rainCount * 3)
  for (let i = 0; i < rainCount; i++) {
    positions[i * 3] = (Math.sin(i * 127.1) * 43758.5453 % 1) * 12
    positions[i * 3 + 1] = i / rainCount * 14
    positions[i * 3 + 2] = (Math.sin(i * 311.7) * 23421.631 % 1) * 12
  }
  rainGeometry.setAttribute('position', new BufferAttribute(positions, 3))
  const rainMaterial = new PointsMaterial({ color: '#c4d8eb', size: 0.035, transparent: true, depthWrite: false, opacity: 0 })
  const rain = new Points(rainGeometry, rainMaterial)
  scene.add(rain)

  let previousWeather: WeatherMode = 'auto'
  let previousTimeOfDay: TimeOfDayMode = 'auto'
  return {
    /** Patch freshly built or freshly loaded materials for cascaded shadows.
     *  The per-frame update rescans on its own, so calling this after a floor
     *  rebuild is an optimisation, not a requirement. */
    setupShadows() {
      shadows.setupScene(scene)
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
      dome.position.copy(camera.position)
      const daylight = Math.max(state.sunHeight, 0)
      lightDirection.copy(sunDirection).multiplyScalar(state.sunHeight >= 0 ? 1 : -1)
      lightDirection.y = Math.max(lightDirection.y, 0.08)
      const intensity = state.sunHeight >= 0
        ? (0.25 + daylight * 3.9) * (1 - state.overcast * 0.7)
        : 0.62
      sunColor.set(state.sunHeight < 0 ? '#93b0ff' : daylight < 0.3 ? '#ffb877' : '#fff0cb')
      if (camera instanceof PerspectiveCamera) shadows.update(camera, lightDirection, sunColor, intensity, delta)
      hemi.intensity = 0.2 + state.dayness * 0.4
      ambient.intensity = 0.04 + state.dayness * 0.03
      // Lantern pools fade in as the sun goes down, and stay out of daylight.
      const lamp = (1 - state.dayness) ** 1.5 * 2.6
      for (const light of lanterns) light.intensity = lamp
      fog.color.copy(nightFog).lerp(dayFog, state.dayness).lerp(stormFog, state.overcast * state.dayness * 0.55)
      fog.density = 0.0036 * (1 + state.rain * 1.3 + state.overcast * 0.25)
      // The post pipeline reads this to bias bloom toward night highlights;
      // `courtyardRenderer` has no other view of the clock.
      scene.userData.dayness = state.dayness
      rain.visible = state.rain > 0.02
      rainMaterial.opacity = state.rain * 0.65
      rain.position.set(x, 0, z)
      if (rain.visible) {
        const attribute = rainGeometry.attributes.position as BufferAttribute
        for (let i = 0; i < rainCount; i++) attribute.setY(i, (attribute.getY(i) - delta * 21 + 14) % 14)
        attribute.needsUpdate = true
      }
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
