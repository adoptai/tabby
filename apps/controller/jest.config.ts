export default {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.spec.ts'],
  moduleNameMapper: {
    '^@browser-hitl/shared(.*)$': '<rootDir>/../../packages/shared/src$1',
    '^@kubernetes/client-node$': '<rootDir>/src/__mocks__/@kubernetes/client-node.ts',
  },
  transform: {
    '^.+\\.ts$': ['ts-jest', {
      tsconfig: 'tsconfig.spec.json',
    }],
  },
};
