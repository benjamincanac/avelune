export default defineAppConfig({
  ui: {
    colors: {
      primary: 'green',
      neutral: 'neutral',
    },
    button: {
      slots: {
        base: 'active:translate-y-px transition-transform duration-200',
      },
    },
  },
})
