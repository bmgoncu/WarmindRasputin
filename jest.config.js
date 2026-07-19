/** Jest config. ESM + ts-jest; tests live in __tests__/ named after the src file they cover. */
export default {
    preset: "ts-jest/presets/default-esm",
    testEnvironment: "node",
    extensionsToTreatAsEsm: [".ts"],
    // NodeNext requires .js specifiers in TS source; strip them for the resolver.
    moduleNameMapper: { "^(\\.{1,2}/.*)\\.js$": "$1" },
    transform: {
        "^.+\\.ts$": ["ts-jest", { useESM: true, tsconfig: "tsconfig.test.json" }],
    },
    testMatch: ["<rootDir>/__tests__/**/*.test.ts"],
};
