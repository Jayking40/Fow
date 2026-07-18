
import { stopContainers } from './helpers/integration-test.helper';

module.exports = async () => {
  await stopContainers();
};
