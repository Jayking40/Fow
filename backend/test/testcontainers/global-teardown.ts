import { stopContainers } from './base';

export default async function globalTeardown() {
  await stopContainers();
}
