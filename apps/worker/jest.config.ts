export default {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.spec.ts'],
  moduleNameMapper: {
    '^@browser-hitl/shared(.*)$': '<rootDir>/../../packages/shared/src$1',
  },
};
