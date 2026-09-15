import { Color, Mesh, MeshStandardMaterial, Vector3 } from 'three'
import type { Object3D } from 'three'

/**
 * A rim / wrap term for character materials only.
 *
 * Characters are lit by the same sun and sky as the town, so at mid-day they
 * sink into a background of the same value and the silhouette disappears. This
 * adds two cheap grazing-angle terms on top of the standard shading: a cool
 * sky-side rim that traces the upper edge, and a fainter warm wrap on the sun
 * side. It is deliberately small — enough to separate the outline, not enough
 * to read as a second light.
 *
 * Everything happens in the fragment stage, so `USE_SKINNING` and the rest of
 * the vertex pipeline are untouched. The world normal is recovered from the
 * view normal with `transpose(viewMatrix)` rather than a new varying.
 */

/** One shared uniform set: a single per-frame write lights every character. */
const rimUniforms = {
  uRimSun: { value: new Vector3(0.4, 0.7, 0.3).normalize() },
  uRimSky: { value: new Color('#9ecdff') },
  uRimWarm: { value: new Color('#ffd6a5') },
  uRimStrength: { value: 1 },
  uRimWarmth: { value: 1 },
}

/** Follow the sky's sun so the warm side matches the actual key light.
 *  `daylight` fades the warm term out entirely at night and leaves only a faint
 *  cool edge, which is what separates a silhouette from a dark street. */
export function setCharacterRim(x: number, y: number, z: number, daylight: number): void {
  // Below the horizon the sun would wrap warm light onto faces it cannot reach,
  // so flatten the direction to the horizon; the warm term is off by then anyway.
  rimUniforms.uRimSun.value.set(x, Math.max(y, 0), z).normalize()
  const day = Math.min(1, Math.max(0, daylight))
  rimUniforms.uRimStrength.value = 0.18 + 0.82 * day
  rimUniforms.uRimWarmth.value = day
}

const RIM_PARS = /* glsl */ `
uniform vec3 uRimSun;
uniform vec3 uRimSky;
uniform vec3 uRimWarm;
uniform float uRimStrength;
uniform float uRimWarmth;
`

const RIM_BODY = /* glsl */ `
{
  vec3 rimNormal = normalize( normal );
  vec3 rimView = normalize( vViewPosition );
  float rimFalloff = pow( saturate( 1.0 - dot( rimNormal, rimView ) ), 3.0 );
  // transpose( viewMatrix ) * n — the rotation part is orthonormal, so the
  // right-multiply is the inverse and no extra varying is needed.
  vec3 rimWorldNormal = normalize( ( vec4( rimNormal, 0.0 ) * viewMatrix ).xyz );
  float rimSkyMask = saturate( rimWorldNormal.y * 0.65 + 0.35 );
  float rimSunMask = saturate( dot( rimWorldNormal, uRimSun ) );
  vec3 rim = uRimSky * ( rimFalloff * rimSkyMask * 0.22 * uRimStrength )
    + uRimWarm * ( rimFalloff * rimSunMask * 0.10 * uRimWarmth );
  outgoingLight += rim;
}
`

function hook(material: MeshStandardMaterial): void {
  if (material.userData.characterRim) return
  material.userData.characterRim = true

  // Chain rather than replace: the outfit swap and any future decoration may
  // already have installed a hook on this material.
  const previousCompile = material.onBeforeCompile.bind(material)
  material.onBeforeCompile = (shader, renderer) => {
    previousCompile(shader, renderer)
    Object.assign(shader.uniforms, rimUniforms)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${RIM_PARS}`)
      .replace('#include <opaque_fragment>', `${RIM_BODY}\n#include <opaque_fragment>`)
  }

  // Programs are cached by this key; without a distinct one a character could
  // reuse an un-hooked program compiled for an identical material.
  const previousKey = material.customProgramCacheKey.bind(material)
  material.customProgramCacheKey = () => `${previousKey()}|character-rim`
  material.needsUpdate = true
}

/** Install the rim on every standard material under `root`. Call it after any
 *  per-rig material cloning (`applyOutfitColor`): `Material.clone()` drops
 *  `onBeforeCompile` and `customProgramCacheKey`. */
export function applyCharacterRim(root: Object3D): void {
  root.traverse((object) => {
    if (!(object instanceof Mesh)) return
    const materials = Array.isArray(object.material) ? object.material : [object.material]
    for (const material of materials) {
      if (material instanceof MeshStandardMaterial) hook(material)
    }
  })
}
