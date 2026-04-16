module.exports = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [2, 'always', [
      'feat', 'fix', 'chore', 'ci', 'docs', 'style', 'refactor',
      'perf', 'test', 'build', 'revert', 'release',
    ]],
  },
};
