
// Integration tests in this repo normally use Testcontainers (Docker) via startContainers().
// In environments without Docker, that strategy fails before any test can run.
//
// Multi-instance Socket.IO Redis tests should rely on already-running dependencies
// (Redis + Postgres) provided externally, so we no-op globalSetup here.
module.exports = async () => {
  // no-op
};

