export default defineAppConfig({
  ui: {
    colors: {
      primary: 'avelune',
      // The whole surface is cool: warm greys fight the aqua accent.
      neutral: 'slate',
    },
    /**
     * The design has four button weights, and they map onto Nuxt UI's own
     * variants rather than onto a parallel set of CSS classes: `primary/solid`
     * is the one accent action, `neutral/subtle` the frost fill,
     * `neutral/outline` the bordered secondary, `error/subtle` the destructive
     * one. Sizes carry the design's padding and tracking ladder. Hover moves
     * colour only — no transforms — and the library's `/75` fade becomes a lift,
     * which is what the handoff asks for.
     */
    button: {
      slots: {
        base: 'rounded-none font-display font-bold uppercase leading-none transition-colors duration-120 ease-out',
      },
      variants: {
        size: {
          xs: { base: 'gap-2.5 px-5 py-2.75 text-[13px] tracking-[0.18em]', leadingIcon: 'size-3.5', trailingIcon: 'size-3.5' },
          sm: { base: 'gap-2.5 px-4 py-3.25 text-[13px] tracking-[0.2em]', leadingIcon: 'size-3.5', trailingIcon: 'size-3.5' },
          md: { base: 'gap-3.5 px-4.5 py-3.5 text-sm tracking-[0.16em]', leadingIcon: 'size-3.5', trailingIcon: 'size-3.5' },
          lg: { base: 'gap-3.5 px-4.5 py-3.75 text-base tracking-[0.18em]', leadingIcon: 'size-3.5', trailingIcon: 'size-3.5' },
          xl: { base: 'gap-3.5 px-10 py-5 text-[19px] tracking-[0.2em]', leadingIcon: 'size-3.5', trailingIcon: 'size-3.5' },
        },
      },
      compoundVariants: [
        {
          color: 'primary',
          variant: 'solid',
          class: 'bg-primary text-avelune-950 hover:bg-avelune-300 active:bg-avelune-300 disabled:bg-primary aria-disabled:bg-primary',
        },
        {
          color: 'neutral',
          variant: 'subtle',
          class: 'bg-white/7 font-semibold text-[#e6ecf1] ring-white/12 hover:bg-white/14 active:bg-white/14 disabled:bg-white/7 aria-disabled:bg-white/7 focus-visible:ring-white',
        },
        {
          color: 'neutral',
          variant: 'outline',
          class: 'bg-transparent font-semibold text-[#e6ecf1] ring-white/22 hover:bg-transparent hover:text-white hover:ring-white active:bg-transparent disabled:bg-transparent',
        },
        {
          color: 'error',
          variant: 'subtle',
          class: 'bg-error/10 text-[#f0a591] ring-error/45 hover:bg-error/20 hover:text-[#ffd2c4] active:bg-error/20 disabled:bg-error/10',
        },
      ],
    },
    input: {
      slots: {
        base: 'transition-colors duration-120 ease-out',
      },
    },
    popover: {
      slots: {
        content: 'frost rounded-[6px] shadow-[0_30px_70px_rgb(0_0_0/0.4)]',
      },
    },
    /** The entry screen's bar: a 3px track with an accent fill and its glow. */
    progress: {
      slots: {
        base: 'bg-white/10 rounded-none',
        indicator: 'rounded-none shadow-[0_0_18px_rgb(111_240_218/0.6)]',
      },
      variants: {
        size: {
          xs: { base: 'h-0.75' },
        },
      },
    },
    toast: {
      slots: {
        root: 'frost rounded-[6px]',
      },
    },
    /**
     * Keycaps are one shape everywhere: a mono glyph on a light fill at 3px.
     * Kbd is a flat `tv` config rather than a slotted one, so `base` sits at the
     * top level — nesting it under `slots` makes the merge emit the literal
     * class "base". The metrics live in the size variant and the fill in the
     * compound, because both would otherwise win over anything set on `base`.
     */
    kbd: {
      base: 'inline-flex items-center justify-center rounded-[3px] font-mono font-semibold uppercase tracking-normal',
      variants: {
        size: {
          sm: 'h-auto min-w-0 px-1.5 py-0.5 text-[9px]',
          md: 'h-auto min-w-0 px-[7px] py-1 text-[10px]',
          lg: 'h-auto min-w-0 px-2 py-1 text-[11px]',
        },
      },
      compoundVariants: [
        { color: 'neutral', variant: 'soft', class: 'bg-white/12 text-highlighted' },
      ],
      defaultVariants: {
        variant: 'soft',
      },
    },
  },
})
