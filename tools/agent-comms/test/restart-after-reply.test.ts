import { describe, expect, it } from 'bun:test';
import { createRestartAfterReplyController } from '../src/restart-after-reply';

describe('restart-after-reply controller', () => {
  it('waits for worker idle and restarts exactly once', async () => {
    let idle = false;
    let restarts = 0;
    const controller = createRestartAfterReplyController({
      isWorkerIdle: () => idle,
      restart: () => restarts++,
      delayMs: 5,
    });

    expect(controller.request()).toEqual({ alreadyQueued: false });
    expect(controller.request()).toEqual({ alreadyQueued: true });
    await Bun.sleep(10);
    expect(restarts).toBe(0);

    idle = true;
    controller.notifyWorkerIdle();
    await Bun.sleep(10);
    expect(restarts).toBe(1);

    controller.notifyWorkerIdle();
    await Bun.sleep(10);
    expect(restarts).toBe(1);
  });

  it('rechecks idleness before restart to protect a newly arrived turn', async () => {
    let idle = true;
    let restarts = 0;
    const controller = createRestartAfterReplyController({
      isWorkerIdle: () => idle,
      restart: () => restarts++,
      delayMs: 10,
    });

    controller.request();
    idle = false;
    await Bun.sleep(20);
    expect(restarts).toBe(0);
    expect(controller.isPending()).toBe(true);

    idle = true;
    controller.notifyWorkerIdle();
    await Bun.sleep(20);
    expect(restarts).toBe(1);
  });
});
