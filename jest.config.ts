import { pathsToModuleNameMapper } from 'ts-jest';
import { compilerOptions } from './tsconfig.json';
import type { JestConfigWithTsJest } from 'ts-jest'

const baseTestDir = '<rootDir>/tests';

const jestConfig: JestConfigWithTsJest = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    verbose: true,
    modulePaths: ['<rootDir>'],
    moduleNameMapper: pathsToModuleNameMapper(compilerOptions.paths, { prefix: '<rootDir>' }),
    testMatch: [
        `${baseTestDir}/tests/getter/**/*test.ts`,
    ],
    ...(process.env["WATCH_MODE"] ? {
        globalSetup: `${baseTestDir}/config/jest.watch-mode.setup.ts`,
    } : {
        globalSetup: `${baseTestDir}/config/jest.setup.ts`,
        globalTeardown: `${baseTestDir}/config/jest.teardown.ts`,
    }),
    transform: {
        '^.+\\.ts?$': 'ts-jest',
    },
    extensionsToTreatAsEsm: ['.ts']
}

export default jestConfig
