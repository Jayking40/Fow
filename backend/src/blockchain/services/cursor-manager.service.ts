import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

const CURSOR_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface CursorPayload {
  queryType: string;
  position: string;
  issuedAt: number;
}

@Injectable()
export class CursorManager {
  private readonly secret: string;

  constructor(private readonly configService: ConfigService) {
    this.secret =
      this.configService.get<string>('CURSOR_SIGNING_SECRET') ?? 'default-cursor-secret';
  }

  encode(queryType: string, position: string): string {
    const payload: CursorPayload = {
      queryType,
      position,
      issuedAt: Date.now(),
    };
    const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = crypto
      .createHmac('sha256', this.secret)
      .update(data)
      .digest('base64url');
    return `${data}.${sig}`;
  }

  decode(token: string, expectedQueryType: string): CursorPayload {
    const parts = token.split('.');
    if (parts.length !== 2) {
      throw new Error('Invalid cursor token format');
    }
    const [data, sig] = parts;
    const expectedSig = crypto
      .createHmac('sha256', this.secret)
      .update(data)
      .digest('base64url');

    if (
      sig.length !== expectedSig.length ||
      !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))
    ) {
      throw new Error('Cursor token signature invalid');
    }

    let payload: CursorPayload;
    try {
      payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    } catch {
      throw new Error('Cursor token payload malformed');
    }

    if (Date.now() - payload.issuedAt > CURSOR_TTL_MS) {
      throw new Error('Cursor token has expired');
    }

    if (payload.queryType !== expectedQueryType) {
      throw new Error('Cursor token is not valid for this query type');
    }

    return payload;
  }
}
