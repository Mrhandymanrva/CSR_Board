/** Loaded before the test graph so config.js can import.
 *  These are placeholders. They are not credentials and must not be real ones. */
const defaults = {
  ST_CLIENT_ID: 'test',
  ST_CLIENT_SECRET: 'test',
  ST_APP_KEY: 'test',
  ST_TENANT_ID: 'test',
  BOARD_TOKEN: 'test-board-token',
  TZ: 'America/New_York',
};
for (const [key, value] of Object.entries(defaults)) {
  if (!process.env[key]) process.env[key] = value;
}
