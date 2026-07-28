import { Injectable, Logger } from '@nestjs/common';

import { NotificationsGateway } from '../gateways/notifications.gateway';

@Injectable()
export class InAppProvider {
  private readonly logger = new Logger(InAppProvider.name);

  constructor(private readonly gateway: NotificationsGateway) {}

  async send(recipientId: string, payload: any): Promise<void> {
    try {
      await this.gateway.emitToRecipient(recipientId, payload);
    } catch (error) {
      this.logger.error(
        `Error sending in-app notification to ${recipientId}`,
        error,
      );
      throw error;
    }
  }
}
