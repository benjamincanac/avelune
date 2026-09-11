import { BufferAttribute, BufferGeometry, Color, DataTexture, DynamicDrawUsage, LinearFilter, RepeatWrapping, RGBAFormat, Sprite, UniformsLib, UniformsUtils, Vector3 } from 'three'
import type { Object3D, Scene, ShaderMaterial } from 'three'
import { Reflector } from 'three/addons/objects/Reflector.js'
import type { createFountainSimulation } from './fountainSimulation'

const reflecting = new WeakSet<Scene>()

/** A seamless normal field with several capillary wavelengths. The solver
 * supplies the large slopes; this texture only breaks up the specular surface. */
function createNormalTexture() {
  const size = 128
  const data = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size * Math.PI * 2
      const v = y / size * Math.PI * 2
      const dx = Math.cos(u * 3 + v * 2) * 0.34 + Math.cos(u * 7 - v * 5) * 0.22 + Math.sin(u * 13 + v * 9) * 0.12
      const dy = Math.cos(u * 3 + v * 2) * 0.23 - Math.cos(u * 7 - v * 5) * 0.16 + Math.sin(u * 13 + v * 9) * 0.08
      const i = (y * size + x) * 4
      data[i] = Math.round((dx * 0.5 + 0.5) * 255)
      data[i + 1] = Math.round((dy * 0.5 + 0.5) * 255)
      data[i + 2] = 255
      data[i + 3] = 255
    }
  }
  const texture = new DataTexture(data, size, size, RGBAFormat)
  texture.wrapS = texture.wrapT = RepeatWrapping
  texture.minFilter = texture.magFilter = LinearFilter
  texture.needsUpdate = true
  return texture
}

