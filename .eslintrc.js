module.exports = {
  env: {
    browser: true,
    es2021: true,
    node: true
  },
  extends: ['eslint:recommended', 'plugin:react/recommended', 'plugin:react/jsx-runtime'],
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
    ecmaFeatures: {
      jsx: true
    }
  },
  settings: {
    react: {
      version: 'detect'
    }
  },
  plugins: ['unused-imports'], // Add the unused-imports plugin
  rules: {
    'react/prop-types': 'off', // Disable prop-types rule

    // Rules for unused imports
    'unused-imports/no-unused-imports': 'error', // Automatically remove unused imports
    'unused-imports/no-unused-vars': [
      'warn',
      {
        vars: 'all', // Check all variables
        varsIgnorePattern: '^_', // Ignore variables starting with "_"
        args: 'after-used', // Check function arguments after the last used
        argsIgnorePattern: '^_' // Ignore arguments starting with "_"
      }
    ]
  }
}
