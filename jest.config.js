export default {
  preset: "ts-jest",
  testEnvironment: "jsdom",
  verbose: false,

  // Runs after the test environment is set up — needed for jest-dom's
  // custom matchers (toBeInTheDocument, toBeDisabled, etc.)
  setupFilesAfterEnv: ["@testing-library/jest-dom"],

  globalSetup: "<rootDir>/jest.global-setup.js",

  // Views import their own .css files. Jest can't parse CSS, so swap in an empty module.
  moduleNameMapper: {
    "\\.css$": "<rootDir>/src/test-support/styleMock.cjs",
  },
};