const shader = {
  name: 'FountainReflectiveWater',
  uniforms: UniformsUtils.merge([UniformsLib.lights!, UniformsLib.fog!, {
    color: { value: new Color('#257780') },
    tDiffuse: { value: null },
    textureMatrix: { value: null },
    normalMap: { value: null },
    flow: { value: 0 },
    radius: { value: 1 },
    innerRadius: { value: 0 },
    eye: { value: new Vector3() },
  }]),
  vertexShader: /* glsl */ `
    uniform mat4 textureMatrix;
    attribute float foam;
    varying float vFoam;
    varying vec4 mirrorCoord;
    varying vec3 vWorldPosition;
    varying vec3 vWorldNormal;
    varying vec2 vSurface;
    #include <common>
    #include <fog_pars_vertex>
    #include <shadowmap_pars_vertex>
    #include <logdepthbuf_pars_vertex>
    void main() {
      vec4 worldPosition = modelMatrix * vec4(position, 1.0);
      vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
      vWorldPosition = worldPosition.xyz;
      vSurface = position.xy;
      vFoam = foam;
      mirrorCoord = textureMatrix * vec4(position, 1.0);
      gl_Position = projectionMatrix * mvPosition;
      #include <beginnormal_vertex>
      #include <defaultnormal_vertex>
      vWorldNormal = inverseTransformDirection(transformedNormal, viewMatrix);
      #include <shadowmap_vertex>
      #include <fog_vertex>
      #include <logdepthbuf_vertex>
    }
  `,
  fragmentShader: /* glsl */ `
    uniform vec3 color;
    uniform vec3 eye;
    uniform sampler2D tDiffuse;
    uniform sampler2D normalMap;
    uniform float flow;
    uniform float radius;
    uniform float innerRadius;
    varying float vFoam;
    varying vec4 mirrorCoord;
    varying vec3 vWorldPosition;
    varying vec3 vWorldNormal;
    varying vec2 vSurface;
    #include <common>
    #include <packing>
    #include <bsdfs>
    #include <lights_pars_begin>
    #include <shadowmap_pars_fragment>
    #include <shadowmask_pars_fragment>
    #include <fog_pars_fragment>
    #include <logdepthbuf_pars_fragment>
    float hash21(vec2 p) {
      p = fract(p * vec2(123.34, 456.21));
      p += dot(p, p + 45.32);
      return fract(p.x * p.y);
    }
    void main() {
      float distanceToCenter = length(vSurface);
      if (distanceToCenter > radius || distanceToCenter < innerRadius) discard;
      #include <logdepthbuf_fragment>
      vec2 uv = vWorldPosition.xz;
      vec2 detail = texture2D(normalMap, uv * 0.75 + vec2(flow, flow * 0.43)).rg;
      detail += texture2D(normalMap, uv * 1.37 + vec2(-flow * 0.71, flow * 0.57)).rg;
      detail -= 1.0;
      vec3 normal = normalize(vWorldNormal + vec3(detail.x, 0.0, detail.y) * 0.2);
      vec3 toEye = eye - vWorldPosition;
      vec3 eyeDirection = normalize(toEye);
      float facing = max(dot(normal, eyeDirection), 0.0);
      // Schlick Fresnel for air/water (IOR 1.333), matching Three's Water.
      float fresnel = 0.02037 + 0.97963 * pow(1.0 - facing, 5.0);
      vec2 distortion = normal.xz * (0.016 + 0.025 / max(length(toEye), 1.0));
      vec2 reflectionUv = clamp(mirrorCoord.xy / mirrorCoord.w + distortion, 0.002, 0.998);
      vec3 reflection = texture2D(tDiffuse, reflectionUv).rgb;
      vec3 diffuse = ambientLightColor;
      vec3 specular = vec3(0.0);
      #if NUM_HEMI_LIGHTS > 0
        for (int i = 0; i < NUM_HEMI_LIGHTS; i++) {
          diffuse += mix(hemisphereLights[i].groundColor, hemisphereLights[i].skyColor, 0.85) * 0.5;
        }
      #endif
      #if NUM_DIR_LIGHTS > 0
        for (int i = 0; i < NUM_DIR_LIGHTS; i++) {
          vec3 lightDirection = inverseTransformDirection(directionalLights[i].direction, viewMatrix);
          float nDotL = max(dot(normal, lightDirection), 0.0);
          diffuse += directionalLights[i].color * nDotL * 0.48;
          vec3 reflectedLight = reflect(-lightDirection, normal);
          specular += directionalLights[i].color * pow(max(dot(reflectedLight, eyeDirection), 0.0), 180.0) * 0.65;
        }
      #endif
      float shadow = getShadowMask();
      // Light is absorbed over the deeper middle of the annulus. A clearer
      // shoreline lets the actual basin beneath the transparent pass show.
      float shoreDistance = radius - distanceToCenter;
      if (innerRadius > 0.0) shoreDistance = min(shoreDistance, distanceToCenter - innerRadius);
      float depth = smoothstep(0.0, radius * 0.3, shoreDistance);
      vec3 waterColor = mix(color * 1.1, color * 0.32, depth);
      vec3 scatter = waterColor * diffuse * mix(0.3, 0.72, shadow);
      vec3 outgoing = mix(scatter, reflection, fresnel) + specular * shadow * (0.18 + fresnel);
      // Sparse bubble rims carry the simulated aeration. Even a saturated
      // impact cell retains clear water between bubbles instead of a white disc.
      vec2 bubblePosition = vSurface * 48.0 + detail * 1.7 + vec2(flow * 1.3, -flow * 0.7);
      vec2 cell = floor(bubblePosition);
      vec2 center = vec2(0.35) + vec2(hash21(cell), hash21(cell + 17.1)) * 0.3;
      float bubbleDistance = length(fract(bubblePosition) - center);
      float bubbleRadius = 0.15 + hash21(cell + 3.7) * 0.19;
      float aa = max(fwidth(bubbleDistance), 0.03);
      float rim = (1.0 - smoothstep(0.02, 0.02 + aa, abs(bubbleDistance - bubbleRadius)));
      float density = smoothstep(0.04, 0.75, vFoam);
      float bubbles = step(hash21(cell + 8.3), density * 0.65) * rim;
      float foam = bubbles * density * 0.68;
      vec3 foamLight = diffuse / (vec3(1.0) + diffuse * 0.55);
      outgoing = mix(outgoing, vec3(0.61, 0.72, 0.69) * foamLight * mix(0.45, 1.0, shadow), foam);
      gl_FragColor = vec4(outgoing, mix(mix(0.56, 0.87, depth), 0.96, max(fresnel, foam)));
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
      #include <fog_fragment>
    }
  `,
}

