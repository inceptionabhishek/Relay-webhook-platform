module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/tests/unit.test.ts'],
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: {
          target: 'ES2022',
          module: 'CommonJS',
          esModuleInterop: true,
          experimentalDecorators: true,
          emitDecoratorMetadata: true,
        },
        diagnostics: true,
      },
    ],
  },
};
