// Runs once before the tests. A fixed, non-UTC time zone (with daylight saving) makes date
// handling behave the same on every machine, so a UTC-versus-local mix-up can't hide.
export default async function globalSetup() {
  process.env.TZ = "America/New_York";
}
