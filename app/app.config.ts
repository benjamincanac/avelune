export default defineAppConfig({
  ui: {
    colors: {
      primary: 'stadium',
      neutral: 'gray',
    },
    button: {
      slots: {
        base: 'active:translate-y-px transition-transform duration-200',
      },
    },
    popover: {
      slots: {
        content: 'backdrop-blur-sm bg-black/35 ring-white/5 divide-y divide-white/5 rounded-lg',
      },
    },
    kbd: {
      defaultVariants: {
        variant: 'soft',
      },
    },
  },
})
