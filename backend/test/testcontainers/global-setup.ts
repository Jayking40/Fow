import { startContainers } from './base';

export default async function globalSetup() {
  await startContainers();
}
