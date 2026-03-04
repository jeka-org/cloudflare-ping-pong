import { describe, it, expect } from 'vitest';
import {
  updateBall,
  checkWallBounce,
  checkPaddleCollision,
  checkScore,
  resetBall,
} from '../src/physics';

describe('ball movement', () => {
  it('moves ball by velocity each tick', () => {
    const ball = { x: 0.5, y: 0.5, vx: 0.01, vy: 0.005 };
    const next = updateBall(ball);
    expect(next.x).toBe(0.51);
    expect(next.y).toBe(0.505);
  });

  it('bounces off top wall', () => {
    const ball = { x: 0.5, y: 0.005, vx: 0.01, vy: -0.02 };
    const next = checkWallBounce(ball);
    expect(next.vy).toBeGreaterThan(0); // reversed
  });

  it('bounces off bottom wall', () => {
    const ball = { x: 0.5, y: 0.995, vx: 0.01, vy: 0.02 };
    const next = checkWallBounce(ball);
    expect(next.vy).toBeLessThan(0);
  });
});

describe('paddle collision', () => {
  it('detects hit on left paddle', () => {
    const ball = { x: 0.015, y: 0.5, vx: -0.01, vy: 0 };
    const paddleY = 0.5;
    const result = checkPaddleCollision(ball, paddleY, 'left');
    expect(result.hit).toBe(true);
    expect(result.ball.vx).toBeGreaterThan(0); // reversed
  });

  it('misses when paddle is elsewhere', () => {
    const ball = { x: 0.015, y: 0.5, vx: -0.01, vy: 0 };
    const paddleY = 0.9;
    const result = checkPaddleCollision(ball, paddleY, 'left');
    expect(result.hit).toBe(false);
  });

  it('increases ball speed after each hit', () => {
    const ball = { x: 0.015, y: 0.5, vx: -0.01, vy: 0 };
    const result = checkPaddleCollision(ball, 0.5, 'left');
    expect(result.hit).toBe(true);
    expect(Math.abs(result.ball.vx)).toBeGreaterThan(0.01);
  });

  it('adds angle based on where ball hits paddle', () => {
    // Hit top of paddle → ball goes up
    // Paddle at 0.5 with height 0.15 extends from 0.425 to 0.575
    const ball = { x: 0.015, y: 0.44, vx: -0.01, vy: 0 };
    const result = checkPaddleCollision(ball, 0.5, 'left');
    expect(result.hit).toBe(true);
    expect(result.ball.vy).toBeLessThan(0); // upward
  });

  it('detects hit on right paddle', () => {
    const ball = { x: 0.985, y: 0.5, vx: 0.01, vy: 0 };
    const paddleY = 0.5;
    const result = checkPaddleCollision(ball, paddleY, 'right');
    expect(result.hit).toBe(true);
    expect(result.ball.vx).toBeLessThan(0); // reversed
  });
});

describe('scoring', () => {
  it('scores for player 2 when ball passes left edge', () => {
    const ball = { x: -0.01, y: 0.5, vx: -0.01, vy: 0 };
    const result = checkScore(ball);
    expect(result.scored).toBe(true);
    expect(result.scorer).toBe(2);
  });

  it('scores for player 1 when ball passes right edge', () => {
    const ball = { x: 1.01, y: 0.5, vx: 0.01, vy: 0 };
    const result = checkScore(ball);
    expect(result.scored).toBe(true);
    expect(result.scorer).toBe(1);
  });

  it('no score when ball is in play', () => {
    const ball = { x: 0.5, y: 0.5, vx: 0.01, vy: 0 };
    expect(checkScore(ball).scored).toBe(false);
  });
});

describe('ball reset', () => {
  it('resets ball to center', () => {
    const ball = resetBall();
    expect(ball.x).toBe(0.5);
    expect(ball.y).toBe(0.5);
  });

  it('creates ball with non-zero velocity', () => {
    const ball = resetBall();
    expect(Math.abs(ball.vx)).toBeGreaterThan(0);
    expect(Math.abs(ball.vy)).toBeGreaterThan(0);
  });
});
