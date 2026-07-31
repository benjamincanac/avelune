import { nativeFetch } from '../utils/nativeFetch'

// Evaluate the nativeFetch util at Nitro boot — before any request, and in
// particular before an SSR/error render loads the Vue server bundle whose
// side effect replaces globalThis.fetch (see server/utils/nativeFetch.ts).
export default defineNitroPlugin(() => {
  void nativeFetch
})
