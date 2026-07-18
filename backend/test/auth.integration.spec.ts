
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import Redis from 'ioredis';

import { REDIS_CLIENT } from '../src/redis/redis.constants';
import { UserEntity } from '../src/users/entities/user.entity';
import { AuthService } from '../src/auth/auth.service';
import { hashPassword } from '../src/auth/utils/password.util';
import {
  createDataSource,
  createRedisClient,
  getDataSource,
  getPostgresConfig,
  getRedisConfig,
  resetDatabase,
  resetRedis,
} from './helpers/integration-test.helper';
import { AuthSessionEntity } from '../src/auth/entities/auth-session.entity';
import { JwtKeyService } from '../src/auth/jwt-key.service';
import { AuthSessionRepository } from '../src/auth/repositories/auth-session.repository';
import { UserActivityService } from '../src/user-activity/user-activity.service';
import { SecurityEventLoggerService } from '../src/user-activity/security-event-logger.service';
import { MfaService } from '../src/auth/mfa/mfa.service';
import { SessionRiskService } from '../src/auth/session-risk.service';

describe('AuthService - Refresh Token Race Condition (Integration)', () => {
  let authService: AuthService;
  let userRepository: Repository<UserEntity>;
  let jwtService: JwtService;
  let testUser: UserEntity;

  beforeAll(async () => {
    await createDataSource();
    await createRedisClient();
  });

  afterAll(async () => {
    const dataSource = getDataSource();
    if (dataSource) {
      await dataSource.destroy();
    }
  });

  beforeEach(async () => {
    await resetDatabase();
    await resetRedis();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [
            () => ({
              JWT_SECRET: 'test-secret-key-long-enough-12345',
              JWT_REFRESH_SECRET: 'test-refresh-secret-key-long-enough-12345',
              JWT_EXPIRES_IN: '1h',
              JWT_REFRESH_EXPIRES_IN: '7d',
              ...getPostgresConfig(),
              ...getRedisConfig(),
            }),
          ],
        }),
        JwtModule.register({
          secret: 'test-secret-key-long-enough-12345',
          signOptions: { expiresIn: '1h' },
        }),
        TypeOrmModule.forRoot({
          type: 'postgres',
          ...getPostgresConfig(),
          entities: [UserEntity, AuthSessionEntity],
          synchronize: true,
        }),
        TypeOrmModule.forFeature([UserEntity, AuthSessionEntity]),
      ],
      providers: [
        AuthService,
        JwtKeyService,
        AuthSessionRepository,
        { provide: REDIS_CLIENT, useValue: getRedisClient() },
        {
          provide: UserActivityService,
          useValue: { logEvent: jest.fn() },
        },
        {
          provide: SecurityEventLoggerService,
          useValue: { logEvent: jest.fn() },
        },
        {
          provide: MfaService,
          useValue: { isMfaEnabled: jest.fn().mockResolvedValue(false) },
        },
        {
          provide: SessionRiskService,
          useValue: { scoreSession: jest.fn().mockResolvedValue({ score: 0, level: 'LOW', signals: {} }) },
        },
      ],
    }).compile();

    authService = moduleFixture.get<AuthService>(AuthService);
    userRepository = moduleFixture.get<Repository<UserEntity>>(getRepositoryToken(UserEntity));
    jwtService = moduleFixture.get<JwtService>(JwtService);

    // Create test user
    const passwordHash = await hashPassword('password123!');
    testUser = userRepository.create({
      email: 'test@example.com',
      name: 'Test User',
      role: 'donor',
      passwordHash,
      failedLoginAttempts: 0,
      lockedUntil: null,
      passwordHistory: [],
      emailVerified: true,
    });
    await userRepository.save(testUser);
  });

  describe('Concurrent Refresh Token Requests', () => {
    it('should only allow one concurrent request to succeed', async () => {
      const loginResult = await authService.login({
        email: 'test@example.com',
        password: 'password123!',
      });

      const refreshToken = loginResult.refresh_token;

      const [result1, result2] = await Promise.allSettled([
        authService.refreshToken(refreshToken),
        authService.refreshToken(refreshToken),
      ]);

      const succeeded = [result1, result2].filter(
        (r) => r.status === 'fulfilled',
      );
      const failed = [result1, result2].filter((r) => r.status === 'rejected');

      expect(succeeded).toHaveLength(1);
      expect(failed).toHaveLength(1);
    });

    it('should rotate refresh token on successful use', async () => {
      const loginResult = await authService.login({
        email: 'test@example.com',
        password: 'password123!',
      });

      const oldRefreshToken = loginResult.refresh_token;
      const refreshResult = await authService.refreshToken(oldRefreshToken);

      expect(refreshResult.access_token).toBeDefined();
      expect(refreshResult.refresh_token).toBeDefined();
      expect(refreshResult.refresh_token).not.toBe(oldRefreshToken);
    });
  });
});
