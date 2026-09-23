/**
 * Jest configuration.
 *
 * NestJS 12 ships as pure ESM (`"type": "module"`, no CommonJS build). Node 22
 * can `require()` an ES module natively, which is why the compiled application
 * runs fine as CommonJS — but Jest intercepts module loading with its own
 * runtime, and that interception only gained `require(esm)` support in Node
 * 24.9. Below that, any test that transitively imports `@nestjs/common` fails to
 * load.
 *
 * The fix is to run Jest in native ESM mode, which needs three things that must
 * agree with each other:
 *
 *   1. `--experimental-vm-modules` on the Node command line (see the `test`
 *      script in package.json). Jest's ESM support is built on `vm.Module`,
 *      which is still behind that flag.
 *   2. `extensionsToTreatAsEsm` plus `useESM` on the transform, so ts-jest emits
 *      ES modules rather than CommonJS.
 *   3. A module name mapper that strips the `.js` suffix from relative
 *      specifiers. Real ESM requires extensions; the source here is written
 *      extensionless for the CommonJS build, and the mapper reconciles the two
 *      so both targets work from one set of sources.
 */

/** @type {import('jest').Config} */
export default {
  rootDir: 'src',
  testEnvironment: 'node',
  moduleFileExtensions: ['js', 'mjs', 'json', 'ts'],
  testRegex: '.*\\.spec\\.ts$',

  extensionsToTreatAsEsm: ['.ts'],

  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        useESM: true,
        // `isolatedModules` keeps per-file transpilation fast; full type errors
        // are caught by `npm run typecheck`, which is the right place for them.
        isolatedModules: true,
        tsconfig: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          target: 'ES2023',
          experimentalDecorators: true,
          emitDecoratorMetadata: true,
          esModuleInterop: true,
          allowSyntheticDefaultImports: true,
          strictNullChecks: true,
          verbatimModuleSyntax: false,
        },
      },
    ],
  },

  // Relative `./foo.js` specifiers resolve to `./foo` so the same sources work
  // under both the CommonJS build and the ESM test runner.
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },

  // Nest's packages are already ESM and need no transformation.
  transformIgnorePatterns: ['/node_modules/'],

  collectCoverageFrom: [
    '**/*.ts',
    '!**/*.spec.ts',
    '!**/*.dto.ts',
    '!**/*.entity.ts',
    '!**/*.module.ts',
    '!main.ts',
    '!database/migrations/**',
    '!database/seeds/**',
  ],
  coverageDirectory: '../coverage',

  clearMocks: true,
  // argon2 hashing is intentionally slow; the default 5s timeout is marginal on
  // a loaded machine even at reduced test cost parameters.
  testTimeout: 30_000,
};
