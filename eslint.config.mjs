import { createConfigForNuxt } from '@nuxt/eslint-config/flat'

export default createConfigForNuxt({
  features: {
    stylistic: true,
  },
}).overrideRules({
  'vue/multi-word-component-names': 'off',
}).append({
  // Claude Code git worktrees are separate checkouts nested under here; linting
  // them just re-flags duplicate copies of files that live in the main tree.
  ignores: ['.claude/**'],
})
