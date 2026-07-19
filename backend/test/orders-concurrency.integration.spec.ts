
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import request from 'supertest';
import { App } from 'supertest/types';

import { InventoryStockEntity } from '../src/inventory/entities/inventory-stock.entity';
import { InventoryService } from '../src/inventory/inventory.service';
import { OrderEventEntity } from '../src/orders/entities/order-event.entity';
import { OrderEntity } from '../src/orders/entities/order.entity';
import { OrdersController } from '../src/orders/orders.controller';
import { OrdersService } from '../src/orders/orders.service';
import { OrderEventStoreService } from '../src/orders/services/order-event-store.service';
import { RequestStatusService } from '../src/orders/services/request-status.service';
import { OrderStateMachine } from '../src/orders/state-machine/order-state-machine';
import { ReservedUnitInvariantService } from '../src/common/invariants/reserved-unit.invariant';
import {
  createDataSource,
  getDataSource,
  getPostgresConfig,
  resetDatabase,
} from './helpers/integration-test.helper';

describe('Orders Inventory Concurrency Integration', () => {
  let app: INestApplication<App>;
  let inventoryService: InventoryService;

  beforeAll(async () => {
    await createDataSource();
  });

  afterAll(async () => {
    const dataSource = getDataSource();
    if (dataSource) {
      await dataSource.destroy();
    }
    if (app) {
      await app.close();
    }
  });

  beforeEach(async () => {
    await resetDatabase();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
        }),
        TypeOrmModule.forRoot({
          type: 'postgres',
          ...getPostgresConfig(),
          entities: [OrderEntity, OrderEventEntity, InventoryStockEntity],
          synchronize: true,
        }),
        TypeOrmModule.forFeature([
          OrderEntity,
          OrderEventEntity,
          InventoryStockEntity,
        ]),
      ],
      controllers: [OrdersController],
      providers: [
        OrdersService,
        OrderStateMachine,
        OrderEventStoreService,
        RequestStatusService,
        InventoryService,
        {
          provide: ReservedUnitInvariantService,
          useValue: {
            assertReservable: jest.fn().mockResolvedValue(undefined),
            assertUnitStatus: jest.fn(),
          },
        },
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    inventoryService = moduleFixture.get<InventoryService>(InventoryService);
  });

  afterEach(async () => {
    if (app) {
      await app.close();
    }
  });

  it('allows only one order when stock has one unit', async () => {
    await inventoryService.create({
      bloodBankId: 'BB-001',
      bloodType: 'O+',
      availableUnits: 1,
    });

    const payload = {
      hospitalId: 'HOSP-001',
      bloodBankId: 'BB-001',
      bloodType: 'O+',
      quantity: 1,
      deliveryAddress: '123 Main St',
    };

    const [resA, resB] = await Promise.all([
      request(app.getHttpServer()).post('/orders').send(payload),
      request(app.getHttpServer()).post('/orders').send(payload),
    ]);

    const statuses = [resA.status, resB.status].sort((a, b) => a - b);
    expect(statuses).toEqual([201, 409]);

    const stock = await inventoryService.findByBankAndBloodType('BB-001', 'O+');
    expect(stock).toBeTruthy();
    expect(stock?.availableUnits).toBe(0);
  });
});