/** A deforming pool over one mean reflection plane. Reflector owns the mirror
 * camera/target, while the shallow-water solver owns geometry and foam. */
export function createFountainSurface(sim: ReturnType<typeof createFountainSimulation>, height: number) {
  const positions = new Float32Array(sim.heights.length * 3)
  const foam = new Float32Array(sim.heights.length)
  const indices: number[] = []
  for (let z = 0; z < sim.resolution; z++) {
    for (let x = 0; x < sim.resolution; x++) {
      const i = z * sim.resolution + x
      // Reflector's local plane faces +Z. After rotation, local -Y is world +Z.
      positions.set([x * sim.spacing - sim.radius, sim.radius - z * sim.spacing, 0], i * 3)
      if (x >= sim.resolution - 1 || z >= sim.resolution - 1) continue
      indices.push(i, i + sim.resolution, i + 1, i + 1, i + sim.resolution, i + sim.resolution + 1)
    }
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(positions, 3).setUsage(DynamicDrawUsage))
  geometry.setAttribute('foam', new BufferAttribute(foam, 1).setUsage(DynamicDrawUsage))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  const mesh = new Reflector(geometry, { textureWidth: 256, textureHeight: 256, multisample: 0, clipBias: 0.003, shader, color: '#23606b' })
  mesh.name = 'Reflective fountain surface'
  mesh.userData.fountainSurface = true
  mesh.rotation.x = -Math.PI / 2
  mesh.position.y = height
  mesh.receiveShadow = true
  const material = mesh.material as ShaderMaterial
  material.lights = true
  material.fog = true
  material.transparent = true
  material.depthWrite = false
  const normalTexture = createNormalTexture()
  material.uniforms.normalMap!.value = normalTexture
  material.uniforms.radius!.value = sim.radius
  material.uniforms.innerRadius!.value = sim.pedestalRadius
  const reflect = mesh.onBeforeRender.bind(mesh)
  const hidden: Object3D[] = []
  let disposed = false
  mesh.onBeforeRender = (renderer, scene, camera, ...args) => {
    // GTAO's normal override and mirrored/shadow cameras must never trigger a
    // nested world render. Other pools are hidden to avoid feedback recursion.
    if (disposed || scene.overrideMaterial || reflecting.has(scene) || camera.userData.fountainReflection) return
    material.uniforms.eye!.value.setFromMatrixPosition(camera.matrixWorld)
    const mirrorCamera = mesh.getReflectionCamera(camera)
    mirrorCamera.userData.fountainReflection = true
    scene.traverse((object) => {
      if (object !== mesh && object.visible && (object instanceof Sprite || object.userData.fountainSurface)) {
        hidden.push(object)
        object.visible = false
      }
    })
    const renderTarget = renderer.getRenderTarget()
    const xrEnabled = renderer.xr.enabled
    const shadowAutoUpdate = renderer.shadowMap.autoUpdate
    reflecting.add(scene)
    try {
      reflect(renderer, scene, camera, ...args)
    }
    finally {
      reflecting.delete(scene)
      mesh.visible = true
      renderer.xr.enabled = xrEnabled
      renderer.shadowMap.autoUpdate = shadowAutoUpdate
      renderer.setRenderTarget(renderTarget)
      for (const object of hidden) object.visible = true
      hidden.length = 0
    }
  }
  return {
    mesh,
    update(seconds: number) {
      material.uniforms.flow!.value = seconds * 0.037 % 1000
      for (let i = 0; i < sim.heights.length; i++) positions[i * 3 + 2] = sim.heights[i]!
      foam.set(sim.foam)
      geometry.attributes.position!.needsUpdate = true
      geometry.attributes.foam!.needsUpdate = true
      geometry.computeVertexNormals()
    },
    dispose() {
      if (disposed) return
      disposed = true
      mesh.removeFromParent()
      mesh.dispose()
      geometry.dispose()
      normalTexture.dispose()
    },
  }
}
