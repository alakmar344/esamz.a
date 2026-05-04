import nextVitals from 'eslint-config-next/core-web-vitals'

const eslintConfig = [
  ...nextVitals,
  {
    files: ['app/page.tsx'],
    rules: {
      'react/no-direct-mutation-state': 'off',
      'react-hooks/unsupported-syntax': 'off',
    },
  },
]

export default eslintConfig
