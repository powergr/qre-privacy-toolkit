export default {
  preset: "ts-jest",
  testEnvironment: "jsdom",
  verbose: false,

  // Runs after the test environment is set up — needed for jest-dom's
  // custom matchers (toBeInTheDocument, toBeDisabled, etc.)
  setupFilesAfterEnv: ["@testing-library/jest-dom"],
};
