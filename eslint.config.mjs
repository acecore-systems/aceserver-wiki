import withNuxt from './.nuxt/eslint.config.mjs'

export default withNuxt(
  {
    ignores: [
      'poc/astro-sveltia/worker-configuration.d.ts',
      'poc/discord-oidc-broker/worker-configuration.d.ts',
    ],
  },
  {
    rules: {
      'vue/html-self-closing': [
        'error',
        {
          html: {
            void: 'always',
          },
        },
      ],
      'vue/multi-word-component-names': 'off',
    },
  },
)
